import { Button, Modal, Table, Tag } from "antd";
import { useState } from "react";
import type { RunOverview } from "../../../../src/contracts/api";
import type { gradingSummary } from "../../../../src/modules/grading/summary";
import {
	DataTable,
	Disclosure,
	DisclosureTitle,
} from "../../components/antd-compat";
import { duration } from "../../components/ui";

type Fraction = { numerator: number; denominator: number; rate: number | null };
const fraction = (value: Fraction) =>
	`${value.numerator} / ${value.denominator}${value.rate === null ? "" : `（${(value.rate * 100).toFixed(1)}%）`}`;
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
			<Disclosure className="Verifier-details">
				<DisclosureTitle>详细统计与统计口径</DisclosureTitle>
				{!!metrics.groups.length && (
					<div className="TableWrap">
						<DataTable className="Table">
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
											<Disclosure>
												<DisclosureTitle>更多指标</DisclosureTitle>
												<p>
													全部成功 {fraction(g.successRatio)} · 规则版本{" "}
													{g.ruleHash ?? "未判分"}
												</p>
											</Disclosure>
										</td>
									</tr>
								))}
							</tbody>
						</DataTable>
					</div>
				)}
				<p className="form-hint">
					通过率 = 通过 /（通过 +
					失败）。回复检查与任务验收分开统计；执行错误、无法判定和取消单列。重试后按最新执行统计，耗时与
					Token 包含全部尝试。
				</p>
			</Disclosure>
		</div>
	);
}
export function RunSummary({ run }: { run: RunOverview }) {
	const [details, setDetails] = useState<"execution" | "judge">();
	const s = run.summary,
		j = run.judgeSummary;
	const ended = s.passed + s.failed + s.error + s.inconclusive + s.cancelled;
	return (
		<section className="RunSummary CompactRunSummary" aria-label="批次摘要">
			<div className="CompactSummaryRow">
				<h2>执行结果</h2>
				<div className="CompactSummaryContent">
					<div className="CompactSummaryLine">
						<strong>
							已结束 {ended} / {s.total}
						</strong>
						<Tag color="success">通过 {s.passed}</Tag>
						<span>
							失败 {s.failed} · 错误 {s.error} · 无法判定 {s.inconclusive} ·
							取消 {s.cancelled} · 待完成 {s.queued + s.running}
						</span>
					</div>
					<p className="CompactSummaryMeta">
						累计执行 {duration(s.durationMs)} · Token{" "}
						{s.tokens.toLocaleString()} · 重试 {s.retryCount ?? 0} 次
					</p>
				</div>
				<Button type="link" onClick={() => setDetails("execution")}>
					统计说明
				</Button>
			</div>
			<div className="CompactSummaryRow">
				<h2>LLM 评分</h2>
				<div className="CompactSummaryContent">
					{j.expected ? (
						<>
							<div className="CompactSummaryLine">
								<strong>
									已评分 {j.scored} / {j.expected}
								</strong>
								{j.groups.length === 1 && (
									<div className="CompactJudgeGroup CompactJudgeInline">
										<span title={j.groups[0].model}>{j.groups[0].model}</span>
										<span>平均分 {j.groups[0].average.toFixed(1)} / 100</span>
									</div>
								)}
								{(j.errors > 0 || j.insufficient > 0 || j.unscored > 0) && (
									<span>
										评分错误 {j.errors} · 信息不足 {j.insufficient} · 未评分{" "}
										{j.unscored}
									</span>
								)}
							</div>
							{(j.groups.length > 1 ? j.groups.slice(0, 2) : []).map((g, i) => (
								<div key={i} className="CompactJudgeGroup">
									<span title={g.model}>{g.model}</span>
									<span>平均分 {g.average.toFixed(1)} / 100</span>
								</div>
							))}
							{!j.groups.length && (
								<span className="CompactSummaryMeta">暂无有效均分</span>
							)}
							{j.groups.length > 2 && (
								<span className="CompactSummaryMeta">
									另有 {j.groups.length - 2} 个评分分组，查看详情
								</span>
							)}
							<p className="CompactSummaryMeta">
								评分耗时 {duration(j.durationMs)} · Token{" "}
								{(j.inputTokens + j.outputTokens).toLocaleString()}
							</p>
						</>
					) : (
						<span className="CompactSummaryMeta">未配置 LLM 评分器</span>
					)}
				</div>
				{j.expected > 0 && (
					<Button type="link" onClick={() => setDetails("judge")}>
						查看详情
					</Button>
				)}
			</div>
			<Modal
				open={details === "execution"}
				title="执行统计说明"
				footer={null}
				width={900}
				onCancel={() => setDetails(undefined)}
			>
				<p>
					按各轮最新尝试的最终状态统计；已结束包含通过、失败、执行错误、无法判定和取消，不代表全部通过。待完成包括排队{" "}
					{s.queued} 次、运行中 {s.running} 次。
				</p>
				<p>累计耗时与 Token 包含全部尝试（含重试）。</p>
				<GradingMetrics metrics={run.gradingSummary} />
			</Modal>
			<Modal
				open={details === "judge"}
				title="LLM 评分详情"
				footer={null}
				width={960}
				onCancel={() => setDetails(undefined)}
			>
				<p>
					已评分 {j.scored} / {j.expected} · 评分错误 {j.errors} · 信息不足{" "}
					{j.insufficient} · 未评分 {j.unscored} · 待评分 {j.pending}
				</p>
				<p className="form-hint">
					按评分器版本和有效配置分别汇总，不合并均分。只有有效数值评分计入均分；配置评分条目时以逐项判定为准。信息不足可能与已评分重叠，待评分包含在未评分中。
				</p>
				<Table
					size="small"
					pagination={{ pageSize: 8, hideOnSinglePage: true }}
					rowKey={(_, i) => String(i)}
					dataSource={j.groups}
					locale={{ emptyText: "暂无有效数值评分" }}
					columns={[
						{
							title: "评分器 / 模型",
							dataIndex: "model",
							width: "45%",
							render: (v) => <span className="SummaryLongText">{v}</span>,
						},
						{
							title: "评分标准",
							dataIndex: "rubric",
							render: (v) => <div className="SummaryRubric">{v}</div>,
						},
						{ title: "已评分", dataIndex: "scored", width: 85 },
						{
							title: "平均分",
							width: 130,
							render: (_, g) => `${g.average.toFixed(1)} / 100`,
						},
					]}
				/>
				<p className="form-hint">
					评分累计耗时 {duration(j.durationMs)} · Token{" "}
					{(j.inputTokens + j.outputTokens).toLocaleString()}
					（含重试）。逐项结论和证据可在下方案例结果中查看。
				</p>
			</Modal>
		</section>
	);
}
