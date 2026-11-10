import { useState } from "react";
import type {
	JudgeConfig,
	JudgeModel,
} from "../../../../src/modules/judging/types";
import { api } from "../../api/client";
import {
	Box,
	Button,
	Check,
	Field,
	JsonInput,
	Text,
} from "../../components/ui";

export function JudgeModelEditor({
	value,
	onChange,
}: {
	value: JudgeModel;
	onChange: (value: JudgeModel) => void;
}) {
	const set = (key: keyof JudgeModel, next: unknown) =>
		onChange({ ...value, [key]: next || undefined });
	return (
		<>
			<div className="react-grid">
				{(["providerId", "modelId", "baseUrl", "apiKeyEnv"] as const).map(
					(key) => (
						<Field
							key={key}
							label={
								{
									providerId: "Judge Provider",
									modelId: "Judge 模型",
									baseUrl: "Judge Base URL",
									apiKeyEnv: "Judge 密钥环境变量名",
								}[key]
							}
						>
							<Text value={value[key]} onChange={(v) => set(key, v)} />
						</Field>
					),
				)}
			</div>
			<details>
				<summary>Judge 自定义请求头</summary>
				<JsonInput
					label="Judge headers"
					value={value.headers ?? {}}
					onChange={(v) => set("headers", v)}
				/>
				<JsonInput
					label="Judge headersEnv"
					value={value.headersEnv ?? {}}
					onChange={(v) => set("headersEnv", v)}
				/>
			</details>
		</>
	);
}
export const judgeDefaults = (): JudgeConfig => ({
	enabled: true,
	referenceAnswer: "",
	targets: ["result"],
	affectsOutcome: false,
	passScore: 80,
	timeoutMs: 60000,
	maxInputBytes: 262144,
	resultFiles: [],
});
export function JudgeEditor({
	value,
	onChange,
	mode,
}: {
	value?: JudgeConfig;
	onChange: (value: JudgeConfig | undefined) => void;
	mode?: string;
}) {
	const [stored, setStored] = useState(value ?? judgeDefaults());
	const config = value ?? stored;
	const change = (next: JudgeConfig) => {
		setStored(next);
		onChange(next);
	};
	const set = <K extends keyof JudgeConfig>(key: K, next: JudgeConfig[K]) =>
		change({ ...config, [key]: next });
	return (
		<Box title="LLM 评分">
			<Check
				checked={value?.enabled}
				onChange={(enabled) => change({ ...config, enabled })}
			>
				启用 LLM Judge
			</Check>
			{value?.enabled && (
				<>
					<Field label="参考答案">
						<Text
							multiline
							value={config.referenceAnswer}
							onChange={(v) => set("referenceAnswer", v)}
						/>
					</Field>
					<Field label="评审内容">
						{(["result", "trajectory"] as const).map((target) => (
							<Check
								key={target}
								checked={config.targets.includes(target)}
								onChange={(v) =>
									set(
										"targets",
										v
											? [...config.targets, target]
											: config.targets.filter((t) => t !== target),
									)
								}
							>
								{target === "result" ? "执行结果" : "执行轨迹"}
							</Check>
						))}
					</Field>
					<Field label="评分标准（可选）">
						<Text
							multiline
							value={config.rubric}
							onChange={(v) => set("rubric", v || undefined)}
						/>
					</Field>
					<Button
						onClick={async () => {
							const global = await api<JudgeModel | null>(
								"/api/judge-settings",
							);
							if (global) set("model", global);
						}}
					>
						使用全局 Judge 配置
					</Button>
					<Check
						checked={!!config.model}
						onChange={(v) =>
							set(
								"model",
								v
									? { providerId: "openai-compatible", modelId: "" }
									: undefined,
							)
						}
					>
						独立配置评审模型
					</Check>
					{config.model && (
						<JudgeModelEditor
							value={config.model}
							onChange={(v) => set("model", v)}
						/>
					)}
					<Check
						checked={config.affectsOutcome}
						onChange={(v) => set("affectsOutcome", v)}
					>
						影响通过结果
					</Check>
					{config.affectsOutcome && (
						<Field label="及格分">
							<Text
								type="number"
								min={0}
								max={100}
								value={config.passScore}
								onChange={(v) => set("passScore", Number(v))}
							/>
						</Field>
					)}
					<details>
						<summary>评分高级设置</summary>
						<Field label="评分超时（毫秒）">
							<Text
								type="number"
								value={config.timeoutMs}
								onChange={(v) => set("timeoutMs", Number(v))}
							/>
						</Field>
						<Field label="输入字节上限">
							<Text
								type="number"
								value={config.maxInputBytes}
								onChange={(v) => set("maxInputBytes", Number(v))}
							/>
						</Field>
						{mode === "full-task" && (
							<Field label="归档产物文件（每行一个相对路径）">
								<Text
									multiline
									value={config.resultFiles.join("\n")}
									onChange={(v) =>
										set("resultFiles", v.split("\n").filter(Boolean))
									}
								/>
							</Field>
						)}
					</details>
				</>
			)}
		</Box>
	);
}
