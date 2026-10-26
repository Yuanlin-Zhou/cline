/** SPEC-026 repeatable, isolated benchmark. No model calls or user data. */
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir, cpus, totalmem, platform } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEvalServer } from "../src/web/server.js";
import { parseEvalSuite } from "../src/schema.js";
import type { Run, RunItem, SavedCase } from "../src/web/types.js";

const args = process.argv.slice(2),
	arg = (name: string, fallback: string) =>
		args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1) ??
		fallback;
const samples = Number(arg("--samples", "30")),
	output = path.resolve(arg("--output", "performance-results.json"));
if (!Number.isInteger(samples) || samples < 1)
	throw Error("samples must be positive");
const directory = await mkdtemp(
	path.join(tmpdir(), "eval-performance-benchmark-"),
);
const app = await createEvalServer({
	directory,
	port: 0,
	storage: "sqlite",
	execute: async () => {
		throw Error("Benchmark must not invoke an executor");
	},
});
app.queue.kick = () => {};
const store = app.store,
	origin = `http://127.0.0.1:${app.server.port}`,
	module = store.activeModules()[0];
const defaults = parseEvalSuite({
	defaults: {
		providerId: "openai-compatible",
		modelId: "benchmark",
		baseUrl: "http://127.0.0.1:1/v1",
	},
	cases: [{ id: "x", prompt: "x" }],
}).defaults;
const cases: SavedCase[] = [];
const percentile = (values: number[], p: number) =>
	[...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const results: any[] = [];
async function measure(
	label: string,
	route: string,
	init?: () => RequestInit,
	after?: (body: any) => void,
) {
	const values: number[] = [],
		bytes: number[] = [];
	for (let i = 0; i < samples + 1; i++) {
		const start = performance.now(),
			res = await fetch(origin + route, init?.()),
			text = await res.text();
		if (!res.ok) throw Error(`${route}: ${res.status} ${text}`);
		const body = JSON.parse(text),
			ms = performance.now() - start;
		if (i) {
			values.push(ms);
			bytes.push(Buffer.byteLength(text));
		}
		after?.(body);
	}
	const result = {
		label,
		samples,
		p50Ms: percentile(values, 0.5),
		p95Ms: percentile(values, 0.95),
		maxBytes: Math.max(...bytes),
	};
	results.push(result);
	console.log(JSON.stringify(result));
	return result;
}
const post = (body: unknown) => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
const removeRun = (id: string) =>
	store.db.transaction(() => {
		const ids = (
			store.db
				.query("SELECT item_id FROM run_item_summaries WHERE run_id=?")
				.all(id) as { item_id: string }[]
		).map((r) => r.item_id);
		for (const item of ids)
			store.db
				.query("DELETE FROM records WHERE kind='item' AND id=?")
				.run(item);
		for (const table of [
			"run_item_summaries",
			"run_item_state",
			"run_revisions",
		])
			store.db.query(`DELETE FROM ${table} WHERE run_id=?`).run(id);
		store.db.query("DELETE FROM records WHERE kind='run' AND id=?").run(id);
	})();
let count = 0,
	target = "";
function seedBatch(allFailed = false) {
	const id = randomUUID(),
		run: Run = {
			id,
			name: `History ${count++}`,
			createdAt: new Date().toISOString(),
			status: "completed",
			concurrency: 1,
			repeatCount: 1,
		};
	store.db.transaction(() => {
		store.put("run", id, run);
		for (const [index, c] of cases.entries()) {
			const status = allFailed
				? "failed"
				: (["passed", "failed", "error", "inconclusive", "cancelled"] as const)[
						index % 5
					];
			const item: RunItem = {
				id: randomUUID(),
				runId: id,
				round: 1,
				snapshot: c,
				moduleName: module.name,
				status,
				text: "",
				endedAt: new Date().toISOString(),
				result: {
					id: c.definition.id,
					status: status === "cancelled" ? "error" : status,
					text:
						index % 10 === 0 ? "large output ".repeat(5000) : `output ${index}`,
					durationMs: 10,
					iterations: 1,
					usage: {
						inputTokens: 10,
						outputTokens: 2,
						totalCost: index % 7 ? 0.001 : undefined,
					},
					assertions: [],
					toolCalls: [],
					execution: {
						status:
							status === "error"
								? "error"
								: status === "cancelled"
									? "cancelled"
									: "completed",
					},
				},
			};
			store.put("item", item.id, item);
		}
	})();
	return id;
}
try {
	store.db.transaction(() => {
		for (let i = 0; i < 200; i++) {
			const length = (10 + Math.round((190 * i) / 199)) * 1024;
			const text = Array.from(
				{ length: Math.ceil(length / 80) },
				(_, n) =>
					`record ${i} step ${n}: value=${(i * 7919 + n * 104729) % 999983}; task context and expected observations.\n`,
			)
				.join("")
				.slice(0, length);
			const mode = i % 3 === 2 ? "function-call" : "single-turn";
			const definition = parseEvalSuite({
				defaults,
				cases: [
					{
						id: `perf-${i}`,
						description: "performance fixture",
						replayMode: mode,
						prompt: i % 3 === 0 ? text : "Evaluate the saved context.",
						history: i % 3 === 1 ? [{ role: "user", content: text }] : [],
						...(mode === "function-call"
							? {
									functionCall: {
										tools: ["read_files"],
										history: [{ role: "user", content: text }],
									},
								}
							: {}),
					},
				],
			}).cases[0];
			const c: SavedCase = {
				id: randomUUID(),
				moduleId: module.id,
				revision: 1,
				updatedAt: new Date().toISOString(),
				defaults,
				definition,
			};
			store.put("case", c.id, c);
			cases.push(c);
		}
	})();
	target = seedBatch(true);
	for (const history of [0, 5, 25]) {
		while (count < history + 1) seedBatch();
		const forbidden = store.items.bind(store);
		store.items = () => {
			throw Error("Metadata path loaded bodies");
		};
		await measure(`history=${history}:cases`, "/api/cases?view=summary");
		const overview = (await (
			await fetch(`${origin}/api/runs/${target}/overview`)
		).json()) as any;
		await measure(
			`history=${history}:overview`,
			`/api/runs/${target}/overview`,
		);
		await measure(
			`history=${history}:unchanged`,
			`/api/runs/${target}/changes?cursor=${encodeURIComponent(overview.cursor)}`,
		);
		await measure(
			`history=${history}:retry-preview`,
			`/api/runs/${target}/retry-preview`,
		);
		store.items = forbidden;
		await measure(
			`history=${history}:start-200`,
			"/api/runs",
			() => post({ caseIds: cases.map((c) => c.id), name: "benchmark start" }),
			(body) => removeRun(body.id),
		);
		// Retry a fresh completed source each time; remove only benchmark-generated attempts after timing.
		await measure(
			`history=${history}:retry`,
			`/api/runs/${target}/retry`,
			() =>
				post({
					requestId: randomUUID(),
					expectedRetryRevision:
						store.require<Run>("run", target).retryRevision ?? 0,
					statuses: ["failed", "error", "inconclusive", "cancelled"],
				}),
			(body) => {
				store.db.transaction(() => {
					for (const id of body.itemIds) {
						store.db
							.query("DELETE FROM records WHERE kind='item' AND id=?")
							.run(id);
						store.db
							.query("DELETE FROM run_item_summaries WHERE item_id=?")
							.run(id);
						store.db
							.query("DELETE FROM run_item_state WHERE item_id=?")
							.run(id);
					}
					store.put("run", target, { ...body.run, status: "completed" });
				})();
			},
		);
	}
	const bytes = await stat(path.join(directory, "eval.sqlite"));
	const report = {
		seed: "deterministic arithmetic fixture v1",
		environment: {
			bun: Bun.version,
			node: process.version,
			platform: platform(),
			cpu: cpus()[0]?.model,
			cpuCount: cpus().length,
			memoryBytes: totalmem(),
		},
		samples,
		caseCount: cases.length,
		caseBytes: cases.reduce(
			(n, c) => n + Buffer.byteLength(JSON.stringify(c)),
			0,
		),
		databaseBytes: bytes.size,
		walBytes: await stat(path.join(directory, "eval.sqlite-wal"))
			.then((s) => s.size)
			.catch(() => 0),
		results,
	};
	await writeFile(output, JSON.stringify(report, null, 2));
	console.log(`Report: ${output}`);
} finally {
	await app.close();
	await rm(directory, { recursive: true, force: true });
}
