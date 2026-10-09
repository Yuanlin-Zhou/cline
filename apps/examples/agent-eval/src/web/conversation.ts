import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { redactValue } from "../grading/evidence.js";
import type { RunItem } from "./types.js";
import { within } from "./workspace.js";

export type ConversationBlock = { type: string; text: string; toolName?: string; toolCallId?: string };
export type ConversationMessage = { id: string; index: number; role: string; timestamp?: string; blocks: ConversationBlock[] };
export type Conversation = {
	sessionId?: string; source: "sdk-session"; status: "ready" | "pending" | "missing" | "unavailable";
	notice: string; updatedAt?: string; messages: ConversationMessage[]; total: number; nextOffset?: number;
};

const contentText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
function blocks(content: unknown): ConversationBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [{ type: "unknown", text: contentText(content) }];
	return content.map(value => {
		if (!value || typeof value !== "object") return { type: "unknown", text: contentText(value) };
		const block = value as Record<string, unknown>; const type = String(block.type ?? "unknown");
		const media = ["image", "file", "audio", "video"].includes(type);
		return {
			type, text: media ? `（${type} 内容不在文本视图展示）` : contentText(block.text ?? block.input ?? block.output ?? block.result ?? block.content ?? block),
			...(typeof block.toolName === "string" ? { toolName: block.toolName } : typeof block.name === "string" ? { toolName: block.name } : {}),
			...(typeof block.toolCallId === "string" ? { toolCallId: block.toolCallId } : typeof block.id === "string" ? { toolCallId: block.id } : {}),
		};
	});
}

// Read only the owning item's fixed session location, never a client path or a manifest path.
export async function readConversation(directory: string, item: RunItem, options: { offset?: number; limit?: number; download?: boolean; secrets?: string[] } = {}): Promise<Conversation> {
	const sessionId = item.sessionId ?? item.result?.sessionId;
	const active = ["queued", "running"].includes(item.status);
	const empty = (status: Conversation["status"], notice: string): Conversation => ({ source: "sdk-session", sessionId, status, notice, messages: [], total: 0 });
	if (!sessionId) return empty(active ? "pending" : "missing", active ? "会话尚未建立。" : "这次执行没有记录会话 ID；仍可查看结果和已有输出。");
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return empty("unavailable", "会话标识无效，无法读取记录。");
	const file = path.join(directory, "session", "sessions", sessionId, `${sessionId}.messages.json`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const root = await realpath(directory); const target = await realpath(file);
		if (!within(root, target)) return empty("unavailable", "会话文件路径越界，未读取。");
		handle = await open(target, "r"); const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return empty("unavailable", "会话文件超过 32 MiB 读取限制或不是普通文件，请在本地查看。");
		const bytes = Buffer.alloc(stat.size + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead > stat.size) return empty("pending", "会话记录正在更新，请稍后重试。");
		let payload: unknown;
		try { payload = redactValue(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), options.secrets ?? []); }
		catch { return empty(active ? "pending" : "unavailable", active ? "会话记录正在写入，请稍后重试。" : "会话记录格式不完整，仍可查看最终结果和已有输出。"); }
		if (!payload || typeof payload !== "object" || !Array.isArray((payload as { messages?: unknown }).messages)) return empty("unavailable", "会话记录格式不受支持，仍可查看最终结果和已有输出。");
		const raw = payload as { sessionId?: unknown; messages: unknown[]; updated_at?: unknown };
		if (raw.sessionId !== undefined && raw.sessionId !== sessionId) return empty("unavailable", "会话记录与本次执行不匹配，未读取。");
		const offset = options.offset ?? 0; const limit = options.download ? raw.messages.length : options.limit ?? 50;
		const messages = raw.messages.slice(offset, offset + limit).map((value, index): ConversationMessage => {
			const message = value && typeof value === "object" ? value as Record<string, unknown> : {};
			return { id: `${sessionId}:${offset + index}`, index: offset + index, role: typeof message.role === "string" ? message.role : "unknown", blocks: blocks(message.content), ...(typeof message.timestamp === "string" ? { timestamp: message.timestamp } : {}) };
		});
		return { source: "sdk-session", sessionId, status: "ready", notice: "来自本次执行保存的会话上下文；新消息在保存后出现，压缩后的上下文可能不包含全部早期消息。工具请求与结果记录不作为实际执行的判分证据。", messages, total: raw.messages.length, ...(typeof raw.updated_at === "string" ? { updatedAt: raw.updated_at } : {}), ...(offset + messages.length < raw.messages.length ? { nextOffset: offset + messages.length } : {}) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(active ? "pending" : "missing", active ? "等待会话记录保存；可先查看最近活动。" : "会话文件不存在或已清理；仍可查看结果和已有输出。");
		return empty("unavailable", "会话记录暂时无法读取，请重试或在本地查看。");
	} finally { await handle?.close(); }
}
