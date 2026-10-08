import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import path from "node:path";
import { ClineCore, type CoreSessionEvent } from "@cline/sdk";
import { runEvalSuite } from "./runner.js";
import { parseEvalSuite } from "./schema.js";

afterEach(() => mock.restore());

function fixture() {
	const start = mock(async (_input: unknown) => ({
		result: {
			text: "Use Bun",
			finishReason: "completed",
			durationMs: 10,
			iterations: 1,
			usage: { inputTokens: 3, outputTokens: 2 },
			toolCalls: [],
		},
	}));
	const dispose = mock(async () => {});
	const unsubscribe = mock(() => {});
	let listener: ((event: CoreSessionEvent) => void) | undefined;
	spyOn(ClineCore, "create").mockResolvedValue({
		start,
		stop: mock(async () => {}),
		dispose,
		subscribe: (callback: (event: CoreSessionEvent) => void) => {
			listener = callback;
			return unsubscribe;
		},
	} as unknown as ClineCore);
	return {
		start,
		dispose,
		unsubscribe,
		emit: (event: CoreSessionEvent) => listener?.(event),
	};
}

describe("runEvalSuite", () => {
	test("single-turn disables inherited and overridden tools and limits execution to one response", async () => {
		const runtime = fixture();
		await runEvalSuite({
			suite: parseEvalSuite({ defaults: { tools: "full", maxIterations: 30 }, cases: [{ id: "single", replayMode: "single-turn", prompt: "hello", tools: "full", maxIterations: 20 }] }),
			suitePath: path.resolve("suite.json"), overrides: { stream: false, tools: "full" },
		});
		expect(runtime.start.mock.calls[0]?.[0]).toMatchObject({ config: { enableTools: false, maxIterations: 1 }, toolPolicies: { "*": { enabled: false } } });
	});

	test("seeds history and returns structured results using read-only policies", async () => {
		const runtime = fixture();
		const suite = parseEvalSuite({
			cases: [
				{
					id: "context",
					replayMode: "full-task",
					history: [
						{ role: "user", content: "Use Bun" },
						{ role: "assistant", content: "OK" },
					],
					prompt: "Which package manager?",
					assertions: { contains: ["Bun"] },
				},
			],
		});
		const result = await runEvalSuite({
			suite,
			suitePath: path.resolve("suite.json"),
			overrides: { stream: false },
		});
		expect(runtime.start.mock.calls[0]?.[0]).toMatchObject({
			initialMessages: suite.cases[0].history,
			prompt: suite.cases[0].prompt,
			config: { enableTools: true, enableSpawnAgent: false },
			toolPolicies: { "*": { enabled: false }, read_files: { enabled: true } },
		});
		expect(result.summary).toMatchObject({
			passed: 1,
			failed: 0,
			inputTokens: 3,
			outputTokens: 2,
		});
		expect(result.cases[0].text).toBe("Use Bun");
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(runtime.unsubscribe).toHaveBeenCalledTimes(1);
	});

	test("continues after case failure and resolves CLI cwd from the terminal", async () => {
		const runtime = fixture();
		runtime.start.mockRejectedValueOnce(new Error("provider unavailable"));
		const result = await runEvalSuite({
			suite: parseEvalSuite({
				cases: [
					{ id: "one", prompt: "one" },
					{ id: "two", prompt: "two" },
				],
			}),
			suitePath: path.resolve("nested/suite.json"),
			overrides: { stream: false, cwd: "my-workspace" },
		});
		expect(result.cases[0].error).toBe("provider unavailable");
		expect(result.summary).toMatchObject({ passed: 1, failed: 1 });
		expect(runtime.start.mock.calls[1]?.[0]).toMatchObject({
			config: { cwd: path.resolve("my-workspace") },
		});
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
	});

	test("streams current SDK text events without duplicating final content", async () => {
		const runtime = fixture();
		const write = spyOn(process.stderr, "write").mockReturnValue(true);
		await runEvalSuite({
			suite: parseEvalSuite({ cases: [{ id: "stream", prompt: "hello" }] }),
			suitePath: path.resolve("suite.json"),
			overrides: { stream: true },
			onCaseStart: () =>
				runtime.emit({
					type: "agent_event",
					payload: {
						sessionId: "test",
						event: {
							type: "content_start",
							contentType: "text",
							text: "hello",
							id: "text-1",
						},
					},
				} as CoreSessionEvent),
		});
		expect(write).toHaveBeenCalledWith("hello");
	});
});
