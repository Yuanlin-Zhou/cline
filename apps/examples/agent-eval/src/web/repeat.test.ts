import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvalCaseResult } from "../types.js";
import { EvalQueue } from "./queue.js";
import { buildRepeatReport, repeatReportMarkdown } from "./repeat-report.js";
import { createEvalServer } from "./server.js";
import { EvalStore } from "./store.js";
import type { RunItem } from "./types.js";

let store: EvalStore;
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), "eval-repeat-test-")); store = new EvalStore(directory); });
afterEach(() => {
	store.db.close();
	if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("eval-repeat-test-")) rmSync(directory, { recursive: true, force: true });
});

function seed(id = "same-prompt", moduleId = store.activeModules()[0].id) {
	return store.createCase(moduleId, store.settings(), { id, prompt: "Which package manager?", history: [{ role: "user", content: "Use Bun" }], assertions: { contains: ["Bun"] } });
}
function result(item: RunItem, text = "Use Bun", status: EvalCaseResult["status"] = "passed"): EvalCaseResult {
	return { id: item.snapshot.definition.id, sessionId: item.id, text, status, durationMs: 10, iterations: 1, finishReason: "completed", usage: { inputTokens: 3, outputTokens: 2, totalCost: 0.01 }, toolCalls: [], assertions: [{ passed: status === "passed", message: "output contains Bun" }] };
}

