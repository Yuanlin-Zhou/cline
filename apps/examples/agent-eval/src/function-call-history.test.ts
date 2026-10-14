import { test, expect } from "bun:test";
import {
	readHistoryDocument,
	convertHistoryDocument,
	parseNativeHistory,
	strictHistoryJson,
	HISTORY_BYTES,
} from "./function-call-history.js";
import {
	historyImportExamples,
	clineHistoryExample,
} from "./history-import-examples.js";
import { parseFunctionCall } from "./function-call-config.js";
import { parseEvalSuite } from "./schema.js";
import {
	caseToDocument,
	caseFromDocument,
	caseValidator,
} from "./web/mongo-schema.js";

const native = () => structuredClone(clineHistoryExample) as any;
test("reasoning_content accepts empty fields and requires consent for actual reasoning across formats", () => {
	for (const example of historyImportExamples) {
		for (const value of [null, "", "\n", "private reasoning"]) {
			const raw = JSON.parse(example.value);
			const index = example.label === "Cline 原生记录" ? 1 : 2;
			const message = raw.messages[index].data ?? raw.messages[index];
			message.reasoning_content = value;
			const doc = readHistoryDocument(JSON.stringify(raw));
			expect(doc.hasThinking).toBe(value === "private reasoning");
			if (doc.hasThinking)
				expect(() => convertHistoryDocument(doc)).toThrow(
					`messages[${index}].reasoning_content`,
				);
			const imported = convertHistoryDocument(doc, {
				ignoreThinking: doc.hasThinking,
			});
			expect(JSON.stringify(imported.history)).not.toContain(
				"reasoning_content",
			);
			expect(JSON.stringify(imported)).not.toContain("private reasoning");
			expect(
				imported.history.some((m) => m.tool_calls?.[0].id === "call_1"),
			).toBe(true);
			expect(
				parseFunctionCall({
					tools: ["editor"],
					history: imported.history,
					historySource: imported.source,
				}).history,
			).toEqual(imported.history);
		}
	}
});

test("reasoning_content validates type and role without changing tool-chain requirements", () => {
	for (const value of [false, 1, {}, []]) {
		const raw = JSON.parse(historyImportExamples[1].value);
		raw.messages[2].reasoning_content = value;
		expect(() =>
			convertHistoryDocument(readHistoryDocument(JSON.stringify(raw)), {
				ignoreThinking: true,
			}),
		).toThrow("必须为字符串或 null");
	}
	const wrongRole = native();
	wrongRole.messages[0].reasoning_content = "";
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(wrongRole))),
	).toThrow("只能用于 assistant");
	const pending = JSON.parse(historyImportExamples[1].value);
	pending.messages[2].reasoning_content = "\n";
	pending.messages.splice(3);
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(pending))),
	).toThrow("结尾缺少工具结果");
});

test("selected current question is validated; only later messages are excluded", () => {
	const raw = native();
	raw.messages[3].content[0].unexpected = "bad";
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(raw)), {
			currentIndex: 3,
		}),
	).toThrow("unexpected");
	delete raw.messages[3].content[0].unexpected;
	raw.messages[3].sessionId = "other";
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(raw)), {
			currentIndex: 3,
		}),
	).toThrow("sessionId");
	expect(() =>
		convertHistoryDocument(
			readHistoryDocument(historyImportExamples[0].value),
			{ currentIndex: 2 },
		),
	).toThrow("不能选择工具结果");
});

test("standard arguments preserve original whitespace and tool results are never rearranged", () => {
	const standard = JSON.parse(historyImportExamples[1].value);
	standard.messages[2].tool_calls[0].function.arguments =
		'  { "paths" : [ "demo.py" ] }  ';
	const converted = convertHistoryDocument(
		readHistoryDocument(JSON.stringify(standard)),
	);
	expect(converted.history[2].tool_calls?.[0].function.arguments).toBe(
		'  { "paths" : [ "demo.py" ] }  ',
	);
	const raw = native();
	raw.messages[2].content.unshift({
		type: "text",
		text: "illegal before tool result",
	});
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(raw))),
	).toThrow("缺少工具结果");
});

