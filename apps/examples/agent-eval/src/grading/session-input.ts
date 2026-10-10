import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { redactValue } from "./evidence.js";
import { within } from "../web/workspace.js";

export async function readSessionInput(directory: string, sessionId: string, active = false, secrets: string[] = []) {
	const unavailable = (status: "pending" | "missing" | "unavailable", notice: string) => ({ status, notice, messages: [] as Record<string, unknown>[], completeness: "missing", issues: [notice] });
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return unavailable("unavailable", "会话标识无效，无法读取记录。");
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const root = await realpath(directory); const target = await realpath(path.join(root, "session", "sessions", sessionId, `${sessionId}.messages.json`));
		if (!within(root, target)) return unavailable("unavailable", "会话文件路径越界，未读取。");
		handle = await open(target, "r"); const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return unavailable("unavailable", "会话文件超过 32 MiB 读取限制或不是普通文件，请在本地查看。");
		const bytes = Buffer.alloc(stat.size + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead > stat.size) return unavailable("pending", "会话记录正在更新，请稍后重试。");
		let raw: { messages?: unknown; sessionId?: unknown; updated_at?: unknown };
		try { raw = redactValue(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), secrets); }
		catch { return unavailable(active ? "pending" : "unavailable", active ? "会话记录正在写入，请稍后重试。" : "会话记录格式不完整，仍可查看最终结果和已有输出。"); }
		if (!raw || !Array.isArray(raw.messages)) return unavailable("unavailable", "会话记录格式不受支持，仍可查看最终结果和已有输出。");
		if (raw.sessionId !== undefined && raw.sessionId !== sessionId) return unavailable("unavailable", "会话记录与本次执行不匹配，未读取。");
		const messages: Record<string, unknown>[] = raw.messages.map(m => m && typeof m === "object" ? m as Record<string, unknown> : { role: "unknown", content: m });
		return { status: "ready" as const, messages, completeness: "unknown", issues: ["SDK保存的是主会话上下文，可能经历压缩；不能保证包含所有早期消息或子会话。"], notice: "来自本次执行保存的会话上下文；新消息在保存后出现，压缩后的上下文可能不包含全部早期消息。工具请求与结果记录不作为实际执行的判分证据。", ...(typeof raw.updated_at === "string" ? { updatedAt: raw.updated_at } : {}) };
	} catch (error) { return unavailable((error as NodeJS.ErrnoException).code === "ENOENT" ? active ? "pending" : "missing" : "unavailable", (error as NodeJS.ErrnoException).code === "ENOENT" ? active ? "等待会话记录保存；可先查看最近活动。" : "会话文件不存在或已清理；仍可查看结果和已有输出。" : "会话记录暂时无法读取，请重试或在本地查看。"); }
	finally { await handle?.close(); }
}
