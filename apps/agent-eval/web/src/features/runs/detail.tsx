import { useMutation } from "@tanstack/react-query";
import { Button as AntButton, Dropdown, Empty } from "antd";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { RunOverview } from "../../../../src/contracts/api";
import { canRetry, type RunItem } from "../../../../src/contracts/catalog";
import { message, send, useApi } from "../../api/client";
import {
	Badge,
	DataTable,
	Disclosure,
	DisclosureTitle,
} from "../../components/antd-compat";
import {
	Alert,
	Box,
	Button,
	Check,
	DataState,
	duration,
	JsonView,
	Modal,
	modeLabel,
	Select,
	Status,
	Tabs,
	Text,
} from "../../components/ui";
import { InlineItemInspector, ItemInspector } from "../results/inspector";
import { RepeatReport } from "./repeat-report";
import { RunSummary } from "./summary";
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
						· {new Set(run.items.map((item) => item.snapshot.id)).size} 个案例 ·{" "}
						{run.repeatCount ?? 1} 轮 · 并发 {run.concurrency}
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
					<Dropdown
						trigger={["click"]}
						menu={{
							items: ["json", "csv", "markdown"].map((format) => ({
								key: format,
								label: (
									<a href={`/api/runs/${run.id}/export?format=${format}`}>
										导出 {format === "markdown" ? "简报" : format.toUpperCase()}
									</a>
								),
							})),
						}}
					>
						<AntButton>导出 ▾</AntButton>
					</Dropdown>
					{!running && (
						<Button primary onClick={() => setRepeat(true)}>
							重复评测
						</Button>
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
											<AntButton
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
															<Badge className="Label Label--danger">
																Bad case
															</Badge>
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
											</AntButton>
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
										<Empty
											image={Empty.PRESENTED_IMAGE_SIMPLE}
											description="没有匹配的案例"
										>
											<div className="empty-desc">
												调整结果、模块或搜索条件后重试。
											</div>
										</Empty>
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
							<DataTable className="Table">
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
							</DataTable>
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
