import { useState } from "react";
import type { EvalCase } from "../../../../src/contracts/evaluation";
import type { Rule } from "../../../../src/modules/grading/types";
import { useApi } from "../../api/client";
import {
	Alert,
	Box,
	Button,
	Check,
	Field,
	JsonInput,
	Select,
	Text,
} from "../../components/ui";
import { HistoryTrials } from "../results/history-trials";
import { Guide, UploadDialog } from "../verifiers/page";

export function RulesEditor({
	value,
	onChange,
	caseId,
}: {
	value: EvalCase;
	onChange: (value: EvalCase) => void;
	caseId?: string;
}) {
	const [kind, setKind] = useState("file.exists");
	const [upload, setUpload] = useState(false);
	const [guide, setGuide] = useState(false);
	const [trial, setTrial] = useState<any>();
	const verifiers = useApi<any>("/api/verifiers");
	const rules = value.grading?.rules ?? [];
	function update(next: Rule[]) {
		onChange({
			...value,
			grading: next.length ? { version: 1, rules: next } : undefined,
		});
	}
	function change(index: number, patch: any) {
		update(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
	}
	function add() {
		const base: any = {
			id: `rule-${crypto.randomUUID().slice(0, 8)}`,
			kind,
			required: true,
		};
		if (kind.startsWith("file.")) base.path = "";
		if (kind === "file.text")
			Object.assign(base, { op: "contains", expected: "" });
		if (kind === "file.json")
			Object.assign(base, { pointer: "", op: "exists" });
		if (kind === "script" || kind === "command") base.verifierId = "";
		if (kind === "command") base.expectedExitCode = 0;
		if (kind === "script") Object.assign(base, { params: {} });
		if (kind === "tool.count")
			Object.assign(base, {
				match: { name: "read_files", phase: "requested" },
				min: 1,
				required: false,
			});
		update([...rules, base]);
	}
	return (
		<>
			<Box title="回复检查">
				<Field label="结束原因">
					<Select
						value={value.assertions?.finishReason ?? "completed"}
						onChange={(v) =>
							onChange({
								...value,
								assertions: { ...value.assertions, finishReason: v as any },
							})
						}
						options={[
							"completed",
							"max_iterations",
							"aborted",
							"mistake_limit",
							"error",
						].map((v) => [v, v])}
					/>
				</Field>
				{(["contains", "notContains", "matches"] as const).map((key) => (
					<Field
						key={key}
						label={
							{
								contains: "必须包含（每行一项）",
								notContains: "不得包含（每行一项）",
								matches: "匹配正则（每行一项）",
							}[key]
						}
					>
						<Text
							multiline
							value={value.assertions?.[key]?.join("\n") ?? ""}
							onChange={(v) =>
								onChange({
									...value,
									assertions: {
										...value.assertions,
										[key]: v.split("\n").filter(Boolean),
									},
								})
							}
						/>
					</Field>
				))}
			</Box>
			<Box title="任务验收规则">
				<p className="form-hint">
					必要规则全部通过才判通过；验证器故障或证据不足会单独记录。
				</p>
				<div className="react-row">
					<Select
						value={kind}
						onChange={setKind}
						options={[
							["file.exists", "文件存在"],
							["file.absent", "文件不存在"],
							["file.unchanged", "文件保持不变"],
							["file.text", "文件文本"],
							["file.json", "JSON 字段"],
							["script", "Python / 验证脚本"],
							["command", "验收命令"],
							["tool.count", "工具次数（诊断）"],
						]}
					/>
					<Button onClick={add}>添加检查</Button>
				</div>
				{kind.startsWith("file.") && value.replayMode !== "full-task" && (
					<Alert kind="warning">
						文件检查需要完整任务模式。
						<Button
							onClick={() => onChange({ ...value, replayMode: "full-task" })}
						>
							切换为完整任务
						</Button>
					</Alert>
				)}
				{rules.map((rule: any, index) => (
					<Box
						key={rule.id || index}
						title={
							<div className="flex-between">
								<span>{rule.label || rule.kind}</span>
								<Button
									danger
									onClick={() => update(rules.filter((_, i) => i !== index))}
								>
									移除检查
								</Button>
							</div>
						}
					>
						<Field label="规则 ID">
							<Text value={rule.id} onChange={(id) => change(index, { id })} />
						</Field>
						<Field label="规则名称（可选）">
							<Text
								value={rule.label}
								onChange={(label) =>
									change(index, { label: label || undefined })
								}
							/>
						</Field>
						<Check
							checked={rule.required !== false}
							onChange={(required) => change(index, { required })}
						>
							必要检查
						</Check>
						{rule.kind.startsWith("file.") && (
							<Field label="文件相对路径">
								<Text
									value={rule.path}
									onChange={(path) => change(index, { path })}
								/>
							</Field>
						)}
						{rule.kind === "file.text" && (
							<>
								<Field label="比较方式">
									<Select
										value={rule.op}
										onChange={(op) => change(index, { op })}
										options={[
											["contains", "包含"],
											["notContains", "不包含"],
											["matches", "正则匹配"],
										]}
									/>
								</Field>
								<Field label="预期文本">
									<Text
										multiline
										value={rule.expected}
										onChange={(expected) => change(index, { expected })}
									/>
								</Field>
							</>
						)}
						{rule.kind === "file.json" && (
							<>
								<Field label="JSON Pointer">
									<Text
										value={rule.pointer}
										onChange={(pointer) => change(index, { pointer })}
									/>
								</Field>
								<Field label="比较方式">
									<Select
										value={rule.op}
										onChange={(op) => change(index, { op })}
										options={[
											"exists",
											"equals",
											"contains",
											"matches",
											"approx",
										].map((v) => [v, v])}
									/>
								</Field>
								{rule.op !== "exists" && (
									<JsonInput
										label="预期 JSON 值"
										value={rule.expected ?? null}
										onChange={(expected) => change(index, { expected })}
									/>
								)}
								{rule.op === "approx" && (
									<>
										<Field label="绝对容差">
											<Text
												type="number"
												value={rule.absTolerance ?? 0}
												onChange={(v) =>
													change(index, { absTolerance: Number(v) })
												}
											/>
										</Field>
										<Field label="相对容差">
											<Text
												type="number"
												value={rule.relTolerance ?? 0}
												onChange={(v) =>
													change(index, { relTolerance: Number(v) })
												}
											/>
										</Field>
									</>
								)}
							</>
						)}
						{(rule.kind === "script" || rule.kind === "command") && (
							<>
								<div className="page-actions">
									<Button onClick={() => setUpload(true)}>上传 .py</Button>
									<Button onClick={() => setGuide(true)}>编写指南</Button>
									<Button onClick={() => verifiers.refetch()}>刷新列表</Button>
									{rule.kind === "script" && (
										<Button onClick={() => setTrial(rule)}>试验证</Button>
									)}
								</div>
								<Field label="验证器">
									<Select
										value={rule.verifierId}
										onChange={(verifierId) => change(index, { verifierId })}
										options={[
											["", "请选择验证器"],
											...(verifiers.data?.verifiers ?? []).map(
												(v: any) =>
													[v.id, v.label ?? v.name ?? v.id] as [string, string],
											),
										]}
									/>
								</Field>
								{rule.kind === "script" ? (
									<>
										<JsonInput
											label="验证参数 params"
											value={rule.params ?? {}}
											onChange={(params) => change(index, { params })}
										/>
										<details>
											<summary>高级设置：输入要求</summary>
											{(["required_inputs", "require_complete"] as const).map(
												(key) => (
													<Field
														key={key}
														label={
															key === "required_inputs"
																? "必须提供的输入"
																: "要求完整的输入"
														}
													>
														{[
															"execution",
															"conversation",
															"artifacts",
															"baseline",
															"diagnostics",
														].map((input) => (
															<Check
																key={input}
																checked={rule[key]?.includes(input)}
																onChange={(checked) =>
																	change(index, {
																		[key]: checked
																			? [...(rule[key] ?? []), input]
																			: (rule[key] ?? []).filter(
																					(v: string) => v !== input,
																				),
																	})
																}
															>
																{input}
															</Check>
														))}
													</Field>
												),
											)}
										</details>
									</>
								) : (
									<Field label="预期退出码">
										<Text
											type="number"
											value={rule.expectedExitCode ?? 0}
											onChange={(v) =>
												change(index, { expectedExitCode: Number(v) })
											}
										/>
									</Field>
								)}
							</>
						)}
						<details>
							<summary>高级规则 JSON</summary>
							<JsonInput
								label="完整规则配置"
								value={rule}
								onChange={(next) =>
									update(rules.map((entry, i) => (i === index ? next : entry)))
								}
							/>
						</details>
					</Box>
				))}
				<details>
					<summary>编辑全部规则（支持完整规则合同）</summary>
					<JsonInput label="验收规则数组" value={rules} onChange={update} />
				</details>
			</Box>
			{upload && (
				<UploadDialog
					close={() => setUpload(false)}
					done={() => verifiers.refetch()}
				/>
			)}
			{guide && <Guide close={() => setGuide(false)} />}
			{trial && (
				<HistoryTrials
					caseId={caseId}
					rule={trial}
					close={() => setTrial(undefined)}
				/>
			)}
		</>
	);
}
