import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvalServer } from "./server.js";
import { EvalStore } from "./store.js";
import type { RunItem } from "./types.js";
import type { EvalCaseResult } from "../types.js";
import { parseUpload, validateUploaded, SqliteVerifiers, type VerifierRepository } from "../grading/uploaded-verifiers.js";
import { materializeVerifiers, resolveVerifiers } from "../grading/verifiers.js";
import { gradeCase } from "../grading/engine.js";
import { manifest, snapshot } from "../grading/evidence.js";
import { replyTemplate, artifactTemplate } from "../grading/verifier-guide.js";
import { loadCliVerifierSnapshots } from "../grading/verifier-source.js";

let directory: string;
let app: Awaited<ReturnType<typeof createEvalServer>> | undefined;
beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), "eval-upload-test-")); });
afterEach(async () => { await app?.close(); app = undefined; rmSync(directory, { recursive: true, force: true }); });
const execution = (text: string): EvalCaseResult => ({ id: "case", sessionId: "session", text, execution: { status: "completed" }, status: "passed", durationMs: 1, iterations: 1, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], assertions: [] });
async function grade(item: RunItem, text = "已完成") {
	const destination = path.join(directory, "runs", item.runId, item.id); await mkdir(destination, { recursive: true });
	const resolved = await resolveVerifiers(item.snapshot.definition, undefined, item.verifierSnapshots ?? []);
	const result = execution(text);
	result.grading = await gradeCase({ definition: item.snapshot.definition, result, directory: destination, evidence: manifest(), events: [], verifiers: [...resolved.configured, ...await materializeVerifiers(resolved.uploaded, destination)] });
	result.status = result.grading.verdict; return result;
}
async function request(route: string, body?: unknown, origin?: string) {
	const response = await fetch(`http://127.0.0.1:${app!.server.port}${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: response.status, value: await response.json() };
}

test("upload validates filenames, UTF-8 size and content without executing it", () => {
	for (const input of [{ filename: "../x.mjs", content: "x" }, { filename: "x.py", content: "x" }, { filename: "x.ts", content: " " }, { filename: "x.ts", content: "\ud800" }, { filename: "x.ts", content: "a", command: "sh" }]) expect(() => parseUpload(input)).toThrow();
	expect(() => parseUpload({ filename: "x.ts", content: "汉".repeat(400000) })).toThrow("1 MiB");
	const value = parseUpload({ filename: "x.ts", content: "throw new Error('not run at upload')" });
	expect(validateUploaded(value)).toEqual(value);
	expect(() => validateUploaded({ ...value, content: "changed" })).toThrow("摘要");
});

test("HTTP upload is immediately selectable, frozen across rounds, restart and offline rerun", async () => {
	app = await createEvalServer({ directory, port: 0, execute: item => grade(item) });
	const upload = await request("/api/verifiers", { filename: "verify-reply.mjs", content: replyTemplate });
	expect(upload.status).toBe(201); expect(upload.value.content).toBeUndefined();
	const duplicate = await request("/api/verifiers", { filename: "verify-reply.mjs", content: replyTemplate });
	expect(duplicate.value.id).not.toBe(upload.value.id);
	expect((await request("/api/verifiers")).value.verifiers.map((v: {id: string}) => v.id)).toContain(upload.value.id);
	const state = (await request("/api/state")).value;
	const created = await request("/api/cases", { moduleId: state.modules[0].id, definition: { id: "case", prompt: "task", history: [], replayMode: "full-task", grading: { version: 1, rules: [{ id: "accept", kind: "script", verifierId: upload.value.id }] } } });
	expect(created.status).toBe(201);
	const run = await request("/api/runs", { caseIds: [created.value.id], repeatCount: 2 }); expect(run.status).toBe(202);
	await app.queue.idle();
	const detail = app.store.detail(run.value.id);
	expect(detail.items.map(i => i.status)).toEqual(["passed", "passed"]);
	expect(detail.items[0].verifierSnapshots?.[0].content).toBe(replyTemplate);
	expect(detail.items[1].result?.grading?.ruleHash).toBe(detail.items[0].result?.grading?.ruleHash);
	await app.close(); app = undefined;
	app = await createEvalServer({ directory, port: 0, execute: item => grade(item) });
	expect((await request("/api/verifiers")).value.verifiers).toHaveLength(2);
	await app.close(); app = undefined;
	const unavailable: VerifierRepository = { async list() { throw new Error("offline"); }, async get() { throw new Error("offline"); }, async create() { throw new Error("offline"); } };
	app = await createEvalServer({ directory, port: 0, verifierRepository: unavailable, execute: item => grade(item) });
	const rerun = await request("/api/runs", { parentRunId: run.value.id, rerunScope: "all" }); expect(rerun.status).toBe(202); await app.queue.idle();
	expect(app.store.items(rerun.value.id)[0].status).toBe("passed");
	expect((await request(`/api/runs/${run.value.id}`)).status).toBe(200);
	expect((await request("/api/verifiers", { filename: "x.mjs", content: replyTemplate }, "https://untrusted.example")).status).toBe(403);
});

test("actual templates verify replies and artifact snapshots; protocol faults remain errors", async () => {
	for (const [source, text, total, status] of [[replyTemplate, "已完成", 12, "pass"], [replyTemplate, "失败", 12, "fail"], [artifactTemplate, "已完成", 12, "pass"], [artifactTemplate, "已完成", 13, "fail"], [artifactTemplate, "已完成", undefined, "fail"], ['console.log("not JSON")', "已完成", 12, "error"], ['throw new Error("broken verifier")', "已完成", 12, "error"]] as const) {
		const id = crypto.randomUUID(); const dest = path.join(directory, id); const workspace = path.join(dest, "fixture"); await mkdir(workspace, { recursive: true });
		if (total !== undefined) await writeFile(path.join(workspace, "summary.json"), JSON.stringify({ total }));
		const evidence = manifest(); await snapshot(workspace, dest, "artifacts", evidence, []);
		const uploaded = parseUpload({ filename: "verify.mjs", content: source });
		const definition = { id: "case", prompt: "task", history: [], replayMode: "full-task" as const, grading: { version: 1 as const, rules: [{ id: "accept", kind: "script" as const, verifierId: uploaded.id }] } };
		const result = await gradeCase({ definition, result: execution(text), directory: dest, evidence, events: [], verifiers: await materializeVerifiers([uploaded], dest) });
		expect(result.results[0].status).toBe(status);
	}
});

test("CLI reads the SQLite script library without changing queued history", async () => {
	const store = new EvalStore(directory); const value = await new SqliteVerifiers(store).create({ filename: "verify.mjs", content: replyTemplate });
	const c = store.createCase(store.activeModules()[0].id, store.settings(), { id: "case", prompt: "task", history: [], replayMode: "full-task", grading: { version: 1, rules: [{ id: "accept", kind: "script", verifierId: value.id }] } });
	const run = store.createRun({ caseIds: [c.id] });
	try { expect(await loadCliVerifierSnapshots(c.definition, directory)).toEqual([value]); expect(store.require<{status: string}>("run", run.id).status).toBe("queued"); } finally { store.db.close(); }
});

test("configured verifier registry reloads without restarting the server", async () => {
	const previous = process.env.EVAL_VERIFIERS_FILE;
	const file = path.join(directory, "registry.json"); const script = path.join(directory, "configured.mjs");
	await writeFile(script, replyTemplate); await writeFile(file, "[]"); process.env.EVAL_VERIFIERS_FILE = file;
	try {
		app = await createEvalServer({ storage: "sqlite", directory, port: 0, execute: item => grade(item) });
		expect((await request("/api/verifiers")).value.verifiers).toHaveLength(0);
		await writeFile(file, JSON.stringify([{ id: "hot", label: "Hot", version: "1", command: "{runtime}", args: [script], files: [script] }]));
		expect((await request("/api/verifiers")).value.verifiers[0].id).toBe("hot");
		const c = app.store.createCase(app.store.activeModules()[0].id, app.store.settings(), { id: "hot", prompt: "task", history: [], replayMode: "full-task", grading: { version: 1, rules: [{ id: "hot", kind: "script", verifierId: "hot" }] } });
		const run = await request("/api/runs", { caseIds: [c.id] }); expect(run.status).toBe(202); await app.queue.idle(); expect(app.store.items(run.value.id)[0].status).toBe("passed");
		await writeFile(file, "[]"); expect((await request("/api/runs", { caseIds: [c.id] })).status).toBe(400);
	} finally { if (previous === undefined) delete process.env.EVAL_VERIFIERS_FILE; else process.env.EVAL_VERIFIERS_FILE = previous; }
});

test("JS and TypeScript uploads execute with the same protocol; timeouts remain verifier faults", async () => {
	for (const filename of ["verify.js", "verify.ts", "timeout.mjs"]) {
		const dest = path.join(directory, filename); await mkdir(dest);
		const source = filename === "verify.ts" ? replyTemplate.replace("const expected =", "const expected: {executionStatus: string; contains: string} =") : filename === "timeout.mjs" ? "setInterval(() => {}, 1000)" : replyTemplate;
		const uploaded = parseUpload({ filename, content: source });
		const verifiers = await materializeVerifiers([uploaded], dest);
		if (filename === "timeout.mjs") verifiers[0].timeoutMs = 100;
		const result = await gradeCase({ definition: { id: "case", prompt: "task", history: [], grading: { version: 1, rules: [{ id: "script", kind: "script", verifierId: uploaded.id }] } }, result: execution("已完成"), directory: dest, evidence: manifest(), events: [], verifiers });
		expect(result.results[0].status).toBe(filename === "timeout.mjs" ? "error" : "pass");
		if (filename === "timeout.mjs") expect(result.results[0].message).toContain("超时");
	}
});
