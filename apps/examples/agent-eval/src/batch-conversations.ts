import {
	convertHistoryDocument,
	readHistoryDocument,
	HISTORY_BYTES,
	type HistorySource,
} from "./function-call-history.js";
import {
	parseFunctionCall,
	type FunctionCallConfig,
} from "./function-call-config.js";
import { parseEvalSuite } from "./schema.js";
import type { EvalCase, EvalDefaults, EvalSuite } from "./types.js";

export const BATCH_FILE_LIMIT = 100;
export const BATCH_BYTE_LIMIT = 20 * 1024 * 1024;
export type ConversationFile = {
	filename: string;
	content: string;
	caseId?: string;
	continuation?: string;
	systemSource?: "file" | "messages";
};
export type BatchConversationOptions = {
	tools: FunctionCallConfig["tools"];
	toolChoice?: FunctionCallConfig["toolChoice"];
	continuation?: string;
	ignoreThinking?: boolean;
	verifierId?: string;
};
export type BatchConversationRequest = {
	moduleId: string;
	files: ConversationFile[];
	options: BatchConversationOptions;
	defaults: EvalDefaults;
	policy: "skip" | "version";
};
export type ConversationPreview = {
	index: number;
	filename: string;
	caseId: string;
	error?: string;
	definition?: EvalCase;
	appended?: boolean;
	originalCount?: number;
	duplicate?: boolean;
	source?: HistorySource;
};
export type BatchConversationPreview = {
	rows: ConversationPreview[];
	suite: EvalSuite;
	warnings: string[];
};
const bytes = (v: string) => new TextEncoder().encode(v).length;
const record = (v: unknown, at: string): Record<string, any> => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw Error(`${at} 必须为对象`);
	return v as Record<string, any>;
};
const only = (v: Record<string, any>, allowed: string[], at: string) => {
	for (const k of Object.keys(v))
		if (!allowed.includes(k)) throw Error(`${at}.${k} 是不支持的字段`);
};
const nonempty = (v: unknown, at: string) => {
	if (typeof v !== "string" || !v.trim()) throw Error(`${at} 不能为空`);
	return v;
};

/** Visible, deterministic names for repeated filenames; manual duplicate IDs still fail. */
export function conversationCaseIds(filenames: string[]): string[] {
	const used = new Set<string>();
	return filenames.map((name, index) => {
		const base = name.replace(/\.json$/i, "").trim() || `case-${index + 1}`;
		let id = base,
			n = 2;
		while (used.has(id)) id = `${base}-${n++}`;
		used.add(id);
		return id;
	});
}

