import { readSessionInput } from "../grading/session-input.js";
import type { RunItem } from "./types.js";

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
	const input = await readSessionInput(directory, sessionId, active, options.secrets);
	if (input.status !== "ready") return empty(input.status, input.notice);
	const offset = options.offset ?? 0; const limit = options.download ? input.messages.length : options.limit ?? 50;
	const messages = input.messages.slice(offset, offset + limit).map((message, index): ConversationMessage => ({ id: `${sessionId}:${offset + index}`, index: offset + index, role: typeof message.role === "string" ? message.role : "unknown", blocks: blocks(message.content), ...(typeof message.timestamp === "string" ? { timestamp: message.timestamp } : {}) }));
	return { source: "sdk-session", sessionId, status: "ready", notice: input.notice, messages, total: input.messages.length, updatedAt: input.updatedAt, ...(offset + messages.length < input.messages.length ? { nextOffset: offset + messages.length } : {}) };
}
