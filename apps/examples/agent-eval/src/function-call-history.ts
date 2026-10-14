/** Provider-independent imports normalized to OpenAI Chat Completions history. */
export const HISTORY_BYTES = 1024 * 1024;
export const HISTORY_MESSAGES = 500;
export type NativeToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};
export type NativeHistoryMessage = {
	role: "system" | "developer" | "user" | "assistant" | "tool";
	content?: string | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: NativeToolCall[];
};
export type HistorySource = {
	format: "cline" | "openai" | "type-data";
	sessionId?: string;
	notices: string[];
	messages: Array<{
		index: number;
		sourceIndex: number;
		blockIndex?: number;
		id?: string;
	}>;
};
type ObjectValue = Record<string, any>;
const object = (v: unknown, at: string): ObjectValue => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw Error(`${at} 必须是对象`);
	return v as ObjectValue;
};
const text = (v: unknown, at: string) => {
	if (typeof v !== "string") throw Error(`${at} 必须是字符串`);
	return v;
};
const required = (v: unknown, at: string) => {
	const s = text(v, at);
	if (!s.trim()) throw Error(`${at} 不能为空`);
	return s;
};
function keys(v: ObjectValue, allowed: string[], at: string) {
	for (const key of Object.keys(v))
		if (!allowed.includes(key)) throw Error(`${at}.${key} 是不支持的字段`);
}
function size(v: unknown, at: string) {
	if (new TextEncoder().encode(JSON.stringify(v)).length > HISTORY_BYTES)
		throw Error(`${at} 超过 1 MiB 限制`);
}

/** JSON.parse accepts duplicate keys and overflows; reject both before importing. */
export function strictHistoryJson(source: string, at = "JSON"): any {
	let value: any;
	try {
		value = JSON.parse(source);
	} catch (e) {
		throw Error(
			`${at} 不是有效 JSON：${e instanceof Error ? e.message : String(e)}`,
		);
	}
	let i = 0;
	const ws = () => {
		while (/\s/.test(source[i] ?? "") && i < source.length) i++;
	};
	const string = () => {
		const start = i++;
		while (i < source.length) {
			if (source[i] === "\\") i += 2;
			else if (source[i++] === '"') break;
		}
		return JSON.parse(source.slice(start, i)) as string;
	};
	const scan = (path: string, depth = 0): void => {
		if (depth > 64) throw Error(`${path} JSON 嵌套过深`);
		ws();
		const ch = source[i];
		if (ch === "{") {
			i++;
			ws();
			const seen = new Set<string>();
			while (source[i] !== "}") {
				const k = string();
				if (seen.has(k)) throw Error(`${path}.${k} 存在重复 JSON 键`);
				seen.add(k);
				ws();
				i++;
				scan(`${path}.${k}`, depth + 1);
				ws();
				if (source[i] === ",") {
					i++;
					ws();
				} else break;
			}
			i++;
		} else if (ch === "[") {
			i++;
			ws();
			let n = 0;
			while (source[i] !== "]") {
				scan(`${path}[${n++}]`, depth + 1);
				ws();
				if (source[i] === ",") {
					i++;
					ws();
				} else break;
			}
			i++;
		} else if (ch === '"') string();
		else {
			const start = i;
			while (i < source.length && !/[\s,}\]]/.test(source[i])) i++;
			const literal = source.slice(start, i);
			if (
				!["true", "false", "null"].includes(literal) &&
				!Number.isFinite(Number(literal))
			)
				throw Error(`${path} 包含非有限数字`);
		}
	};
	scan(at);
	return value;
}

