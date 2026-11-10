import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { RunSummary } from "../../../../src/contracts/api";
import { api, message, send } from "../../api/client";
import {
	Alert,
	Button,
	DataState,
	Heading,
	Select,
	Status,
	Text,
	duration,
} from "../../components/ui";
export function RunsPage() {
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState("");
	const query = useQuery<RunSummary[]>({
		queryKey: ["/api/runs"],
		queryFn: ({ signal }) => api<RunSummary[]>("/api/runs", { signal }),
		refetchInterval: (q) =>
			q.state.data?.some((r: any) => ["queued", "running"].includes(r.status))
				? 1500
				: false,
	});
	const cancel = useMutation({
		mutationFn: (id: string) => send(`/api/runs/${id}/cancel?view=summary`, {}),
		onSuccess: () => query.refetch(),
	});
	const rows =
		query.data?.filter(
			(r) =>
				(!status || r.status === status) &&
				`${r.name} ${r.note ?? ""}`
					.toLowerCase()
					.includes(search.toLowerCase()),
		) ?? [];
	return (
		<>
			<Heading title="评测批次" description="查看执行进度、历史结果和重试记录">
				<Link className="btn btn-primary" to="/run/new">
					新建评测
				</Link>
			</Heading>
			<div className="react-filters">
				<Text
					aria-label="搜索批次"
					value={search}
					placeholder="搜索批次名称或备注"
					onChange={setSearch}
				/>
				<Select
					value={status}
					onChange={setStatus}
					options={[
						["", "全部状态"],
						["queued", "排队中"],
						["running", "运行中"],
						["completed", "已完成"],
						["cancelled", "已取消"],
						["interrupted", "已中断"],
					]}
				/>
			</div>
			<Alert>{cancel.error && message(cancel.error)}</Alert>
			<DataState query={query}>
				<div className="react-table-wrap">
					<table className="react-table">
						<thead>
							<tr>
								<th>评测批次</th>
								<th>状态</th>
								<th>案例结果</th>
								<th>轮次 / 并发</th>
								<th>耗时</th>
								<th>创建时间</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.id}>
									<td>
										<Link className="case-name" to={`/run/${r.id}`}>
											{r.name}
										</Link>
										<small className="react-block muted">{r.note}</small>
									</td>
									<td>
										<Status value={r.status} />
									</td>
									<td>
										通过 {r.summary.passed} / {r.summary.total}
										<small className="react-block">
											失败 {r.summary.failed} · 错误 {r.summary.error} ·
											无法判定 {r.summary.inconclusive}
										</small>
									</td>
									<td>
										{r.repeatCount ?? 1} / {r.concurrency}
									</td>
									<td>{duration(r.summary.durationMs)}</td>
									<td>{new Date(r.createdAt).toLocaleString()}</td>
									<td>
										<Link className="btn" to={`/run/${r.id}`}>
											查看
										</Link>
										{["queued", "running"].includes(r.status) && (
											<Button
												disabled={cancel.isPending}
												onClick={() => cancel.mutate(r.id)}
											>
												停止
											</Button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{!rows.length && <div className="empty">没有匹配的评测批次</div>}
				</div>
			</DataState>
		</>
	);
}
