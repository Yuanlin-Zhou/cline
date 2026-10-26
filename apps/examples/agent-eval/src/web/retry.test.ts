import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvalStore } from "./store.js";
import { EvalQueue } from "./queue.js";
import { summarize, latestAttempts, type RunItem } from "./types.js";
import type { EvalCaseResult } from "../types.js";
import { buildRepeatReport, repeatReportMarkdown } from "./repeat-report.js";
import { createEvalServer } from "./server.js";
const result = (
	item: RunItem,
	status: EvalCaseResult["status"],
): EvalCaseResult => ({
	id: item.snapshot.definition.id,
	sessionId: item.id,
	text: status,
	status,
	durationMs: 10,
	iterations: 1,
	usage: { inputTokens: 2, outputTokens: 3, totalCost: 0.01 },
	toolCalls: [],
	assertions: [],
});
async function fixture(run: (store: EvalStore) => Promise<void>) {
	const dir = await mkdtemp(path.join(tmpdir(), "retry-test-"));
	const store = new EvalStore(dir);
	try {
		await run(store);
	} finally {
		store.db.close();
		await rm(dir, { recursive: true, force: true });
	}
}
test("reason selection retries only latest matching rounds, freezes inputs, keeps attempts and cumulative costs", async () =>
	fixture(async (store) => {
		const m = store.activeModules()[0];
		const cases = ["failed", "inconclusive", "passed", "error"].map((id) =>
			store.createCase(m.id, store.settings(), {
				id,
				prompt: "original",
				history: [],
			}),
		);
		const run = store.createRun({
			caseIds: cases.map((c) => c.id),
			repeatCount: 2,
			concurrency: 2,
		});
		const queue = new EvalQueue(store, async (item) =>
			result(
				item,
				item.attempt
					? "passed"
					: (item.snapshot.definition.id as EvalCaseResult["status"]),
			),
		);
		queue.kick();
		await queue.idle();
		const first = structuredClone(store.items(run.id));
		store.deleteCase(cases[1].id);
		const retry = store.retryRun(run.id, {
			requestId: "reason-one",
			expectedRetryRevision: 0,
			statuses: ["inconclusive"],
		});
		expect(retry.itemIds).toHaveLength(2);
		expect(store.list("run")).toHaveLength(1);
		expect(() =>
			store.retryRun(run.id, {
				requestId: "competing",
				expectedRetryRevision: 0,
				statuses: ["failed"],
			}),
		).toThrow();
		queue.kick();
		await queue.idle();
		expect(store.items(run.id).slice(0, 8)).toEqual(first);
		expect(latestAttempts(store.items(run.id))).toHaveLength(8);
		expect(summarize(store.items(run.id))).toMatchObject({
			total: 8,
			passed: 4,
			failed: 2,
			error: 2,
			inconclusive: 0,
			tokens: 50,
			retryCount: 2,
			durationMs: 100,
		});
		const report = buildRepeatReport(store.detail(run.id));
		expect(report.retryCount).toBe(2);
		expect(report.firstSummary.inconclusive).toBe(2);
		expect(report.completedRounds).toBe(2);
		expect(
			report.cases.find((c) => c.name === "inconclusive")?.allRoundsPassed,
		).toBe(true);
		expect(repeatReportMarkdown(store.detail(run.id))).toContain(
			"执行尝试历史",
		);
		const twice = store.retryRun(run.id, {
			requestId: "reason-two",
			expectedRetryRevision: 1,
			statuses: ["failed", "error"],
		});
		expect(twice.itemIds).toHaveLength(4);
		queue.kick();
		await queue.idle();
		expect(summarize(store.items(run.id))).toMatchObject({
			passed: 8,
			total: 8,
			retryCount: 6,
		});
		expect(() =>
			store.retryRun(run.id, {
				requestId: "no-match",
				expectedRetryRevision: 2,
				statuses: ["inconclusive"],
			}),
		).toThrow("最新执行");
	}));
