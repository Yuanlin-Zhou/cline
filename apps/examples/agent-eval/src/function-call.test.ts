import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	runFunctionCall,
	preflightFunctionCall,
	FUNCTION_RESPONSE_LIMIT,
} from "./function-call.js";
import { parseEvalSuite } from "./schema.js";
import { replayConfig } from "./replay.js";
import {
	functionCallTools,
	parseFunctionCall,
} from "./function-call-config.js";
import { createEvalServer } from "./web/server.js";
import {
	caseToDocument,
	caseFromDocument,
	caseValidator,
} from "./web/mongo-schema.js";

const examples = new URL("../examples/", import.meta.url);
test("new mode preserves schema/configuration and old replay contracts", () => {
	const c = parseEvalSuite({
		cases: [
			{
				id: "fc",
				prompt: "task",
				replayMode: "function-call",
				functionCall: { tools: ["read_files"], toolChoice: "read_files" },
			},
		],
	}).cases[0];
	expect(c.functionCall).toEqual({
		tools: ["read_files"],
		toolChoice: "read_files",
	});
	expect(
		replayConfig(c, {
			providerId: "openai-compatible",
			modelId: "x",
			tools: "full",
		}),
	).toEqual({ tools: "none", maxIterations: 1 });
	expect(
		replayConfig(
			{ ...c, replayMode: "single-turn" },
			{ providerId: "x", modelId: "x", tools: "full" },
		),
	).toEqual({ tools: "none", maxIterations: 1 });
	expect(() =>
		parseFunctionCall({ tools: ["read_files", "read_files"] }),
	).toThrow();
	expect(() =>
		parseFunctionCall({ tools: ["skills"], toolChoice: "editor" }),
	).toThrow();
	expect(() =>
		preflightFunctionCall(c, { providerId: "cline", modelId: "x" }),
	).toThrow("openai-compatible");
	const saved = {
		id: "case-id",
		moduleId: "module-id",
		revision: 1,
		updatedAt: new Date().toISOString(),
		definition: c,
		defaults: {
			providerId: "openai-compatible",
			modelId: "x",
			baseUrl: "http://localhost/v1",
		},
	};
	expect(
		caseFromDocument(caseToDocument(saved)).definition.functionCall,
	).toEqual(c.functionCall);
	expect(
		caseValidator.$jsonSchema.properties.definition.properties.replayMode.enum,
	).toContain("function-call");
});

test("one native request carries schemas and headers without executing tools; timeout and response bounds", async () => {
	let requests: any[] = [];
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = await req.json();
			requests.push({ body, header: req.headers.get("x-test") });
			if (body.model === "slow") {
				await Bun.sleep(150);
				return Response.json({});
			}
			if (body.model === "large")
				return new Response("x".repeat(FUNCTION_RESPONSE_LIMIT + 1));
			return Response.json({
				choices: [
					{
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							tool_calls: [
								{
									id: "c",
									type: "function",
									function: {
										name: "run_commands",
										arguments: '{"commands":["touch /should-not-exist"]}',
									},
								},
							],
						},
					},
				],
			});
		},
	});
	try {
		const definition = {
			id: "test",
			prompt: "task",
			history: [],
			replayMode: "function-call" as const,
			functionCall: {
				tools: ["run_commands" as const],
				toolChoice: "required" as const,
			},
			headers: { "x-test": "configured" },
		};
		const defaults = {
			providerId: "openai-compatible",
			modelId: "x",
			baseUrl: `http://127.0.0.1:${mock.port}/v1`,
		};
		const result = await runFunctionCall({ definition, defaults });
		expect(requests.length).toBe(1);
		expect(requests[0].header).toBe("configured");
		expect(requests[0].body.stream).toBe(false);
		expect(requests[0].body.tools).toEqual(
			functionCallTools(parseFunctionCall(definition.functionCall)),
		);
		expect(result.toolCalls[0].output).toEqual({ not_executed: true });
		expect(result.functionCallResponse?.raw_response).toContain(
			"/should-not-exist",
		);
		expect(
			(
				await runFunctionCall({
					definition: { ...definition, timeoutMs: 10 },
					defaults: { ...defaults, modelId: "slow" },
				})
			).error,
		).toContain("timed out");
		expect(
			(
				await runFunctionCall({
					definition,
					defaults: { ...defaults, modelId: "large" },
				})
			).error,
		).toContain("512 KiB");
	} finally {
		mock.stop(true);
	}
});