export function parseNativeHistory(
	value: unknown,
	at = "functionCall.history",
): NativeHistoryMessage[] {
	if (!Array.isArray(value) || value.length > HISTORY_MESSAGES)
		throw Error(`${at} 必须为不超过 ${HISTORY_MESSAGES} 条的消息数组`);
	size(value, at);
	const pending = new Set<string>(),
		used = new Set<string>();
	let instructions = true;
	return value.map((raw, index) => {
		const p = `${at}[${index}]`,
			m = object(raw, p);
		keys(m, ["role", "content", "name", "tool_calls", "tool_call_id"], p);
		if (!["system", "developer", "user", "assistant", "tool"].includes(m.role))
			throw Error(`${p}.role 不受支持`);
		const role = m.role as NativeHistoryMessage["role"];
		if ((role === "system" || role === "developer") && !instructions)
			throw Error(`${p} 系统指令只能位于历史前部`);
		if (role !== "system" && role !== "developer") instructions = false;
		if (pending.size && role !== "tool")
			throw Error(`${p} 缺少工具结果：${[...pending].join(", ")}`);
		const result: NativeHistoryMessage = { role };
		if (m.name !== undefined) result.name = required(m.name, `${p}.name`);
		if (m.content !== undefined)
			result.content =
				m.content === null && role === "assistant"
					? null
					: text(m.content, `${p}.content`);
		if (role === "tool") {
			if (m.tool_calls !== undefined)
				throw Error(`${p}.tool_calls 只能用于 assistant`);
			result.content = text(m.content, `${p}.content`);
			const id = required(m.tool_call_id, `${p}.tool_call_id`);
			if (!pending.delete(id))
				throw Error(
					`${p}.tool_call_id ${id} 没有对应的未完成调用（或结果重复）；上下文可能已压缩，请导入完整片段`,
				);
			result.tool_call_id = id;
		} else {
			if (m.tool_call_id !== undefined)
				throw Error(`${p}.tool_call_id 只能用于 tool`);
			if (m.tool_calls !== undefined) {
				if (
					role !== "assistant" ||
					!Array.isArray(m.tool_calls) ||
					!m.tool_calls.length
				)
					throw Error(`${p}.tool_calls 须为 assistant 的非空数组`);
				result.tool_calls = m.tool_calls.map((rawCall: unknown, n: number) => {
					const cp = `${p}.tool_calls[${n}]`,
						call = object(rawCall, cp);
					keys(call, ["id", "type", "function"], cp);
					const id = required(call.id, `${cp}.id`);
					if (used.has(id)) throw Error(`${cp}.id 调用 ID ${id} 重复`);
					used.add(id);
					pending.add(id);
					if (call.type !== "function")
						throw Error(`${cp}.type 必须为 function`);
					const fn = object(call.function, `${cp}.function`);
					keys(fn, ["name", "arguments"], `${cp}.function`);
					const args = text(fn.arguments, `${cp}.function.arguments`);
					object(
						strictHistoryJson(args, `${cp}.function.arguments`),
						`${cp}.function.arguments`,
					);
					return {
						id,
						type: "function",
						function: {
							name: required(fn.name, `${cp}.function.name`),
							arguments: args,
						},
					};
				});
			}
			if (
				!result.tool_calls &&
				(typeof result.content !== "string" || !result.content.trim())
			)
				throw Error(
					`${p}.content 不能为空；assistant 可以用 tool_calls 代替文本`,
				);
		}
		if (index === value.length - 1 && pending.size)
			throw Error(`${p} 历史结尾缺少工具结果：${[...pending].join(", ")}`);
		return result;
	});
}

export function parseHistorySource(value: unknown): HistorySource | undefined {
	if (value === undefined) return undefined;
	const v = object(value, "functionCall.historySource");
	keys(
		v,
		["format", "sessionId", "notices", "messages"],
		"functionCall.historySource",
	);
	if (
		!["cline", "openai", "type-data"].includes(v.format) ||
		!Array.isArray(v.notices) ||
		v.notices.some((n: unknown) => typeof n !== "string") ||
		!Array.isArray(v.messages) ||
		v.messages.length > HISTORY_MESSAGES
	)
		throw Error("functionCall.historySource 格式无效");
	size(v, "functionCall.historySource");
	const messages = v.messages.map((raw: unknown) => {
		const m = object(raw, "historySource.messages");
		keys(
			m,
			["index", "sourceIndex", "blockIndex", "id"],
			"historySource.messages",
		);
		for (const k of ["index", "sourceIndex", "blockIndex"])
			if (m[k] !== undefined && (!Number.isSafeInteger(m[k]) || m[k] < 0))
				throw Error(`historySource.${k} 必须为非负整数`);
		if (m.index === undefined || m.sourceIndex === undefined)
			throw Error("historySource 消息索引缺失");
		return {
			index: m.index,
			sourceIndex: m.sourceIndex,
			...(m.blockIndex !== undefined ? { blockIndex: m.blockIndex } : {}),
			...(m.id !== undefined ? { id: text(m.id, "historySource.id") } : {}),
		};
	});
	return {
		format: v.format,
		...(v.sessionId !== undefined
			? { sessionId: required(v.sessionId, "historySource.sessionId") }
			: {}),
		notices: [...v.notices],
		messages,
	};
}

