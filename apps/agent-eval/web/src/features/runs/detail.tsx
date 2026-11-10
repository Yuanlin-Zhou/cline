import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { RunOverview } from "../../../../src/contracts/api";
import { canRetry, type RunItem } from "../../../../src/contracts/catalog";
import { api, message, send, useApi } from "../../api/client";
import {
	Alert,
	Box,
	Button,
	Check,
	DataState,
	JsonView,
	Modal,
	Select,
	Status,
	Tabs,
	Text,
	duration,
	modeLabel,
} from "../../components/ui";
import { InlineItemInspector, ItemInspector } from "../results/inspector";
import { GradingMetrics, RunSummary } from "./summary";
import { useRun } from "./use-run";

export function RunPage() {
	const { id = "" } = useParams();
	const query = useRun(id);
	return (
		<DataState query={query}>
			{query.data && (
				<RunDetail key={id} run={query.data} refresh={() => query.refetch()} />
			)}
		</DataState>
	);
}
function RunDetail({
	run,
	refresh,
}: {
	run: RunOverview;
	refresh: () => unknown;
}) {
	const [search, setSearch] = useState("");
	const [tab, setTab] = useState("items");
	const [filter, setFilter] = useState("");
	const [module, setModule] = useState("");
	const [round, setRound] = useState("");
	const [selectedRoot, setSelectedRoot] = useState<string>();
	const [attemptChoice, setAttemptChoice] = useState<Record<string, string>>(
		{},
	);
	const [expanded, setExpanded] = useState(false);
	const [retry, setRetry] = useState(false);
	const [retryItems, setRetryItems] = useState<string[]>();
	const [repeat, setRepeat] = useState(false);
	const stop = useMutation({
		mutationFn: () => send(`/api/runs/${run.id}/cancel?view=summary`, {}),
		onSuccess: refresh,
	});
	const running = ["queued", "running"].includes(run.status);
	const rows = run.items.filter(
		(item) =>
			(!filter ||
				(filter === "issues"
					? ["failed", "error", "inconclusive"].includes(item.status)
					: item.status === filter)) &&
			(!module || item.moduleName === module) &&
			(!round || String(item.round ?? 1) === round) &&
			`${item.snapshot.definition.id} ${item.snapshot.definition.description ?? ""} ${item.moduleName}`
				.toLowerCase()
				.includes(search.toLowerCase()),
	);
	const current =
		rows.find((item) => (item.rootItemId ?? item.id) === selectedRoot) ??
		rows[0];
	const root = current?.rootItemId ?? current?.id;
	const attempts = useApi<RunItem[]>(
		`/api/runs/${run.id}/items/${current?.id}/attempts`,
		!!current && tab === "items",
	);
	const history =
		attempts.data?.map((item) => (item.id === current?.id ? current : item)) ??
		(current ? [current] : []);
	const active =
		history.find(
			(item) => item.id === (root ? attemptChoice[root] : undefined),
		) ?? current;
	const startRetry = (ids?: string[]) => {
		setRetryItems(ids);
		setRetry(true);
	};
	return (
		<div className="RunDetailPage">
			<div className="crumbs">
				<Link to="/runs">评测批次</Link>
				<span>/</span>
				<span>{run.name}</span>
			</div>
			<div className="page-head flex-between wrap gap-3">
				<div className="RunHeading">
					<div className="flex-center gap-2 wrap">
						<h1 className="page-title">{run.name}</h1>
						<Status value={run.status} />
					</div>
					<p className="page-desc">
						创建于{" "}
						{new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false })}{" "}
						· {run.repeatCount ?? 1} 轮 · 并发 {run.concurrency}
						{run.note ? ` · ${run.note}` : ""}
					</p>
				</div>
				<div className="page-actions">
					{running ? (
						<Button
							danger
							disabled={stop.isPending}
							onClick={() => stop.mutate()}
						>
							停止评测
						</Button>
					) : (
						run.items.some(canRetry) && (
							<Button primary onClick={() => startRetry()}>
								重试未通过案例
							</Button>
						)
					)}
					{["json", "csv", "markdown"].map((format) => (
						<a
							key={format}
							className="btn"
							href={`/api/runs/${run.id}/export?format=${format}`}
						>
							导出 {format === "markdown" ? "简报" : format.toUpperCase()}
						</a>
					))}
					{!running && (
						<Button onClick={() => setRepeat(true)}>重复评测本批次</Button>
					)}
				</div>
			</div>
			<Alert>{stop.error && message(stop.error)}</Alert>
			<RunSummary run={run} />
			<Tabs
				onChange={setTab}
				entries={[
					[
						"items",
						"案例结果",
						<section key="items" aria-label="案例结果工作台">
							<div className="ResultFilters">
								<Text
									aria-label="搜索批次案例"
									placeholder="搜索案例名称或描述…"
									value={search}
									onChange={setSearch}
								/>
								<Select
									aria-label="按执行结果筛选"
									value={filter}
									onChange={setFilter}
									options={[
										["", "全部结果"],
										["issues", "失败与错误"],
										["running", "运行中"],
										["queued", "排队中"],
										["passed", "通过"],
										["failed", "断言失败"],
										["error", "执行错误"],
										["inconclusive", "无法判定"],
										["cancelled", "已取消"],
									]}
								/>
								<Select
									aria-label="按模块筛选"
									value={module}
									onChange={setModule}
									options={[
										["", "全部模块"],
										...[
											...new Set(run.items.map((item) => item.moduleName)),
										].map((name) => [name, name] as [string, string]),
									]}
								/>
								<Select
									aria-label="按重复轮次筛选"
									value={round}
									onChange={setRound}
									options={[
										["", "全部轮次"],
										...Array.from(
											{ length: run.repeatCount ?? 1 },
											(_, i) =>
												[String(i + 1), `第 ${i + 1} 轮`] as [string, string],
										),
									]}
								/>
								<span className="muted small">
									{rows.length} / {run.items.length} 项结果
								</span>
							</div>
							<div className="RunWorkbench" data-empty={!rows.length}>
								<div className="RunListColumn" hidden={!rows.length}>
									<section
										className="RunItems"
										aria-label="案例结果列表"
										hidden={!rows.length}
									>
										{rows.map((item) => (
											<button
												type="button"
												key={item.id}
												className="RunItem"
												aria-label={`查看案例：${item.snapshot.definition.id}`}
												aria-pressed={item.id === current?.id}
												onClick={() => {
													setSelectedRoot(item.rootItemId ?? item.id);
													setExpanded(false);
												}}
											>
												<span className="RunItem-head">
													<span className="case-name">
														{item.snapshot.definition.id}
														{(item.snapshot.definition.badCase ||
															(
																item.snapshot.definition as {
																	isBadCase?: boolean;
																}
															).isBadCase) && (
															<span className="Label Label--danger">
																Bad case
															</span>
														)}
													</span>
													<Status value={item.status} />
												</span>
												<span className="muted small">
													第 {item.round ?? 1} 轮 · 重试 {item.attempt ?? 0} 次
													· {item.moduleName} ·{" "}
													{modeLabel(item.snapshot.definition.replayMode)} ·{" "}
													{duration(item.result?.durationMs)}
												</span>
												{["queued", "running"].includes(item.status) &&
													item.phase && (
														<span className="RunItem-phase">
															{{
																executing: "执行中",
																verifying: "验证中",
																judging: "LLM 评分中",
															}[item.phase] ?? item.phase}
														</span>
													)}
											</button>
										))}
									</section>
								</div>
								<section className="RunInspector" aria-label="选中案例详情">
									{active && current ? (
										<>
											<div className="Inspector-toolbar">
												<Select
													aria-label="执行尝试历史"
													value={active.id}
													onChange={(id) => {
														if (root)
															setAttemptChoice((v) => ({ ...v, [root]: id }));
													}}
													options={history.map((item) => [
														item.id,
														`${item.attempt ? `第 ${item.attempt} 次重试` : "首次执行"} · ${{ queued: "排队中", running: "运行中", passed: "通过", failed: "失败", error: "执行错误", cancelled: "已取消", inconclusive: "无法判定" }[item.status]}`,
													])}
												/>
												<Button
													disabled={running || !canRetry(current)}
													onClick={() => startRetry([current.id])}
												>
													重试此案例
												</Button>
												<Button onClick={() => setExpanded(true)}>
													查看详情
												</Button>
											</div>
											<Alert>{attempts.error && message(attempts.error)}</Alert>
											<div className="Inspector-title">
												{active.snapshot.definition.id}
											</div>
											{!expanded && tab === "items" && (
												<InlineItemInspector
													key={active.id}
													runId={run.id}
													item={active}
												/>
											)}
										</>
									) : (
										<div className="empty">
											<div className="empty-title">没有匹配的案例</div>
											<div className="empty-desc">
												调整结果、模块或搜索条件后重试。
											</div>
										</div>
									)}
								</section>
							</div>
						</section>,
					],
					[
						"report",
						"多轮报告",
						tab === "report" ? (
							<RepeatReport
								key="report"
								runId={run.id}
								revision={run.revision}
							/>
						) : null,
					],
					[
						"modules",
						"模块统计",
						<div className="TableWrap" key="modules">
							<table className="Table">
								<thead>
									<tr>
										<th>模块</th>
										<th>通过 / 总数</th>
										<th>失败 / 错误 / 无法判定</th>
										<th>累计执行耗时</th>
										<th>Token</th>
									</tr>
								</thead>
								<tbody>
									{Object.entries(run.moduleSummary).map(([name, stats]) => (
										<tr key={name}>
											<td>{name}</td>
											<td>
												{stats.passed} / {stats.total}
											</td>
											<td>
												{stats.failed} / {stats.error} / {stats.inconclusive}
											</td>
											<td>{duration(stats.durationMs)}</td>
											<td>{stats.tokens.toLocaleString()}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>,
					],
				]}
			/>
			{expanded && active && (
				<ItemInspector
					runId={run.id}
					item={active}
					close={() => setExpanded(false)}
				/>
			)}
			{retry && (
				<RetryDialog
					runId={run.id}
					itemIds={retryItems}
					close={() => setRetry(false)}
					done={() => {
						setRetry(false);
						refresh();
					}}
				/>
			)}
			{repeat && <RepeatDialog run={run} close={() => setRepeat(false)} />}
		</div>
	);
}

function RetryDialog({
	runId,
	itemIds,
	close,
	done,
}: {
	runId: string;
	itemIds?: string[];
	close: () => void;
	done: () => void;
}) {
	const preview = useApi<any>(`/api/runs/${runId}/retry-preview`);
	const [selected, setSelected] = useState<Set<string> | undefined>(() =>
		itemIds ? new Set(itemIds) : undefined,
	);
	const [statuses, setStatuses] = useState([
		"failed",
		"error",
		"cancelled",
		"inconclusive",
	]);
	const [requestId] = useState(() => crypto.randomUUID());
	const visible =
		preview.data?.items.filter((i: any) => statuses.includes(i.status)) ?? [];
	const submit = useMutation({
		mutationFn: () =>
			send(`/api/runs/${runId}/retry`, {
				requestId,
				expectedRetryRevision: preview.data.retryRevision ?? 0,
				itemIds: visible
					.filter((i: any) => !selected || selected.has(i.id))
					.map((i: any) => i.id),
				statuses,
			}),
		onSuccess: done,
	});
	return (
		<Modal open title="重试未通过案例" onClose={close}>
			<p className="form-hint">
				使用原始快照重新执行，保留原尝试；取消/失败任务可能已有外部副作用。
			</p>
			{["failed", "error", "cancelled", "inconclusive"].map((status) => (
				<Check
					key={status}
					checked={statuses.includes(status)}
					onChange={(v) => {
						setStatuses((s) =>
							v ? [...s, status] : s.filter((x) => x !== status),
						);
						setSelected(undefined);
					}}
				>
					{status}
				</Check>
			))}
			<DataState query={preview}>
				{visible.map((item: any) => (
					<Check
						key={item.id}
						checked={!selected || selected.has(item.id)}
						onChange={(v) =>
							setSelected((s) => {
								const next = new Set<string>(
									s ?? visible.map((i: any) => i.id),
								);
								v ? next.add(item.id) : next.delete(item.id);
								return next;
							})
						}
					>
						{item.snapshot.definition.id} · 第 {item.round ?? 1} 轮 ·{" "}
						{item.status}
					</Check>
				))}
				{!visible.length && <p>没有符合条件的最新执行</p>}
			</DataState>
			<Alert>{submit.error && message(submit.error)}</Alert>
			<Button
				primary
				disabled={submit.isPending || !visible.length || selected?.size === 0}
				onClick={() => submit.mutate()}
			>
				确认重试
			</Button>
		</Modal>
	);
}
function RepeatDialog({ run, close }: { run: any; close: () => void }) {
	const [count, setCount] = useState(run.repeatCount ?? 1);
	const navigate = useNavigate();
	const mutation = useMutation({
		mutationFn: () =>
			send<any>("/api/runs", {
				parentRunId: run.id,
				rerunScope: "all",
				repeatCount: count,
				concurrency: run.concurrency,
				name: `${run.name} · 重复 ${count} 轮`,
			}),
		onSuccess: (value) => navigate(`/run/${value.id}`),
	});
	return (
		<Modal open title="重复评测" onClose={close}>
			<Text
				type="number"
				min={1}
				max={100}
				value={count}
				onChange={(v) => setCount(Number(v))}
			/>
			<p>保留原批次案例与配置快照，新建评测批次。</p>
			<Alert>{mutation.error && message(mutation.error)}</Alert>
			<Button
				primary
				disabled={mutation.isPending}
				onClick={() => mutation.mutate()}
			>
				开始重复评测
			</Button>
		</Modal>
	);
}
function RepeatReport({
	runId,
	revision,
}: {
	runId: string;
	revision: number;
}) {
	const [mode, setMode] = useState("latest");
	const [chosen, setChosen] = useState("");
	const path = `/api/runs/${runId}/report?attemptMode=${mode}`;
	const query = useQuery<any>({
		queryKey: [path, revision],
		queryFn: ({ signal }) => api(path, { signal }),
	});
	const selected = useApi<any>(`/api/runs/${runId}/items/${chosen}`, !!chosen);
	const report = query.data?.repeatReport;
	const rate = (v: number | null | undefined) =>
		v == null ? "—" : `${(v * 100).toFixed(1)}%`;
	return (
		<>
			<Select
				value={mode}
				onChange={setMode}
				options={[
					["latest", "各轮最新尝试"],
					["first", "各轮首次尝试"],
				]}
			/>
			<DataState query={query}>
				{report && (
					<>
						<h2 className="section-title">重复多轮评测报告</h2>
						<p>
							{report.caseCount} 个案例 × {report.repeatCount} 轮 · 完整执行{" "}
							{report.completedRounds} 轮
						</p>
						{report.partial && (
							<Alert kind="warning">
								这是阶段性报告，部分执行尚未完成或已取消。
							</Alert>
						)}
						<div className="ReviewSummary">
							<strong>
								全轮通过 {report.allRoundsPassedCases}/{report.caseCount}
							</strong>
							<span>通过/失败波动 {report.judgmentChangedCases} 个案例</span>
							<span>
								输出变化 {report.outputChangedCases}/{report.comparableCases}{" "}
								个可比较案例
							</span>
						</div>
						<details className="Verifier-details">
							<summary>多轮比较口径</summary>
							<p className="form-hint">{report.method}</p>
						</details>
						<GradingMetrics metrics={report.grading} />
						<Box title="各轮结果">
							<div className="TableWrap">
								<table className="Table">
									<thead>
										<tr>
											<th>轮次</th>
											<th>通过</th>
											<th>失败</th>
											<th>错误 / 无法判定</th>
											<th>取消 / 待完成</th>
											<th>文本通过率</th>
										</tr>
									</thead>
									<tbody>
										{report.rounds.map((r: any) => (
											<tr key={r.round}>
												<td>{r.round}</td>
												<td>{r.passed}</td>
												<td>{r.failed}</td>
												<td>
													{r.error} / {r.inconclusive}
												</td>
												<td>
													{r.cancelled} / {r.queued + r.running}
												</td>
												<td>{rate(r.passRate)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</Box>
						{report.grading.groups.map((g: any) => (
							<Box key={g.ruleHash ?? g.name} title={g.name}>
								<p>
									已判定通过率 {rate(g.passRate.rate)}（{g.passRate.numerator}/
									{g.passRate.denominator}） · 覆盖率 {rate(g.coverage.rate)} ·
									全部成功率 {rate(g.successRatio.rate)}
								</p>
								<p>
									关键约束通过率 {rate(g.constraints.rate)} · 验证错误{" "}
									{g.verifierErrors} · 未判定约束 {g.unknownConstraints}
								</p>
							</Box>
						))}
						<Box title="案例重复性">
							<p className="form-hint">
								一致率 = 最常见输出次数 /
								可比较输出次数，少于两次不计算；输出变化本身不代表质量下降。
							</p>
							{report.cases.map((c: any) => (
								<details key={c.caseId}>
									<summary>
										{c.moduleName} / {c.name} · 通过 {c.passed}/
										{c.passed + c.failed} · 输出版本 {c.outputVariants} · 一致率{" "}
										{rate(c.consistencyRate)}
									</summary>
									<div className="page-actions">
										{c.rounds.map((r: any) => (
											<Button
												key={r.itemId}
												onClick={() => setChosen(r.itemId)}
											>
												第 {r.round} 轮 · {r.status}
											</Button>
										))}
									</div>
									{c.rounds
										.filter((r: any) => r.error || r.failedAssertions.length)
										.map((r: any) => (
											<Alert key={r.itemId}>
												第 {r.round} 轮：
												{[...r.failedAssertions, r.error]
													.filter(Boolean)
													.join("；")}
											</Alert>
										))}
									{c.variants.map((v: any, i: number) => (
										<p key={i}>
											输出版本 {i + 1} · 第 {v.rounds.join("、")} 轮{" "}
											<Button onClick={() => setChosen(v.itemIds[0])}>
												查看完整输出
											</Button>
										</p>
									))}
								</details>
							))}
						</Box>
						<details>
							<summary>完整报告数据</summary>
							<JsonView value={report} />
						</details>
					</>
				)}
			</DataState>
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
		</>
	);
}
