import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvalServer } from "../src/web/server.js";

// Exercise the full web replay chain against a local loopback provider:
// HTTP server → store → queue → isolated workspace → worker → real SDK → mock
// provider → assertions → results → artifacts/export. No real credentials.
const dataDir = await mkdtemp(path.join(os.tmpdir(), "cline-eval-web-smoke-"));
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "cline-eval-fixture-"));
await writeFile(path.join(fixtureDir, "seed.txt"), "fixture-seed-content\n");

process.env.CLINE_EVAL_SMOKE_KEY = "local-mock-not-a-real-key";
process.env.CLINE_DATA_DIR = path.join(dataDir, "session");
process.env.CLINE_SANDBOX = "1";
process.env.CLINE_SANDBOX_DATA_DIR = path.join(dataDir, "session");
process.env.CLINE_LOG_ENABLED = "0";

const requests: string[] = [];
const mock = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const body = await request.text();
		requests.push(body);
		if (body.includes("SLOW_MARKER")) await new Promise((resolve) => setTimeout(resolve, 8000));
		const chunks = [
			{ choices: [{ index: 0, delta: { role: "assistant", content: "Use Bun" }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
		]
			.map((chunk) => `data: ${JSON.stringify({ id: "local-smoke", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", ...chunk })}\n\n`)
			.join("");
		return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
	},
});

const app = await createEvalServer({ directory: dataDir, port: 0 });
const base = `http://127.0.0.1:${app.server.port}`;

let failures = 0;
function check(ok: boolean, label: string): void {
	if (ok) console.log(`  ok  ${label}`);
	else { console.error(`  FAIL ${label}`); failures++; }
}

async function call(route: string, init?: RequestInit): Promise<{ status: number; data: any }> {
	const res = await fetch(base + route, init);
	const text = await res.text();
	let data: any = null;
	try { data = text ? JSON.parse(text) : null; } catch { data = null; }
	return { status: res.status, data };
}

const jsonInit = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function waitRun(id: string, timeoutMs = 60000): Promise<any> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const { data } = await call(`/api/runs/${id}`);
		if (["completed", "cancelled", "interrupted"].includes(data.status)) return data;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`run ${id} did not finish within ${timeoutMs}ms`);
}

