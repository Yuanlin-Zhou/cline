import { test, expect } from "bun:test";
import {
	previewConversations,
	conversationCaseIds,
} from "./batch-conversations.js";
import {
	historyImportExamples,
	clineHistoryExample,
} from "./history-import-examples.js";
const request = (files: any[]) => ({
	moduleId: "module",
	files,
	options: { tools: ["editor"], continuation: "继续" },
	defaults: {
		providerId: "openai-compatible",
		modelId: "mock",
		baseUrl: "http://localhost:8000/v1",
	},
	policy: "skip",
});
test("actual terminal user is used once; assistant/tool tails keep history and append continuation", () => {
	for (const e of historyImportExamples) {
		const p = previewConversations(
			request([{ filename: "case.json", content: e.value }]),
		);
		const c = p.suite.cases[0];
		expect(p.rows[0].appended).toBe(false);
		expect(c.prompt).toContain("world");
		expect(c.functionCall?.history?.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
		]);
	}
	const raw = structuredClone(clineHistoryExample) as any;
	raw.messages.push({ role: "assistant", content: "ANSWER_MUST_STAY" });
	const p = previewConversations(
		request([
			{
				filename: "complete.json",
				content: JSON.stringify(raw),
				continuation: "请继续处理",
			},
		]),
	);
	expect(p.rows[0].appended).toBe(true);
	expect(p.suite.cases[0].prompt).toBe("请继续处理");
	expect(p.suite.cases[0].functionCall?.history?.at(-1)?.content).toBe(
		"ANSWER_MUST_STAY",
	);
	expect(
		p.suite.cases[0].functionCall?.history?.some(
			(m) => m.role === "user" && m.content?.includes("world"),
		),
	).toBe(true);
	raw.messages.splice(-2);
	const tool = previewConversations(
		request([{ filename: "tool.json", content: JSON.stringify(raw) }]),
	);
	expect(tool.suite.cases[0].prompt).toBe("继续");
	expect(tool.suite.cases[0].functionCall?.history?.at(-1)?.role).toBe("tool");
});
test("supports no-question contexts, BOM and names while rejecting unfinished calls or invalid inputs", () => {
	const result = previewConversations(
		request([
			{
				filename: "assistant.json",
				content:
					'\uFEFF{"messages":[{"role":"assistant","content":"context"}]}',
			},
		]),
	);
	expect(result.rows[0].error).toBeUndefined();
	expect(result.suite.cases[0].prompt).toBe("继续");
	expect(conversationCaseIds(["x.json", "x.json", "x-2.json"])).toEqual([
		"x",
		"x-2",
		"x-2-2",
	]);
	const raw = structuredClone(clineHistoryExample) as any;
	raw.messages.splice(2);
	const p = previewConversations(
		request([
			{ filename: "bad.json", content: JSON.stringify(raw) },
			{ filename: "../bad.json", content: "{}" },
			{ filename: "bad.txt", content: "{}" },
		]),
	);
	expect(p.rows.every((r) => !!r.error)).toBe(true);
	expect(p.rows[0].error).toContain("缺少工具结果");
	expect(p.suite.cases).toHaveLength(0);
});
test("batch IDs, reasoning opt-in, Python rule and defaults snapshot are explicit", () => {
	const file = { filename: "x.json", content: historyImportExamples[1].value };
	const dup = previewConversations(
		request([
			{ ...file, caseId: "same" },
			{ ...file, caseId: "same" },
		]),
	);
	expect(dup.rows.every((r) => !!r.error)).toBe(true);
	const raw = JSON.parse(file.content);
	raw.messages[2].reasoning_content = "reason";
	const body = request([{ ...file, content: JSON.stringify(raw) }]) as any;
	expect(previewConversations(body).rows[0].error).toContain("思考");
	body.options.ignoreThinking = true;
	body.options.verifierId = "uploaded-python";
	const p = previewConversations(body);
	expect(p.rows[0].error).toBeUndefined();
	expect(JSON.stringify(p.suite)).not.toContain('"reason"');
	expect(p.suite.cases[0].grading?.rules[0]).toMatchObject({
		kind: "script",
		verifierId: "uploaded-python",
	});
	body.defaults.modelId = "changed";
	expect(p.suite.defaults.modelId).toBe("mock");
});
test("batch count, raw file, serialized payload and settings have bounded validation", () => {
	expect(() => previewConversations(request([]))).toThrow("1–100");
	expect(() =>
		previewConversations(request(Array.from({ length: 101 }, () => ({})))),
	).toThrow("1–100");
	const p = previewConversations(
		request([{ filename: "big.json", content: " ".repeat(1024 * 1024 + 1) }]),
	);
	expect(p.rows[0].error).toContain("1 MiB");
	expect(() =>
		previewConversations({
			...request([{ filename: "a.json", content: "{}" }]),
			options: { tools: ["editor"], continuation: "" },
		}),
	).toThrow("续接文案");
});
