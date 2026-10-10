import { randomUUID } from "node:crypto";
import path from "node:path";
import { materializeVerifiers, verifyProcess } from "../grading/verifiers.js";
import { preparePythonUpload } from "../grading/python-runtime.js";
import type { UploadedVerifier } from "../grading/uploaded-verifiers.js";
import { frozenValidationInput, historicalEvidence } from "../grading/validation-context.js";
import type { EvidenceManifest, RuleResult, Rule } from "../grading/types.js";
import type { RunItem } from "./types.js";
import { EvalStore } from "./store.js";

export type VerifierTest = { id: string; runId: string; itemId: string; status: "queued" | "running" | "completed" | "cancelled" | "error"; createdAt: string; endedAt?: string; verifierId: string; result?: Partial<RuleResult>; error?: string; evidence: EvidenceManifest };
export class VerifierTests {
	private controllers = new Map<string, AbortController>();
	private tasks = new Map<string, Promise<void>>();
	private preparing = 0;
	constructor(private store: EvalStore) {
		for (const task of store.list<VerifierTest>("verifier-test")) if (["queued", "running"].includes(task.status)) { task.status = "error"; task.error = "服务重启，试验证已中断"; task.endedAt = new Date().toISOString(); store.put("verifier-test", task.id, task); }
	}
	get(id: string, runId: string, itemId: string) { const task = this.store.get<VerifierTest>("verifier-test", id); return task?.runId === runId && task.itemId === itemId ? task : undefined; }
	async create(item: RunItem, uploaded: UploadedVerifier, rule: Extract<Rule, { kind: "script" }>) {
		if (["queued", "running"].includes(item.status)) throw new Error("请选择已结束的历史执行进行试验证");
		if (this.tasks.size + this.preparing >= 4) throw new Error("试验证任务较多，请稍后重试");
		if (uploaded.extension !== ".py") throw new Error("历史试验证请使用 Python verify(ctx) 脚本");
		this.preparing++;
		try {
		const directory = path.join(this.store.directory, "runs", item.runId, item.id);
		const evidence = await historicalEvidence(directory, item);
		await frozenValidationInput(directory, evidence);
		const verifier = await preparePythonUpload(uploaded);
		const task: VerifierTest = { id: randomUUID(), runId: item.runId, itemId: item.id, verifierId: uploaded.id, status: "queued", createdAt: new Date().toISOString(), evidence: structuredClone(evidence) };
		const controller = new AbortController(); this.controllers.set(task.id, controller); this.store.put("verifier-test", task.id, task);
		const work = (async () => {
			try {
				task.status = "running"; this.store.put("verifier-test", task.id, task);
				const testDirectory = path.join(directory, "verifier-tests", task.id);
				const [executable] = await materializeVerifiers([verifier], testDirectory);
				task.result = await verifyProcess(rule, executable, { directory, gradeDirectory: path.join(testDirectory, "grading"), execution: item.result, evidence: task.evidence, timeoutMs: 60000, signal: controller.signal, secrets: [process.env[item.snapshot.defaults.apiKeyEnv ?? ""] ?? ""] });
				task.status = controller.signal.aborted ? "cancelled" : "completed";
			} catch (error) { task.status = controller.signal.aborted ? "cancelled" : "error"; task.error = error instanceof Error ? error.message : String(error); }
			finally { task.endedAt = new Date().toISOString(); this.store.put("verifier-test", task.id, task); this.controllers.delete(task.id); this.tasks.delete(task.id); }
		})();
		this.tasks.set(task.id, work); return { ...task, status: "queued" as const };
		} finally { this.preparing--; }
	}
	cancel(id: string) { this.controllers.get(id)?.abort(); }
	async close() { for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled(this.tasks.values()); }
}