try {
	console.log(`\nAgent Eval web smoke — server http://127.0.0.1:${app.server.port}\n`);

	// 1. Seeded state
	const state0 = await call("/api/state");
	check(state0.status === 200 && Array.isArray(state0.data.modules) && state0.data.modules.length >= 4, "seeded modules present in /api/state");

	// 2. Create a module
	const moduleResp = await call("/api/modules", jsonInit({ name: "smoke", description: "端到端冒烟测试" }));
	check(moduleResp.status === 201 && !!moduleResp.data.id, "create module");
	const moduleId = moduleResp.data.id;

	// 3. Import (preview then import) single-turn + full-task cases
	const singleSuite = {
		defaults: { providerId: "openai-compatible", modelId: "gpt-4o-mini", baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKeyEnv: "CLINE_EVAL_SMOKE_KEY", tools: "none", maxIterations: 2, timeoutMs: 15000 },
		cases: [
			{ id: "single-history", history: [{ role: "user", content: "Use Bun in this project" }, { role: "assistant", content: "Understood" }], prompt: "Which package manager?", assertions: { contains: ["Use Bun"] } },
		],
	};
	const fullSuite = {
		defaults: { providerId: "openai-compatible", modelId: "gpt-4o-mini", baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKeyEnv: "CLINE_EVAL_SMOKE_KEY", tools: "none", maxIterations: 2, timeoutMs: 15000, cwd: fixtureDir },
		cases: [
			{ id: "full-task-fixture", replayMode: "full-task", prompt: "Read the seed file and report its content.", assertions: { contains: ["Use Bun"] } },
		],
	};
	const preview = await call("/api/import/preview", jsonInit({ moduleId, content: JSON.stringify(singleSuite), format: "json", replayMode: "single-turn" }));
	check(preview.status === 200 && preview.data.cases?.length === 1 && preview.data.cases[0].id === "single-history", "import preview parses cases");

	const import1 = await call("/api/import", jsonInit({ moduleId, content: JSON.stringify(singleSuite), format: "json", replayMode: "single-turn", policy: "skip" }));
	check(import1.status === 200 && import1.data.created === 1, "import single-turn case");
	const import2 = await call("/api/import", jsonInit({ moduleId, content: JSON.stringify(fullSuite), format: "json", replayMode: "full-task", policy: "skip" }));
	check(import2.status === 200 && import2.data.created === 1, "import full-task case");

	// 4. Batch run over the module (both cases, concurrency 2)
	const runResp = await call("/api/runs", jsonInit({ moduleIds: [moduleId], name: "smoke-batch", concurrency: 2, repeatCount: 3 }));
	check(runResp.status === 202 && !!runResp.data.id, "create batch run");
	const runId = runResp.data.id;
	const run = await waitRun(runId);
	check(run.status === "completed", `batch run completes (status=${run.status})`);
	check(run.items?.length === 6, `batch has 2 cases × 3 rounds (${run.items?.length})`);
	check(new Set(run.items?.map((item: any) => item.result?.sessionId)).size === 6, "every repetition has an independent SDK session");
	check(new Set(run.items?.map((item: any) => item.workspace)).size === 6, "every repetition has an isolated workspace");
	check(run.repeatReport?.completedRounds === 3 && run.repeatReport?.allRoundsPassedCases === 2, "repeat report aggregates all three rounds");
	if (run.items) for (const item of run.items) {
		console.log(`    item ${item.snapshot.definition.id}: status=${item.status} error=${item.error ?? item.result?.error ?? ""} result=${item.result ? JSON.stringify(item.result).slice(0, 300) : "none"}`);
	}
	check(run.items?.every((item: any) => item.status === "passed") === true, "all items passed");
	check(run.items?.every((item: any) => item.result?.text === "Use Bun") === true, "result text reaches SDK output");
	check(run.items?.every((item: any) => (item.result?.usage.inputTokens ?? 0) > 0) === true, "usage tokens recorded");
	check(run.summary?.passed === 6 && run.summary?.failed === 0, "summary counts correct");

	// 5. Provider received seeded history + current prompt (real SDK → provider)
	check(requests.some((body) => body.includes("Use Bun in this project") && body.includes("Which package manager?")), "provider received seeded history + prompt");
	const singleRequests = requests.filter((body) => body.includes("Which package manager?"));
	check(singleRequests.length === 3, "single-turn makes exactly one provider request per repetition");
	check(singleRequests.every(body => JSON.stringify(JSON.parse(body).messages) === JSON.stringify(JSON.parse(singleRequests[0]).messages)), "repetitions send identical prompt/history messages");
	check(singleRequests.every((body) => !JSON.parse(body).tools?.length), "single-turn exposes no tools to the provider");

	// 6. Artifacts: full-task fixture file present and unchanged (isolated workspace copy)
	const fullTaskItem = run.items.find((item: any) => item.snapshot.definition.id === "full-task-fixture");
	check(!!fullTaskItem?.workspace, "full-task item has an isolated workspace");
	const artifactsResp = await call(`/api/runs/${runId}/artifacts?item=${fullTaskItem.id}`);
	check(artifactsResp.status === 200, "artifacts endpoint responds");
	const seed = artifactsResp.data.find((file: any) => file.path === "seed.txt");
	check(seed?.change === "unchanged", `fixture seed.txt copied and unchanged (change=${seed?.change})`);

	// 7. Exports
	const csvRes = await fetch(base + `/api/runs/${runId}/export?format=csv`);
	const csvText = await csvRes.text();
	check(csvRes.status === 200 && csvText.includes("smoke"), "CSV export includes rows");
	const exportJson = await call(`/api/runs/${runId}/export?format=json`);
	check(exportJson.status === 200 && exportJson.data.summary?.total === 6, "JSON export has summary");

	// 8. Draft run (unsaved case) via the detail-page path
	const draftResp = await call("/api/runs", jsonInit({
		name: "smoke-draft",
		concurrency: 1,
		replayMode: "single-turn",
		draft: [{
			moduleId,
			definition: { id: "draft-case", prompt: "Draft prompt", assertions: { contains: ["Use Bun"] } },
			defaults: { providerId: "openai-compatible", modelId: "gpt-4o-mini", baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKeyEnv: "CLINE_EVAL_SMOKE_KEY", tools: "none", maxIterations: 2, timeoutMs: 15000 },
		}],
	}));
	check(draftResp.status === 202, "draft run accepted");
	const draftRun = await waitRun(draftResp.data.id);
	check(draftRun.status === "completed" && draftRun.items?.[0]?.status === "passed" && draftRun.items[0].snapshot.revision === 0, "draft run passes with revision 0 (not persisted)");

	// 9. Rerun-failed: failing case → rerun parent → new run contains the failed item
	const failResp = await call("/api/cases", jsonInit({
		moduleId,
		definition: { id: "always-fails", prompt: "Answer anything", assertions: { notContains: ["Use Bun"] } },
		defaults: { providerId: "openai-compatible", modelId: "gpt-4o-mini", baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKeyEnv: "CLINE_EVAL_SMOKE_KEY", tools: "none", maxIterations: 2, timeoutMs: 15000 },
	}));
	check(failResp.status === 201, "create failing case");
	const failRun = await waitRun((await call("/api/runs", jsonInit({ caseIds: [failResp.data.id], name: "fail-run" }))).data.id);
	check(failRun.items?.[0]?.status === "failed", "failing case reports failed (assertion)");
	const rerun = await call("/api/runs", jsonInit({ parentRunId: failRun.id, name: "rerun-failed", concurrency: 1 }));
	check(rerun.status === 202 && rerun.data.parentRunId === failRun.id, "rerun-failed creates a child batch");

	// 10. Cancel a slow run
	const slowResp = await call("/api/cases", jsonInit({
		moduleId,
		definition: { id: "slow-case", prompt: "SLOW_MARKER please", assertions: { contains: ["Use Bun"] } },
		defaults: { providerId: "openai-compatible", modelId: "gpt-4o-mini", baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKeyEnv: "CLINE_EVAL_SMOKE_KEY", tools: "none", maxIterations: 1, timeoutMs: 30000 },
	}));
	check(slowResp.status === 201, "create slow case");
	const slowRunResp = await call("/api/runs", jsonInit({ caseIds: [slowResp.data.id], name: "slow-run", concurrency: 1 }));
	await new Promise((resolve) => setTimeout(resolve, 800));
	const cancelResp = await call(`/api/runs/${slowRunResp.data.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" } });
	check(cancelResp.status === 200, "cancel request accepted");
	const slowRun = await waitRun(slowRunResp.data.id, 30000);
	check(slowRun.status === "cancelled" && slowRun.items?.[0]?.status === "cancelled", "slow run cancelled");

	// 11. Case history endpoint
	const caseRuns = await call(`/api/cases/${failResp.data.id}/runs`);
	check(caseRuns.status === 200 && Array.isArray(caseRuns.data) && caseRuns.data.length >= 1, "case history lists runs");

	console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)\n`);
} finally {
	mock.stop(true);
	app.server.stop(true);
}

process.exitCode = failures === 0 ? 0 : 1;
