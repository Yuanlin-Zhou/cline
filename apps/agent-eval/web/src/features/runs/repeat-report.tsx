import { useQuery } from "@tanstack/react-query";
import {
	Alert as AntAlert,
	Button as AntButton,
	Card,
	Collapse,
	Empty,
	Progress,
	Segmented,
	Select,
	Statistic,
	Table,
	Tag,
} from "antd";
import { useState } from "react";
import type { RepeatReport as Report } from "../../../../src/modules/runs/repeat-report";
import { api, useApi } from "../../api/client";
import { DataState, JsonView, Modal, Status } from "../../components/ui";
import { ItemInspector } from "../results/inspector";
import { GradingMetrics } from "./summary";

type Case = Report["cases"][number];
const rate = (passed: number, total: number) =>
	total ? `${((passed / total) * 100).toFixed(1)}%` : "—";
function verdict(c: Case, count: number) {
	const states = c.rounds.map((r) => r.status);
	if (
		count < 2 ||
		states.filter((s) => s === "passed" || s === "failed").length < 2
	)
		return { label: "暂无法判断", color: "default", key: "unknown" };
	if (states.includes("passed") && states.includes("failed"))
		return { label: "有波动", color: "warning", key: "changed" };
	if (states.length === count && states.every((s) => s === "passed"))
		return { label: "每轮通过", color: "success", key: "passed" };
	if (states.length === count && states.every((s) => s === "failed"))
		return { label: "每轮失败", color: "error", key: "failed" };
	return { label: "尚未全部判定", color: "default", key: "unknown" };
}
export function RepeatReport({
	runId,
	revision,
}: {
	runId: string;
	revision: number;
}) {
	const [mode, setMode] = useState("latest");
	const [filter, setFilter] = useState("all");
	const [chosen, setChosen] = useState("");
	const [comparison, setComparison] = useState<string>();
	const [round, setRound] = useState<number>();
	const [explanation, setExplanation] = useState<string[]>([]);
	const path = `/api/runs/${runId}/report?attemptMode=${mode}`;
	const query = useQuery<{ repeatReport: Report }>({
		queryKey: [path, revision],
		queryFn: ({ signal }) => api(path, { signal }),
	});
	const selected = useApi<any>(`/api/runs/${runId}/items/${chosen}`, !!chosen);
	const report = query.data?.repeatReport;
	const cases = report?.cases ?? [];
	const count = report?.repeatCount ?? 1;
	const records = cases.flatMap((c) => c.rounds);
	const completedRounds =
		report?.rounds.filter(
			(round) =>
				cases.length > 0 &&
				cases.every((c) =>
					c.rounds.some(
						(r) =>
							r.round === round.round &&
							["passed", "failed", "error", "inconclusive"].includes(r.status),
					),
				),
		).length ?? 0;
	const passed = records.filter((r) => r.status === "passed").length;
	const total = cases.length * count;
	const partial =
		report?.partial ||
		records.length < total ||
		records.some((r) => ["queued", "running", "cancelled"].includes(r.status));
	const stable = cases.filter((c) => verdict(c, count).key === "passed").length;
	const changed = cases.filter(
		(c) => verdict(c, count).key === "changed",
	).length;
	const comparable = cases.filter((c) => c.comparedOutputs >= 2);
	const enough = cases.some(
		(c) =>
			c.rounds.filter((r) => r.status === "passed" || r.status === "failed")
				.length >= 2,
	);
	const compared = cases.find((c) => c.caseId === comparison);
	const openItem = (id: string) => {
		setComparison(undefined);
		setRound(undefined);
		setChosen(id);
	};
	const caseName = (c: Case) => (
		<div className="RepeatCaseName">
			<strong title={c.name}>{c.name}</strong>
			<span>{c.moduleName}</span>
		</div>
	);
	return (
		<section className="RepeatReport">
			<DataState query={query}>
				{report && (
					<>
						<Card>
							<div className="RepeatHeading">
								<div>
									<h2>多轮评测概览</h2>
									<span className="form-hint">
										{cases.length} 个案例 × {count} 轮 · 完整执行{" "}
										{completedRounds} 轮
									</span>
								</div>
								<div className="RepeatControls">
									<span>统计口径</span>
									<Select
										aria-label="统计口径"
										value={mode}
										onChange={(v) => {
											setMode(v);
											setFilter("all");
											setChosen("");
											setComparison(undefined);
											setRound(undefined);
										}}
										options={[
											{ value: "latest", label: "各轮最新尝试" },
											{ value: "first", label: "各轮首次尝试" },
										]}
									/>
									<AntButton
										type="link"
										onClick={() => {
											setExplanation(["method"]);
											document.getElementById("repeat-method")?.scrollIntoView({
												behavior: "smooth",
												block: "center",
											});
										}}
									>
										口径说明
									</AntButton>
								</div>
							</div>
							<AntAlert
								type="info"
								showIcon
								title={
									count < 2
										? "当前仅执行 1 轮，暂无法判断稳定性；至少执行 2 轮后可比较。"
										: "同一批案例重复执行，观察通过情况是否稳定；输出变化不等于质量下降。"
								}
							/>
							{partial && (
								<AntAlert
									type="warning"
									showIcon
									title="阶段性报告：部分执行尚未完成或已取消，以下为当前结果。"
								/>
							)}
							<div className="RepeatMetrics">
								<Card size="small">
									<Statistic title="总体通过率" value={rate(passed, total)} />
									<span>
										{total
											? `${passed} / ${total} 次计划执行通过`
											: "暂无计划执行"}
									</span>
								</Card>
								<Card size="small">
									<Statistic
										title="每轮都通过"
										value={
											count >= 2 && cases.length
												? `${stable} / ${cases.length}`
												: "—"
										}
									/>
									<span>
										{count < 2 ? "暂无法判断稳定性" : `${count} 轮均通过的案例`}
									</span>
								</Card>
								<Card size="small">
									<Statistic
										title="通过情况有波动"
										value={enough ? `${changed} 个` : "—"}
									/>
									<span>
										{enough
											? "有时通过，有时失败"
											: "至少需要两次通过或失败的判定"}
									</span>
								</Card>
								<Card size="small">
									<Statistic
										title="输出有变化"
										value={
											comparable.length
												? `${comparable.filter((c) => c.outputVariants > 1).length} / ${comparable.length}`
												: "—"
										}
									/>
									<span>
										{comparable.length
											? "具备至少两次可比较输出的案例"
											: "暂无可比较案例，至少需要两次输出"}
									</span>
								</Card>
							</div>
						</Card>
						<Card
							title="各轮表现"
							extra={<span className="form-hint">点击轮次查看案例结果</span>}
						>
							<Table
								size="small"
								pagination={false}
								rowKey="round"
								dataSource={cases.length ? report.rounds : []}
								scroll={{ x: 1000 }}
								columns={[
									{
										title: "轮次",
										dataIndex: "round",
										render: (n: number) => (
											<AntButton type="link" onClick={() => setRound(n)}>
												第 {n} 轮
											</AntButton>
										),
									},
									{
										title: "通过率",
										width: 240,
										render: (_, r) => {
											const n = records.filter(
												(x) => x.round === r.round && x.status === "passed",
											).length;
											return (
												<div className="RepeatProgress">
													<Progress
														percent={
															cases.length ? (n / cases.length) * 100 : 0
														}
														showInfo={false}
													/>
													<span>{rate(n, cases.length)}</span>
												</div>
											);
										},
									},
									...(
										[
											"passed",
											"failed",
											"error",
											"inconclusive",
											"cancelled",
											"pending",
										] as const
									).map((s, i) => ({
										title: [
											"通过",
											"失败",
											"执行错误",
											"无法判定",
											"已取消",
											"未完成",
										][i],
										render: (_: unknown, r: Report["rounds"][number]) =>
											s === "pending"
												? cases.length -
													records.filter(
														(x) =>
															x.round === r.round &&
															!["queued", "running"].includes(x.status),
													).length
												: records.filter(
														(x) => x.round === r.round && x.status === s,
													).length,
									})),
								]}
							/>
							<p className="form-hint RepeatFootnote">
								通过率 = 最终状态为通过的执行数 /
								计划执行数，包含全部状态；详细验收指标见下方统计口径。
							</p>
						</Card>
						<Card
							title={
								<div>
									案例稳定性{" "}
									<span className="form-hint">
										横向查看同一案例在不同轮次的表现
									</span>
								</div>
							}
							extra={
								<Segmented
									aria-label="稳定性筛选"
									value={filter}
									onChange={setFilter}
									options={[
										{ value: "all", label: `全部 ${cases.length}` },
										{
											value: "changed",
											label: `有波动 ${enough ? changed : "—"}`,
											disabled: !enough,
										},
										{
											value: "passed",
											label: `每轮通过 ${count >= 2 && cases.length ? stable : "—"}`,
											disabled: count < 2,
										},
									]}
								/>
							}
						>
							<Table
								size="small"
								rowKey="caseId"
								pagination={{ pageSize: 20, hideOnSinglePage: true }}
								scroll={{ x: Math.max(1000, 560 + count * 120) }}
								locale={{
									emptyText: (
										<Empty
											image={Empty.PRESENTED_IMAGE_SIMPLE}
											description="暂无符合条件的案例"
										/>
									),
								}}
								dataSource={cases.filter(
									(c) => filter === "all" || verdict(c, count).key === filter,
								)}
								columns={[
									{
										title: "案例",
										key: "case",
										fixed: "left",
										width: 260,
										render: (_, c) => caseName(c),
									},
									...report.rounds.map((r) => ({
										title: `第 ${r.round} 轮`,
										key: `round-${r.round}`,
										width: 120,
										render: (_: unknown, c: Case) => {
											const item = c.rounds.find((x) => x.round === r.round);
											return item ? (
												<AntButton
													type="text"
													aria-label={`${c.name} 第 ${r.round} 轮详情`}
													onClick={() => openItem(item.itemId)}
												>
													<Status value={item.status} />
												</AntButton>
											) : (
												<Tag>待执行</Tag>
											);
										},
									})),
									{
										title: "通过情况",
										width: 150,
										render: (_, c) => {
											const v = verdict(c, count);
											return <Tag color={v.color}>{v.label}</Tag>;
										},
									},
									{
										title: "输出版本",
										width: 100,
										render: (_, c) =>
											c.comparedOutputs ? `${c.outputVariants} 个` : "暂无输出",
									},
									{
										title: "操作",
										width: 120,
										render: (_, c) => (
											<AntButton
												type="link"
												onClick={() => setComparison(c.caseId)}
											>
												{count < 2 ? "查看结果" : "查看对比"}
											</AntButton>
										),
									},
								]}
							/>
							<p className="form-hint RepeatFootnote">
								输出版本仅表示文本差异，不作为通过或失败的依据。
							</p>
						</Card>
						<div id="repeat-method">
							<Collapse
								activeKey={explanation}
								onChange={(v) =>
									setExplanation(typeof v === "string" ? [v] : v)
								}
								items={[
									{
										key: "method",
										label: "统计口径与原始数据",
										children: (
											<>
												<p>
													主视图按所选尝试的最终执行状态统计，每个案例每轮最多一次。总体通过率分母为全部计划执行；错误、无法判定、取消和未完成不会被排除。只有同一案例出现通过与失败才计为波动。
												</p>
												<p>{report.method}</p>
												<GradingMetrics metrics={report.grading} />
												{report.grading.groups.map((g) => (
													<Card
														size="small"
														key={g.ruleHash ?? g.name}
														title={g.name}
													>
														<p>
															已判定通过率{" "}
															{rate(
																g.passRate.numerator,
																g.passRate.denominator,
															)}{" "}
															· 覆盖率{" "}
															{rate(
																g.coverage.numerator,
																g.coverage.denominator,
															)}{" "}
															· 全部成功率{" "}
															{rate(
																g.successRatio.numerator,
																g.successRatio.denominator,
															)}
														</p>
														<p>
															关键约束通过率{" "}
															{rate(
																g.constraints.numerator,
																g.constraints.denominator,
															)}{" "}
															· 验证错误 {g.verifierErrors} · 未判定约束{" "}
															{g.unknownConstraints}
														</p>
													</Card>
												))}
												<Collapse
													items={[
														{
															key: "raw",
															label: "原始报告数据",
															children: <JsonView value={report} />,
														},
													]}
												/>
											</>
										),
									},
								]}
							/>
						</div>
					</>
				)}
			</DataState>
			{compared && (
				<Modal
					open
					title={`案例对比 · ${compared.name}`}
					onClose={() => setComparison(undefined)}
				>
					<p className="form-hint">
						{compared.moduleName} ·
						输出版本仅按文本差异分组；点击查看完整执行证据。
					</p>
					<Table
						pagination={false}
						size="small"
						rowKey="itemId"
						dataSource={compared.rounds}
						columns={[
							{
								title: "轮次",
								dataIndex: "round",
								render: (n) => `第 ${n} 轮`,
							},
							{
								title: "结果",
								dataIndex: "status",
								render: (s) => <Status value={s} />,
							},
							{
								title: "异常与未通过规则",
								render: (_, r) => (
									<div className="RepeatIssue">
										{[...r.failedAssertions, r.error]
											.filter(Boolean)
											.join("；") || "—"}
									</div>
								),
							},
							{
								title: "操作",
								render: (_, r) => (
									<AntButton type="link" onClick={() => openItem(r.itemId)}>
										查看执行
									</AntButton>
								),
							},
						]}
					/>
					{compared.comparedOutputs < 2 && (
						<p>可比较输出不足两次，暂无法判断输出一致性。</p>
					)}
					{compared.variants.map((v, i) => (
						<div className="RepeatVariant" key={v.itemIds[0]}>
							<span>
								输出版本 {i + 1} · 第 {v.rounds.join("、")} 轮
							</span>
							<AntButton onClick={() => openItem(v.itemIds[0])}>
								查看完整输出
							</AntButton>
						</div>
					))}
				</Modal>
			)}
			{round !== undefined && (
				<Modal
					open
					title={`第 ${round} 轮案例结果`}
					onClose={() => setRound(undefined)}
				>
					<Table
						rowKey="caseId"
						pagination={{ pageSize: 10, hideOnSinglePage: true }}
						dataSource={cases}
						columns={[
							{ title: "案例", render: (_, c) => caseName(c) },
							{
								title: "结果",
								render: (_, c) => {
									const r = c.rounds.find((x) => x.round === round);
									return r ? (
										<AntButton type="text" onClick={() => openItem(r.itemId)}>
											<Status value={r.status} />
										</AntButton>
									) : (
										<Tag>待执行</Tag>
									);
								},
							},
						]}
					/>
				</Modal>
			)}
			{chosen && (
				<DataState query={selected}>
					{selected.data && (
						<ItemInspector
							runId={runId}
							item={selected.data}
							close={() => setChosen("")}
						/>
					)}
				</DataState>
			)}
		</section>
	);
}