test("three formats convert and select current question without leaking future replies", () => {
	for (const example of historyImportExamples) {
		const doc = readHistoryDocument(example.value),
			last = doc.candidates.at(-1)!;
		const converted = convertHistoryDocument(doc, { currentIndex: last.index });
		expect(converted.history.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
		]);
		expect(converted.history[2].tool_calls?.[0].id).toBe("call_1");
		expect(converted.history[3].tool_call_id).toBe("call_1");
		expect(converted.history[3].content).toBe("print('hello')\n");
		expect(converted.prompt).toContain("world");
	}
	const raw = native();
	raw.messages.push({ role: "assistant", content: "FUTURE_SECRET_ANSWER" });
	const doc = readHistoryDocument(JSON.stringify(raw));
	const chosen = convertHistoryDocument(doc, { currentIndex: 3 });
	expect(JSON.stringify(chosen)).not.toContain("FUTURE_SECRET_ANSWER");
	expect(chosen.source.messages.map((m) => m.id).filter(Boolean)).not.toContain(
		"m4",
	);
	const config = parseFunctionCall({
		tools: ["editor"],
		history: chosen.history,
		historySource: chosen.source,
	});
	expect(config.historySource?.sessionId).toBe("original-session");
	const c = parseEvalSuite({
		cases: [
			{
				id: "native",
				replayMode: "function-call",
				prompt: chosen.prompt,
				functionCall: config,
			},
		],
	}).cases[0];
	const docMongo = caseToDocument({
		id: "saved",
		moduleId: "module",
		definition: c,
		defaults: { providerId: "openai-compatible", modelId: "test" },
		revision: 1,
		updatedAt: new Date().toISOString(),
	});
	expect(caseFromDocument(docMongo).definition.functionCall).toEqual(config);
	expect(
		caseValidator.$jsonSchema.properties.definition.properties.functionCall
			.properties.history,
	).toBeDefined();
});

test("parallel calls, provider aliases, structured error results and inline files", () => {
	const raw = native();
	raw.messages[1].content.push({
		type: "tool_use",
		id: "internal_2",
		call_id: "call_2",
		name: "other_historical_tool",
		input: { flag: false, count: 2 },
	});
	raw.messages[2].content.unshift({
		type: "tool_result",
		tool_use_id: "call_2",
		name: "other_historical_tool",
		content: [{ query: "test", result: { success: false, count: 0 } }],
		is_error: true,
	});
	raw.messages[2].content.push({ type: "text", text: "继续编辑。" });
	raw.messages[0].content.push({
		type: "file",
		path: "/never-read/demo.py",
		content: "inline only",
	});
	const converted = convertHistoryDocument(
		readHistoryDocument(JSON.stringify(raw)),
		{ currentIndex: 3 },
	);
	expect(converted.history.map((m) => m.role)).toEqual([
		"system",
		"user",
		"assistant",
		"tool",
		"tool",
		"user",
	]);
	expect(converted.history[3].tool_call_id).toBe("call_2");
	expect(JSON.parse(converted.history[3].content!)).toEqual([
		{ query: "test", result: { success: false, count: 0 } },
	]);
	expect(converted.history[1].content).toContain("inline only");
	expect(converted.source.notices.join("\n")).toContain("is_error=true");
});

