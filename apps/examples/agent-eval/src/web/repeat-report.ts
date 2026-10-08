import { summarize, type RunDetail, type RunItem } from "./types.js";
import { gradingSummary } from "../grading/summary.js";

const judged = (item: RunItem) => item.status === "passed" || item.status === "failed";
const passRate = (passed: number, failed: number) => passed + failed ? passed / (passed + failed) : null;
export const REPEAT_REPORT_METHOD = "旧版文本判定与任务验收分开统计；任务指标按案例及规则版本分组，无法判定、验证错误和取消单列。输出比较仅统计已判定且有完整结果的执行，统一换行并忽略首尾空白。输出差异不等于幻觉，规则通过也不代表事实正确，请核查验收规则与原始证据。";

export function buildRepeatReport(run: RunDetail) {
	const repeatCount = run.repeatCount ?? 1;
	const groups = new Map<string, RunItem[]>();
	for (const item of run.items) {
		const group = groups.get(item.snapshot.id) ?? [];
		group.push(item); groups.set(item.snapshot.id, group);
	}
	const rounds = Array.from({ length: repeatCount }, (_, index) => {
		const round = index + 1;
		const items = run.items.filter(item => (item.round ?? 1) === round);
		const summary = summarize(items);
		return { round, ...summary, grading: gradingSummary(items), interrupted: items.filter(item => item.interrupted).length, passRate: gradingSummary(items).legacy.rate };
	});
	const cases = [...groups.entries()].map(([caseId, items]) => {
		const summary = summarize(items);
		const outputs = items.filter(item => judged(item) && item.result);
		const variants = new Map<string, { rounds: number[]; itemIds: string[] }>();
		for (const item of outputs) {
			const text = item.result!.text.replace(/\r\n?/g, "\n").trim();
			const variant = variants.get(text) ?? { rounds: [], itemIds: [] };
			variant.rounds.push(item.round ?? 1); variant.itemIds.push(item.id); variants.set(text, variant);
		}
		const definition = items[0].snapshot.definition;
		const assertions = definition.assertions;
		return {
			caseId, name: definition.id, moduleName: items[0].moduleName,
			...summary, grading: gradingSummary(items), passRate: items[0].snapshot.definition.grading ? (gradingSummary(items).groups.length === 1 ? gradingSummary(items).groups[0].passRate.rate : null) : passRate(summary.passed, summary.failed),
			hasContentAssertions: Boolean(definition.grading || assertions?.contains?.length || assertions?.notContains?.length || assertions?.matches?.length),
			comparedOutputs: outputs.length, outputVariants: variants.size,
			// A single response is insufficient evidence of repeatability.
			consistencyRate: outputs.length >= 2 ? Math.max(...[...variants.values()].map(v => v.itemIds.length)) / outputs.length : null,
			judgmentChanged: summary.passed > 0 && summary.failed > 0,
			allRoundsPassed: items.length === repeatCount && summary.passed === repeatCount,
			variants: [...variants.values()],
			rounds: items.map(item => ({
				round: item.round ?? 1, itemId: item.id, status: item.status,
				failedAssertions: [...(item.result?.assertions ?? []).filter(a => !a.passed).map(a => a.message), ...(item.result?.grading?.results ?? []).filter(r => r.status !== "pass").map(r => `${r.id}: ${r.status} ${r.message}`)],
				error: item.error ?? item.result?.error,
			})),
		};
	});
	const summary = summarize(run.items);
	return {
		repeatCount, caseCount: cases.length, summary,
		passRate: gradingSummary(run.items).legacy.rate,
		grading: gradingSummary(run.items),
		completedRounds: rounds.filter(r => r.total > 0 && r.queued + r.running + r.cancelled + r.interrupted === 0).length,
		partial: run.status !== "completed" || summary.queued + summary.running + summary.cancelled > 0,
		allRoundsPassedCases: cases.filter(c => c.allRoundsPassed).length,
		judgmentChangedCases: cases.filter(c => c.judgmentChanged).length,
		outputChangedCases: cases.filter(c => c.outputVariants > 1).length,
		comparableCases: cases.filter(c => c.comparedOutputs >= 2).length,
		withoutContentAssertions: cases.filter(c => !c.hasContentAssertions).length,
		method: REPEAT_REPORT_METHOD, rounds, cases,
	};
}

export type RepeatReport = ReturnType<typeof buildRepeatReport>;

