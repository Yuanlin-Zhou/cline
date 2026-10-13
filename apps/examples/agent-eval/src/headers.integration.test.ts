import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runIsolated } from "./grading/run.js";
import { runFunctionCall } from "./function-call.js";
import { runEvalSuite } from "./runner.js";
import { parseEvalSuite } from "./schema.js";

test("real SDK requests carry explicit auth and isolated execution IDs while saved suites retain references", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "eval-headers-integration-"),
	);
	const runtimeEnv = {
		CLINE_DATA_DIR: path.join(directory, "cli-data"),
		CLINE_SESSION_DATA_DIR: path.join(directory, "cli-data", "sessions"),
		CLINE_SANDBOX: "1",
		CLINE_SANDBOX_DATA_DIR: path.join(directory, "cli-data"),
		CLINE_LOG_ENABLED: "0",
	};
	const previousRuntime = Object.fromEntries(
		Object.keys(runtimeEnv).map((k) => [k, process.env[k]]),
	);
	Object.assign(process.env, runtimeEnv);
	const previous = process.env.EVAL_HEADERS_INTEGRATION_AUTH;
	const previousKey = process.env.EVAL_HEADERS_INTEGRATION_KEY;
	process.env.EVAL_HEADERS_INTEGRATION_KEY = "fake-default-api-key";
	process.env.EVAL_HEADERS_INTEGRATION_AUTH =
		"Bearer custom-header-test-secret";
	const requests: Headers[] = [];
	const counts = new Map<string, number>();
	let retried = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(new Headers(request.headers));
			const body = (await request.json()) as {
				messages: unknown[];
				stream?: boolean;
			};
			if (request.headers.get("x-case") === "a" && !retried) {
				retried = true;
				return Response.json(
					{ error: { message: "retry", type: "rate_limit" } },
					{ status: 429 },
				);
			}
			if (body.stream === false)
				return Response.json({
					choices: [
						{
							message: { role: "assistant", content: "Done" },
							finish_reason: "stop",
						},
					],
				});
			if (JSON.stringify(body).includes("HEADER_ERROR"))
				return Response.json(
					{
						error: {
							message: "rejected Bearer custom-header-test-secret",
							type: "auth_error",
						},
					},
					{ status: 401 },
				);
			const session = request.headers.get("x-session-id")!;
			const count = (counts.get(session) ?? 0) + 1;
			counts.set(session, count);
			const delta =
				count === 1 && !JSON.stringify(body).includes("HEADER_SINGLE")
					? {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "read-1",
									type: "function",
									function: {
										name: "read_files",
										arguments: JSON.stringify({ paths: ["input.txt"] }),
									},
								},
							],
						}
					: { role: "assistant", content: "Done" };
			const events = [
				{ id: "test", choices: [{ index: 0, delta, finish_reason: null }] },
				{
					id: "test",
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason:
								count === 1 && !JSON.stringify(body).includes("HEADER_SINGLE")
									? "tool_calls"
									: "stop",
						},
					],
					usage: { prompt_tokens: body.messages.length, completion_tokens: 1 },
				},
			];
			return new Response(
				events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
					"data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	try {
		const fixture = path.join(directory, "fixture");
		await mkdir(fixture);
		await writeFile(path.join(fixture, "input.txt"), "hello");
		const suite = parseEvalSuite({
			defaults: {
				providerId: "openai-compatible",
				modelId: "gpt-4o-mini",
				apiKeyEnv: "EVAL_HEADERS_INTEGRATION_KEY",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				headers: {
					"x-session-id": "{{sessionId}}",
					"x-message-id": "{{evaluationId}}",
					"x-case": "{{caseId}}",
					"x-request-id": "{{requestId}}",
					"x-trace": "req/{{requestId}}/{{requestId}}",
				},
				headersEnv: { Authorization: "EVAL_HEADERS_INTEGRATION_AUTH" },
				tools: "read-only",
				maxIterations: 3,
				timeoutMs: 20000,
			},
			cases: [
				{
					id: "a",
					prompt: "Read input.txt",
					replayMode: "full-task",
					cwd: fixture,
				},
				{
					id: "b",
					prompt: "Read input.txt",
					replayMode: "full-task",
					cwd: fixture,
				},
			],
		});
		const results = await Promise.all(
			suite.cases.map((definition, i) =>
				runIsolated({
					definition,
					defaults: suite.defaults,
					directory: path.join(directory, `run-${i}`),
				}),
			),
		);
		for (const result of results) {
			expect(result.status).toBe("passed");
			expect(result.text).toBe("Done");
			const calls = requests.filter(
				(headers) => headers.get("x-session-id") === result.sessionId,
			);
			expect(calls).toHaveLength(result.id === "a" ? 3 : 2);
			expect(new Set(calls.map((h) => h.get("x-request-id"))).size).toBe(
				calls.length,
			);
			expect(
				new Set(calls.map((headers) => headers.get("x-message-id"))).size,
			).toBe(1);
			for (const headers of calls) {
				expect(headers.get("authorization")).toBe(
					"Bearer custom-header-test-secret",
				);
				expect(headers.get("x-case")).toBe(result.id);
				const id = headers.get("x-request-id")!;
				expect(id).toMatch(/^[0-9a-f-]{36}$/);
				expect(headers.get("x-trace")).toBe(`req/${id}/${id}`);
			}
		}
		expect(
			new Set(requests.map((headers) => headers.get("x-message-id"))).size,
		).toBe(2);
		const single = {
			...suite.cases[0],
			id: "single",
			prompt: "HEADER_SINGLE",
			replayMode: "single-turn" as const,
		};
		const singleResult = await runIsolated({
			definition: single,
			defaults: suite.defaults,
			directory: path.join(directory, "single"),
		});
		expect(singleResult.status).toBe("passed");
		const cli = await runEvalSuite({
			suite: { ...suite, cases: [{ ...single, id: "cli" }] },
			suitePath: path.join(directory, "suite.json"),
			overrides: { stream: false },
		});
		expect(cli.cases[0].status).toBe("passed");
		const fc = await runFunctionCall({
			definition: {
				...single,
				id: "fc",
				replayMode: "function-call",
				functionCall: { tools: ["editor"] },
			},
			defaults: suite.defaults,
		});
		expect(fc.status).toBe("passed");
		for (const result of [singleResult, cli.cases[0], fc]) {
			const calls = requests.filter(
				(h) => h.get("x-session-id") === result.sessionId,
			);
			expect(calls).toHaveLength(1);
			expect(calls[0].get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
		}
		expect(new Set(requests.map((h) => h.get("x-request-id"))).size).toBe(
			requests.length,
		);
		const failed = await runIsolated({
			definition: { ...suite.cases[0], prompt: "HEADER_ERROR" },
			defaults: suite.defaults,
			directory: path.join(directory, "failed"),
		});
		expect(failed.finishReason).toBe("error");
		expect(failed.status).toBe("failed");
		for (const name of ["run-0", "run-1", "failed"]) {
			const saved = await readFile(
				path.join(directory, name, "suite.json"),
				"utf8",
			);
			expect(saved).not.toContain("custom-header-test-secret");
			expect(JSON.parse(saved).defaults.headersEnv.authorization).toBe(
				"EVAL_HEADERS_INTEGRATION_AUTH",
			);
		}
	} finally {
		server.stop(true);
		for (const [key, value] of Object.entries(previousRuntime)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (previous === undefined)
			delete process.env.EVAL_HEADERS_INTEGRATION_AUTH;
		else process.env.EVAL_HEADERS_INTEGRATION_AUTH = previous;
		if (previousKey === undefined)
			delete process.env.EVAL_HEADERS_INTEGRATION_KEY;
		else process.env.EVAL_HEADERS_INTEGRATION_KEY = previousKey;
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);
