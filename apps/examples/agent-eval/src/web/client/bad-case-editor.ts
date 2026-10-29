import { parseBadCase, type BadCase } from "../../case-origin.js";
import type { EvalCase } from "../../types.js";

export function badCaseEditor(definition: EvalCase) {
	const element = document.createElement("section");
	element.className = "mt-3";
	const label = document.createElement("label"), enabled = document.createElement("input");
	label.className = "form-label";
	enabled.type = "checkbox"; enabled.checked = Boolean(definition.badCase);
	label.append(enabled, " 标记为 Bad case");
	const body = document.createElement("div"); body.hidden = !enabled.checked;
	const hint = document.createElement("p"); hint.className = "form-hint";
	hint.textContent = "日志平台中的原始错误输出，仅供查看，不会加入模型输入或作为评分参考答案。";
	const output = document.createElement("textarea"); output.className = "form-control width-full";
	output.rows = 8; output.style.maxHeight = "360px"; output.style.overflow = "auto";
	output.value = definition.badCase?.observedOutput ?? ""; output.setAttribute("aria-label", "原始错误输出");
	const format = document.createElement("select"); format.className = "form-control"; format.style.width = "auto"; format.setAttribute("aria-label", "错误输出格式");
	for (const name of ["text", "json"]) { const option = document.createElement("option"); option.value = name; option.textContent = name === "text" ? "文本" : "JSON"; format.append(option); }
	format.value = definition.badCase?.outputFormat ?? "text";
	const reason = document.createElement("textarea"); reason.className = "form-control normal width-full"; reason.rows = 2;
	reason.placeholder = "错误原因（可选）"; reason.setAttribute("aria-label", "错误原因"); reason.value = definition.badCase?.reason ?? "";
	const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn btn-sm"; copy.textContent = "复制原始输出";
	copy.onclick = async () => { try { await navigator.clipboard.writeText(output.value); copy.textContent = "已复制"; } catch { output.focus(); output.select(); copy.textContent = "请复制选中文本"; } };
	const title = document.createElement("h3"); title.textContent = "原始错误输出";
	const controls = document.createElement("div"); controls.className = "flex-center gap-2 mb-2"; controls.style.justifyContent = "flex-start"; controls.append(format, copy);
	const reasonLabel = document.createElement("label"); reasonLabel.className = "form-label mt-2"; reason.id = "bad-case-reason"; reasonLabel.htmlFor = reason.id; reasonLabel.textContent = "错误原因（可选）";
	body.append(title, hint, controls, output, reasonLabel, reason);
	enabled.onchange = () => {
		if (!enabled.checked && output.value && !window.confirm("移除 Bad case 标记将在保存后清除错误输出与原因，是否继续？")) enabled.checked = true;
		body.hidden = !enabled.checked;
	};
	element.append(label, body);
	if (definition.importSource) {
		const source = definition.importSource, info = document.createElement("p"); info.className = "form-hint";
		info.textContent = `来源：${source.platform} · 任务 ${source.taskId} · 轮次 ${source.turnId}`;
		if (source.url) { const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = " 查看原始任务"; info.append(link); }
		element.append(info);
	}
	return { element, read(validate = true): BadCase | undefined {
		if (!enabled.checked) return;
		const value: BadCase = { observedOutput: output.value, outputFormat: format.value as "text" | "json", ...(reason.value.trim() ? { reason: reason.value } : {}) };
		return validate ? parseBadCase(value) : value;
	} };
}