export function repeatReportMarkdown(run: RunDetail, report = buildRepeatReport(run)): string {
	const escapeMarkdown = (value: string) => value.replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&").replace(/[\r\n]+/g, " ");
	const rate = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
	const status = { queued: "排队中", running: "运行中", passed: "通过", failed: "断言失败", error: "执行错误", cancelled: "已取消", inconclusive: "无法判定" };
	const items = new Map(run.items.map(item => [item.id, item]));
	const lines = [
		`# 重复多轮评测报告：${escapeMarkdown(run.name)}`, "",
		`批次：${run.id} · 创建：${run.createdAt} · 状态：${run.status}${report.partial ? "（阶段性报告，样本未全部完成）" : ""}`,
		`${report.caseCount} 个案例 × ${report.repeatCount} 轮；完整执行 ${report.completedRounds} 轮。`, "",
		`- 旧版文本通过率：${rate(report.passRate)}（${report.grading.legacy.numerator}/${report.grading.legacy.denominator}）；失败 ${report.summary.failed}，无法判定 ${report.summary.inconclusive}，执行错误率 ${rate(report.grading.executionErrors.rate)}（${report.grading.executionErrors.numerator}/${report.grading.executionErrors.denominator}），取消 ${report.summary.cancelled}。`,
		...report.grading.groups.map(g => `- 任务 ${escapeMarkdown(g.name)}（规则 ${g.ruleHash?.slice(0, 12) ?? "未判分"}）：已判定通过率 ${rate(g.passRate.rate)}（${g.passRate.numerator}/${g.passRate.denominator}）；全部成功 ${rate(g.successRatio.rate)}（${g.successRatio.numerator}/${g.successRatio.denominator}）；覆盖率 ${rate(g.coverage.rate)}（${g.coverage.numerator}/${g.coverage.denominator}）；关键约束 ${rate(g.constraints.rate)}（${g.constraints.numerator}/${g.constraints.denominator}），未判定约束 ${g.unknownConstraints}；验证错误 ${g.verifierErrors}。`),
		`- 全轮通过案例：${report.allRoundsPassedCases}/${report.caseCount}；通过/失败波动案例：${report.judgmentChangedCases}。`,
		`- 输出变化案例：${report.outputChangedCases}/${report.comparableCases} 个可比较案例；未配置内容规则：${report.withoutContentAssertions}。`,
		`- 累计执行耗时：${report.summary.durationMs} ms；Token：${report.summary.tokens}；费用：${report.summary.cost === null ? "未提供" : `$${report.summary.cost.toFixed(4)}`}。`, "",
		"## 各轮结果", "", "| 轮次 | 旧版通过/已判定 | 旧版文本通过率 | 失败 | 错误/未判定 | 取消 | 待完成 |", "| --- | --- | --- | --- | --- | --- | --- |",
		...report.rounds.map(r => `| ${r.round} | ${r.grading.legacy.numerator}/${r.grading.legacy.denominator} | ${rate(r.passRate)} | ${r.failed} | ${r.error}/${r.inconclusive} | ${r.cancelled} | ${r.queued + r.running} |`), "",
		"## 案例重复性", "", "一致率 = 最常见输出次数 / 可比较输出次数；少于 2 次输出显示 —。", "",
		"| 模块 / 案例 | 通过/已判定 | 输出版本 | 一致率 | 判定波动 |", "| --- | --- | --- | --- | --- |",
		...report.cases.map(c => `| ${escapeMarkdown(c.moduleName)} / ${escapeMarkdown(c.name)} | ${c.passed}/${c.passed + c.failed} | ${c.outputVariants} | ${rate(c.consistencyRate)} | ${c.judgmentChanged ? "有" : "未观察到"} |`), "",
		"## 差异与异常摘录", "",
	];
	const issues = report.cases.filter(c => c.outputVariants > 1 || c.failed + c.error + c.inconclusive > 0 || c.rounds.some(r => r.failedAssertions.length));
	if (!issues.length) lines.push("当前样本未观察到输出差异、规则失败或执行错误。", "");
	for (const c of issues.slice(0, 20)) {
		lines.push(`### ${escapeMarkdown(c.moduleName)} / ${escapeMarkdown(c.name)}`, "");
		for (const r of c.rounds.filter(r => r.failedAssertions.length || r.error).slice(0, 10)) lines.push(`- 第 ${r.round} 轮：${status[r.status]}；${escapeMarkdown([...r.failedAssertions, r.error ?? ""].filter(Boolean).join("；").slice(0, 500))}`);
		if (c.outputVariants > 1) for (const variant of c.variants.slice(0, 3)) {
			const text = items.get(variant.itemIds[0])?.result?.text ?? "";
			lines.push(`- 输出版本（第 ${variant.rounds.join("、")} 轮）：${escapeMarkdown(text.slice(0, 500))}${text.length > 500 ? "…（截断）" : ""}`);
		}
		lines.push("");
	}
	lines.push("摘录最多展示 20 个案例、每案例 10 条异常和 3 个输出版本；完整原文、逐轮状态与断言证据见批次详情或 JSON 导出。", "", report.method, "");
	return lines.join("\n");
}
