import type { RunOverview } from "../../../../src/contracts/api";
import type { gradingSummary } from "../../../../src/modules/grading/summary";
import { Status, duration } from "../../components/ui";

type Fraction = { numerator: number; denominator: number; rate: number | null };
const fraction = (value: Fraction) =>
	`${value.numerator} / ${value.denominator}${value.rate === null ? "" : `（${(value.rate * 100).toFixed(1)}%）`}`;
const cost = (value: number | null | undefined) =>
	value == null ? "未提供" : `$${value.toFixed(4)}`;
export function GradingMetrics({
	metrics,
}: {
	metrics: ReturnType<typeof gradingSummary>;
}) {
	const passed = metrics.groups.reduce(
			(sum, g) => sum + g.passRate.numerator,
			0,
		),
		total = metrics.groups.reduce((sum, g) => sum + g.passRate.denominator, 0);
	const issues = [
		metrics.executionErrors.numerator
			? `执行错误 ${metrics.executionErrors.numerator}`
			: "",
		metrics.cancelled ? `取消 ${metrics.cancelled}` : "",
		...metrics.groups.flatMap((g) => [
			g.inconclusive ? `${g.name} 未判定 ${g.inconclusive}` : "",
			g.verifierErrors ? `${g.name} 验证错误 ${g.verifierErrors}` : "",
		]),
	].filter(Boolean);
	return (
		<div className="ResultMetrics">
			{!!metrics.legacy.denominator && (
				<p className="ResultMetrics-primary">
					回复检查通过 {fraction(metrics.legacy)}
				</p>
			)}
			{!!metrics.groups.length && (
				<p className="ResultMetrics-primary">
					任务验收通过{" "}
					{fraction({
						numerator: passed,
						denominator: total,
						rate: total ? passed / total : null,
					})}
				</p>
			)}
			{!metrics.groups.length && !metrics.legacy.denominator && (
				<p className="muted">尚无已判定结果</p>
			)}
			{!!issues.length && (
				<p className="ResultMetrics-issues">{issues.join(" · ")}</p>
			)}
			<details className="Verifier-details">
				<summary>详细统计与统计口径</summary>
				{!!metrics.groups.length && (
					<div className="TableWrap">
						<table className="Table">
							<thead>
								<tr>
									<th>案例</th>
									<th>任务通过 / 已判定</th>
									<th>验收覆盖</th>
									<th>异常</th>
								</tr>
							</thead>
							<tbody>
								{metrics.groups.map((g) => (
									<tr key={g.key}>
										<td>{g.name}</td>
										<td>{fraction(g.passRate)}</td>
										<td>{fraction(g.coverage)}</td>
										<td>
											{g.verifierErrors || g.inconclusive
												? `验证错误 ${g.verifierErrors} · 未判定 ${g.inconclusive}`
												: "无"}
											<details>
												<summary>更多指标</summary>
												<p>
													全部成功 {fraction(g.successRatio)} · 规则版本{" "}
													{g.ruleHash ?? "未判分"}
												</p>
											</details>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<p className="form-hint">
					通过率 = 通过 /（通过 +
					失败）。回复检查与任务验收分开统计；执行错误、无法判定和取消单列。重试后按最新执行统计，费用与耗时包含全部尝试。
				</p>
			</details>
		</div>
	);
}
export function RunSummary({ run }: { run: RunOverview }) {
	const s = run.summary,
		j = run.judgeSummary;
	const ended = s.passed + s.failed + s.error + s.inconclusive + s.cancelled;
	const states = [
		"passed",
		"failed",
		"error",
		"inconclusive",
		"cancelled",
		"queued",
		"running",
	] as const;
	return (
		<section className="RunSummary" aria-label="批次摘要">
			<GradingMetrics metrics={run.gradingSummary} />
			{j.expected > 0 && (
				<div className="JudgeSummary">
					<strong>
						LLM 已评分 {j.scored}/{j.expected}
					</strong>
					<span className="muted small">
						{" "}
						· 未评分 {j.unscored} · 评分耗时 {duration(j.durationMs)} · 评分
						Token {(j.inputTokens + j.outputTokens).toLocaleString()} · 评分费用{" "}
						{cost(j.cost)}
					</span>
					<details className="Verifier-details">
						<summary>Judge 分组均分</summary>
						{j.groups.map((g, i) => (
							<p key={i}>
								{g.model} · {g.rubric}：{g.average.toFixed(1)}/100（{g.scored}{" "}
								次）
							</p>
						))}
					</details>
				</div>
			)}
			{states.some((state) => state !== "passed" && s[state] > 0) && (
				<div className="RunSummary-counts">
					{states
						.filter((state) => state !== "passed" && s[state] > 0)
						.map((state) => (
							<span key={state} className="flex-center gap-1">
								<Status value={state} />
								<b>{s[state]}</b>
							</span>
						))}
				</div>
			)}
			<div className="RunSummary-meta muted small">
				已结束 {ended} / {s.total} · 重试 {s.retryCount ?? 0} 次 · 累计执行耗时{" "}
				{duration(s.durationMs)} · Token {s.tokens.toLocaleString()} · 费用{" "}
				{cost(s.cost)}
			</div>
			<div
				className="StatusBar"
				role="img"
				aria-label={`通过 ${s.passed}，失败 ${s.failed}，错误 ${s.error}，无法判定 ${s.inconclusive}，取消 ${s.cancelled}，运行中 ${s.running}，排队 ${s.queued}`}
			>
				{states
					.filter((state) => s[state] > 0)
					.map((state) => (
						<span
							key={state}
							className={`seg-${state === "inconclusive" ? "queued" : state}`}
							style={{ width: `${(s[state] / (s.total || 1)) * 100}%` }}
						/>
					))}
			</div>
		</section>
	);
}
