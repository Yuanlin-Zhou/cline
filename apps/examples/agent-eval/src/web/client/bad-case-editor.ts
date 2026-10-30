import { parseBadCase, type BadCase } from "../../case-origin.js";
import type { EvalCase } from "../../types.js";

export function badCaseEditor(definition: EvalCase) {
	const element = document.createElement("section");
	element.className = "BadCaseEditor";
	const label = document.createElement("label"), enabled = document.createElement("input");
	label.className = "BadCaseEditor-toggle";
	enabled.type = "checkbox"; enabled.checked = Boolean(definition.badCase);
	label.append(enabled, " 标记为 Bad case");
	const body = document.createElement("div"); body.className = "BadCaseEditor-body"; body.hidden = !enabled.checked;
	const hint = document.createElement("p"); hint.className = "form-hint";
	hint.textContent = "历史错误示例，仅作对照，不作为评分参考答案。";
	const output = document.createElement("textarea"); output.className = "form-control BadCaseEditor-output";
	output.rows = 2;
	output.value = definition.badCase?.observedOutput ?? ""; output.setAttribute("aria-label", "原始错误输出");
	const format = document.createElement("select"); format.className = "form-control"; format.setAttribute("aria-label", "错误输出格式");
	for (const name of ["text", "json"]) { const option = document.createElement("option"); option.value = name; option.textContent = name === "text" ? "文本" : "JSON"; format.append(option); }
	format.value = definition.badCase?.outputFormat ?? "text";
	const reason = document.createElement("textarea"); reason.className = "form-control normal BadCaseEditor-reason"; reason.rows = 1;
	reason.placeholder = "补充原因，便于后续回归"; reason.setAttribute("aria-label", "错误原因"); reason.value = definition.badCase?.reason ?? "";
	const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn btn-sm"; copy.textContent = "复制"; copy.setAttribute("aria-label", "复制原始输出");
	copy.onclick = async () => { try { await navigator.clipboard.writeText(output.value); copy.textContent = "已复制"; } catch { output.focus(); output.select(); copy.textContent = "请复制选中文本"; } };
	const title = document.createElement("label"); title.className = "form-label"; title.textContent = "原始错误输出"; output.id = "bad-case-output"; title.htmlFor = output.id;
	const controls = document.createElement("div"); controls.className = "BadCaseEditor-actions"; controls.append(format, copy);
	const heading = document.createElement("div"); heading.className = "BadCaseEditor-heading"; heading.append(title, controls);
	const reasonLabel = document.createElement("label"); reasonLabel.className = "form-label"; reason.id = "bad-case-reason"; reasonLabel.htmlFor = reason.id; reasonLabel.textContent = "错误原因（可选）";
	body.append(heading, hint, output, reasonLabel, reason);
	const fit = () => {
		if (CSS.supports("field-sizing", "content")) return;
		for (const area of [output, reason]) { area.style.height = "auto"; area.style.height = `${Math.min(240, Math.max(area === output ? 76 : 40, area.scrollHeight + 2))}px`; }
	};
	output.addEventListener("input", fit); reason.addEventListener("input", fit);
	requestAnimationFrame(fit);
	enabled.onchange = () => {
		if (!enabled.checked && output.value && !window.confirm("移除 Bad case 标记将在保存后清除错误输出与原因，是否继续？")) enabled.checked = true;
		body.hidden = !enabled.checked;
		if (enabled.checked) requestAnimationFrame(fit);
	};
	element.append(label, body);
	if (definition.importSource) {
		const source = definition.importSource, info = document.createElement("details"); info.className = "BadCaseEditor-source";
		const summary = document.createElement("summary"); summary.textContent = "导入来源";
		const metadata = document.createElement("p"); metadata.textContent = `${source.platform} · 任务 ${source.taskId} · 轮次 ${source.turnId}`; info.append(summary, metadata);
		if (source.url) { const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = " 查看原始任务"; info.append(link); }
		element.append(info);
	}
	return { element, read(validate = true): BadCase | undefined {
		if (!enabled.checked) return;
		const value: BadCase = { observedOutput: output.value, outputFormat: format.value as "text" | "json", ...(reason.value.trim() ? { reason: reason.value } : {}) };
		return validate ? parseBadCase(value) : value;
	} };
}