test("idempotent delivery, invalid reasons, stale selections, and transactional rollback", async () =>
	fixture(async (store) => {
		const c = store.createCase(store.activeModules()[0].id, store.settings(), {
			id: "x",
			prompt: "x",
			history: [],
		});
		const run = store.createRun({ caseIds: [c.id] });
		const queue = new EvalQueue(store, async (item) => result(item, "failed"));
		queue.kick();
		await queue.idle();
		const item = store.items(run.id)[0];
		for (const statuses of [
			[],
			["passed"],
			["failed", "failed"],
			["bogus"],
			"failed",
		])
			expect(() =>
				store.retryRun(run.id, {
					requestId: "bad",
					expectedRetryRevision: 0,
					statuses,
				}),
			).toThrow();
		expect(() =>
			store.retryRun(run.id, {
				requestId: "mismatch",
				expectedRetryRevision: 0,
				itemIds: [item.id],
				statuses: ["inconclusive"],
			}),
		).toThrow();
		store.db.exec(
			`CREATE TRIGGER reject_retry BEFORE INSERT ON records WHEN NEW.kind='retry' BEGIN SELECT RAISE(ABORT,'rollback'); END;`,
		);
		const body = {
			requestId: "same",
			expectedRetryRevision: 0,
			itemIds: [item.id],
			statuses: ["failed"],
		};
		expect(() => store.retryRun(run.id, body)).toThrow("rollback");
		expect(store.items(run.id)).toHaveLength(1);
		expect(store.detail(run.id).status).toBe("completed");
		store.db.exec("DROP TRIGGER reject_retry");
		const response = store.retryRun(run.id, body);
		expect(store.retryRun(run.id, body)).toEqual(response);
		expect(() =>
			store.retryRun(run.id, { ...body, statuses: ["error"] }),
		).toThrow("标识");
		queue.kick();
		await queue.idle();
		expect(store.retryRun(run.id, body)).toEqual(response);
		expect(() =>
			store.retryRun(run.id, {
				requestId: "stale",
				expectedRetryRevision: 1,
				itemIds: [item.id],
			}),
		).toThrow();
		const current = latestAttempts(store.items(run.id))[0];
		const next = store.retryRun(run.id, {
			requestId: "next",
			expectedRetryRevision: 1,
			itemIds: [current.id],
		});
		expect(store.items(run.id).at(-1)).toMatchObject({
			attempt: 2,
			rootItemId: item.id,
			previousItemId: current.id,
		});
		queue.cancel(run.id);
		expect(store.items(run.id).at(-1)?.status).toBe("cancelled");
		expect(next.itemIds).toHaveLength(1);
	}));
test("HTTP retry and export retain one run and reason filtered attempts", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "retry-http-"));
	const app = await createEvalServer({
		directory: dir,
		port: 0,
		execute: async (item) =>
			result(item, item.attempt ? "passed" : "inconclusive"),
	});
	try {
		const c = app.store.createCase(
			app.store.activeModules()[0].id,
			app.store.settings(),
			{ id: "x", prompt: "x", history: [] },
		);
		const run = app.store.createRun({ caseIds: [c.id] });
		app.queue.kick();
		await app.queue.idle();
		const base = `http://127.0.0.1:${app.server.port}`;
		const response = await fetch(`${base}/api/runs/${run.id}/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: "http",
				expectedRetryRevision: 0,
				statuses: ["inconclusive"],
			}),
		});
		expect(response.status).toBe(202);
		await app.queue.idle();
		const detail = await (await fetch(`${base}/api/runs/${run.id}`)).json();
		expect(detail.summary).toMatchObject({
			passed: 1,
			total: 1,
			retryCount: 1,
		});
		expect(detail.items).toHaveLength(2);
		expect(detail.latestItemIds).toHaveLength(1);
		expect(
			await (
				await fetch(`${base}/api/runs/${run.id}/export?format=csv`)
			).text(),
		).toContain('"root_item_id","attempt","previous_item_id","is_latest"');
		const state = await (await fetch(`${base}/api/state`)).json();
		expect(state.runs).toHaveLength(1);
		expect(state.latest[c.id].status).toBe("passed");
	} finally {
		await app.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("restart interrupts only the pending retry and permits another attempt from the original snapshot", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "retry-restart-"));
	let store = new EvalStore(dir);
	try {
		const c = store.createCase(store.activeModules()[0].id, store.settings(), {
			id: "x",
			prompt: "original",
			history: [],
		});
		const run = store.createRun({ caseIds: [c.id] });
		const queue = new EvalQueue(store, async (item) => result(item, "failed"));
		queue.kick();
		await queue.idle();
		const first = structuredClone(store.items(run.id)[0]);
		store.retryRun(run.id, {
			requestId: "before",
			expectedRetryRevision: 0,
			statuses: ["failed"],
		});
		store.db.close();
		store = new EvalStore(dir);
		expect(store.items(run.id)[0]).toEqual(first);
		expect(store.detail(run.id).status).toBe("interrupted");
		expect(store.items(run.id)[1]).toMatchObject({
			attempt: 1,
			status: "error",
			interrupted: true,
		});
		store.retryRun(run.id, {
			requestId: "after",
			expectedRetryRevision: 1,
			statuses: ["error"],
		});
		expect(store.items(run.id)[2]).toMatchObject({
			attempt: 2,
			rootItemId: first.id,
			snapshot: first.snapshot,
		});
	} finally {
		store.db.close();
		await rm(dir, { recursive: true, force: true });
	}
});
