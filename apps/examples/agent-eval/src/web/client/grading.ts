import type { Rule } from "../../grading/types.js";
import { ruleTitle } from "./grading-help.js";
import type { EvalCaseResult } from "../../types.js";
import type { gradingSummary } from "../../grading/summary.js";
export { gradingEditor } from "./grading-editor.js";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => { const node = document.createElement(tag); node.textContent = text; node.className = cls; return node; };
const button = (text: string, action: () => void) => { const node = el("button", text, "btn btn-sm"); node.type = "button"; node.onclick = action; return node; };
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? "—";
export function gradingPanel(result: EvalCaseResult, load?: (id: string) => Promise<{ text: string }>, options: { rules?: Rule[]; verifiers?: Array<{id: string; label: string}>; caseUrl?: string } = {}) {
	const root = el("section", "", "Box Box-body mt-3 Grading-results");
	if (!result.grading) {
  root.className = "Grading-results";
  const method = el("details", "", "Verifier-details");
  method.append(el("summary", "判定方式"), el("p", "当前按最终回复和结束状态判定；正常结束不能单独证明业务任务完成。", "form-hint")); root.append(method); return root;
 }
	const grade = result.grading; const status = { pass: "通过", fail: "失败", error: "验证错误", insufficient: "证据不足", skipped: "未验证" };
	const verdicts = { passed: "验收通过", failed: "验收未通过", inconclusive: "暂时无法判定" }; const stages = { completed: "已完成", error: "出错", cancelled: "已取消" };
	root.append(el("h3", verdicts[grade.verdict], "section-title"));
	const required = grade.results.filter(r => r.required); const failed = required.filter(r => r.status !== "pass");
	root.append(el("p", `影响通过的检查：${required.filter(r => r.status === "pass").length}/${required.length} 通过${failed.length ? "。展开下方未通过项查看原因。" : "。"}`, "form-hint"));
	if (options.caseUrl) { const edit = el("a", "修改判定规则", "btn btn-sm"); edit.href = options.caseUrl; root.append(edit); }
	const rank: Record<string, number> = { error: 0, fail: 1, insufficient: 2, skipped: 3, pass: 4 };
	for (const r of [...grade.results].sort((a, b) => Number(b.required) - Number(a.required) || rank[a.status] - rank[b.status])) {
		const card = el("details", "", "Box Box-body mt-2 Grading-result"); card.open = r.required && r.status !== "pass";
		const summary = el("summary"); const tone = r.status === "pass" ? "success" : r.status === "fail" || r.status === "error" ? "danger" : "attention";
		const rule = options.rules?.find(rule => rule.id === r.id) ?? (r.expected && typeof r.expected === "object" && "kind" in r.expected ? r.expected as Rule : undefined);
		const verifierLabel = rule && "verifierId" in rule ? options.verifiers?.find(v => v.id === rule.verifierId)?.label : undefined;
		const title = r.label ?? ruleTitle(rule ? { ...rule } : { kind: r.kind }, verifierLabel);
		summary.append(el("span", status[r.status], `Label Label--${tone}`), el("strong", title), el("span", r.required ? "影响通过" : "仅作参考", "muted small")); card.append(summary, el("p", r.message, "Grading-result-message"));
		const guidance = r.status === "error" ? "查看运行日志，检查验证脚本或服务器环境；修正后可用历史结果试验证。" : r.status === "insufficient" ? "确认所需数据已归档。文件检查需要完整任务；完整性未知的数据不能当作通过。" : r.status === "skipped" ? "本项尚未完成验证，恢复执行或重新评测后再查看。" : r.status === "fail" ? r.kind.startsWith("file.") ? "核对文件路径、实际内容与任务要求；需要修改检查条件时，返回判定规则调整。" : "对照任务要求和实际结果；脚本可用历史结果试验证，模型任务可修改后重新评测。" : "";
		if (guidance) card.append(el("p", guidance, "form-hint"));
		const values = (host: HTMLElement, expected: unknown, actual: unknown) => { if (expected !== undefined) host.append(el("strong", "预期"), el("pre", json(expected), "code")); if (actual !== undefined) host.append(el("strong", "实际"), el("pre", json(actual), "code")); };
		values(card, r.expected, r.actual);
		for (const check of r.checks ?? []) { const detail = el("details", "", "Verifier-details Grading-check"); detail.open = check.status !== "pass"; detail.append(el("summary", `${status[check.status]} · ${check.message}`)); values(detail, check.expected, check.actual); if (check.files?.length) detail.append(el("p", `相关文件：${check.files.join("、")}`, "form-hint")); card.append(detail); }
		if (r.evidenceRefs.length) {
			const evidence = el("details", "", "Verifier-details Grading-evidence"); evidence.append(el("summary", "日志与相关证据"));
			const actions = el("div", "", "Verifier-actions"); const preview = el("pre", "", "code"); preview.hidden = true; const cache = new Map<string, string>(); let generation = 0;
			for (const ref of r.evidenceRefs) { const label = result.evidence?.refs.find(e => e.id === ref)?.label ?? "验证证据"; const title = label.endsWith("Python验证日志") ? "运行日志" : label.endsWith("Python检查报告") ? "检查报告" : label;
				const view = button(title, () => { void (async () => { const current = ++generation; view.disabled = true; preview.hidden = false; preview.textContent = "正在加载…"; try { const text = cache.get(ref) ?? (load ? (await load(ref)).text : "请在批次详情查看证据。"); cache.set(ref, text); if (current === generation) preview.textContent = text; } catch (error) { if (current === generation) preview.textContent = `加载失败：${String(error)}。点击按钮重试。`; } finally { view.disabled = false; } })(); }); actions.append(view);
			} evidence.append(actions, preview); card.append(evidence);
		}
		const metadata = el("details", "", "Verifier-details"); metadata.append(el("summary", "检查详情"), el("p", `规则标识 ${r.id} · 验证耗时 ${r.durationMs}ms`, "form-hint")); if (r.runtime) metadata.append(el("p", `Python ${r.runtime.version} · 环境 ${r.runtime.environmentId} · 输入摘要 ${r.contextSha256 ?? "未知"}`, "form-hint")); card.append(metadata); root.append(card);
	}
	const metadata = el("details", "", "Verifier-details"); metadata.append(el("summary", "执行与规则版本"), el("p", `执行：${result.execution ? stages[result.execution.status] : "未知"} · 验证阶段：${stages[grade.status]} · 规则版本 ${grade.ruleHash}`, "form-hint")); root.append(metadata);
	if (result.evidence?.issues.length) root.append(el("p", `数据归档提示：${result.evidence.issues.join("；")}`, "flash flash-warning"));
	return root;
}