test("thinking requires explicit consent; multimodal and ambiguous sessions reject", () => {
	const raw = native();
	raw.messages[1].content.unshift({
		type: "thinking",
		thinking: "private reasoning",
		signature: "signed",
	});
	const doc = readHistoryDocument(JSON.stringify(raw));
	expect(doc.hasThinking).toBe(true);
	expect(() => convertHistoryDocument(doc)).toThrow("不发送思考块");
	const clean = convertHistoryDocument(doc, { ignoreThinking: true });
	expect(JSON.stringify(clean)).not.toContain("private reasoning");
	expect(JSON.stringify(clean.history)).not.toContain("signed");
	raw.messages[2].content[0].content = [
		{ type: "image", data: "base64", mediaType: "image/png" },
	];
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(raw)), {
			ignoreThinking: true,
		}),
	).toThrow("图片");
	const mixed = native();
	mixed.messages[0].sessionId = "other";
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(mixed))),
	).toThrow("sessionId");
});

test("reject duplicate keys, invalid wrappers, orphan/unfinished/duplicate calls and ID collisions", () => {
	expect(() => strictHistoryJson('{"a":1,"a":2}')).toThrow("重复");
	expect(() => strictHistoryJson('{"a":1e400}')).toThrow("非有限");
	expect(() => readHistoryDocument('{"messages":[],"messgaes":[]}')).toThrow(
		"同时",
	);
	expect(() =>
		readHistoryDocument(
			'{"messages":[{"type":"user","data":{"role":"assistant","content":"x"}}]}',
		),
	).toThrow("不一致");
	const misspelled = readHistoryDocument(
		'{"messgaes":[{"type":"user","data":{"content":"x"}}]}',
	);
	expect(convertHistoryDocument(misspelled).source.notices[0]).toContain(
		"messgaes",
	);
	const raw = native();
	raw.messages[2].content[0].tool_use_id = "missing";
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(raw))),
	).toThrow("已压缩");
	const truncated = native();
	truncated.messages.splice(2);
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(truncated))),
	).toThrow("结尾缺少");
	const collision = native();
	collision.messages[1].content.push({
		type: "tool_use",
		id: "call_1",
		name: "read_files",
		input: {},
	});
	expect(() =>
		convertHistoryDocument(readHistoryDocument(JSON.stringify(collision))),
	).toThrow("歧义");
	const standard = convertHistoryDocument(
		readHistoryDocument(historyImportExamples[1].value),
	).history;
	const bad = structuredClone(standard);
	bad[2].tool_calls![0].function.arguments = '{"x":1,"x":2}';
	expect(() => parseNativeHistory(bad)).toThrow("重复 JSON");
	const repeated = structuredClone(standard);
	repeated.splice(4, 0, repeated[3]);
	expect(() => parseNativeHistory(repeated)).toThrow("重复");
	expect(() => readHistoryDocument(" ".repeat(HISTORY_BYTES + 1))).toThrow(
		"1 MiB",
	);
	expect(() =>
		parseNativeHistory(
			Array.from({ length: 501 }, () => ({ role: "user", content: "x" })),
		),
	).toThrow("500");
});

test("system source conflict is explicit; legacy histories and strict saved contracts remain compatible", () => {
	const raw = native();
	raw.messages.unshift({ role: "system", content: "embedded system" });
	const doc = readHistoryDocument(JSON.stringify(raw));
	expect(() => convertHistoryDocument(doc)).toThrow("选择指令来源");
	expect(
		convertHistoryDocument(doc, { systemSource: "file" })
			.history.filter((m) => m.role === "system")
			.map((m) => m.content),
	).toEqual([clineHistoryExample.system_prompt]);
	expect(
		convertHistoryDocument(doc, { systemSource: "messages" }).history[0]
			.content,
	).toBe("embedded system");
	expect(parseFunctionCall({ tools: ["editor"] }).history).toBeUndefined();
	expect(() =>
		parseFunctionCall({
			tools: ["editor"],
			historySource: { format: "cline", notices: [], messages: [] },
		}),
	).toThrow("完整原生历史");
	expect(() =>
		parseNativeHistory([{ role: "user", content: "x", unknown: 1 }]),
	).toThrow("unknown");
	expect(() =>
		parseNativeHistory([
			{ role: "user", content: "x" },
			{ role: "system", content: "late" },
		]),
	).toThrow("前部");
});