export function previewConversations(input: unknown): BatchConversationPreview {
	const body = record(input, "导入请求");
	only(
		body,
		["moduleId", "files", "options", "defaults", "policy"],
		"导入请求",
	);
	nonempty(body.moduleId, "目标模块");
	if (!["skip", "version"].includes(body.policy))
		throw Error("同名处理须为 skip 或 version");
	if (
		!Array.isArray(body.files) ||
		!body.files.length ||
		body.files.length > BATCH_FILE_LIMIT
	)
		throw Error(`每批请选择 1–${BATCH_FILE_LIMIT} 个 JSON 文件`);
	if (bytes(JSON.stringify(body)) > BATCH_BYTE_LIMIT)
		throw Error("导入请求超过 20 MiB，请减少文件数量");
	const opts = record(body.options, "公共设置");
	only(
		opts,
		["tools", "toolChoice", "continuation", "ignoreThinking", "verifierId"],
		"公共设置",
	);
	const functionConfig = parseFunctionCall({
		tools: opts.tools,
		toolChoice: opts.toolChoice,
	});
	const continuation =
		opts.continuation === undefined
			? "继续"
			: nonempty(opts.continuation, "统一续接文案");
	if (
		opts.ignoreThinking !== undefined &&
		typeof opts.ignoreThinking !== "boolean"
	)
		throw Error("思考处理开关须为布尔值");
	if (opts.verifierId !== undefined) nonempty(opts.verifierId, "Python 验证器");
	const defaults = parseEvalSuite({
		defaults: record(body.defaults, "运行配置"),
		cases: [{ id: "defaults", prompt: "defaults" }],
	}).defaults;
	let total = 0;
	for (const [i, raw] of body.files.entries()) {
		const f = record(raw, `files[${i}]`);
		if (typeof f.content !== "string")
			throw Error(`files[${i}].content 必须为文本`);
		total += bytes(f.content);
	}
	if (total > BATCH_BYTE_LIMIT)
		throw Error("文件内容合计超过 20 MiB，请减少文件数量");
	const names = conversationCaseIds(
		body.files.map((f: any, i: number) =>
			typeof f.filename === "string" ? f.filename : `case-${i + 1}.json`,
		),
	);
	const rows: ConversationPreview[] = body.files.map(
		(raw: unknown, index: number) => {
			const row: ConversationPreview = {
				index,
				filename: String((raw as any).filename ?? `文件 ${index + 1}`),
				caseId: String((raw as any).caseId ?? names[index]),
			};
			try {
				const f = record(raw, `files[${index}]`);
				only(
					f,
					["filename", "content", "caseId", "continuation", "systemSource"],
					`files[${index}]`,
				);
				const filename = nonempty(f.filename, "文件名");
				if (
					filename.length > 240 ||
					/[\\/\x00-\x1f]/.test(filename) ||
					!filename.toLowerCase().endsWith(".json")
				)
					throw Error("请选择独立 .json 文件，文件名不能包含路径");
				const caseId = nonempty(f.caseId ?? names[index], "案例 ID").trim();
				row.caseId = caseId;
				if (bytes(f.content) > HISTORY_BYTES)
					throw Error("文件超过 1 MiB 限制");
				if (
					f.systemSource !== undefined &&
					!["file", "messages"].includes(f.systemSource)
				)
					throw Error("系统指令来源必须为 file 或 messages");
				if (f.continuation !== undefined)
					nonempty(f.continuation, "本文件续接文案");
				const doc = readHistoryDocument(f.content.replace(/^\uFEFF/, ""));
				// Only the ACTUAL final user message becomes the prompt. Never search backwards.
				const last = doc.candidates.find(
					(c) => c.index === doc.messages.length - 1,
				);
				const converted = convertHistoryDocument(doc, {
					...(last ? { currentIndex: last.index } : {}),
					ignoreThinking: opts.ignoreThinking,
					...(f.systemSource ? { systemSource: f.systemSource } : {}),
				});
				if (last) {
					converted.source.notices = converted.source.notices.filter(
						(n) => !n.startsWith(`第 ${last.index + 1} 条作为本轮输入`),
					);
					converted.source.notices.push(
						"实际末条用户消息作为本轮输入；原对话顺序完整保留，未追加续接消息",
					);
				} else
					converted.source.notices.push(
						"完整保留历史，自动追加用户消息作为本轮输入",
					);
				const prompt = last
					? converted.prompt!
					: (f.continuation ?? continuation);
				row.definition = parseEvalSuite({
					defaults,
					cases: [
						{
							id: caseId,
							description: `来源文件：${filename}`,
							replayMode: "function-call",
							history: [],
							prompt,
							functionCall: {
								...functionConfig,
								history: converted.history,
								historySource: converted.source,
							},
							...(opts.verifierId
								? {
										grading: {
											version: 1,
											rules: [
												{
													id: "function-call",
													kind: "script",
													verifierId: opts.verifierId,
													required_inputs: ["execution", "diagnostics"],
												},
											],
										},
									}
								: {}),
						},
					],
				}).cases[0];
				row.appended = !last;
				row.originalCount = doc.messages.length;
				row.source = converted.source;
			} catch (error) {
				row.error = `${row.filename}：${error instanceof Error ? error.message : String(error)}`;
			}
			return row;
		},
	);
	const counts = new Map<string, number>();
	for (const r of rows) counts.set(r.caseId, (counts.get(r.caseId) ?? 0) + 1);
	for (const r of rows)
		if ((counts.get(r.caseId) ?? 0) > 1) {
			r.error = `${r.filename}：本批案例 ID ${r.caseId} 重复，请修改`;
			delete r.definition;
		}
	const warnings: string[] = [];
	if (defaults.providerId !== "openai-compatible" || !defaults.baseUrl)
		warnings.push(
			"当前模型配置需要调整为 OpenAI-compatible 并填写 baseUrl 后才能运行；导入会保留此配置快照",
		);
	if (!opts.verifierId)
		warnings.push("未绑定 Python 验证器：本次仅创建案例，尚未配置自动判定");
	return {
		rows,
		suite: {
			version: 1,
			defaults,
			cases: rows.flatMap((r) =>
				r.error || !r.definition ? [] : [r.definition],
			),
		},
		warnings,
	};
}