describe("repeated batches", () => {
	test("validates repeat count atomically and keeps the default one round", () => {
		const c = seed();
		for (const repeatCount of [0, -1, 101, 1.5, NaN, "3", null] as number[]) expect(() => store.createRun({ caseIds: [c.id], repeatCount })).toThrow("重复轮数");
		expect(store.list("run")).toHaveLength(0);
		const run = store.createRun({ caseIds: [c.id] });
		expect(run.repeatCount).toBe(1); expect(store.items(run.id)).toHaveLength(1);
	});

	test("rounds keep identical snapshots, unique executions, concurrency and a round barrier", async () => {
		const a = seed("a"); const b = seed("b");
		const run = store.createRun({ caseIds: [a.id, b.id], repeatCount: 3, concurrency: 2 });
		a.definition.prompt = "changed after submission"; store.put("case", a.id, a);
		const finished: number[] = []; let active = 0; let peak = 0;
		const queue = new EvalQueue(store, async item => {
			if (item.round! > 1) expect(finished.filter(round => round === item.round! - 1)).toHaveLength(2);
			peak = Math.max(peak, ++active);
			expect(item.snapshot.definition.prompt).toBe("Which package manager?");
			await Bun.sleep(item.snapshot.definition.id === "a" ? 15 : 1);
			active--; finished.push(item.round!); return result(item);
		});
		queue.kick(); await queue.idle();
		const detail = store.detail(run.id);
		expect(detail.items.map(i => i.round)).toEqual([1, 1, 2, 2, 3, 3]);
		expect(new Set(detail.items.map(i => i.id)).size).toBe(6);
		expect(detail.items.every(i => i.status === "passed")).toBe(true); expect(peak).toBe(2);
		expect(buildRepeatReport(detail)).toMatchObject({ completedRounds: 3, allRoundsPassedCases: 2, outputChangedCases: 0, comparableCases: 2, partial: false, summary: { total: 6, tokens: 30, durationMs: 60 } });
	});

	test("cancellation stops future rounds and excludes them from judged/output rates", async () => {
		const c = seed(); const run = store.createRun({ caseIds: [c.id], repeatCount: 4 });
		let calls = 0;
		const queue = new EvalQueue(store, async item => { calls++; queue.cancel(run.id); return result(item); });
		queue.kick(); await queue.idle();
		const report = buildRepeatReport(store.detail(run.id));
		expect(calls).toBe(1);
		expect(report).toMatchObject({ partial: true, completedRounds: 0, passRate: null, comparableCases: 0, summary: { cancelled: 4 } });
		expect(report.cases[0].outputVariants).toBe(0);
	});

	test("reports flaky judgments, exact output groups and execution errors separately", async () => {
		const c = seed(); const run = store.createRun({ caseIds: [c.id], repeatCount: 4 });
		const queue = new EvalQueue(store, async item => {
			if (item.round === 4) throw new Error("provider unavailable");
			return result(item, item.round === 2 ? "Use npm" : item.round === 3 ? " Use Bun\r\n" : "Use Bun", item.round === 2 ? "failed" : "passed");
		});
		queue.kick(); await queue.idle();
		const detail = store.detail(run.id); const report = buildRepeatReport(detail);
		expect(report).toMatchObject({ passRate: 2 / 3, judgmentChangedCases: 1, outputChangedCases: 1, allRoundsPassedCases: 0, summary: { passed: 2, failed: 1, error: 1, cost: null } });
		expect(report.cases[0]).toMatchObject({ consistencyRate: 2 / 3, comparedOutputs: 3, outputVariants: 2, hasContentAssertions: true });
		expect(report.cases[0].variants[0].rounds).toEqual([1, 3]);
		expect(report.cases[0].rounds[1].failedAssertions).toEqual(["output contains Bun"]);
		const markdown = repeatReportMarkdown(detail);
		expect(markdown).toContain("provider unavailable"); expect(markdown).toContain("Use npm"); expect(markdown).toContain("输出差异不等于幻觉");
	});

	test("different outputs can pass, and equal case names across modules stay separate", async () => {
		const a = seed(); const b = seed("same-prompt", store.activeModules()[1].id);
		delete b.definition.assertions; store.put("case", b.id, b);
		const run = store.createRun({ caseIds: [a.id, b.id], repeatCount: 2 });
		const queue = new EvalQueue(store, async item => result(item, `Bun ${item.round}`)); queue.kick(); await queue.idle();
		expect(buildRepeatReport(store.detail(run.id))).toMatchObject({ caseCount: 2, outputChangedCases: 2, judgmentChangedCases: 0, allRoundsPassedCases: 2, withoutContentAssertions: 1 });
	});

	test("reruns deduplicate failed repetitions and reuse original snapshots for all-case repeats", async () => {
		const c = seed(); const run = store.createRun({ caseIds: [c.id], repeatCount: 3 });
		const queue = new EvalQueue(store, async item => result(item, "npm", "failed")); queue.kick(); await queue.idle();
		c.definition.prompt = "new prompt"; store.put("case", c.id, c);
		const failed = store.createRun({ parentRunId: run.id });
		expect(store.items(failed.id)).toHaveLength(1);
		const all = store.createRun({ parentRunId: run.id, rerunScope: "all", repeatCount: 2 });
		expect(store.items(all.id)).toHaveLength(2);
		expect(store.items(all.id).every(i => i.snapshot.definition.prompt === "Which package manager?")).toBe(true);
	});

	test("legacy runs get round-one reports and single output does not imply consistency", () => {
		const run = store.createRun({ caseIds: [seed().id] }); const item = store.items(run.id)[0];
		delete run.repeatCount; delete item.round;
		item.result = result(item); item.status = "passed"; run.status = "completed";
		const report = buildRepeatReport({ ...run, items: [item] });
		expect(report.repeatCount).toBe(1); expect(report.rounds[0].passed).toBe(1);
		expect(report.cases[0].consistencyRate).toBeNull();
	});

	test("restart preserves repetitions and reports interrupted pending work as partial", () => {
		const run = store.createRun({ caseIds: [seed().id], repeatCount: 3 });
		store.db.close(); store = new EvalStore(directory);
		expect(store.detail(run.id).status).toBe("interrupted");
		expect(store.items(run.id).map(i => i.round)).toEqual([1, 2, 3]);
		expect(buildRepeatReport(store.detail(run.id))).toMatchObject({ partial: true, completedRounds: 0, passRate: null, summary: { error: 3 } });
	});

	test("HTTP creation, report exports and round identifiers work end to end", async () => {
		const c = seed();
		const app = await createEvalServer({ directory, port: 0, execute: async item => result(item, item.round === 2 ? "Use npm" : "Use Bun", item.round === 2 ? "failed" : "passed") });
		const base = `http://127.0.0.1:${app.server.port}`;
		try {
			const post = (repeatCount: unknown) => fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseIds: [c.id], repeatCount }) });
			expect((await post("3")).status).toBe(400);
			const response = await post(3); expect(response.status).toBe(202); const run = await response.json() as { id: string };
			await app.queue.idle();
			const detail = await (await fetch(`${base}/api/runs/${run.id}`)).json() as { repeatReport: { judgmentChangedCases: number } };
			expect(detail.repeatReport.judgmentChangedCases).toBe(1);
			const md = await fetch(`${base}/api/runs/${run.id}/export?format=markdown`);
			expect(md.headers.get("content-disposition")).toContain("repeat-report.md"); expect(await md.text()).toContain("1 个案例 × 3 轮");
			const csv = await (await fetch(`${base}/api/runs/${run.id}/export?format=csv`)).text();
			expect(csv).toContain('"round"'); expect(csv).toContain("Use npm");
			const json = await (await fetch(`${base}/api/runs/${run.id}/export?format=json`)).json() as { items: RunItem[]; repeatReport: unknown };
			expect(json.items.map(i => i.round)).toEqual([1, 2, 3]); expect(json.repeatReport).toBeDefined();
			expect(csv).toContain('"session_id"');
			for (const item of json.items) expect(csv).toContain(item.result!.sessionId);
			const state = await (await fetch(`${base}/api/state`)).json() as { latest: Record<string, { sessionId?: string }> };
			expect(state.latest[c.id].sessionId).toBe(json.items[2].result!.sessionId);
			const history = await (await fetch(`${base}/api/cases/${c.id}/runs`)).json() as Array<{ items: Array<{ sessionId?: string }> }>;
			expect(history[0].items.map(i => i.sessionId)).toEqual(json.items.map(i => i.result!.sessionId));
		} finally { app.server.stop(true); await app.queue.idle(); app.store.db.close(); }
	});

	test("deleting a case preserves submitted executions, exports and snapshot reruns", async () => {
		const c = seed(); const other = seed("keep-me");
		const app = await createEvalServer({ directory, port: 0, execute: async item => result(item) });
		const base = `http://127.0.0.1:${app.server.port}`;
		try {
			const run = app.store.createRun({ caseIds: [c.id], repeatCount: 2 });
			const remove = () => fetch(`${base}/api/cases/${c.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" } });
			expect((await remove()).status).toBe(200);
			expect(app.store.get("case", c.id)).toBeUndefined();
			expect(app.store.activeCases().map(c => c.id)).toEqual([other.id]);
			expect((await remove()).status).toBe(404);
			expect(() => app.store.createRun({ caseIds: [c.id] })).toThrow("不存在");
			app.queue.kick(); await app.queue.idle();
			expect(app.store.detail(run.id).items.every(i => i.status === "passed")).toBe(true);
			const exported = await (await fetch(`${base}/api/runs/${run.id}/export`)).json() as { items: RunItem[] };
			expect(exported.items).toHaveLength(2);
			expect(exported.items[0].snapshot.definition.prompt).toBe(c.definition.prompt);
			const rerun = app.store.createRun({ parentRunId: run.id, rerunScope: "all" });
			expect(app.store.items(rerun.id)[0].snapshot).toEqual(exported.items[0].snapshot);
			app.queue.kick(); await app.queue.idle();
			expect(app.store.items(rerun.id)[0].status).toBe("passed");
			const replacement = app.store.createCase(c.moduleId, c.defaults, c.definition);
			const history = await (await fetch(`${base}/api/cases/${replacement.id}/runs`)).json();
			expect(history).toEqual([]);
			app.store.setArchived("case", other.id, true);
			app.store.deleteCase(other.id);
			expect(app.store.get("case", other.id)).toBeUndefined();
		} finally { app.server.stop(true); await app.queue.idle(); app.store.db.close(); }
	});
});
