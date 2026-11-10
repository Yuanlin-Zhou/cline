import type { ReactNode } from "react";
import type { EvalDefaults } from "../../../../src/contracts/evaluation";
import { HeadersEditor } from "../../components/headers";
import { Field, Select, Text } from "../../components/ui";

export function ConfigEditor({
	value,
	onChange,
	workspace = true,
	caseLayout = false,
	caseHeaders,
	origin,
}: {
	value: EvalDefaults;
	onChange: (value: EvalDefaults) => void;
	workspace?: boolean;
	caseLayout?: boolean;
	caseHeaders?: ReactNode;
	origin?: string;
}) {
	const field = <K extends keyof EvalDefaults>(key: K, next: EvalDefaults[K]) =>
		onChange({ ...value, [key]: next });
	const connection = (
		<div className="react-grid">
			<Field
				label="Provider"
				hint={caseLayout ? "如 cline、openai-compatible、anthropic" : undefined}
			>
				<Text
					aria-label="Provider"
					value={value.providerId}
					onChange={(v) => field("providerId", v)}
				/>
			</Field>
			<Field label="模型">
				<Text
					aria-label="模型"
					value={value.modelId}
					onChange={(v) => field("modelId", v)}
				/>
			</Field>

			<Field
				label="密钥环境变量名"
				hint={
					caseLayout
						? "从服务端环境变量读取 API Key，例如 DEEPSEEK_API_KEY"
						: undefined
				}
			>
				<Text
					value={value.apiKeyEnv}
					onChange={(v) => field("apiKeyEnv", v || undefined)}
				/>
			</Field>

			<Field
				label="Base URL"
				hint={caseLayout ? "自定义 OpenAI 兼容端点时填写" : undefined}
			>
				<Text
					aria-label="Base URL"
					value={value.baseUrl}
					onChange={(v) => field("baseUrl", v || undefined)}
				/>
			</Field>
		</div>
	);
	const advanced = (
		<>
			<div className="CaseConfig-timeout">
				{" "}
				<Field label="超时（毫秒）">
					<Text
						type="number"
						min={1}
						value={value.timeoutMs ?? 300000}
						onChange={(v) => field("timeoutMs", Number(v))}
					/>
				</Field>
			</div>{" "}
			<Field label="系统提示词">
				<Text
					multiline
					value={value.systemPrompt}
					onChange={(v) => field("systemPrompt", v || undefined)}
				/>
			</Field>
		</>
	);
	const environment = (
		<div className="react-grid">
			<>
				<Field label="工具权限">
					<Select
						value={value.tools ?? "read-only"}
						onChange={(v) => field("tools", v as EvalDefaults["tools"])}
						options={[
							["none", "禁用工具"],
							["read-only", "只读工具"],
							["full", "全部工具（自动批准）"],
						]}
					/>
				</Field>
				<Field label="迭代上限">
					<Text
						type="number"
						min={1}
						value={value.maxIterations ?? 10}
						onChange={(v) => field("maxIterations", Number(v))}
					/>
				</Field>
				<Field label="工作区目录 cwd">
					<Text
						value={value.cwd}
						onChange={(v) => field("cwd", v || undefined)}
					/>
				</Field>
				<Field label="工作区方式">
					<Select
						value={value.workspace?.mode ?? "copy"}
						onChange={(v) =>
							field(
								"workspace",
								v === "direct" ? { mode: "direct" } : { mode: "copy" },
							)
						}
						options={[
							["copy", "复制后执行"],
							["direct", "直接在原目录执行"],
						]}
					/>
				</Field>
				{value.workspace?.mode !== "direct" && (
					<Field label="副本保存根目录（可选）">
						<Text
							value={value.workspace?.copyRoot}
							onChange={(v) =>
								field("workspace", {
									mode: "copy",
									...(v ? { copyRoot: v } : {}),
								})
							}
						/>
					</Field>
				)}
			</>
		</div>
	);
	const headers = (
		<HeadersEditor
			title={caseLayout ? "默认模型请求头" : undefined}
			value={value}
			onChange={(headers) =>
				onChange({
					...value,
					headers: headers.headers,
					headersEnv: headers.headersEnv,
				})
			}
		/>
	);
	if (caseLayout)
		return (
			<>
				{workspace && (
					<section className="Box mb-3 CaseConfig-environment">
						<div className="Box-body">
							<h3 className="section-title">环境与执行配置</h3>
							{environment}
						</div>
					</section>
				)}
				<details className="Box CaseConfig" open>
					<summary className="Box-header">
						<span>模型与高级配置</span>
					</summary>
					<div className="Box-body">
						<p className="CaseConfig-origin">{origin}</p>
						<section className="ConfigGroup">
							<h3 className="ConfigGroup-title">模型连接</h3>
							{connection}
						</section>
						{headers}
						{caseHeaders}
						<section className="CaseConfig-advanced">
							<h3 className="ConfigGroup-title">高级执行设置</h3>
							{advanced}
						</section>
					</div>
				</details>
			</>
		);
	return (
		<>
			<div className="react-grid">
				<Field label="Provider">
					<Text
						aria-label="Provider"
						value={value.providerId}
						onChange={(v) => field("providerId", v)}
					/>
				</Field>
				<Field label="模型">
					<Text
						aria-label="模型"
						value={value.modelId}
						onChange={(v) => field("modelId", v)}
					/>
				</Field>
				<Field label="Base URL">
					<Text
						aria-label="Base URL"
						value={value.baseUrl}
						onChange={(v) => field("baseUrl", v || undefined)}
					/>
				</Field>
				<Field label="密钥环境变量名">
					<Text
						value={value.apiKeyEnv}
						onChange={(v) => field("apiKeyEnv", v || undefined)}
					/>
				</Field>
			</div>
			<Field label="系统提示词">
				<Text
					multiline
					value={value.systemPrompt}
					onChange={(v) => field("systemPrompt", v || undefined)}
				/>
			</Field>
			<div className="react-grid">
				<Field label="超时（毫秒）">
					<Text
						type="number"
						min={1}
						value={value.timeoutMs ?? 300000}
						onChange={(v) => field("timeoutMs", Number(v))}
					/>
				</Field>
				{workspace && (
					<>
						<Field label="工具权限">
							<Select
								value={value.tools ?? "read-only"}
								onChange={(v) => field("tools", v as EvalDefaults["tools"])}
								options={[
									["none", "禁用工具"],
									["read-only", "只读工具"],
									["full", "全部工具（自动批准）"],
								]}
							/>
						</Field>
						<Field label="迭代上限">
							<Text
								type="number"
								min={1}
								value={value.maxIterations ?? 10}
								onChange={(v) => field("maxIterations", Number(v))}
							/>
						</Field>
						<Field label="工作区目录 cwd">
							<Text
								value={value.cwd}
								onChange={(v) => field("cwd", v || undefined)}
							/>
						</Field>
						<Field label="工作区方式">
							<Select
								value={value.workspace?.mode ?? "copy"}
								onChange={(v) =>
									field(
										"workspace",
										v === "direct" ? { mode: "direct" } : { mode: "copy" },
									)
								}
								options={[
									["copy", "复制后执行"],
									["direct", "直接在原目录执行"],
								]}
							/>
						</Field>
						{value.workspace?.mode !== "direct" && (
							<Field label="副本保存根目录（可选）">
								<Text
									value={value.workspace?.copyRoot}
									onChange={(v) =>
										field("workspace", {
											mode: "copy",
											...(v ? { copyRoot: v } : {}),
										})
									}
								/>
							</Field>
						)}
					</>
				)}
			</div>
			<HeadersEditor
				value={value}
				onChange={(headers) =>
					onChange({
						...value,
						headers: headers.headers,
						headersEnv: headers.headersEnv,
					})
				}
			/>
		</>
	);
}