export function gradingMetrics(summary: ReturnType<typeof gradingSummary>) {
	const root = el("div", "", "ResultMetrics");
	const format = (f: {
		numerator: number;
		denominator: number;
		rate: number | null;
	}) =>
		`${f.numerator} / ${f.denominator}${f.rate === null ? "" : `（${(f.rate * 100).toFixed(1)}%）`}`;
	if (summary.legacy.denominator)
		root.append(
			el(
				"p",
				`回复检查通过 ${format(summary.legacy)}`,
				"ResultMetrics-primary",
			),
		);
	const task = {
		numerator: summary.groups.reduce((n, g) => n + g.passRate.numerator, 0),
		denominator: summary.groups.reduce((n, g) => n + g.passRate.denominator, 0),
		rate: null as number | null,
	};
	task.rate = task.denominator ? task.numerator / task.denominator : null;
	if (summary.groups.length)
		root.append(
			el("p", `任务验收通过 ${format(task)}`, "ResultMetrics-primary"),
		);
	if (!summary.groups.length && !summary.legacy.denominator)
		root.append(el("p", "尚无已判定结果", "muted"));
	const issues = [
		summary.executionErrors.numerator
			? `执行错误 ${summary.executionErrors.numerator}`
			: "",
		summary.cancelled ? `取消 ${summary.cancelled}` : "",
		...summary.groups.flatMap((g) => [
			g.inconclusive ? `${g.name} 未判定 ${g.inconclusive}` : "",
			g.verifierErrors ? `${g.name} 验证错误 ${g.verifierErrors}` : "",
		]),
	].filter(Boolean);
	if (issues.length)
		root.append(el("p", issues.join(" · "), "ResultMetrics-issues"));
	const details = el("details", "", "Verifier-details");
	details.append(el("summary", "详细统计与统计口径"));
	const table = el("table", "", "Table");
	const head = el("tr");
	for (const title of ["案例", "任务通过 / 已判定", "验收覆盖", "异常"])
		head.append(el("th", title));
	const thead = el("thead");
	thead.append(head);
	table.append(thead);
	const body = el("tbody");
	for (const g of summary.groups) {
		const row = el("tr");
		for (const value of [
			g.name,
			format(g.passRate),
			format(g.coverage),
			g.verifierErrors || g.inconclusive
				? `验证错误 ${g.verifierErrors} · 未判定 ${g.inconclusive}`
				: "无",
		])
			row.append(el("td", value));
		const meta = el("details");
		meta.append(
			el("summary", "更多指标"),
			el(
				"p",
				`全部成功 ${format(g.successRatio)}${g.constraints.denominator ? ` · 关键约束 ${format(g.constraints)}` : ""}${g.unknownConstraints ? ` · 未判定约束 ${g.unknownConstraints}` : ""} · 规则版本 ${g.ruleHash ?? "未判分"}`,
			),
		);
		row.lastElementChild!.append(meta);
		body.append(row);
	}
	table.append(body);
	if (summary.groups.length) details.append(table);
	details.append(
		el(
			"p",
			"通过率 = 通过 /（通过 + 失败）。回复检查与任务验收分开统计；执行错误、无法判定和取消单列。重试后按最新执行统计，费用与耗时包含全部尝试。",
			"form-hint",
		),
	);
	root.append(details);
	return root;
}
