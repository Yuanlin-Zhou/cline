import { useQuery } from "@tanstack/react-query";
import { Empty } from "antd";
import { useState } from "react";
import { api, useApi } from "../../api/client";
import {
	ActionLink,
	Disclosure,
	DisclosureTitle,
} from "../../components/antd-compat";
import { RemoteJson } from "../../components/remote-json";
import {
	Alert,
	Box,
	Button,
	DataState,
	duration,
	JsonView,
	Modal,
	Select,
	Status,
	Tabs,
} from "../../components/ui";
import { JudgeTrial } from "../judging/trial";
import { useRunItem } from "../runs/use-run";
import { VerifierTrial } from "../verifiers/trial";

export function ItemInspector({
	runId,
	item,
	close,
}: {
	runId: string;
	item: any;
	close: () => void;
}) {
	return (
		<Modal open title={item.snapshot.definition.id} onClose={close}>
			<InlineItemInspector runId={runId} item={item} />
		</Modal>
	);
}
export function InlineItemInspector({
	runId,
	item,
}: {
	runId: string;
	item: any;
}) {
	const query = useRunItem(runId, item);
	return (
		<DataState query={query}>
			{query.data && (
				<ItemContent
					runId={runId}
					item={{ ...query.data, status: item.status, phase: item.phase }}
				/>
			)}
		</DataState>
	);
}
export function ItemContent({ runId, item }: { runId: string; item: any }) {
	const result = item.result;
	const [tab, setTab] = useState("result");
	const [evidenceId, setEvidenceId] = useState<string>();
	const evidence = useApi<any>(
		`/api/runs/${runId}/items/${item.id}/evidence/${evidenceId}`,
		!!evidenceId,
	);
	const finished = !["queued", "running"].includes(item.status);
	const checks = (
		<>
			<Box title="回复断言">
				{result?.assertions?.map((a: any, i: number) => (
					<p key={i}>
						<Status value={a.passed ? "passed" : "failed"} /> {a.message}
					</p>
				))}
				{!result?.assertions?.length && (
					<p className="muted">没有回复断言记录</p>
				)}
			</Box>
			{result?.grading && (
				<Box title={`任务验收 · ${result.grading.verdict}`}>
					<p>验证状态：{result.grading.status}</p>
					{result.grading.results.map((rule: any) => (
						<Box
							key={rule.id}
							title={`${rule.label ?? rule.id} · ${rule.status}`}
						>
							<p>{rule.message}</p>
							<Disclosure>
								<DisclosureTitle>预期与实际</DisclosureTitle>
								<JsonView
									value={{
										expected: rule.expected,
										actual: rule.actual,
									}}
								/>
							</Disclosure>
							{rule.evidenceRefs?.map((id: string) => (
								<Button key={id} onClick={() => setEvidenceId(id)}>
									查看证据
								</Button>
							))}
						</Box>
					))}
					{evidenceId && (
						<DataState query={evidence}>
							{evidence.data && <JsonView value={evidence.data.text} />}
						</DataState>
					)}
				</Box>
			)}
			{result?.llmJudge && (
				<Box title={`LLM Judge · ${result.llmJudge.score ?? "无分数"}`}>
					<p>{result.llmJudge.rationale}</p>
					<JsonView value={result.llmJudge} />
					<RemoteJson
						path={`/api/runs/${runId}/items/${item.id}/judge-scores/official-input`}
						title="查看正式评分输入"
					/>
				</Box>
			)}
		</>
	);
	return (
		<>
			<div className="react-row">
				<Status value={item.status} />
				<span>
					{!finished &&
						item.phase &&
						{ executing: "执行中", verifying: "验收中", judging: "评分中" }[
							item.phase as string
						]}
				</span>
				<span>{duration(result?.durationMs)}</span>
				<span>
					第 {item.round ?? 1} 轮 · 尝试 {(item.attempt ?? 0) + 1}
				</span>
			</div>
			<p className="muted small Inspector-context">
				模型：{item.snapshot.defaults.modelId} · v{item.snapshot.revision}
			</p>
			{(result?.sessionId ?? item.sessionId) && (
				<p className="muted small Inspector-context">
					<code>session_id: {result?.sessionId ?? item.sessionId}</code>
				</p>
			)}
			<Alert>
				{item.error ??
					result?.error ??
					(item.status === "failed"
						? result?.assertions
								?.filter((a: any) => !a.passed)
								.map((a: any) => a.message)
								.join("；") || "断言未通过"
						: undefined)}
			</Alert>
			<Tabs
				onChange={setTab}
				entries={[
					[
						"result",
						"结果与断言",
						<>
							{!result?.functionCallResponse &&
								!(
									["error", "cancelled"].includes(item.status) &&
									!result?.text &&
									!item.text
								) && (
									<Box title="最终回复">
										<JsonView value={result?.text || item.text || "暂无输出"} />
									</Box>
								)}
							{result?.functionCallResponse && (
								<Box title="原始函数调用响应">
									<p className="form-hint">工具仅公布，没有实际执行。</p>
									<p className="form-hint">
										HTTP {result.functionCallResponse.http_status} ·{" "}
										{result.functionCallResponse.completeness}
									</p>
									<JsonView value={result.functionCallResponse.raw_response} />
									<Disclosure>
										<DisclosureTitle>本次公布的工具与调用策略</DisclosureTitle>
										<JsonView
											value={{
												tools: result.functionCallResponse.request_tools,
												toolChoice: result.functionCallResponse.tool_choice,
											}}
										/>
									</Disclosure>
								</Box>
							)}
							{item.snapshot.definition.badCase && (
								<Box title="原始 Bad case 输出">
									<p className="form-hint">
										仅作案例对照，不是本次模型输入或评分参考答案。
									</p>
									<Disclosure>
										<DisclosureTitle>展开原始错误输出</DisclosureTitle>
										<JsonView
											value={item.snapshot.definition.badCase.observedOutput}
										/>
									</Disclosure>
									{item.snapshot.definition.badCase.reason && (
										<p>{item.snapshot.definition.badCase.reason}</p>
									)}
								</Box>
							)}
							{tab === "result" && checks}
							<Disclosure className="Verifier-details Inspector-execution">
								<DisclosureTitle>执行详情</DisclosureTitle>
								<div className="Inspector-execution-body">
									<p>
										结束原因：{result?.finishReason ?? "—"} · 迭代：
										{result?.iterations ?? "—"}
									</p>
									<p>
										输入 Token：{result?.usage?.inputTokens ?? "—"} · 输出
										Token：
										{result?.usage?.outputTokens ?? "—"} · 费用：
										{result?.usage?.totalCost ?? "未知"}
									</p>
									{item.workspace && (
										<p className="form-hint">
											{result?.workspaceInfo?.mode === "direct"
												? "直接执行"
												: "复制后执行"}{" "}
											· 实际目录：{item.workspace}
										</p>
									)}
									<Disclosure>
										<DisclosureTitle>任务配置快照</DisclosureTitle>
										<JsonView value={item.snapshot} />
										{result?.runtime && (
											<Disclosure>
												<DisclosureTitle>生效执行配置</DisclosureTitle>
												<JsonView value={result.runtime} />
											</Disclosure>
										)}
									</Disclosure>
								</div>
							</Disclosure>
							{result && (
								<div className="metric-row mt-3">
									<span className="metric">
										耗时 <b>{duration(result.durationMs)}</b>
									</span>
									<span className="metric">
										迭代 <b>{result.iterations}</b>
									</span>
									<span className="metric">
										输入 Token{" "}
										<b>{result.usage?.inputTokens?.toLocaleString() ?? "—"}</b>
									</span>
									<span className="metric">
										输出 Token{" "}
										<b>{result.usage?.outputTokens?.toLocaleString() ?? "—"}</b>
									</span>
									<span className="metric">
										费用{" "}
										<b>
											{result.usage?.totalCost == null
												? "未提供"
												: `$${result.usage.totalCost.toFixed(4)}`}
										</b>
									</span>
								</div>
							)}
						</>,
					],
					["checks", "验收结果", tab === "checks" && checks],
					[
						"conversation",
						"会话与工具",
						<>
							{tab === "conversation" && (
								<Conversation runId={runId} item={item} />
							)}
							{result?.toolCalls?.map((call: any, i: number) => (
								<Disclosure key={i}>
									<DisclosureTitle>
										{call.name} · {duration(call.durationMs)}
										{call.error ? " · 错误" : ""}
									</DisclosureTitle>
									<JsonView
										value={{
											input: call.input,
											output: call.output,
											error: call.error,
										}}
									/>
								</Disclosure>
							))}
							<p className="form-hint">
								已保存的工具诊断不证明真实执行或审批事件。
							</p>
						</>,
					],
					[
						"artifacts",
						"文件产物",
						tab === "artifacts" && <Artifacts runId={runId} item={item} />,
					],
					[
						"trials",
						"试验证 / 试评分",
						finished ? (
							tab === "trials" && (
								<>
									<VerifierTrial runId={runId} item={item} />
									<JudgeTrial runId={runId} item={item} />
								</>
							)
						) : (
							<p key="trial-empty">
								请选择已结束的执行。试验证和试评分不改写原批次正式结论。
							</p>
						),
					],
				]}
			/>
		</>
	);
}
function Conversation({ runId, item }: { runId: string; item: any }) {
	const [offset, setOffset] = useState(0);
	const path = `/api/runs/${runId}/items/${item.id}/conversation`;
	const query = useQuery<any>({
		queryKey: [path, offset],
		queryFn: ({ signal }) =>
			api(`${path}?offset=${offset}&limit=50`, { signal }),
		refetchInterval: ["queued", "running"].includes(item.status) ? 2000 : false,
	});
	return (
		<DataState query={query}>
			{query.data && (
				<>
					<p className="form-hint">{query.data.notice}</p>
					<ActionLink className="btn" href={`${path}?download=1`}>
						下载完整会话
					</ActionLink>
					{query.data.messages.map((m: any) => (
						<Box key={m.id} title={`${m.index + 1} · ${m.role}`}>
							{m.blocks.map((b: any, i: number) => (
								<div key={i}>
									{b.toolName && <strong>{b.toolName}</strong>}
									<JsonView value={b.text} />
								</div>
							))}
						</Box>
					))}
					<div className="page-actions">
						<Button
							disabled={!offset}
							onClick={() => setOffset((v) => Math.max(0, v - 50))}
						>
							上一页
						</Button>
						<Button
							disabled={query.data.nextOffset === undefined}
							onClick={() => setOffset(query.data.nextOffset)}
						>
							下一页
						</Button>
						<span>
							{offset + 1}–{Math.min(offset + 50, query.data.total)} /{" "}
							{query.data.total}
						</span>
					</div>
				</>
			)}
		</DataState>
	);
}
function Artifacts({ runId, item }: { runId: string; item: any }) {
	const applicable = item.snapshot.definition.replayMode === "full-task";
	const [file, setFile] = useState("");
	const path = `/api/runs/${runId}/artifacts?item=${item.id}`;
	const list = useApi<any[]>(path, applicable);
	const diff = useApi<any>(`${path}&file=${encodeURIComponent(file)}`, !!file);
	if (!applicable)
		return (
			<Empty
				image={Empty.PRESENTED_IMAGE_SIMPLE}
				description="单轮回放不产生工作区文件变更。"
			/>
		);
	return (
		<>
			<DataState query={list}>
				{list.data && (
					<>
						<Select
							value={file}
							onChange={setFile}
							options={[
								["", "选择文件查看差异"],
								...list.data.map(
									(f) =>
										[f.path, `${f.change} · ${f.path} (${f.size} B)`] as [
											string,
											string,
										],
								),
							]}
						/>
						{!list.data.length && <p>没有归档文件</p>}
					</>
				)}
			</DataState>
			{file && (
				<DataState query={diff}>
					{diff.data && (
						<div className="react-diff">
							<div>
								<strong>执行前</strong>
								<JsonView value={diff.data.before ?? "文件不存在"} />
							</div>
							<div>
								<strong>执行后</strong>
								<JsonView value={diff.data.after ?? "文件不存在"} />
							</div>
						</div>
					)}
				</DataState>
			)}
		</>
	);
}
