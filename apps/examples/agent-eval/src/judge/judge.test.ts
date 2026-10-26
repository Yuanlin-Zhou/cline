import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseJudgeConfig } from "./config.js";
import { parseEvalSuite } from "../schema.js";
import { buildJudgeInput } from "./input.js";
import {
	scoreWithJudge,
	parseJudgeResponse,
	applyJudgeOutcome,
	redactJudgeInput,
} from "./engine.js";
import { manifest, saveEvidence } from "../grading/evidence.js";
import { freezeValidationInput } from "../grading/validation-context.js";
import { runIsolated } from "../grading/run.js";
import type { EvalCase, EvalCaseResult } from "../types.js";
import type { JudgeConfig } from "./types.js";
const config = (extra: Partial<JudgeConfig> = {}): JudgeConfig =>
	parseJudgeConfig({
		enabled: true,
		referenceAnswer: "REFERENCE ONLY",
		targets: ["result"],
		model: {
			providerId: "openai-compatible",
			modelId: "gpt-4o-mini",
			baseUrl: "http://127.0.0.1:1/v1",
		},
		...extra,
	})!;
const executed = (): EvalCaseResult => ({
	id: "case",
	sessionId: "session1",
	status: "passed",
	text: "FINAL ANSWER",
	durationMs: 1,
	iterations: 1,
	usage: { inputTokens: 1, outputTokens: 2 },
	toolCalls: [
		{ name: "read_files", input: { path: "a.txt" }, output: "TOOL DATA" },
	],
	assertions: [],
	execution: { status: "completed" },
});
async function archive(dir: string) {
	const result = executed(),
		evidence = manifest(),
		definition: EvalCase = {
			id: "case",
			prompt: "TASK",
			history: [{ role: "user", content: "BACKGROUND" }],
			replayMode: "full-task",
		};
	const session = path.join(dir, "session/sessions/session1");
	await mkdir(session, { recursive: true });
	await writeFile(
		path.join(session, "session1.messages.json"),
		JSON.stringify({
			sessionId: "session1",
			messages: [
				{ role: "user", content: "TASK" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call1",
							name: "read_files",
							input: { path: "a.txt" },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call1",
							toolName: "read_files",
							output: "TOOL DATA",
						},
					],
				},
				{ role: "assistant", content: "FINAL ANSWER" },
			],
		}),
	);
	await freezeValidationInput({
		directory: dir,
		definition,
		result,
		evidence,
		secrets: [],
	});
	return { result, evidence, definition };
}
async function temp(fn: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(path.join(tmpdir(), "judge-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
function mockJudge(handler?: (body: any) => { text?: string; delay?: number }) {
	const requests: Array<{ body: any; headers: Headers }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = await request.json();
			requests.push({ body, headers: request.headers });
			const custom = handler?.(body) ?? {};
			if (custom.delay) await Bun.sleep(custom.delay);
			const text =
				custom.text ??
				JSON.stringify({
					status: "scored",
					score: 85,
					rationale: "与参考一致",
					evidence: [{ ref: "result.final_response", quote: "FINAL" }],
				});
			if (!body.stream)
				return Response.json({
					id: "mock",
					object: "chat.completion",
					model: body.model,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: text },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 },
				});
			const chunk = (delta: any, finish: any = null) =>
				`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			return new Response(
				chunk({ role: "assistant", content: text }) +
					chunk({}, "stop") +
					`data: ${JSON.stringify({ id: "mock", choices: [], usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	return { server, requests, url: `http://127.0.0.1:${server.port}/v1` };
}
test("Judge schema preserves models and disabled values and rejects invalid scopes, budgets and CLI agents", () => {
	const c = config();
	const parsed = parseEvalSuite({
		cases: [{ id: "x", prompt: "question", llmJudge: c }],
	});
	expect(parsed.cases[0].llmJudge).toEqual(c);
	expect(parsed.defaults.modelId).not.toBe(c.model!.modelId);
	expect(
		parseJudgeConfig({
			...c,
			enabled: false,
			referenceAnswer: "",
			targets: [],
			model: { providerId: "", modelId: "" },
		}),
	).toMatchObject({ enabled: false, referenceAnswer: "" });
	for (const update of [
		{ targets: [] },
		{ targets: ["bad"] },
		{ targets: ["result", "result"] },
		{ passScore: 101 },
		{ timeoutMs: 0 },
		{ maxInputBytes: 1048577 },
		{ referenceAnswer: "" },
		{ resultFiles: ["../a"] },
		{ model: { providerId: "claude-code", modelId: "agent" } },
	])
		expect(() => parseJudgeConfig({ ...c, ...update })).toThrow();
	expect(() =>
		parseJudgeConfig({ ...c, resultFiles: ["a.txt"] }, "single-turn"),
	).toThrow("完整任务");
});
test("selected input scopes exclude the other material; file hashes and byte limits are enforced", async () =>
	temp(async (dir) => {
		const a = await archive(dir);
		const result = await buildJudgeInput(dir, a.evidence, config());
		expect(result.sources.map((s) => s.id)).toEqual(["result.final_response"]);
		expect(JSON.stringify(result)).not.toContain("TOOL DATA");
		const trace = await buildJudgeInput(
			dir,
			a.evidence,
			config({ targets: ["trajectory"] }),
		);
		expect(JSON.stringify(trace)).toContain("TOOL DATA");
		expect(JSON.stringify(trace.sources)).not.toContain("FINAL ANSWER");
		expect(trace.limitations.join(" ")).toContain("压缩");
		const both = await buildJudgeInput(
			dir,
			a.evidence,
			config({ targets: ["result", "trajectory"] }),
		);
		expect(both.sources.some((s) => s.id === "result.final_response")).toBe(
			true,
		);
		const file = "artifact text";
		const ref = await saveEvidence(
			dir,
			file,
			"artifacts/a.txt",
			a.evidence.refs,
		);
		a.evidence.artifacts.push({
			path: "a.txt",
			size: file.length,
			sha256: a.evidence.refs.at(-1)!.sha256,
			ref,
		});
		expect(
			(
				await buildJudgeInput(
					dir,
					a.evidence,
					config({ resultFiles: ["a.txt"] }),
				)
			).sources.at(-1)?.content,
		).toBe(file);
		await expect(
			buildJudgeInput(
				dir,
				a.evidence,
				config({ resultFiles: ["missing.txt"] }),
			),
		).rejects.toThrow("缺少");
		await expect(
			buildJudgeInput(
				dir,
				a.evidence,
				config({ referenceAnswer: "a".repeat(3000), maxInputBytes: 1024 }),
			),
		).rejects.toThrow("超过");
		await writeFile(path.join(dir, a.evidence.refs.at(-1)!.path), "tampered");
		await expect(
			buildJudgeInput(dir, a.evidence, config({ resultFiles: ["a.txt"] })),
		).rejects.toThrow("摘要");
	}));
test("structured scores require bounded numbers and exact source citations", async () =>
	temp(async (dir) => {
		const a = await archive(dir),
			input = await buildJudgeInput(dir, a.evidence, config());
		expect(
			parseJudgeResponse(
				"```json\n" +
					JSON.stringify({
						status: "scored",
						score: 0,
						rationale: "错误",
						evidence: [{ ref: "result.final_response" }],
					}) +
					"\n```",
				input,
			).score,
		).toBe(0);
		expect(
			parseJudgeResponse(
				JSON.stringify({
					status: "insufficient",
					score: null,
					rationale: "缺证据",
					evidence: [],
				}),
				input,
			).status,
		).toBe("insufficient");
		for (const response of [
			{
				status: "scored",
				score: 101,
				rationale: "bad",
				evidence: [{ ref: "result.final_response" }],
			},
			{
				status: "scored",
				score: 50,
				rationale: "bad",
				evidence: [{ ref: "trajectory.tool_calls" }],
			},
			{
				status: "scored",
				score: 50,
				rationale: "bad",
				evidence: [{ ref: "result.final_response", quote: "fabricated" }],
			},
			{ status: "insufficient", score: 0, rationale: "bad", evidence: [] },
		])
			expect(() =>
				parseJudgeResponse(JSON.stringify(response), input),
			).toThrow();
		expect(() => parseJudgeResponse("score is 90", input)).toThrow("JSON");
	}));
test("Judge redaction preserves protocol fields for short credentials", async () =>
	temp(async (dir) => {
		const a = await archive(dir);
		const input = redactJudgeInput(
			await buildJudgeInput(dir, a.evidence, config()),
			["result", "FINAL"],
		);
		expect(input.targets).toEqual(["result"]);
		expect(input.sources[0].id).toBe("result.final_response");
		expect(input.sources[0].content).toBe("[REDACTED] ANSWER");
		const api = mockJudge(() => ({
			text: JSON.stringify({
				status: "scored",
				score: 90,
				rationale: "scored",
				evidence: [{ ref: "result.final_response" }],
			}),
		}));
		const previous = process.env.JUDGE_SHORT_TEST_KEY;
		process.env.JUDGE_SHORT_TEST_KEY = "scored";
		try {
			const score = await scoreWithJudge({
				config: config({
					model: {
						providerId: "openai-compatible",
						modelId: "gpt-4o-mini",
						baseUrl: api.url,
						apiKeyEnv: "JUDGE_SHORT_TEST_KEY",
					},
				}),
				directory: dir,
				evidence: a.evidence,
				caseId: "case",
			});
			expect(score.status).toBe("scored");
			expect(score.rationale).toBe("[REDACTED]");
			expect(
				JSON.parse(
					await readFile(
						path.join(dir, "judge", score.id, "result.json"),
						"utf8",
					),
				).status,
			).toBe("scored");
		} finally {
			api.server.stop(true);
			if (previous === undefined) delete process.env.JUDGE_SHORT_TEST_KEY;
			else process.env.JUDGE_SHORT_TEST_KEY = previous;
		}
	}));
test("provider request uses only Judge credentials and selected input, records usage, and thresholds cannot upgrade prior failures", async () =>
	temp(async (dir) => {
		const api = mockJudge(),
			previous = process.env.JUDGE_TEST_KEY;
		process.env.JUDGE_TEST_KEY = "judge-local-test-value";
		try {
			const a = await archive(dir);
			const c = config({
				model: {
					providerId: "openai-compatible",
					modelId: "gpt-4o-mini",
					baseUrl: api.url,
					apiKeyEnv: "JUDGE_TEST_KEY",
					headers: { "x-kind": "judge", "x-request-id": "{{requestId}}" },
				},
			});
			const score = await scoreWithJudge({
				config: c,
				directory: dir,
				evidence: a.evidence,
				caseId: "case",
			});
			expect(score).toMatchObject({
				status: "scored",
				score: 85,
				meetsThreshold: true,
				usage: { inputTokens: 13, outputTokens: 7 },
			});
			expect(api.requests).toHaveLength(1);
			expect(api.requests[0].headers.get("authorization")).toBe(
				"Bearer judge-local-test-value",
			);
			expect(api.requests[0].headers.get("x-kind")).toBe("judge");
			expect(api.requests[0].headers.get("x-request-id")).not.toContain(
				"eval-request-",
			);
			expect(JSON.stringify(api.requests[0].body)).not.toContain("TOOL DATA");
			expect(
				await readFile(path.join(dir, "judge", score.id, "input.json"), "utf8"),
			).toContain("REFERENCE ONLY");
			expect(
				await readFile(
					path.join(dir, "judge", score.id, "result.json"),
					"utf8",
				),
			).not.toContain("judge-local-test-value");
			const advisory = executed();
			applyJudgeOutcome(advisory, {
				...score,
				score: 20,
				meetsThreshold: false,
				affectsOutcome: false,
			});
			expect(advisory.status).toBe("passed");
			applyJudgeOutcome(advisory, {
				...score,
				score: 20,
				meetsThreshold: false,
				affectsOutcome: true,
			});
			expect(advisory.status).toBe("failed");
			applyJudgeOutcome(advisory, {
				...score,
				meetsThreshold: true,
				affectsOutcome: true,
			});
			expect(advisory.status).toBe("failed");
		} finally {
			api.server.stop(true);
			if (previous === undefined) delete process.env.JUDGE_TEST_KEY;
			else process.env.JUDGE_TEST_KEY = previous;
		}
	}));
test("bad responses, timeout, missing evidence and cancellation stay distinct from valid zero scores", async () =>
	temp(async (dir) => {
		const a = await archive(dir),
			bad = mockJudge(() => ({ text: "not JSON" }));
		try {
			const score = await scoreWithJudge({
				config: config({
					model: {
						providerId: "openai-compatible",
						modelId: "gpt-4o-mini",
						baseUrl: bad.url,
					},
				}),
				directory: dir,
				evidence: a.evidence,
				caseId: "case",
			});
			expect(score.status).toBe("error");
			expect(score.score).toBeNull();
			expect(bad.requests).toHaveLength(1);
		} finally {
			bad.server.stop(true);
		}
		const slow = mockJudge(() => ({ delay: 3000 }));
		try {
			const score = await scoreWithJudge({
				config: config({
					timeoutMs: 1000,
					model: {
						providerId: "openai-compatible",
						modelId: "gpt-4o-mini",
						baseUrl: slow.url,
					},
				}),
				directory: dir,
				evidence: a.evidence,
				caseId: "case",
			});
			expect(score).toMatchObject({
				status: "error",
				score: null,
				errorType: "timeout",
			});
		} finally {
			slow.server.stop(true);
		}
		expect(
			await scoreWithJudge({
				config: config({ resultFiles: ["absent.txt"] }),
				directory: dir,
				evidence: a.evidence,
				caseId: "case",
			}),
		).toMatchObject({ status: "insufficient", score: null });
		const controller = new AbortController();
		controller.abort();
		expect(
			(
				await scoreWithJudge({
					config: config(),
					directory: dir,
					evidence: a.evidence,
					caseId: "case",
					signal: controller.signal,
				})
			).status,
		).toBe("cancelled");
	}));
test(
	"isolated execution strips Judge input from worker, then grades via independent request",
	async () =>
		temp(async (dir) => {
			const api = mockJudge((body) =>
				JSON.stringify(body).includes("reference-judge-v1")
					? {
							text: JSON.stringify({
								status: "scored",
								score: 65,
								rationale: "部分正确",
								evidence: [{ ref: "result.final_response" }],
							}),
						}
					: { text: "ACTOR ONLY" },
			);
			try {
				const definition: EvalCase = {
					id: "native",
					prompt: "ACTOR TASK",
					history: [],
					replayMode: "function-call",
					functionCall: { tools: ["read_files"] },
					llmJudge: config({
						affectsOutcome: true,
						referenceAnswer: "PRIVATE REFERENCE",
						model: {
							providerId: "openai-compatible",
							modelId: "gpt-4o-mini",
							baseUrl: api.url,
						},
					}),
				};
				const result = await runIsolated({
					definition,
					defaults: {
						providerId: "openai-compatible",
						modelId: "gpt-4o-mini",
						baseUrl: api.url,
					},
					directory: dir,
				});
				expect(result.status).toBe("failed");
				expect(result.llmJudge).toMatchObject({
					score: 65,
					status: "scored",
					baseStatus: "passed",
				});
				expect(api.requests).toHaveLength(2);
				expect(JSON.stringify(api.requests[0].body)).not.toContain(
					"PRIVATE REFERENCE",
				);
				expect(JSON.stringify(api.requests[1].body)).toContain(
					"PRIVATE REFERENCE",
				);
				expect(
					await readFile(path.join(dir, "suite.json"), "utf8"),
				).not.toContain("PRIVATE REFERENCE");
			} finally {
				api.server.stop(true);
			}
		}),
	30000,
);

test(
	"CLI evaluator isolates Judge-enabled cases, preserves advisory outcomes and separates scoring usage",
	async () =>
		temp(async (dir) => {
			const { runEvalSuite } = await import("../runner.js");
			const api = mockJudge((body) =>
				JSON.stringify(body).includes("reference-judge-v1")
					? {
							text: JSON.stringify({
								status: "scored",
								score: 35,
								rationale: "不足",
								evidence: [{ ref: "result.final_response" }],
							}),
						}
					: { text: "FINAL ACTOR" },
			);
			try {
				const suite = parseEvalSuite({
					defaults: {
						providerId: "openai-compatible",
						modelId: "gpt-4o-mini",
						baseUrl: api.url,
					},
					cases: [
						{
							id: "cli-judge",
							prompt: "QUESTION",
							replayMode: "function-call",
							functionCall: { tools: ["read_files"] },
							llmJudge: config({
								model: {
									providerId: "openai-compatible",
									modelId: "gpt-4o-mini",
									baseUrl: api.url,
								},
							}),
						},
					],
				});
				const previous = process.env.EVAL_DATA_DIR;
				process.env.EVAL_DATA_DIR = path.join(dir, "data");
				try {
					const report = await runEvalSuite({
						suite,
						suitePath: path.join(dir, "suite.json"),
						overrides: { stream: false },
					});
					expect(report.cases[0].status).toBe("passed");
					expect(report.cases[0].llmJudge?.score).toBe(35);
					expect(report.summary.judge).toMatchObject({
						expected: 1,
						scored: 1,
						inputTokens: 13,
						outputTokens: 7,
					});
					expect(report.summary.inputTokens).toBe(13);
					expect(api.requests).toHaveLength(2);
				} finally {
					if (previous === undefined) delete process.env.EVAL_DATA_DIR;
					else process.env.EVAL_DATA_DIR = previous;
				}
			} finally {
				api.server.stop(true);
			}
		}),
	30000,
);
