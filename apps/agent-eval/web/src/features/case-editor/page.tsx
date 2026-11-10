import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import {
	Link,
	useNavigate,
	useParams,
	useSearchParams,
} from "react-router-dom";
import type { Module, Run, SavedCase } from "../../../../src/contracts/catalog";
import type {
	EvalCase,
	EvalDefaults,
} from "../../../../src/contracts/evaluation";
import {
	FUNCTION_CALL_TOOLS,
	parseFunctionCall,
} from "../../../../src/contracts/function-call-config";
import { caseExample, REPLAY_MODES } from "../../../../src/contracts/replay";
import { parseEvalSuite } from "../../../../src/contracts/schema";
import { message, send, useApi } from "../../api/client";
import { assertValidEditors } from "../../components/editor-validity";
import { HeadersEditor } from "../../components/headers";
import { Tags } from "../../components/tags";
import {
	Alert,
	Box,
	Button,
	Check,
	DataState,
	Field,
	Heading,
	JsonView,
	modeLabel,
	Select,
	Status,
	Tabs,
	Text,
	useNotice,
} from "../../components/ui";
import { useDraft } from "../../hooks/draft";
import { TransferDialog } from "../catalog/page";
import { JudgeEditor } from "../judging/editor";
import { InlineItemInspector } from "../results/inspector";
import { useRun } from "../runs/use-run";
import { HistoryTrials } from "../results/history-trials";
import { ConfigEditor } from "../settings/config-editor";
import { HistoryEditor } from "./history";
import { RulesEditor } from "./rules";

