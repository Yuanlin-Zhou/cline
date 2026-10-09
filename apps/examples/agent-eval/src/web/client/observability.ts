import { activityLabel } from "../activity.js";
import type { RunItem } from "../types.js";
import type { Conversation } from "../conversation.js";

function el(tag: string, text = "", className = ""): HTMLElement {
	const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
const age = (date: string, now = Date.now()) => `${Math.max(0, Math.floor((now - Date.parse(date)) / 1000))} 秒`;

export function executionStatus(item: RunItem): HTMLElement {
	const box = el("section", "", "ExecutionStatus"); box.setAttribute("aria-label", "执行状态");
	const active = item.status === "running";
	const phase = item.status === "queued" ? "排队中" : active ? item.phase === "verifying" ? "验证中" : "执行中" : "执行已结束";
	box.append(el("strong", phase), el("span", item.startedAt ? `已运行 ${age(item.startedAt, item.endedAt ? Date.parse(item.endedAt) : Date.now())}` : "等待开始", "muted small"));
	box.append(el("div", item.activity ? activityLabel(item.activity) : active ? "暂无活动记录" : "未记录活动", "small"));
	box.append(el("div", item.lastActivityAt ? `最近收到活动：${age(item.lastActivityAt)}前` : "最近收到活动：尚无记录", "muted small"));
	if (active) box.append(el("p", item.phase === "verifying" ? "模型执行已结束，正在检查结果与文件产物。" : "暂时没有新文本不代表任务停止；等待响应或工具活动时文本预览可能不变。", "muted small"));
	if (item.activities?.length) {
		const list = el("details"); list.append(el("summary", "最近活动"));
		for (const activity of item.activities) list.append(el("div", `${new Date(activity.at).toLocaleTimeString()} · ${activityLabel(activity)}`, "small"));
		list.append(el("p", "工具请求与结果通知用于观察进度，不证明工具实际执行。", "muted small")); box.append(list);
	}
	return box;
}

export function syncStatus(runId: string): HTMLElement {
	const node = el("div", "记录已加载；运行时自动同步。", "SyncStatus muted small"); node.dataset.runSync = runId; node.setAttribute("role", "status"); return node;
}

export function showSyncStatus(runId: string, error?: string): void {
	for (const node of document.querySelectorAll<HTMLElement>("[data-run-sync]")) if (node.dataset.runSync === runId) {
		node.textContent = error ? `页面同步失败：${error}。保留已有内容，正在重试；这不代表评测停止。` : `页面同步正常 · 最近同步 ${new Date().toLocaleTimeString()}`;
		node.classList.toggle("SyncStatus-error", Boolean(error));
	}
}

export function conversationView(runId: string, itemId: string) {
	const node = el("section", "", "Conversation");
	const controls = el("div", "", "flex-center gap-2 wrap"); const notice = el("p", "加载会话记录…", "muted small"); const status = el("span", "", "muted small"); const messages = el("div");
	let offset = 0; let total = 0; let nextOffset: number | undefined; let busy = false; let lastLoad = 0; let signature = ""; let refreshPending = false; let followLatest = true;
	const base = `/api/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/conversation`;
	const button = (label: string, action: () => void) => { const b = el("button", label, "btn btn-sm") as HTMLButtonElement; b.type = "button"; b.onclick = action; controls.append(b); return b; };
	const refresh = button("刷新记录", () => void load());
	const first = button("最早消息", () => { followLatest = false; offset = 0; void load(); });
	const latest = button("最新消息", () => { followLatest = true; offset = Math.max(0, total - 50); void load(); });
	latest.setAttribute("title", "跟随新保存的消息；查看最早消息或下一页时暂停跟随。");
	const next = button("下一页", () => { if (nextOffset !== undefined) { followLatest = false; offset = nextOffset; void load(); } });
	const download = el("a", "下载会话 JSON", "btn btn-sm") as HTMLAnchorElement; download.href = `${base}?download=1`; download.download = `conversation-${itemId}.json`; controls.append(download, status);
	node.append(controls, notice, messages);
	async function load() {
		if (busy) { refreshPending = true; return; } busy = true; refresh.disabled = true;
		try {
			const response = await fetch(`${base}?offset=${offset}&limit=50`, { signal: AbortSignal.timeout(10000) });
			if (!response.ok) throw new Error(`请求失败 (${response.status})`);
			const data = await response.json() as Conversation;
			if (!node.isConnected) return;
			const latestOffset = Math.max(0, data.total - 50);
			if (data.status === "ready" && followLatest && offset !== latestOffset) { offset = latestOffset; busy = false; await load(); return; }
			if (offset >= data.total && data.total > 0 && data.status === "ready") { offset = Math.max(0, data.total - 50); busy = false; await load(); return; }
			if (data.status === "ready") { total = data.total; nextOffset = data.nextOffset; }
			else nextOffset = undefined;
			notice.textContent = data.notice; status.textContent = data.status === "ready" ? `共 ${total} 条 · 当前 ${total ? offset + 1 : 0}–${offset + data.messages.length}` : "记录暂不可用；已有内容保留";
			first.disabled = offset === 0 && !followLatest; latest.disabled = followLatest; latest.setAttribute("aria-pressed", String(followLatest)); next.disabled = nextOffset === undefined;
			download.hidden = data.status !== "ready";
			const value = JSON.stringify(data.messages);
			if (data.status === "ready" && value !== signature) {
				signature = value; messages.replaceChildren();
				for (const message of data.messages) {
					const card = el("article", "", "ConversationMessage"); const role = ({ user: "用户", assistant: "模型", tool: "工具", system: "系统" } as Record<string, string>)[message.role] ?? message.role;
					card.append(el("strong", `${message.index + 1} · ${role}`));
					for (const block of message.blocks) {
						if (block.type === "text") card.append(el("pre", block.text, "output"));
						else {
							const detail = el("details"); const label = ({ "tool-call": "工具请求", "tool-result": "工具结果", tool_use: "工具请求", tool_result: "工具结果", reasoning: "推理记录", thinking: "推理记录" } as Record<string, string>)[block.type] ?? block.type;
							detail.append(el("summary", `${label}${block.toolName ? ` · ${block.toolName}` : ""}`), el("pre", block.text, "code")); card.append(detail);
						}
					}
					messages.append(card);
				}
			}
		} catch (error) { if (node.isConnected) notice.textContent = `会话同步失败：${error instanceof Error ? error.message : String(error)}。已显示的记录保留，可以重试。`; }
		finally { busy = false; lastLoad = Date.now(); refresh.disabled = false; if (refreshPending && node.isConnected) { refreshPending = false; void load(); } }
	}
	void load();
	return { element: node, refresh(force = false) { if (node.isConnected && (force || Date.now() - lastLoad >= 2000)) void load(); } };
}