export type HistoryDocument = {
	format: HistorySource["format"];
	messages: ObjectValue[];
	systemPrompt?: string;
	sessionId?: string;
	notices: string[];
	candidates: Array<{ index: number; text: string }>;
	hasThinking: boolean;
	hasInstructions: boolean;
};
function unpack(raw: unknown, at: string): ObjectValue {
	const m = object(raw, at);
	if (m.type !== undefined || m.data !== undefined) {
		keys(m, ["type", "data"], at);
		const data = object(m.data, `${at}.data`);
		if (data.role !== undefined && data.role !== m.type)
			throw Error(`${at}.type 与 data.role 不一致`);
		return { ...data, role: required(m.type, `${at}.type`) };
	}
	return m;
}
function plainUser(m: ObjectValue): string | undefined {
	if (m.role !== "user") return undefined;
	if (typeof m.content === "string")
		return m.content.trim() ? m.content : undefined;
	if (
		Array.isArray(m.content) &&
		m.content.length &&
		m.content.every(
			(b: any) => b?.type === "text" && typeof b.text === "string",
		)
	)
		return m.content.map((b: any) => b.text).join("\n") || undefined;
	return undefined;
}
export function readHistoryDocument(source: string): HistoryDocument {
	if (new TextEncoder().encode(source).length > HISTORY_BYTES)
		throw Error("粘贴内容超过 1 MiB 限制");
	const raw = strictHistoryJson(source),
		envelope = Array.isArray(raw) ? undefined : object(raw, "导入记录"),
		notices: string[] = [];
	if (envelope?.messages !== undefined && envelope.messgaes !== undefined)
		throw Error("messages 与 messgaes 不能同时存在");
	const list = Array.isArray(raw)
		? raw
		: (envelope!.messages ?? envelope!.messgaes);
	if (envelope?.messgaes !== undefined)
		notices.push("已将 messgaes 规范为 messages");
	if (!Array.isArray(list) || !list.length || list.length > HISTORY_MESSAGES)
		throw Error(`messages 须为 1 至 ${HISTORY_MESSAGES} 条消息数组`);
	const messages = list.map((m, i) => unpack(m, `messages[${i}]`));
	const cline =
		messages.some(
			(m) =>
				Array.isArray(m.content) &&
				m.content.some((b: any) => b?.type !== "text"),
		) ||
		envelope?.system_prompt !== undefined ||
		(envelope?.version === 1 && envelope?.agent !== undefined) ||
		messages.some(
			(m) =>
				Array.isArray(m.content) ||
				["id", "ts", "metadata", "modelInfo", "metrics", "sessionId"].some(
					(k) => m[k] !== undefined,
				),
		);
	const format = cline
		? "cline"
		: list.some((m) => m?.data !== undefined)
			? "type-data"
			: "openai";
	return {
		format,
		messages,
		notices,
		...(envelope?.system_prompt !== undefined
			? { systemPrompt: text(envelope.system_prompt, "system_prompt") }
			: {}),
		...(envelope?.sessionId !== undefined
			? { sessionId: required(envelope.sessionId, "sessionId") }
			: {}),
		candidates: messages.flatMap((m, index) => {
			const content = plainUser(m);
			return content !== undefined ? [{ index, text: content }] : [];
		}),
		hasThinking: messages.some(
			(m) =>
				Array.isArray(m.content) &&
				m.content.some((b: any) =>
					["thinking", "redacted_thinking"].includes(b?.type),
				),
		),
		hasInstructions: messages.some((m) =>
			["system", "developer"].includes(m.role),
		),
	};
}