export function CasePage() {
	const { id } = useParams();
	const [search] = useSearchParams();
	const modules = useApi<{ modules: Module[] }>("/api/modules?view=summary");
	const settings = useApi<EvalDefaults>("/api/settings");
	const existing = useApi<SavedCase>(`/api/cases/${id}`, !!id);
	if (id && existing.isError)
		return <DataState query={existing}>{null}</DataState>;
	if ((id && !existing.data) || !settings.data)
		return (
			<DataState query={settings.isError ? settings : existing}>
				{null}
			</DataState>
		);
	return (
		<DataState query={modules}>
			{modules.data && (
				<CaseForm
					key={id ?? `new-${search.get("module")}`}
					initial={existing.data}
					modules={modules.data.modules}
					moduleId={search.get("module") ?? undefined}
					settings={settings.data}
					initialTab={search.get("tab") ?? undefined}
				/>
			)}
		</DataState>
	);
}
function CaseForm({
	initial,
	modules,
	moduleId,
	settings,
	initialTab,
}: {
	initial?: SavedCase;
	modules: Module[];
	moduleId?: string;
	settings: EvalDefaults;
	initialTab?: string;
}) {
	const [record, setRecord] = useState(initial);
	const [target, setTarget] = useState(
		initial?.moduleId ?? moduleId ?? modules[0]?.id ?? "",
	);
	const draft = useDraft({
		definition: structuredClone(
			initial?.definition ??
				({
					id: "",
					prompt: "",
					history: [],
					replayMode: "single-turn",
					tags: [],
					assertions: { finishReason: "completed" },
				} as EvalCase),
		),
		defaults: structuredClone(initial?.defaults ?? settings),
	});
	const { definition, defaults } = draft.value;
	const setDefinition = (value: EvalCase) =>
		draft.setValue((v) => ({ ...v, definition: value }));
	const navigate = useNavigate();
	const client = useQueryClient();
	const notice = useNotice();
	const [transfer, setTransfer] = useState<"copy" | "move">();
	const [error, setError] = useState("");
	const [judgeTrial, setJudgeTrial] = useState(false);
	const [inlineRun, setInlineRun] = useState<string>();
	const parsed = () => {
		assertValidEditors();
		return parseEvalSuite({ defaults, cases: [definition] });
	};
	const save = useMutation({
		mutationFn: async () => {
			const suite = parsed();
			return send<SavedCase>(
				record ? `/api/cases/${record.id}` : "/api/cases",
				{
					moduleId: target,
					revision: record?.revision,
					definition: suite.cases[0],
					defaults: suite.defaults,
				},
				record ? "PUT" : "POST",
			);
		},
		onSuccess: (value) => {
			flushSync(() => {
				setRecord(value);
				draft.setValue({
					definition: value.definition,
					defaults: value.defaults,
				});
				draft.markSaved({
					definition: value.definition,
					defaults: value.defaults,
				});
			});
			client.setQueryData([`/api/cases/${value.id}`], value);
			void client.invalidateQueries({
				predicate: (q) =>
					String(q.queryKey[0]).startsWith("/api/cases") ||
					String(q.queryKey[0]).startsWith("/api/modules"),
			});
			notice("案例已保存");
			if (!initial) navigate(`/case/${value.id}`, { replace: true });
		},
	});
	const run = useMutation({
		mutationFn: async () => {
			const suite = parsed();
			return send<Run>("/api/runs", {
				name: `调试 · ${definition.id}`,
				draft: [
					{
						moduleId: target,
						definition: suite.cases[0],
						defaults: suite.defaults,
					},
				],
				replayMode: definition.replayMode,
				concurrency: 1,
			});
		},
		onSuccess: (value) => setInlineRun(value.id),
	});
	const mode = definition.replayMode ?? "single-turn";
	const updateMode = (replayMode: EvalCase["replayMode"]) =>
		setDefinition({
			...definition,
			replayMode,
			...(replayMode === "function-call" && !definition.functionCall
				? { functionCall: parseFunctionCall(undefined) }
				: {}),
		});
	const history = useApi<any[]>(`/api/cases/${record?.id}/runs`, !!record);
	if (!target)
		return (
			<Alert kind="warning">
				请先创建一个模块。<Link to="/cases">返回案例集</Link>
			</Alert>
		);
	return (
		<>
			<div className="crumbs">
				<Link to="/cases">案例</Link> /{" "}
				<Link to={`/cases/${target}`}>
					{modules.find((m) => m.id === target)?.name}
				</Link>{" "}
				/ {record ? definition.id : "新建案例"}
			</div>
			<Heading
				title={
					<>
						<span className="case-heading-name" title={definition.id}>
							{record ? definition.id : "新建案例"}
						</span>
						{definition.badCase && (
							<span className="Label Label--danger">Bad case</span>
						)}
					</>
				}
				description={
					record ? (
						<>
							{`模块：${modules.find((m) => m.id === target)?.name} · 版本 v${record.revision} · ${draft.dirty ? "有未保存修改" : "已保存"}`}
							<br />
							<code className="small">
								session_id:{" "}
								{history.data
									?.flatMap((entry) => entry.items ?? [])
									.find((item: any) => item.sessionId)?.sessionId ?? "—"}
							</code>
						</>
					) : (
						`归属模块：${modules.find((m) => m.id === target)?.name}`
					)
				}
			>
				<Link className="btn" to={`/cases/${target}`}>
					返回
				</Link>
				<Button disabled={save.isPending} onClick={() => save.mutate()}>
					保存
				</Button>
				{record && (
					<>
						<Button onClick={() => setTransfer("copy")}>复制到…</Button>
						<Button onClick={() => setTransfer("move")}>移动到…</Button>
						<Button
							danger
							onClick={async () => {
								if (!confirm("永久删除这个案例？")) return;
								try {
									await send(`/api/cases/${record.id}`, undefined, "DELETE");
									flushSync(() => draft.markSaved());
									navigate(`/cases/${target}`);
								} catch (e) {
									setError(message(e));
								}
							}}
						>
							删除
						</Button>
					</>
				)}
				<Button primary disabled={run.isPending} onClick={() => run.mutate()}>
					运行{modeLabel(mode)}
				</Button>
			</Heading>
			<Alert>
				{error ||
					(save.error && message(save.error)) ||
					(run.error && message(run.error))}
			</Alert>
			<fieldset className="replay-cards CaseReplay" aria-label="回放方式">
				{REPLAY_MODES.map((m) => (
					<Button
						key={m.value}
						className={`replay-card ${mode === m.value ? "active" : ""}`}
						aria-pressed={mode === m.value}
						onClick={() => updateMode(m.value)}
					>
						<strong>{m.label}</strong>
						<span className="form-hint">{m.description}</span>
					</Button>
				))}
			</fieldset>
			<div className="CaseLayout CaseEditor">
				<section className="CaseEditor-form">
					<Tabs
						initial={initialTab === "grading" ? "grading" : "input"}
						entries={[
							[
								"input",
								"输入",
								<>
									<Box>
										<h3 className="section-title">基本信息</h3>
										{!record && (
											<Field label="归属模块">
												<Select
													value={target}
													onChange={setTarget}
													options={modules.map((m) => [m.id, m.name])}
												/>
											</Field>
										)}
										<Field
											label="案例 ID *"
											hint="模块内唯一，例如 history-bun-install"
										>
											<Text
												aria-label="案例名称"
												value={definition.id}
												onChange={(id) => setDefinition({ ...definition, id })}
											/>
										</Field>
										<Field
											label="描述"
											hint="可选，例如：验证模型遵循历史上下文"
										>
											<Text
												value={definition.description}
												onChange={(description) =>
													setDefinition({ ...definition, description })
												}
											/>
										</Field>
										<Field label="标签" hint="新增或选择已有标签，保存后生效。">
											<Tags
												value={definition.tags ?? []}
												onChange={(tags) =>
													setDefinition({ ...definition, tags })
												}
											/>
										</Field>

										<section className="BadCaseEditor">
											<Check
												checked={!!definition.badCase}
												onChange={(v) =>
													setDefinition({
														...definition,
														badCase: v
															? { observedOutput: "", outputFormat: "text" }
															: undefined,
													})
												}
											>
												标记为 Bad case
											</Check>
											{definition.badCase && (
												<>
													<Field label="错误输出格式">
														<Select
															value={definition.badCase.outputFormat ?? "text"}
															onChange={(v) =>
																setDefinition({
																	...definition,
																	badCase: {
																		...definition.badCase!,
																		outputFormat: v as "text" | "json",
																	},
																})
															}
															options={[
																["text", "文本"],
																["json", "JSON"],
															]}
														/>
													</Field>
													<Field label="原始错误输出">
														<Text
															multiline
															rows={2}
															className="BadCaseEditor-output"
															value={definition.badCase.observedOutput}
															onChange={(observedOutput) =>
																setDefinition({
																	...definition,
																	badCase: {
																		...definition.badCase!,
																		observedOutput,
																	},
																})
															}
														/>
													</Field>
													<Field label="错误原因">
														<Text
															multiline
															rows={1}
															className="BadCaseEditor-reason"
															value={definition.badCase.reason}
															onChange={(reason) =>
																setDefinition({
																	...definition,
																	badCase: {
																		...definition.badCase!,
																		reason: reason || undefined,
																	},
																})
															}
														/>
													</Field>
													<p className="form-hint">
														仅保存为案例属性，不自动加入模型输入或判分答案。
													</p>
												</>
											)}
											{definition.importSource && (
												<details>
													<summary>来源信息</summary>
													<JsonView value={definition.importSource} />
												</details>
											)}
										</section>
									</Box>

									<HistoryEditor value={definition} onChange={setDefinition} />
									<Box
										title={mode === "full-task" ? "任务指令 *" : "本轮问题 *"}
									>
										<Text
											multiline
											rows={4}
											aria-label="本轮输入"
											value={definition.prompt}
											onChange={(prompt) =>
												setDefinition({ ...definition, prompt })
											}
										/>
										<p className="form-hint">
											示例：{caseExample(mode).prompt}
										</p>
										<Button
											className="btn-sm mt-2"
											onClick={() => {
												if (
													(definition.prompt.trim() ||
														definition.history.length ||
														definition.assertions?.contains?.length) &&
													!window.confirm(
														"将替换当前输入、历史消息和包含文本规则，并填入示例执行配置。",
													)
												)
													return;
												const sample = caseExample(mode);
												setDefinition({
													...definition,
													...sample,
													id: definition.id || sample.id,
												});
											}}
										>
											填入示例
										</Button>
									</Box>
									{mode === "function-call" && (
										<Box title="本轮公布哪些工具？">
											<p className="form-hint">
												只生成模型调用，不实际执行工具；响应可包含多次调用。
											</p>
											{FUNCTION_CALL_TOOLS.map((tool) => (
												<Check
													key={tool}
													checked={definition.functionCall?.tools.includes(
														tool,
													)}
													onChange={(v) => {
														const tools = v
															? [
																	...(definition.functionCall?.tools ?? []),
																	tool,
																]
															: (definition.functionCall?.tools ?? []).filter(
																	(t) => t !== tool,
																);
														setDefinition({
															...definition,
															functionCall: {
																...definition.functionCall!,
																tools,
																toolChoice: [
																	"auto",
																	"required",
																	...tools,
																].includes(
																	definition.functionCall?.toolChoice ?? "auto",
																)
																	? definition.functionCall?.toolChoice
																	: "auto",
															},
														});
													}}
												>
													{tool}
												</Check>
											))}
											<Field label="调用选择方式">
												<Select
													value={definition.functionCall?.toolChoice ?? "auto"}
													onChange={(toolChoice) =>
														setDefinition({
															...definition,
															functionCall: {
																...definition.functionCall!,
																toolChoice: toolChoice as any,
															},
														})
													}
													options={[
														["auto", "自动选择"],
														["required", "必须调用所选工具"],
														...(definition.functionCall?.tools ?? []).map(
															(t) => [t, `强制调用 ${t}`] as [string, string],
														),
													]}
												/>
											</Field>
										</Box>
									)}
								</>,
							],
							[
								"grading",
								"判定规则",
								<>
									<RulesEditor
										value={definition}
										onChange={setDefinition}
										caseId={record?.id}
										judge={
											<>
												<JudgeEditor
													value={definition.llmJudge}
													onChange={(llmJudge) =>
														setDefinition({ ...definition, llmJudge })
													}
													mode={mode}
												/>
												{definition.llmJudge?.enabled && (
													<Button onClick={() => setJudgeTrial(true)}>
														试评分
													</Button>
												)}{" "}
											</>
										}
									/>
								</>,
							],
							[
								"execution",
								"配置",
								<>
									<>
										<ConfigEditor
											caseLayout
											origin={
												record
													? "已载入案例保存的配置。"
													: "已填入当前全局运行配置，可按需修改；保存后作为案例配置。"
											}
											caseHeaders={
												<section className="ConfigGroup">
													<p className="form-hint">
														同名请求头覆盖上方默认值；留空继承。
													</p>
													<HeadersEditor
														title="案例请求头覆盖"
														value={definition}
														onChange={(headers) =>
															setDefinition({
																...definition,
																headers: headers.headers,
																headersEnv: headers.headersEnv,
															})
														}
													/>
												</section>
											}
											workspace={mode === "full-task"}
											value={{
												...defaults,
												...Object.fromEntries(
													[
														"cwd",
														"workspace",
														"systemPrompt",
														"tools",
														"maxIterations",
														"timeoutMs",
													]
														.filter((k) => (definition as any)[k] !== undefined)
														.map((k) => [k, (definition as any)[k]]),
												),
											}}
											onChange={(next) =>
												draft.setValue((v) => ({
													defaults: next,
													definition: {
														...v.definition,
														...Object.fromEntries(
															[
																"cwd",
																"workspace",
																"systemPrompt",
																"tools",
																"maxIterations",
																"timeoutMs",
															]
																.filter(
																	(k) => (v.definition as any)[k] !== undefined,
																)
																.map((k) => [k, (next as any)[k]]),
														),
													},
												}))
											}
										/>
									</>
								</>,
							],
						]}
					/>
				</section>
				<aside className="CaseEditor-results">
					<Box
						title={
							<div className="flex-between">
								<span>执行结果</span>
								<span className="muted small">
									{inlineRun ? (
										"调试执行"
									) : (
										<>
											尚未运行{" "}
											<Button className="btn-sm" danger disabled>
												停止
											</Button>
										</>
									)}
								</span>
							</div>
						}
					>
						{inlineRun ? (
							<DraftResult runId={inlineRun} />
						) : (
							<>
								<p className="muted">
									点击「运行{modeLabel(mode)}」开始调试，结果将在此显示。
								</p>
							</>
						)}
					</Box>
					<Box title="历史记录">
						{!record ? (
							<p className="muted small">保存后可查看历史。</p>
						) : (
							<DataState query={history}>
								{!history.data?.length && (
									<p className="muted small">暂无历史记录</p>
								)}
								{history.data?.map((entry) => (
									<div key={entry.id} className="CaseEditor-historyItem">
										<Link to={`/run/${entry.id}`}>{entry.name}</Link>
										{entry.items?.map((item: any) => (
											<div key={item.id} className="react-row">
												<Status value={item.status} />
												<span>
													v{item.revision} · {item.modelId}
												</span>
												{item.sessionId && (
													<code>session_id: {item.sessionId}</code>
												)}
											</div>
										))}
									</div>
								))}
							</DataState>
						)}
					</Box>
				</aside>
			</div>

			{judgeTrial && (
				<HistoryTrials
					caseId={record?.id}
					judge={definition.llmJudge}
					close={() => setJudgeTrial(false)}
				/>
			)}
			{record && transfer && (
				<TransferDialog
					operation={transfer}
					selected={[record]}
					modules={modules}
					close={() => setTransfer(undefined)}
					done={() => {
						notice("操作成功");
						if (transfer === "move") navigate("/cases");
					}}
				/>
			)}
		</>
	);
}

function DraftResult({ runId }: { runId: string }) {
	const query = useRun(runId);
	const status = query.data?.status;
	const client = useQueryClient();
	useEffect(() => {
		if (status && !["queued", "running"].includes(status))
			void client.invalidateQueries({
				predicate: (q) =>
					String(q.queryKey[0]).startsWith("/api/cases/") &&
					String(q.queryKey[0]).endsWith("/runs"),
			});
	}, [status, client]);
	const run = query.data;
	const active = !run || ["queued", "running"].includes(run.status);
	return (
		<>
			<div className="flex-between mb-3">
				<Status value={run?.status ?? "queued"} />
				<div className="page-actions">
					<Link to={`/run/${runId}`}>查看评测</Link>
					<Button
						className="btn-sm"
						danger
						disabled={!active}
						onClick={() =>
							send(`/api/runs/${runId}/cancel?view=summary`, {}).then(() =>
								query.refetch(),
							)
						}
					>
						停止
					</Button>
				</div>
			</div>
			<DataState query={query}>
				{run?.items[0] ? (
					<InlineItemInspector runId={runId} item={run.items[0]} />
				) : (
					<p className="muted">等待执行…</p>
				)}
			</DataState>
		</>
	);
}
