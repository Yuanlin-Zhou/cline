import { pythonReplyTemplate, pythonArtifactTemplate, pythonConversationTemplate } from "../../grading/python-guide.js";
import { replyTemplate, artifactTemplate, verifierFields, verifierProtocolHelp } from "../../grading/verifier-guide.js";

export const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
export const action = (text: string, click: () => void, primary = false) => { const n = node("button", text, `btn btn-sm${primary ? " btn-primary" : ""}`); n.type = "button"; n.onclick = click; return n; };
export const row = (...children: HTMLElement[]) => { const n = node("div", "", "Verifier-actions"); n.append(...children); return n; };
export const fold = (title: string) => { const n = node("details", "", "Verifier-details"); n.append(node("summary", title)); return n; };
export function downloadScript(filename: string, source: string) {
	const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
	const link = node("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function verifierDialog(title: string, body: HTMLElement, options: { wide?: boolean; onClose?: () => void; footer?: HTMLElement; canClose?: () => boolean } = {}) {
	const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
	const dialog = node("dialog", "", "Modal-overlay Verifier-dialog"); dialog.setAttribute("aria-label", title);
	const modal = node("div", "", `Modal${options.wide ? " Modal--wide" : ""}`);
	const close = () => { if (options.canClose?.() === false) return; dialog.close(); };
	const dismiss = action("关闭", close); dismiss.setAttribute("aria-label", `关闭${title}`);
	modal.append(row(node("strong", title), dismiss)); modal.firstElementChild!.classList.add("Modal-header");
	const content = node("div", "", "Modal-body"); content.append(body); modal.append(content);
	if (options.footer) { const footer = node("div", "", "Modal-footer"); footer.append(options.footer); modal.append(footer); }
	dialog.append(modal); document.body.append(dialog);
	dialog.addEventListener("cancel", e => { if (options.canClose?.() === false) e.preventDefault(); });
	dialog.addEventListener("click", e => { if (e.target === dialog) close(); });
	dialog.addEventListener("close", () => { dialog.remove(); options.onClose?.(); if (origin?.isConnected) origin.focus(); }, { once: true });
	dialog.showModal(); return { close, dialog };
}
export function tabs(items: Array<[string, HTMLElement]>, onChange?: (index: number) => void) {
	const root = node("div", "", "Verifier-tabs"); const bar = node("div", "", "Verifier-tabbar"); bar.setAttribute("role", "tablist");
	const id = `verifier-tabs-${crypto.randomUUID()}`;
	const buttons = items.map(([title], i) => { const b = action(title, () => select(i)); b.setAttribute("role", "tab"); b.id = `${id}-${i}`; b.setAttribute("aria-controls", `${id}-panel-${i}`); return b; });
	items.forEach(([, panel], i) => { panel.id = `${id}-panel-${i}`; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", buttons[i].id); });
	function select(index: number) { items.forEach(([, panel], i) => { panel.hidden = i !== index; buttons[i].setAttribute("aria-selected", String(i === index)); buttons[i].tabIndex = i === index ? 0 : -1; }); onChange?.(index); }
	bar.addEventListener("keydown", e => { const current = buttons.indexOf(document.activeElement as HTMLButtonElement); if (current < 0) return; let next = current; if (e.key === "ArrowRight") next = (current + 1) % buttons.length; else if (e.key === "ArrowLeft") next = (current + buttons.length - 1) % buttons.length; else if (e.key === "Home") next = 0; else if (e.key === "End") next = buttons.length - 1; else return; e.preventDefault(); select(next); buttons[next].focus(); });
	bar.append(...buttons); root.append(bar, ...items.map(([, panel]) => panel)); select(0); return { element: root, select };
}
const templates = [
	{ title: "检查最终回复", filename: "verify-reply.py", source: pythonReplyTemplate, note: "适用于单轮或完整任务。读取最终回复，检查是否包含指定文字。" },
	{ title: "检查文件产物", filename: "verify-artifacts.py", source: pythonArtifactTemplate, note: "需要完整任务模式与已归档的产物。检查所有 txt 文件是否包含指定文字。" },
	{ title: "检查会话", filename: "verify-conversation.py", source: pythonConversationTemplate, note: "需要已保存的会话。检查模型回复；会话压缩后可能缺少早期消息。" },
];
export function openVerifierGuide(legacy = false) {
	const body = node("div", "", "Verifier-guide");
	if (legacy) {
		body.append(node("p", verifierProtocolHelp, "form-hint"));
		for (const [title, filename, source] of [["最终回复", "verify-reply.mjs", replyTemplate], ["文件产物", "verify-artifact.mjs", artifactTemplate]]) {
			const item = fold(title); item.append(action(`下载 ${filename}`, () => downloadScript(filename, source)), node("pre", source, "code")); body.append(item);
		}
		const fields = fold("输入字段参考"); for (const [title, meaning] of verifierFields) fields.append(node("h4", title), node("p", meaning)); body.append(fields);
		return verifierDialog("JS/TS 编写指南", body, { wide: true });
	}
	const quick = node("section"); quick.append(node("p", "定义 verify(ctx)，读取本次执行的数据，返回检查结论。先选一个接近需求的模板，再修改业务逻辑。", "form-hint"));
	const choice = node("select", "", "form-control"); choice.setAttribute("aria-label", "选择Python模板"); templates.forEach((t, i) => choice.append(new Option(t.title, String(i))));
	const note = node("p", "", "form-hint"); const code = node("pre", "", "code Verifier-code"); const status = node("p", "", "form-hint"); status.setAttribute("role", "status");
	const copy = action("复制代码", () => { void navigator.clipboard.writeText(templates[Number(choice.value)].source).then(() => { status.textContent = "代码已复制"; }).catch(() => { status.textContent = "复制失败，请下载脚本或手动选中代码复制。"; }); });
	const download = action("下载 .py 模板", () => downloadScript(templates[Number(choice.value)].filename, templates[Number(choice.value)].source), true);
	const sync = () => { const t = templates[Number(choice.value)]; code.textContent = t.source; note.textContent = t.note; status.textContent = ""; download.textContent = `下载 ${t.filename}`; }; choice.onchange = sync; sync();
	quick.append(choice, note, row(download, copy), status, code);
	const data = node("section");
	const inputs = [
		["执行结果", "最终回复、执行状态、耗时与用量。", 'text = ctx["execution"]["text"]\nstatus = ctx["execution"]["status"]', "execution.status/text/finish_reason/error/duration_ms/iterations/usage"],
		["会话记录", "按消息读取用户、模型和工具内容。会话为 SDK 保存的上下文，不保证包含全部早期消息。", 'for message in ctx["conversation"]["messages"]:\n    for block in message["blocks"]:\n        if block["type"] == "text":\n            print(message["role"], block["text"])', "conversation.status/completeness/issues/messages；消息含 role/blocks；工具块 input/output 保留 JSON 类型"],
		["文件产物与初始文件", "文件从验证副本读取，需要完整任务模式。", 'from pathlib import Path\nroot = Path(ctx["paths"]["artifacts"])\nfor file in ctx["artifacts"]["files"]:\n    text = (root / file["path"]).read_text(encoding="utf-8")', "artifacts.status/files/deleted；文件 path/size/sha256/change；baseline 为初始文件，paths.baseline 是副本目录"],
		["自定义参数", "在高级设置里填写 JSON 对象，供脚本读取。", 'keyword = ctx["params"].get("contains", "已完成")', "params；case.id/prompt/history/replay_mode；run.run_id/item_id/round/session_id"],
		["工具诊断", "可用于调试，不能证明工具真实执行或审批通过。", 'calls = ctx["diagnostics"]["tool_calls"]', "diagnostics.status/completeness/issues/tool_calls/capabilities/events_ref；事件 JSONL 在 paths.diagnostics；临时文件写入 paths.scratch"],
	];
	for (const [title, meaning, sample, fields] of inputs) { const group = fold(title); group.append(node("p", meaning), node("pre", sample, "code")); const reference = fold("字段参考"); reference.append(node("p", fields, "form-hint")); group.append(reference); data.append(group); }
	data.prepend(node("p", "先检查 status、completeness 和 issues；缺失数据不能当作验证通过。", "form-hint"));
	const returned = node("section"); returned.append(node("p", "返回 verdict 和 message；可附 checks 展示逐项预期、实际值与相关文件。"), node("p", "pass：通过 · fail：业务条件不符 · insufficient：数据不足。异常、非法返回和超时显示为验证错误。", "form-hint"), node("pre", 'return {\n    "verdict": "pass",\n    "message": "检查完成",\n    "checks": [{"id": "reply", "status": "pass",\n                "message": "内容正确", "expected": "已完成", "actual": text}]\n}', "code"), node("p", "print() 会进入运行日志，不用自行输出 JSON 协议。checks 的 id 必须唯一；整体通过时，所有检查项也须通过。", "form-hint"));
	body.append(tabs([["快速开始", quick], ["可读取的数据", data], ["返回判定", returned]]).element);
	return verifierDialog("Python 编写指南", body, { wide: true });
}
