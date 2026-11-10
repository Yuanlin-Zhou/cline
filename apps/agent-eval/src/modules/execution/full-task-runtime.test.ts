import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEvalSuite } from "../../contracts/schema.js";
import { runEvalSuite } from "./runner.js";
import { resolveFullTaskRuntime } from "./full-task-runtime.js";

test("full-task settings merge false and retain historical defaults", () => {
	const s = parseEvalSuite({
		defaults: {
			fullTaskRuntime: { compaction: { enabled: true, strategy: "basic" } },
		},
		cases: [
			{
				id: "x",
				prompt: "x",
				fullTaskRuntime: { compaction: { enabled: false } },
			},
		],
	});
	expect(resolveFullTaskRuntime(s.cases[0], s.defaults)).toEqual({
		promptPreset: "plugin-act",
		compaction: { enabled: false, strategy: "basic" },
	});
	expect(
		resolveFullTaskRuntime(
			{ ...s.cases[0], fullTaskRuntime: undefined },
			{ ...s.defaults, fullTaskRuntime: undefined },
			true,
		),
	).toMatchObject({
		promptPreset: "legacy-eval",
		compaction: { enabled: false },
	});
	expect(() =>
		parseEvalSuite({
			cases: [
				{
					id: "x",
					prompt: "x",
					fullTaskRuntime: { compaction: { enabled: "false" } },
				},
			],
		}),
	).toThrow();
});

test("real SDK Act tools read, search, edit and execute without human approval", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "eval-act-"));
	await writeFile(path.join(dir, "fixture.txt"), "before\n");
	const steps = [
		{ name: "read_files", input: { paths: [path.join(dir, "fixture.txt")] } },
		{ name: "search_codebase", input: { queries: ["before"] } },
		{
			name: "editor",
			input: { path: "fixture.txt", old_text: "before", new_text: "after" },
		},
		{ name: "run_commands", input: { commands: ["cat fixture.txt"] } },
	];
	let count = 0;
	const requests: any[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as any;
			requests.push(body);
			const step = steps[count++];
			const delta = step
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `call_${count}`,
								type: "function",
								function: {
									name: step.name,
									arguments: JSON.stringify(step.input),
								},
							},
						],
					}
				: { role: "assistant", content: "task complete" };
			const chunks = [
				{ choices: [{ index: 0, delta, finish_reason: null }] },
				{
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: step ? "tool_calls" : "stop",
						},
					],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 20,
						total_tokens: 120,
					},
				},
			];
			return new Response(
				chunks
					.map(
						(c) =>
							`data: ${JSON.stringify({ id: `response_${count}`, object: "chat.completion.chunk", model: body.model, ...c })}\n\n`,
					)
					.join("") + "data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const oldData = process.env.CLINE_DATA_DIR;
	process.env.CLINE_DATA_DIR = path.join(dir, "data");
	try {
		const suite = parseEvalSuite({
			defaults: {
				providerId: "openai-compatible",
				modelId: "act-test",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				cwd: dir,
				tools: "full",
				timeoutMs: 30000,
				fullTaskRuntime: { compaction: { enabled: true, strategy: "basic" } },
			},
			cases: [
				{ id: "tools", prompt: "Complete the task", replayMode: "full-task" },
			],
		});
		const report = await runEvalSuite({
			suite,
			suitePath: path.join(dir, "suite.json"),
			overrides: { stream: false },
		});
		const result = report.cases[0];
		expect(result.status).toBe("passed");
		expect(await readFile(path.join(dir, "fixture.txt"), "utf8")).toBe(
			"after\n",
		);
		expect(result.toolCalls.map((c) => c.name)).toEqual(
			steps.map((s) => s.name),
		);
		expect(JSON.stringify(result.toolCalls[0].output)).toContain("before");
		expect(JSON.stringify(result.toolCalls[1].output)).toContain("before");
		expect(JSON.stringify(result.toolCalls[3].output)).toContain("after");
		expect(result.runtime?.mode).toBe("act");
		expect(result.runtime?.modelRequests).toBe(5);
		expect(result.runtime?.actualTools).toEqual(
			expect.arrayContaining(steps.map((s) => s.name)),
		);
		expect(requests[0].messages[0].content).not.toContain(
			"automated evaluation",
		);
		expect(result.runtime?.compaction).toEqual({
			enabled: true,
			strategy: "basic",
		});
		suite.defaults.tools = "read-only";
		suite.cases[0].systemPrompt = "Custom task instructions";
		const readonly = await runEvalSuite({
			suite,
			suitePath: path.join(dir, "suite.json"),
			overrides: { stream: false },
		});
		expect(readonly.cases[0].runtime?.actualTools?.sort()).toEqual([
			"read_files",
			"search_codebase",
		]);
		expect(readonly.cases[0].runtime?.promptSource).toBe("custom");
		suite.defaults.tools = "none";
		const none = await runEvalSuite({
			suite,
			suitePath: path.join(dir, "suite.json"),
			overrides: { stream: false },
		});
		expect(none.cases[0].runtime?.actualTools).toEqual([]);
	} finally {
		server.stop(true);
		if (oldData === undefined) delete process.env.CLINE_DATA_DIR;
		else process.env.CLINE_DATA_DIR = oldData;
		await rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("SDK basic compaction triggers on oversized history and is recorded", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "eval-compact-"));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as any;
			return new Response(
				`data: ${JSON.stringify({ id: "compacted", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const oldData = process.env.CLINE_DATA_DIR;
	process.env.CLINE_DATA_DIR = path.join(dir, "sessions");
	try {
		const suite = parseEvalSuite({
			defaults: {
				providerId: "openai-compatible",
				modelId: "act-test",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				cwd: dir,
				fullTaskRuntime: { compaction: { enabled: true, strategy: "basic" } },
			},
			cases: [
				{
					id: "compact",
					prompt: "finish",
					replayMode: "full-task",
					history: Array.from({ length: 80 }, (_, i) => ({
						role: i % 2 ? "assistant" : "user",
						content: "long context words ".repeat(2000),
					})),
				},
			],
		});
		const report = await runEvalSuite({
			suite,
			suitePath: path.join(dir, "suite.json"),
			overrides: { stream: false },
		});
		expect(report.cases[0].error).toBeUndefined();
		expect(report.cases[0].status).toBe("passed");
		expect(report.cases[0].runtime?.compactionEvents.length).toBeGreaterThan(0);
	} finally {
		server.stop(true);
		if (oldData === undefined) delete process.env.CLINE_DATA_DIR;
		else process.env.CLINE_DATA_DIR = oldData;
		await rm(dir, { recursive: true, force: true });
	}
}, 60000);
