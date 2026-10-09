import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runIsolated } from "./grading/run.js";
import { parseEvalSuite } from "./schema.js";

test("real SDK requests carry explicit auth and isolated execution IDs while saved suites retain references", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "eval-headers-integration-"),
	);
	const previous = process.env.EVAL_HEADERS_INTEGRATION_AUTH;
	const previousKey = process.env.EVAL_HEADERS_INTEGRATION_KEY;
	process.env.EVAL_HEADERS_INTEGRATION_KEY = "fake-default-api-key";
	process.env.EVAL_HEADERS_INTEGRATION_AUTH =
		"Bearer custom-header-test-secret";
	const requests: Headers[] = [];
	const counts = new Map<string, number>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(new Headers(request.headers));
			const body = (await request.json()) as { messages: unknown[] };
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
				count === 1
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
							finish_reason: count === 1 ? "tool_calls" : "stop",
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
			expect(calls).toHaveLength(2);
			expect(
				new Set(calls.map((headers) => headers.get("x-message-id"))).size,
			).toBe(1);
			for (const headers of calls) {
				expect(headers.get("authorization")).toBe(
					"Bearer custom-header-test-secret",
				);
				expect(headers.get("x-case")).toBe(result.id);
			}
		}
		expect(
			new Set(requests.map((headers) => headers.get("x-message-id"))).size,
		).toBe(2);
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
		if (previous === undefined)
			delete process.env.EVAL_HEADERS_INTEGRATION_AUTH;
		else process.env.EVAL_HEADERS_INTEGRATION_AUTH = previous;
		if (previousKey === undefined)
			delete process.env.EVAL_HEADERS_INTEGRATION_KEY;
		else process.env.EVAL_HEADERS_INTEGRATION_KEY = previousKey;
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);
