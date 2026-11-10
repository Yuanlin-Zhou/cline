import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Module } from "../../../../src/contracts/catalog";
import type { EvalDefaults } from "../../../../src/contracts/evaluation";
import { FUNCTION_CALL_TOOLS } from "../../../../src/contracts/function-call-config";
import { caseExample, IMPORT_FIELDS } from "../../../../src/contracts/replay";
import {
	conversationCaseIds,
	type ConversationFile,
} from "../../../../src/modules/catalog/batch-conversations";
import { message, send, useApi } from "../../api/client";
import {
	Alert,
	Box,
	Button,
	Check,
	DataState,
	Field,
	Heading,
	JsonView,
	Select,
	Tabs,
	Text,
	useNotice,
} from "../../components/ui";

export function ImportsPage() {
	const modules = useApi<{ modules: Module[] }>("/api/modules?view=summary");
	const settings = useApi<EvalDefaults>("/api/settings");
	return (
		<>
			<Heading
				title="导入案例"
				description="导入案例集，或将多个历史对话 JSON 批量生成案例"
			/>
			<DataState query={modules}>
				{modules.data && settings.data && (
					<ImportForm modules={modules.data.modules} settings={settings.data} />
				)}
			</DataState>
			<Alert>{settings.error && message(settings.error)}</Alert>
		</>
	);
}
function ImportForm({
	modules,
	settings,
}: {
	modules: Module[];
	settings: EvalDefaults;
}) {
	const [params] = useSearchParams();
	const [moduleId, setModuleId] = useState(
		params.get("module") ?? modules[0]?.id ?? "",
	);
	const [kind, setKind] = useState("suite");
	const [content, setContent] = useState("");
	const [format, setFormat] = useState("json");
	const [replayMode, setReplayMode] = useState("single-turn");
	const [policy, setPolicy] = useState("skip");
	const [files, setFiles] = useState<ConversationFile[]>([]);
	const [options, setOptions] = useState({
		tools: [...FUNCTION_CALL_TOOLS],
		toolChoice: "auto",
		continuation: "",
		ignoreThinking: false,
		verifierId: "",
	});
	const [preview, setPreview] = useState<any>();
	const [fingerprint, setFingerprint] = useState("");
	const [error, setError] = useState("");
	const navigate = useNavigate();
	const client = useQueryClient();
	const notice = useNotice();
	const verifiers = useApi<any>("/api/verifiers");
	const payload = () =>
		kind === "suite"
			? { moduleId, content, format, replayMode, policy }
			: {
					moduleId,
					files,
					options: {
						...options,
						continuation: options.continuation || undefined,
						verifierId: options.verifierId || undefined,
					},
					defaults: settings,
					policy,
				};
	const signature = JSON.stringify(payload());
	const validPreview = preview && fingerprint === signature;
	const request = useMutation({
		mutationFn: async (apply: boolean) => {
			if (apply && !validPreview) throw Error("内容发生变化，请重新预览");
			const path =
				kind === "suite" ? "/api/import" : "/api/import/conversations";
			const value = await send<any>(
				apply ? path : `${path}/preview`,
				payload(),
			);
			return { apply, value };
		},
		onSuccess: ({ apply, value }) => {
			if (apply) {
				notice(
					`已新建 ${value.created} 个、更新 ${value.updated} 个、跳过 ${value.skipped} 个案例`,
				);
				void client.invalidateQueries({
					predicate: (q) =>
						String(q.queryKey[0]).startsWith("/api/cases") ||
						String(q.queryKey[0]).startsWith("/api/modules"),
				});
				navigate(`/cases/${moduleId}`);
			} else {
				setPreview(value);
				setFingerprint(signature);
			}
		},
	});
	return (
		<>
			<Box title="目标案例集">
				<Field label="目标模块">
					<Select
						value={moduleId}
						onChange={setModuleId}
						options={modules.map((m) => [m.id, m.name])}
					/>
				</Field>
				<Field label="同名案例处理">
					<Select
						value={policy}
						onChange={setPolicy}
						options={[
							["skip", "跳过同名案例"],
							["version", "更新为新版本"],
						]}
					/>
				</Field>
			</Box>
			<Tabs
				onChange={setKind}
				entries={[
					[
						"suite",
						"导入案例集",
						<Box key="suite">
							<div className="react-grid">
								<Field label="缺省回放方式">
									<Select
										value={replayMode}
										onChange={setReplayMode}
										options={[
											["single-turn", "单轮回放"],
											["full-task", "完整任务"],
											["function-call", "单轮函数调用"],
										]}
									/>
								</Field>
								<Field label="文件格式">
									<Select
										value={format}
										onChange={setFormat}
										options={[
											["json", "JSON"],
											["jsonl", "JSONL"],
										]}
									/>
								</Field>
							</div>
							<Field label="粘贴案例集内容">
								<Text
									aria-label="粘贴案例集内容"
									multiline
									className="mono react-editor"
									value={content}
									onChange={setContent}
								/>
							</Field>
							<Field label="或上传文件">
								<input
									className="form-control"
									type="file"
									accept=".json,.jsonl,.txt"
									onChange={async (e) => {
										const file = e.target.files?.[0];
										if (file) {
											setContent(await file.text());
											setFormat(
												file.name.endsWith(".jsonl") ? "jsonl" : "json",
											);
										}
									}}
								/>
							</Field>
							<div className="page-actions">
								{(["single-turn", "full-task", "function-call"] as const).map(
									(mode) => (
										<Button
											key={mode}
											onClick={() => {
												setContent(
													JSON.stringify(
														{ defaults: settings, cases: [caseExample(mode)] },
														null,
														2,
													),
												);
												setFormat("json");
											}}
										>
											{mode} 示例
										</Button>
									),
								)}
							</div>
						</Box>,
					],
					[
						"conversations",
						"批量历史对话",
						<Box key="conversations">
							<Field label="上传对话 JSON（可多选）">
								<input
									className="form-control"
									type="file"
									accept=".json"
									multiple
									onChange={async (e) => {
										setError("");
										try {
											const selected = Array.from(e.target.files ?? []);
											const names = conversationCaseIds(
												selected.map((f) => f.name),
											);
											setFiles(
												await Promise.all(
													selected.map(async (f, i) => ({
														filename: f.name,
														content: await f.text(),
														caseId: names[i],
													})),
												),
											);
										} catch (e) {
											setError(message(e));
										}
									}}
								/>
							</Field>
							<p className="form-hint">
								每份记录生成一个 function-call
								案例。末尾用户输入自动移为本轮输入；工具/助手结尾须明确填写续接文案。
							</p>
							{files.map((file, index) => (
								<Box key={index} title={file.filename}>
									<Field label="案例名称">
										<Text
											value={file.caseId}
											onChange={(caseId) =>
												setFiles((v) =>
													v.map((entry, i) =>
														i === index ? { ...entry, caseId } : entry,
													),
												)
											}
										/>
									</Field>
									<Field label="单文件续接文案（可选）">
										<Text
											value={file.continuation}
											onChange={(continuation) =>
												setFiles((v) =>
													v.map((entry, i) =>
														i === index ? { ...entry, continuation } : entry,
													),
												)
											}
										/>
									</Field>
									<Field label="系统指令来源">
										<Select
											value={file.systemSource ?? ""}
											onChange={(systemSource) =>
												setFiles((v) =>
													v.map((entry, i) =>
														i === index
															? {
																	...entry,
																	systemSource: systemSource
																		? (systemSource as "file" | "messages")
																		: undefined,
																}
															: entry,
													),
												)
											}
											options={[
												["", "按原始记录判断"],
												["file", "记录顶层系统提示词"],
												["messages", "messages 内的指令"],
											]}
										/>
									</Field>
									<Button
										danger
										onClick={() =>
											setFiles((v) => v.filter((_, i) => i !== index))
										}
									>
										移除文件
									</Button>
								</Box>
							))}
							<Field label="公共续接文案">
								<Text
									value={options.continuation}
									onChange={(continuation) =>
										setOptions((v) => ({ ...v, continuation }))
									}
								/>
							</Field>
							<Check
								checked={options.ignoreThinking}
								onChange={(ignoreThinking) =>
									setOptions((v) => ({ ...v, ignoreThinking }))
								}
							>
								仅导入文本和工具轨迹，不发送思考块
							</Check>
							<Field label="公布的工具">
								{FUNCTION_CALL_TOOLS.map((tool) => (
									<Check
										key={tool}
										checked={options.tools.includes(tool)}
										onChange={(v) =>
											setOptions((o) => ({
												...o,
												tools: v
													? [...o.tools, tool]
													: o.tools.filter((t) => t !== tool),
											}))
										}
									>
										{tool}
									</Check>
								))}
							</Field>
							<Field label="工具选择方式">
								<Select
									value={options.toolChoice}
									onChange={(toolChoice) =>
										setOptions((v) => ({ ...v, toolChoice }))
									}
									options={[
										["auto", "自动选择"],
										["required", "必须调用所选工具"],
										...options.tools.map((t) => [t, t] as [string, string]),
									]}
								/>
							</Field>
							<Field label="绑定 Python 验证器（可选）">
								<Select
									value={options.verifierId}
									onChange={(verifierId) =>
										setOptions((v) => ({ ...v, verifierId }))
									}
									options={[
										["", "不绑定"],
										...(verifiers.data?.verifiers ?? [])
											.filter((v: any) => v.runtime === "python")
											.map(
												(v: any) =>
													[v.id, v.label ?? v.name ?? v.id] as [string, string],
											),
									]}
								/>
							</Field>
						</Box>,
					],
				]}
			/>
			<Alert>{error || (request.error && message(request.error))}</Alert>
			<div className="page-actions">
				<Button
					disabled={request.isPending || !moduleId}
					onClick={() => request.mutate(false)}
				>
					预览并校验
				</Button>
				<Button
					primary
					disabled={
						request.isPending ||
						!validPreview ||
						preview?.rows?.some((r: any) => r.error)
					}
					onClick={() => request.mutate(true)}
				>
					确认导入
				</Button>
			</div>
			{preview && (
				<Box title={validPreview ? "导入预览" : "内容已变化，请重新预览"}>
					{(preview.cases ?? preview.rows ?? []).map(
						(row: any, index: number) => (
							<div key={index}>
								<strong>{row.id ?? row.caseId}</strong>
								{row.duplicate && <span className="Label">同名</span>}
								<Alert>{row.error}</Alert>
								{row.appended && (
									<p className="form-hint">将追加明确填写的续接输入。</p>
								)}
							</div>
						),
					)}
					{preview.warnings?.map((w: string) => (
						<Alert key={w} kind="warning">
							{w}
						</Alert>
					))}
					<details>
						<summary>查看规范化案例</summary>
						<JsonView value={preview.suite} />
					</details>
				</Box>
			)}
			<details>
				<summary>案例导入字段说明</summary>
				<div className="react-table-wrap">
					<table className="react-table">
						<tbody>
							{IMPORT_FIELDS.map(([key, type, description, example]) => (
								<tr key={key}>
									<td>
										{key}
										<small className="react-block">{type}</small>
									</td>
									<td>{description}</td>
									<td>
										<code>{example}</code>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
		</>
	);
}
