import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runIsolated } from "./grading/run.js";
import { runFunctionCall } from "./function-call.js";
import { parseEvalSuite } from "./schema.js";
import {
	readHistoryDocument,
	convertHistoryDocument,
} from "./function-call-history.js";
import { clineHistoryExample } from "./history-import-examples.js";
import { parseUpload } from "./grading/uploaded-verifiers.js";
import { frozenValidationInput } from "./grading/validation-context.js";
import { EvalStore } from "./web/store.js";

test("native request, Python fixed history, repeated snapshots/copy and actual SDK saved-file import", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "native-history-"));
	const previous = process.env.HISTORY_TEST_API_KEY;
	process.env.HISTORY_TEST_API_KEY = "mock";
	const bodies: any[] = [],
		counts = new Map<string, number>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const b = await req.json();
			bodies.push(b);
			if (!b.stream)
				return Response.json({
					choices: [
						{
							message: {
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "new_call",
										type: "function",
										function: {
											name: "editor",
											arguments:
												'{"path":"/never-execute/demo.py","new_text":"world"}',
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
				});
			const sid = req.headers.get("session_id")!;
			const count = (counts.get(sid) ?? 0) + 1;
			counts.set(sid, count);
			const delta =
				count === 1
					? {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "sdk_call",
									type: "function",
									function: {
										name: "read_files",
										arguments: '{"paths":["demo.py"]}',
									},
								},
							],
						}
					: { role: "assistant", content: "Done" };
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: count === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const store = new EvalStore(path.join(directory, "store"));
	try {
		const imported = convertHistoryDocument(
			readHistoryDocument(JSON.stringify(clineHistoryExample)),
			{ currentIndex: 3 },
		);
		const verifier = parseUpload({
			filename: "history.py",
			content:
				'def verify(ctx):\n    h = ctx["case"]["history"]\n    ok = len(h) == 4 and h[2]["tool_calls"][0]["id"] == h[3]["tool_call_id"] and len(ctx["diagnostics"]["tool_calls"]) == 1 and ctx["diagnostics"]["tool_calls"][0]["name"] == "editor"\n    return {"verdict": "pass" if ok else "fail", "message": "fixed history and only current response"}\n',
		});
		const suite = parseEvalSuite({
			defaults: {
				providerId: "openai-compatible",
				modelId: "mock",
				apiKeyEnv: "HISTORY_TEST_API_KEY",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				systemPrompt: "DEFAULT_NOT_SENT",
				headers: { session_id: "{{sessionId}}" },
				timeoutMs: 30000,
			},
			cases: [
				{
					id: "import",
					replayMode: "function-call",
					prompt: imported.prompt,
					history: [{ role: "user", content: "LEGACY_NOT_SENT" }],
					functionCall: {
						tools: ["editor"],
						history: imported.history,
						historySource: imported.source,
					},
					grading: {
						version: 1,
						rules: [
							{
								id: "history",
								kind: "script",
								verifierId: verifier.id,
								required_inputs: ["execution", "diagnostics"],
							},
						],
					},
				},
			],
		});
		const result = await runIsolated({
			definition: suite.cases[0],
			defaults: suite.defaults,
			directory: path.join(directory, "fc"),
			verifierSnapshots: [verifier],
		});
		expect(result.status).toBe("passed");
		expect(bodies).toHaveLength(1);
		expect(bodies[0].messages).toEqual([
			...imported.history,
			{ role: "user", content: imported.prompt },
		]);
		expect(JSON.stringify(bodies[0])).not.toContain("LEGACY_NOT_SENT");
		expect(JSON.stringify(bodies[0])).not.toContain("DEFAULT_NOT_SENT");
		expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual([
			"editor",
		]);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].name).toBe("editor");
		expect(result.toolCalls[0].output).toEqual({ not_executed: true });
		const frozen = await frozenValidationInput(
			path.join(directory, "fc"),
			result.evidence!,
		);
		expect(frozen.context.case.history).toEqual(imported.history);
		expect(frozen.context.case.function_call?.historySource).toEqual(
			imported.source,
		);
		const saved = store.createCase(
			store.activeModules()[0].id,
			suite.defaults,
			suite.cases[0],
		);
		const duplicated = store.duplicateCase(saved.id);
		expect(duplicated.definition.functionCall).toEqual(
			saved.definition.functionCall,
		);
		const run = store.createRun({ caseIds: [saved.id], repeatCount: 2 });
		const snapshot = store.items(run.id)[0].snapshot;
		store.put("case", saved.id, {
			...saved,
			definition: {
				...saved.definition,
				functionCall: { tools: ["editor"], history: [] },
			},
		});
		expect(store.items(run.id)).toHaveLength(2);
		expect(snapshot.definition.functionCall?.history).toEqual(imported.history);
		// Re-running frozen definition uses the original context, not the edited case.
		const rerun = await runFunctionCall({
			definition: snapshot.definition,
			defaults: snapshot.defaults,
		});
		expect(rerun.status).toBe("passed");
		expect(bodies[1].messages).toEqual(bodies[0].messages);
		const fixture = path.join(directory, "fixture");
		await mkdir(fixture);
		await writeFile(path.join(fixture, "demo.py"), "print('hello')");
		const sdkCase = parseEvalSuite({
			cases: [
				{
					id: "sdk",
					replayMode: "full-task",
					prompt: "Read demo.py",
					cwd: fixture,
					tools: "read-only",
					maxIterations: 3,
				},
			],
		}).cases[0];
		const sdk = await runIsolated({
			definition: sdkCase,
			defaults: suite.defaults,
			directory: path.join(directory, "sdk"),
		});
		expect(sdk.status).toBe("passed");
		const payload = await readFile(
			path.join(
				directory,
				"sdk",
				"session",
				"sessions",
				sdk.sessionId,
				`${sdk.sessionId}.messages.json`,
			),
			"utf8",
		);
		const converted = convertHistoryDocument(readHistoryDocument(payload));
		expect(converted.source.format).toBe("cline");
		expect(
			converted.history.some((m) =>
				m.tool_calls?.some((c) => c.function.name === "read_files"),
			),
		).toBe(true);
		expect(converted.history.some((m) => m.role === "tool")).toBe(true);
	} finally {
		server.stop(true);
		store.db.close();
		if (previous === undefined) delete process.env.HISTORY_TEST_API_KEY;
		else process.env.HISTORY_TEST_API_KEY = previous;
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);
