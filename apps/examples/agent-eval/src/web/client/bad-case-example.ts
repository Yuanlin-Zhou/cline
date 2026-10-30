import type { BadCase } from "../../case-origin.js";

/** Historical evidence from the selected execution snapshot, never the current catalog. */
export function badCaseExample(value: BadCase | undefined): HTMLElement | undefined {
	if (!value || typeof value.observedOutput !== "string" || !value.observedOutput.trim()) return;
	const section = document.createElement("section");
	section.className = "BadCaseExample";
	section.setAttribute("aria-label", "原始 Bad case 示例");
	const heading = document.createElement("div"); heading.className = "BadCaseExample-heading";
	const title = document.createElement("h3"); title.textContent = "原始 Bad case 示例";
	const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn btn-sm";
	copy.textContent = "复制"; copy.setAttribute("aria-label", "复制原始 Bad case 示例");
	const output = document.createElement("pre"); output.className = "BadCaseExample-output";
	output.textContent = value.observedOutput; output.tabIndex = 0; output.setAttribute("aria-label", "历史错误输出");
	copy.onclick = async () => {
		try { await navigator.clipboard.writeText(value.observedOutput); copy.textContent = "已复制"; }
		catch {
			output.focus();
			const range = document.createRange(); range.selectNodeContents(output);
			const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
			copy.textContent = "请复制选中文本";
		}
	};
	heading.append(title, copy);
	const hint = document.createElement("p"); hint.className = "form-hint"; hint.textContent = "历史错误输出，仅供本次结果对照。";
	section.append(heading, hint, output);
	if (typeof value.reason === "string" && value.reason.trim()) {
		const reason = document.createElement("p"); reason.className = "BadCaseExample-reason";
		const label = document.createElement("strong"); label.textContent = "错误原因：";
		reason.append(label, document.createTextNode(value.reason)); section.append(reason);
	}
	return section;
}
