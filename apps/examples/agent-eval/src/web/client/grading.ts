import type { EvalCaseResult } from "../../types.js";
import type { gradingSummary } from "../../grading/summary.js";
export { gradingEditor } from "./grading-editor.js";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => { const node = document.createElement(tag); node.textContent = text; node.className = cls; return node; };
const button = (text: string, action: () => void) => { const node = el("button", text, "btn btn-sm"); node.type = "button"; node.onclick = action; return node; };
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? "—";
export function gradingPanel(result: EvalCaseResult, load?: (id: string) => Promise<{ text: string }>) {
	const root = el("section", "", "Box Box-body mt-3");
	if (!result.grading) { root.append(el("p", "旧版文本判定：文本/结束原因通过不代表任务已完成。", "form-hint")); return root; }
	const grade = result.grading; const status = { pass: "通过", fail: "失败", error: "验证错误", insufficient: "证据不足", skipped: "未验证" };
	const verdicts = { passed: "通过", failed: "失败", inconclusive: "无法判定" }; const stages = { completed: "已完成", error: "错误", cancelled: "已取消" };
	root.append(el("h3", "任务结果与行为验收", "section-title"), el("p", `执行：${result.execution ? stages[result.execution.status] : "未知"} · 判分：${verdicts[grade.verdict]} · 验证状态：${stages[grade.status]}`));
	const required = grade.results.filter(r => r.required); root.append(el("p", `必要条件 ${required.filter(r => r.status === "pass").length}/${required.length} 通过 · 规则版本 ${grade.ruleHash.slice(0, 12)}`, "muted small"));
	for (const r of grade.results) {
		const row = el("details", "", "Box Box-body mt-2 Grading-result");
		const summary = el("summary");
		const tone = r.status === "pass" ? "success" : r.status === "fail" || r.status === "error" ? "danger" : "attention";
		summary.append(el("span", status[r.status], `Label Label--${tone}`), el("strong", r.label ?? r.id), el("span", r.required ? "必要" : "可选", "muted small"));
		row.append(summary, el("p", r.message), el("strong", "预期"), el("pre", json(r.expected), "code"), el("strong", "实际"), el("pre", json(r.actual), "code"));
		for (const ref of r.evidenceRefs) row.append(button(result.evidence?.refs.find(e => e.id === ref)?.label ?? "查看证据", async () => {
			const preview = el("pre", "加载中…", "code"); row.append(preview);
			try { preview.textContent = load ? (await load(ref)).text : "请在批次详情查看证据"; } catch (e) { preview.textContent = String(e); }
		})); root.append(row);
	}
	if (result.evidence?.issues.length) root.append(el("p", result.evidence.issues.join("；"), "flash flash-warning"));
	return root;
}

export function gradingMetrics(summary: ReturnType<typeof gradingSummary>) {
	const root = el("div", "", "Box Box-body mt-2");
	const format = (f: { numerator: number; denominator: number; rate: number | null }) => `${f.rate === null ? "—" : (f.rate * 100).toFixed(1) + "%"} (${f.numerator}/${f.denominator})`;
	root.append(el("p", `旧版文本通过率 ${format(summary.legacy)} · 执行错误率 ${format(summary.executionErrors)} · 取消 ${summary.cancelled}`));
	for (const group of summary.groups) root.append(el("p", `${group.name} · 规则 ${group.ruleHash?.slice(0, 8) ?? "未判分"}：任务通过率 ${format(group.passRate)}；全部成功比例 ${format(group.successRatio)}；判分覆盖率 ${format(group.coverage)}；关键约束 ${format(group.constraints)}（未判定 ${group.unknownConstraints}）；无法判定 ${group.inconclusive}，验证错误 ${group.verifierErrors}`));
	return root;
}