export function convertHistoryDocument(
	doc: HistoryDocument,
	options: {
		currentIndex?: number;
		ignoreThinking?: boolean;
		systemSource?: "file" | "messages";
	} = {},
) {
	const notices = [...doc.notices],
		history: NativeHistoryMessage[] = [],
		refs: HistorySource["messages"] = [],
		aliases = new Map<string, string>();
	let prompt: string | undefined;
	if (options.currentIndex !== undefined) {
		const candidate = doc.candidates.find(
			(c) => c.index === options.currentIndex,
		);
		if (!candidate)
			throw Error("本轮输入必须选择纯文本用户消息，不能选择工具结果");
		const current = doc.messages[candidate.index];
		const p = `messages[${candidate.index}]`;
		keys(
			current,
			doc.format === "cline"
				? [
						"role",
						"content",
						"name",
						"id",
						"ts",
						"agent",
						"sessionId",
						"metadata",
						"modelInfo",
						"metrics",
					]
				: ["role", "content", "name"],
			p,
		);
		if (current.name !== undefined) {
			required(current.name, `${p}.name`);
			notices.push(`${p}.name 不随本轮文本问题发送`);
		}
		if (Array.isArray(current.content))
			current.content.forEach((b: unknown, n: number) => {
				keys(
					object(b, `${p}.content[${n}]`),
					["type", "text", "signature"],
					`${p}.content[${n}]`,
				);
			});
		prompt = candidate.text;
		notices.push(
			`第 ${candidate.index + 1} 条作为本轮输入，后续 ${doc.messages.length - candidate.index - 1} 条不导入`,
		);
	}
	const selected = doc.messages.slice(
		0,
		options.currentIndex ?? doc.messages.length,
	);
	const sessions = new Set(
		doc.messages
			.slice(
				0,
				options.currentIndex !== undefined
					? options.currentIndex + 1
					: doc.messages.length,
			)
			.map((m) => m.sessionId)
			.filter((s) => s !== undefined),
	);
	if (
		sessions.size > 1 ||
		(doc.sessionId && [...sessions].some((s) => s !== doc.sessionId))
	)
		throw Error("记录混杂不同 sessionId，请分别导入单个会话");
	if (
		doc.systemPrompt?.trim() &&
		selected.some((m) => ["system", "developer"].includes(m.role)) &&
		!options.systemSource
	)
		throw Error(
			"顶层 system_prompt 与消息中的系统指令同时存在，请选择指令来源",
		);
	const add = (
		m: NativeHistoryMessage,
		sourceIndex: number,
		blockIndex?: number,
	) => {
		refs.push({
			index: history.length,
			sourceIndex,
			...(blockIndex !== undefined ? { blockIndex } : {}),
			...(typeof doc.messages[sourceIndex]?.id === "string"
				? { id: doc.messages[sourceIndex].id }
				: {}),
		});
		history.push(m);
	};
	if (doc.systemPrompt?.trim() && options.systemSource !== "messages") {
		refs.push({ index: history.length, sourceIndex: 0 });
		history.push({ role: "system", content: doc.systemPrompt });
	}
	let dropped = 0;
	const blockText = (raw: unknown, p: string): string => {
		const b = object(raw, p);
		if (b.type === "text") {
			keys(b, ["type", "text", "signature"], p);
			if (b.signature !== undefined) {
				text(b.signature, `${p}.signature`);
				notices.push(`${p}.signature 不随跨模型文本回放发送`);
			}
			return text(b.text, `${p}.text`);
		}
		if (b.type === "file") {
			keys(b, ["type", "path", "content", "source"], p);
			notices.push(`${p} 文件块已转为内联文本，未读取路径`);
			return `[文件 ${text(b.path, `${p}.path`)}]\n${text(b.content, `${p}.content`)}`;
		}
		throw Error(`${p}.type ${String(b.type)} 暂不支持；图片/媒体不能静默省略`);
	};
	const rejectMedia = (v: unknown, p: string, depth = 0): void => {
		if (depth > 64) throw Error(`${p} 嵌套过深`);
		if (!v || typeof v !== "object") return;
		if (
			!Array.isArray(v) &&
			["image", "media", "audio", "video"].includes((v as any).type)
		)
			throw Error(`${p} 包含不支持的图片或媒体`);
		for (const [k, x] of Object.entries(v))
			rejectMedia(x, `${p}.${k}`, depth + 1);
	};
	selected.forEach((m, i) => {
		const p = `messages[${i}]`;
		if (
			["system", "developer"].includes(m.role) &&
			options.systemSource === "file"
		)
			return;
		if (doc.format !== "cline" || !Array.isArray(m.content)) {
			const allowed = ["role", "content", "name", "tool_calls", "tool_call_id"];
			if (doc.format === "cline")
				allowed.push(
					"id",
					"ts",
					"agent",
					"sessionId",
					"metadata",
					"modelInfo",
					"metrics",
				);
			keys(m, allowed, p);
			const cleaned = Object.fromEntries(
				Object.entries(m).filter(([k]) =>
					["role", "content", "name", "tool_calls", "tool_call_id"].includes(k),
				),
			) as NativeHistoryMessage;
			add(cleaned, i);
			return;
		}
		keys(
			m,
			[
				"role",
				"content",
				"id",
				"ts",
				"agent",
				"sessionId",
				"metadata",
				"modelInfo",
				"metrics",
			],
			p,
		);
		if (m.role !== "user" && m.role !== "assistant")
			throw Error(`${p}.role 原生内容块仅支持 user/assistant`);
		let texts: string[] = [];
		const calls: NativeToolCall[] = [];
		const flush = () => {
			if (texts.length) {
				add({ role: m.role, content: texts.join("\n") }, i);
				texts = [];
			}
		};
		m.content.forEach((raw: unknown, j: number) => {
			const bp = `${p}.content[${j}]`,
				b = object(raw, bp);
			if (["thinking", "redacted_thinking"].includes(b.type)) {
				if (m.role !== "assistant")
					throw Error(`${bp} 思考块只能用于 assistant`);
				if (!options.ignoreThinking)
					throw Error(`${bp} 含思考块，请明确选择“不发送思考块”后继续`);
				dropped++;
				return;
			}
			if (b.type === "tool_use") {
				if (m.role !== "assistant")
					throw Error(`${bp} tool_use 只能用于 assistant`);
				keys(b, ["type", "id", "call_id", "name", "input", "signature"], bp);
				const internal = required(b.id, `${bp}.id`),
					id =
						b.call_id !== undefined
							? required(b.call_id, `${bp}.call_id`)
							: internal;
				if (b.signature !== undefined) {
					text(b.signature, `${bp}.signature`);
					notices.push(`${bp}.signature 不随兼容工具轨迹发送`);
				}
				for (const alias of new Set([internal, id])) {
					if (aliases.has(alias))
						throw Error(`${bp} 调用 ID/别名 ${alias} 重复或有歧义`);
					aliases.set(alias, id);
				}
				calls.push({
					id,
					type: "function",
					function: {
						name: required(b.name, `${bp}.name`),
						arguments: JSON.stringify(object(b.input, `${bp}.input`)),
					},
				});
				return;
			}
			if (b.type === "tool_result") {
				if (m.role !== "user") throw Error(`${bp} tool_result 只能用于 user`);
				keys(b, ["type", "tool_use_id", "name", "content", "is_error"], bp);
				required(b.name, `${bp}.name`);
				if (b.is_error !== undefined && typeof b.is_error !== "boolean")
					throw Error(`${bp}.is_error 必须为布尔值`);
				flush();
				const original = required(b.tool_use_id, `${bp}.tool_use_id`);
				const id = aliases.get(original);
				if (!id)
					throw Error(
						`${bp}.tool_use_id ${original} 缺少前文调用，记录可能已压缩`,
					);
				let content: string;
				if (typeof b.content === "string") content = b.content;
				else if (
					Array.isArray(b.content) &&
					b.content.every((x: any) => ["text", "file"].includes(x?.type))
				)
					content = b.content
						.map((x: any, n: number) => blockText(x, `${bp}.content[${n}]`))
						.join("\n");
				else {
					if (b.content === undefined) throw Error(`${bp}.content 缺失`);
					rejectMedia(b.content, `${bp}.content`);
					content = JSON.stringify(b.content);
					notices.push(`${bp} 结构化工具结果已编码为完整 JSON 文本`);
				}
				if (b.is_error)
					notices.push(`${bp} 原工具结果标记为错误（is_error=true）`);
				add({ role: "tool", tool_call_id: id, content }, i, j);
				return;
			}
			texts.push(blockText(b, bp));
		});
		if (calls.length) {
			add(
				{
					role: "assistant",
					content: texts.length ? texts.join("\n") : null,
					tool_calls: calls,
				},
				i,
			);
			texts = [];
		} else flush();
	});
	if (dropped)
		notices.push(`按用户选择省略 ${dropped} 个思考块，不发送思考及签名`);
	if (doc.format === "cline")
		notices.push(
			"Cline 消息元数据不发送给模型；这是上下文转换，不是原 SDK 请求逐字节重放",
		);
	if (history.some((m) => m.role === "developer"))
		notices.push("包含 developer 指令，目标模型服务须支持该角色");
	if (history.at(-1)?.role === "assistant")
		notices.push("历史结尾包含助手回复，请确认它属于历史而非待验证答案");
	const normalized = parseNativeHistory(history, "转换后的 messages");
	const source: HistorySource = {
		format: doc.format,
		...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
		notices: [...new Set(notices)],
		messages: refs,
	};
	return {
		history: normalized,
		source,
		prompt,
		originalCount: doc.messages.length,
	};
}
