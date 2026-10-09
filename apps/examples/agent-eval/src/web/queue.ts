import path from "node:path";
import { runIsolated } from "../grading/run.js";
import type { EvalCaseResult } from "../types.js";
import { EvalStore } from "./store.js";
import type { Run, RunItem } from "./types.js";


export type Executor = (item: RunItem, onText: (text: string) => void, signal: AbortSignal) => Promise<EvalCaseResult>;
export function makeExecutor(store: EvalStore): Executor {
	return async (item, onText, signal) => runIsolated({
		definition: item.snapshot.definition, defaults: item.snapshot.defaults, verifierSnapshots: item.verifierSnapshots ?? [],
		directory: path.join(store.directory, "runs", item.runId, item.id), itemId: item.id, signal, onText,
		onWorkspace: workspace => { item.workspace = workspace; store.put("item", item.id, item); },
		onPhase: phase => { item.phase = phase; store.put("item", item.id, item); },
	});
}
export class EvalQueue {
	private draining = false;
	private controllers = new Map<string, AbortController>();
	constructor(readonly store: EvalStore, private execute: Executor = makeExecutor(store)) {}
	kick() { if (!this.draining) void this.drain().catch(error => { console.error("Evaluation queue:", error); }); }
	cancel(runId: string) {
		const run = this.store.require<Run>("run", runId);
		if (!["queued", "running"].includes(run.status)) return;
		run.status = "cancelled"; this.store.put("run", runId, run); this.controllers.get(runId)?.abort();
		for (const item of this.store.items(runId)) if (item.status === "queued") { item.status = "cancelled"; item.endedAt = new Date().toISOString(); this.store.put("item", item.id, item); }
		if (!this.controllers.has(runId)) { run.endedAt = new Date().toISOString(); this.store.put("run", runId, run); }
	}
	async idle() { while (this.draining) await new Promise(resolve => setTimeout(resolve, 10)); }
	private async drain() {
		this.draining = true;
		try {
			while (true) {
				const run = this.store.list<Run>("run").find(r => r.status === "queued"); if (!run) break;
				run.status = "running"; this.store.put("run", run.id, run);
				const controller = new AbortController(); this.controllers.set(run.id, controller);
				const items = this.store.items(run.id);
				// Finish the whole batch before starting the next repetition.
				for (let round = 1; round <= (run.repeatCount ?? 1) && !controller.signal.aborted; round++) {
					const pending = items.filter(item => (item.round ?? 1) === round && item.status === "queued"); let next = 0;
					await Promise.all(Array.from({ length: Math.min(run.concurrency, pending.length) }, async () => {
						while (!controller.signal.aborted) {
							const item = pending[next++]; if (!item) break;
							item.status = "running"; item.startedAt = new Date().toISOString(); this.store.put("item", item.id, item);
							try {
								const result = await this.execute(item, text => { item.text = (item.text + text).slice(-200000); this.store.put("item", item.id, item); }, controller.signal);
								item.result = result; item.status = controller.signal.aborted ? "cancelled" : result.status;
							} catch (error) { item.status = controller.signal.aborted ? "cancelled" : "error"; item.error = error instanceof Error ? error.message : String(error); }
							item.endedAt = new Date().toISOString(); this.store.put("item", item.id, item);
						}
					}));
				}
				run.status = controller.signal.aborted ? "cancelled" : "completed"; run.endedAt = new Date().toISOString(); this.store.put("run", run.id, run); this.controllers.delete(run.id);
			}
		} finally { this.draining = false; }
	}
}