test("upload six validators, import eight examples, reject invalid native arguments and preserve frozen history trials", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "eval-function-"));
	let calls = 0;
	const fixture = JSON.parse(
		await readFile(new URL("function-calls/schemas.json", examples), "utf8"),
	);
	const samples: Record<string, unknown> = {
		read_files: {
			files: [{ path: "/project/README.md", start_line: 1, end_line: 10 }],
		},
		search_codebase: { queries: ["TODO"] },
		run_commands: { commands: ["echo done"] },
		fetch_web_content: {
			requests: [{ url: "https://example.com", prompt: "summarize" }],
		},
		editor: { path: "/project/hello.txt", new_text: "hello\n" },
		skills: { skill: "code-review", args: null },
	};
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			calls++;
			const body = await req.json();
			expect(body.stream).toBe(false);
			expect(body.n).toBe(1);
			for (const tool of body.tools)
				expect(tool.function.parameters).toEqual(fixture[tool.function.name]);
			return Response.json({
				choices: [
					{
						index: 0,
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							content: null,
							tool_calls: body.tools.map((t: any, i: number) => ({
								id: `call_${i}`,
								type: "function",
								function: {
									name: t.function.name,
									arguments:
										body.messages.at(-1).content === "bad-format"
											? '{"files":[{"path":"/x","start_line":"1"}]}'
											: JSON.stringify(samples[t.function.name]),
								},
							})),
						},
					},
				],
				usage: { prompt_tokens: 12, completion_tokens: 5 },
			});
		},
	});
	const app = await createEvalServer({
		storage: "sqlite",
		directory: path.join(directory, "data"),
		port: 0,
	});
	const base = `http://127.0.0.1:${app.server.port}`;
	const post = (url: string, body: unknown) =>
		fetch(base + url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		const defaults = {
			providerId: "openai-compatible",
			modelId: "mock",
			baseUrl: `http://127.0.0.1:${mock.port}/v1`,
			tools: "none" as const,
			timeoutMs: 10000,
		};
		app.store.put("settings", "default", defaults);
		const prepared = path.join(directory, "bound.json");
		const process = Bun.spawn(
			[
				"python3",
				new URL("function-calls/prepare.py", examples).pathname,
				"--url",
				base,
				"--output",
				prepared,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await process.exited).toBe(0);
		const suite = app.store.parseImport(
			await readFile(prepared, "utf8"),
			"json",
			"function-call",
		);
		expect(suite.cases).toHaveLength(6);
		expect(
			suite.cases.every((c) => c.grading!.rules[0].kind === "script"),
		).toBe(true);
		const module = app.store.activeModules()[0];
		const extra = JSON.parse(
			await readFile(
				new URL("importable/function-call-multi.json", examples),
				"utf8",
			),
		);
		const idsByName = Object.fromEntries(
			suite.cases.map((c) => [
				c.functionCall!.tools[0],
				(c.grading!.rules[0] as any).verifierId,
			]),
		);
		for (const c of extra.cases)
			for (const rule of c.grading.rules)
				rule.verifierId = idsByName[rule.verifierId.replace("example-fc-", "")];
		suite.cases.push(...extra.cases);
		const imported = await post("/api/import", {
			moduleId: module.id,
			content: JSON.stringify(suite),
			format: "json",
			replayMode: "function-call",
			policy: "skip",
		});
		expect(imported.status).toBe(200);
		expect((await imported.json()).created).toBe(8);
		const ids = app.store.list<any>("case").map((c) => c.id);
		const response = await post("/api/runs", { caseIds: ids, concurrency: 2 });
		expect(response.status).toBe(202);
		const run = await response.json();
		await app.queue.idle();
		const items = app.store.items(run.id);
		expect(items).toHaveLength(8);
		expect(calls).toBe(8);
		for (const item of items) {
			expect(item.status).toBe("passed");
			expect(item.result!.grading!.results[0].status).toBe("pass");
			expect(item.result!.toolCalls[0].output).toEqual({ not_executed: true });
			expect(
				item.result!.evidence!.refs.some(
					(r) => r.label === "原始函数调用响应 v1",
				),
			).toBe(true);
		}
		const readItem = items.find(
			(i) => i.snapshot.definition.id === "fc-read_files",
		)!;
		const bad = app.store.createCase(module.id, suite.defaults, {
			...readItem.snapshot.definition,
			id: "fc-bad-type",
			prompt: "bad-format",
		});
		const badRun = await (
			await post("/api/runs", { caseIds: [bad.id] })
		).json();
		await app.queue.idle();
		expect(app.store.items(badRun.id)[0].status).toBe("failed");
		expect(
			app.store
				.items(badRun.id)[0]
				.result!.grading!.results[0].checks!.some(
					(c) => c.status === "fail" && c.message.includes("start_line"),
				),
		).toBe(true);
		expect(calls).toBe(9);
		const item = items[0];
		const before = JSON.stringify(item);
		const prefix = `/api/runs/${run.id}/items/${item.id}`;
		const input = await (
			await fetch(base + prefix + "/validation-input")
		).json();
		expect(JSON.stringify(input)).toContain("function_call_response");
		const rule = item.snapshot.definition.grading!.rules[0] as any;
		const trialResponse = await post(prefix + "/verifier-tests", {
			verifierId: rule.verifierId,
			params: rule.params,
		});
		expect(trialResponse.status).toBe(202);
		const trial = await trialResponse.json();
		let task: any;
		for (let n = 0; n < 200; n++) {
			task = await (
				await fetch(base + prefix + `/verifier-tests/${trial.id}`)
			).json();
			if (!["queued", "running"].includes(task.status)) break;
			await Bun.sleep(20);
		}
		expect(task.result?.status).toBe("pass");
		expect(calls).toBe(9);
		expect(JSON.stringify(app.store.items(run.id)[0])).toBe(before);
	} finally {
		await app.close();
		mock.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);

test("editor flexible examples use one request each, preserve history and grade every returned call", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "eval-editor-flexible-"));
	const requests: any[] = [];
	const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
		const body = await req.json();
		requests.push(body);
		const count = body.tool_choice === "required" ? 3 : 1;
		return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
			role: "assistant", content: null, tool_calls: Array.from({ length: count }, (_, i) => ({
				id: `call_${i}`, type: "function", function: { name: "editor", arguments: JSON.stringify({ path: path.join(directory, `${i}.txt`), new_text: "world\n" }) },
			})),
		} }] });
	} });
	const app = await createEvalServer({ directory, port: 0, storage: "sqlite" });
	const base = `http://127.0.0.1:${app.server.port}`;
	const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	try {
		const upload = await post("/api/verifiers", { filename: "verify_editor.py", content: await readFile(new URL("function-calls/verify_editor.py", examples), "utf8") });
		expect(upload.status).toBe(201);
		const verifier = await upload.json();
		const suite = parseEvalSuite(JSON.parse(await readFile(new URL("importable/function-call-editor-flexible.json", examples), "utf8")));
		suite.defaults = { providerId: "openai-compatible", modelId: "mock", baseUrl: `http://127.0.0.1:${mock.port}/v1`, tools: "none" };
		for (const c of suite.cases) (c.grading!.rules[0] as any).verifierId = verifier.id;
		const imported = await post("/api/import", { moduleId: app.store.activeModules()[0].id, content: JSON.stringify(suite), format: "json", replayMode: "function-call", policy: "skip" });
		expect(imported.status).toBe(200);
		expect((await imported.json()).created).toBe(2);
		const started = await post("/api/runs", { caseIds: app.store.list<any>("case").map(c => c.id), concurrency: 1 });
		expect(started.status).toBe(202);
		const run = await started.json();
		await app.queue.idle();
		expect(requests).toHaveLength(2);
		for (const body of requests) expect(body.tools.map((t: any) => t.function.name)).toEqual(["editor"]);
		expect(requests[0].tool_choice).toEqual({ type: "function", function: { name: "editor" } });
		expect(requests[1].tool_choice).toBe("required");
		expect(requests[1].messages.slice(-3)).toEqual([...suite.cases[1].history, { role: "user", content: suite.cases[1].prompt }]);
		const items = app.store.items(run.id);
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.status).toBe("passed");
			const count = item.snapshot.definition.functionCall!.toolChoice === "required" ? 3 : 1;
			expect(item.result!.toolCalls).toHaveLength(count);
			expect(item.result!.toolCalls.every(c => (c.output as any).not_executed)).toBe(true);
			const checks = item.result!.grading!.results[0].checks!;
			expect(checks.find(c => c.id === "target-count")?.actual).toBe(count);
			expect(checks.filter(c => c.id.endsWith("-schema"))).toHaveLength(count);
		}
		expect(await Bun.file(path.join(directory, "0.txt")).exists()).toBe(false);
	} finally {
		await app.close(); mock.stop(true); await rm(directory, { recursive: true, force: true });
	}
}, 30000);
