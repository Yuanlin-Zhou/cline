import type { EvalDefaults } from "../../../../src/contracts/evaluation";
import { HeadersEditor } from "../../components/headers";
import { Field, Select, Text } from "../../components/ui";

export function ConfigEditor({
	value,
	onChange,
	workspace = true,
}: {
	value: EvalDefaults;
	onChange: (value: EvalDefaults) => void;
	workspace?: boolean;
}) {
	const field = <K extends keyof EvalDefaults>(key: K, next: EvalDefaults[K]) =>
		onChange({ ...value, [key]: next });
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
