import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createEvalServer } from "../web/server.js";
import { runProcess } from "./process.js";
import type { RunDetail, SavedCase } from "../web/types.js";

test("real SDK worker → fixed evidence → grading → HTTP/CLI exports, without external credentials", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "eval-grading-integration-"));
	const fixture = path.join(directory, "fixture"); await mkdir(fixture); await writeFile(path.join(fixture, "input.json"), '{"total":12}');
	const previousKey = process.env.CLINE_GRADING_TEST_KEY; process.env.CLINE_GRADING_TEST_KEY = "local-mock-credential";
	const requests: string[] = [];
	const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.text(); requests.push(body);
		if (body.includes("SLOW_GRADING")) await Bun.sleep(1500);
		return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Done"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
	} });
	const app = await createEvalServer({ directory: path.join(directory, "data"), port: 0 });
	const base = `http://127.0.0.1:${app.server.port}`;
	const post = async (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const defaults = { providerId: "openai-compatible", modelId: "gpt-4o-mini", baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKeyEnv: "CLINE_GRADING_TEST_KEY", cwd: fixture, tools: "none", maxIterations: 1, timeoutMs: 10000 };
	try {
		const moduleId = app.store.activeModules()[0].id;
		const preview = await post("/api/import/preview", { moduleId, format: "json", replayMode: "full-task", content: JSON.stringify({ cases: [{ id: "imported", prompt: "x", grading: { version: 1, rules: [{ id: "out", kind: "file.exists", path: "out.txt" }] } }] }) });
		expect(preview.status).toBe(200); expect((await preview.json() as any).suite.cases[0].grading.rules[0].id).toBe("out");
		const created = await post("/api/cases", { moduleId, defaults, definition: { id: "json-check", replayMode: "full-task", prompt: "Check fixture", grading: { version: 1, rules: [{ id: "json", kind: "file.json", path: "input.json", pointer: "/total", op: "equals", expected: 12 }, { id: "tool", kind: "tool.count", required: false, match: { name: "read_files", phase: "started" }, min: 1 }] } } });
		expect(created.status).toBe(201); const c = await created.json() as SavedCase;
		const started = await post("/api/runs", { caseIds: [c.id], repeatCount: 2 }); expect(started.status).toBe(202); const { id } = await started.json() as { id: string };
		await app.queue.idle();
		const run = await (await fetch(`${base}/api/runs/${id}`)).json() as RunDetail;
		expect(run.items.map(i => i.status)).toEqual(["passed", "passed"]);
		for (const item of run.items) {
			expect(item.result?.grading?.results.map(r => r.status)).toEqual(["pass", "insufficient"]);
			expect(item.result?.execution?.status).toBe("completed"); expect(item.result?.sessionId).toBeTruthy();
			const ref = item.result!.grading!.results[0].evidenceRefs[0];
			const evidence = await fetch(`${base}/api/runs/${id}/items/${item.id}/evidence/${ref}`); expect(evidence.status).toBe(200);
			expect((await fetch(`${base}/api/runs/${id}/items/${item.id}/evidence/unknown`)).status).toBe(404);
			expect((await fetch(`${base}/api/runs/${id}/items/${item.id}/grading`)).status).toBe(200);
		}
		const csv = await (await fetch(`${base}/api/runs/${id}/export?format=csv`)).text(); expect(csv).toContain('"grading_verdict"'); expect(csv).toContain('"task"');
		const updated = await fetch(`${base}/api/cases/${c.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: c.revision, defaults: c.defaults, definition: { ...c.definition, grading: { version: 1, rules: [{ id: "changed", kind: "file.exists", path: "other.txt" }] } } }) });
		expect(updated.status).toBe(200); expect(app.store.detail(id).items[0].snapshot.definition.grading?.rules[0].id).toBe("json");
		const denied = app.store.createCase(moduleId, c.defaults, { ...c.definition, id: "unsupported", grading: { version: 1, rules: [{ id: "tool", kind: "tool.count", match: { name: "read_files", phase: "started" }, min: 1 }] } });
		const requestCount = requests.length; expect((await post("/api/runs", { caseIds: [denied.id] })).status).toBe(400); expect(requests.length).toBe(requestCount);
		const missing = app.store.createCase(moduleId, c.defaults, { ...c.definition, id: "missing", grading: { version: 1, rules: [{ id: "output", kind: "file.exists", path: "never-created.txt" }] } });
		const badRun = await (await post("/api/runs", { caseIds: [missing.id] })).json() as { id: string }; await app.queue.idle(); expect(app.store.detail(badRun.id).items[0].status).toBe("failed");
		const inputPath = path.join(directory, "suite.json"); const outputPath = path.join(directory, "report.json");
		await writeFile(inputPath, JSON.stringify({ defaults, cases: [c.definition] }));
		const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
		const cliRuntime = process.env.EVAL_NODE_BINARY ?? process.execPath;
		const entry = process.env.EVAL_NODE_BINARY ? path.resolve(import.meta.dir, "../../dist/index.js") : path.resolve(import.meta.dir, "../index.ts");
		const cli = await runProcess(cliRuntime, [entry, inputPath, "--output", outputPath], { cwd: directory, env, timeoutMs: 20000 });
		expect(cli.code).toBe(0); const report = JSON.parse(await readFile(outputPath, "utf8")); expect(report.cases[0].grading.verdict).toBe("passed"); expect(cli.stderr).toContain("[workspace]");
		expect(await readFile(path.join(fixture, "input.json"), "utf8")).toBe('{"total":12}');
		const slow = app.store.createCase(moduleId, c.defaults, { ...c.definition, id: "slow", prompt: "SLOW_GRADING" });
		const slowRun = await (await post("/api/runs", { caseIds: [slow.id] })).json() as { id: string };
		let observed = false;
		for (let n = 0; n < 100; n++) {
			const item = app.store.detail(slowRun.id).items[0];
			try { observed = (await readFile(path.join(directory, "data", "runs", slowRun.id, item.id, "evidence/events.jsonl"), "utf8")).includes("session.started"); } catch {}
			if (observed) break; await Bun.sleep(20);
		}
		expect(observed).toBe(true); await post(`/api/runs/${slowRun.id}/cancel`, {}); await app.queue.idle();
		const cancelled = app.store.detail(slowRun.id).items[0]; expect(cancelled.status).toBe("cancelled"); expect(cancelled.result?.grading?.status).toBe("cancelled"); expect(cancelled.result?.evidence?.refs.length).toBeGreaterThan(0);
	} finally {
		await app.queue.idle(); app.server.stop(true); app.store.db.close(); mock.stop(true);
		if (previousKey === undefined) delete process.env.CLINE_GRADING_TEST_KEY; else process.env.CLINE_GRADING_TEST_KEY = previousKey;
		if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("eval-grading-integration-")) await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test.skipIf(process.env.EVAL_PROCESS_TREE_TEST !== "1")("Windows verifier timeout kills child process tree", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "eval-tree-test-"));
	try {
		const script = path.join(directory, "tree.ts"); const pidFile = path.join(directory, "pid.txt");
		await writeFile(script, 'import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true}); await Bun.write("pid.txt", String(child.pid)); console.log("spawned"); setInterval(()=>{},1000);');
		const output = await runProcess(process.execPath, [script], { cwd: directory, env: Object.fromEntries(Object.entries(process.env).filter((p): p is [string, string] => p[1] !== undefined)), timeoutMs: 500 });
		expect(output.timedOut).toBe(true); expect(output.cleanupError).toBeUndefined(); const pid = Number(await readFile(pidFile, "utf8")); expect(() => process.kill(pid, 0)).toThrow();
	} finally { if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("eval-tree-test-")) await rm(directory, { recursive: true, force: true }); }
}, 10000);
