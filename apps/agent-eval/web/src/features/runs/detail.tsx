import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, message, send, useApi } from "../../api/client";
import {
	Alert,
	Box,
	Button,
	Check,
	DataState,
	Heading,
	JsonView,
	Modal,
	Select,
	Status,
	Tabs,
	Text,
	duration,
	modeLabel,
} from "../../components/ui";
import { ItemInspector } from "../results/inspector";
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
function RunDetail({ run, refresh }: { run: any; refresh: () => unknown }) {
	const [search, setSearch] = useState("");
	const [tab, setTab] = useState("items");
	const [filter, setFilter] = useState("");
	const [round, setRound] = useState("");
	const [selected, setSelected] = useState<string>();
	const [retry, setRetry] = useState(false);
	const [repeat, setRepeat] = useState(false);
	const [attempts, setAttempts] = useState<Record<string, any[]>>({});
	const [error, setError] = useState("");
	const stop = useMutation({
		mutationFn: () => send(`/api/runs/${run.id}/cancel?view=summary`, {}),
		onSuccess: refresh,
	});
	const running = ["queued", "running"].includes(run.status);
	const summary = run.summary;
	const rows = run.items.filter(
		(item: any) =>
			(!filter || item.status === filter) &&
			(!round || String(item.round ?? 1) === round) &&
			`${item.snapshot.definition.id} ${item.moduleName}`
				.toLowerCase()
				.includes(search.toLowerCase()),
	);
	const activeItem =
		run.items.find((i: any) => i.id === selected) ??
		Object.values(attempts)
			.flat()
			.find((i: any) => i.id === selected);
	async function loadAttempts(item: any) {
		try {
			const values = await api<any[]>(
				`/api/runs/${run.id}/items/${item.id}/attempts`,
			);
			setAttempts((v) => ({ ...v, [item.rootItemId ?? item.id]: values }));
		} catch (e) {
			setError(message(e));
		}
	}
	return (
		<>
			<div className="crumbs">
				<Link to="/runs">评测批次</Link> / {run.name}
			</div>
			<Heading
				title={run.name}
				description={`创建于 ${new Date(run.createdAt).toLocaleString()} · ${run.repeatCount ?? 1} 轮 · 并发 ${run.concurrency}${run.note ? ` · ${run.note}` : ""}`}
			>
				<Status value={run.status} />
				{running ? (
					<Button disabled={stop.isPending} onClick={() => stop.mutate()}>
						停止评测
					</Button>
				) : (
					<>
						<Button onClick={() => setRetry(true)}>重试未通过案例</Button>
						<Button onClick={() => setRepeat(true)}>重复评测</Button>
					</>
				)}
				{["json", "csv", "markdown"].map((format) => (
					<a
						className="btn"
						key={format}
						href={`/api/runs/${run.id}/export?format=${format}`}
					>
						导出 {format === "markdown" ? "简报" : format.toUpperCase()}
					</a>
				))}
			</Heading>
			<Alert>{error || (stop.error && message(stop.error))}</Alert>
			<div className="react-metrics">
				{[
					["案例", summary.total],
					["通过", summary.passed],
					["失败", summary.failed],
					["错误", summary.error],
					["无法判定", summary.inconclusive],
					["取消", summary.cancelled],
					["累计 Token", summary.tokens],
					["费用", summary.cost ?? "未知"],
				].map(([label, value]) => (
					<div key={label}>
						<strong>{value}</strong>
						<span>{label}</span>
					</div>
				))}
			</div>
			<Tabs
				onChange={setTab}
				entries={[
					[
						"items",
						"案例结果",
						<>
							<div className="react-filters">
								<Text
									value={search}
									onChange={setSearch}
									placeholder="搜索案例或模块"
								/>
								<Select
									value={filter}
									onChange={setFilter}
									options={[
										["", "全部结果"],
										...[
											"queued",
											"running",
											"passed",
											"failed",
											"error",
											"cancelled",
											"inconclusive",
										].map((v) => [v, v] as [string, string]),
									]}
								/>
								<Select
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
							</div>
							<div className="react-table-wrap">
								<table className="react-table">
									<thead>
										<tr>
											<th>案例</th>
											<th>模块</th>
											<th>回放方式</th>
											<th>结果</th>
											<th>轮次 / 尝试</th>
											<th>耗时</th>
											<th>操作</th>
										</tr>
									</thead>
									<tbody>
										{rows.map((item: any) => (
											<tr key={item.id}>
												<td>
													{item.snapshot.definition.id}
													{item.snapshot.definition.isBadCase && (
														<span className="Label Label--danger">
															Bad case
														</span>
													)}
												</td>
												<td>{item.moduleName}</td>
												<td>
													{modeLabel(item.snapshot.definition.replayMode)}
												</td>
												<td>
													<Status value={item.status} />
													{["queued", "running"].includes(item.status) &&
														item.phase && (
															<small className="react-block muted">
																{item.phase}
															</small>
														)}
													{item.activity && (
														<small className="react-block muted">
															{item.activity.toolName ?? item.activity.type}
														</small>
													)}
												</td>
												<td>
													{item.round ?? 1} / {(item.attempt ?? 0) + 1}
												</td>
												<td>{duration(item.result?.durationMs)}</td>
												<td>
													<Button onClick={() => setSelected(item.id)}>
														查看详情
													</Button>
													<Button onClick={() => loadAttempts(item)}>
														全部尝试
													</Button>
													{attempts[item.rootItemId ?? item.id]?.map(
														(attempt) => (
															<Button
																key={attempt.id}
																onClick={() => setSelected(attempt.id)}
															>
																尝试 {(attempt.attempt ?? 0) + 1} ·{" "}
																{attempt.status}
															</Button>
														),
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
								{!rows.length && <p className="empty">没有匹配的案例</p>}
							</div>
						</>,
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
						<>
							{Object.entries(run.moduleSummary ?? {}).map(
								([name, stats]: [string, any]) => (
									<Box key={name} title={name}>
										<p>
											通过 {stats.passed} / {stats.total} · 失败 {stats.failed}{" "}
											· 错误 {stats.error} · 无法判定 {stats.inconclusive}
										</p>
										<p>
											{duration(stats.durationMs)} · {stats.tokens} Token
										</p>
									</Box>
								),
							)}
						</>,
					],
				]}
			/>
			{activeItem && (
				<ItemInspector
					key={activeItem.id}
					runId={run.id}
					item={activeItem}
					close={() => setSelected(undefined)}
				/>
			)}
			{retry && (
				<RetryDialog
					runId={run.id}
					close={() => setRetry(false)}
					done={() => {
						setRetry(false);
						refresh();
					}}
				/>
			)}
			{repeat && <RepeatDialog run={run} close={() => setRepeat(false)} />}
		</>
	);
}
function RetryDialog({
	runId,
	close,
	done,
}: {
	runId: string;
	close: () => void;
	done: () => void;
}) {
	const preview = useApi<any>(`/api/runs/${runId}/retry-preview`);
	const [selected, setSelected] = useState<Set<string>>();
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
						<p className="form-hint">{report.method}</p>
						{report.partial && (
							<Alert kind="warning">
								这是阶段性报告，部分执行尚未完成或已取消。
							</Alert>
						)}
						<div className="react-metrics">
							<div>
								<strong>
									{report.completedRounds}/{report.repeatCount}
								</strong>
								<span>完整轮次</span>
							</div>
							<div>
								<strong>
									{report.allRoundsPassedCases}/{report.caseCount}
								</strong>
								<span>全轮通过案例</span>
							</div>
							<div>
								<strong>
									{report.outputChangedCases}/{report.comparableCases}
								</strong>
								<span>可比较案例中的输出变化</span>
							</div>
							<div>
								<strong>{report.judgmentChangedCases}</strong>
								<span>通过/失败波动</span>
							</div>
						</div>
						<Box title="各轮结果">
							<div className="react-table-wrap">
								<table className="react-table">
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
