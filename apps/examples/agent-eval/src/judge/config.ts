import { parseHeaderConfig } from "../headers.js";
import { safeRelative } from "../grading/schema.js";
import type { JudgeConfig, JudgeModel } from "./types.js";
const bytes = (value: string) => new TextEncoder().encode(value).length;
function record(value: unknown, at: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error(`${at}: 必须是对象`);
	return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], at: string) {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw Error(`${at}.${key}: 不支持的字段`);
}
function text(value: unknown, at: string, max: number, required = false) {
	if (value === undefined) {
		if (required) throw Error(`${at}: 必填`);
		return undefined;
	}
	if (
		typeof value !== "string" ||
		bytes(value) > max ||
		(required && !value.trim())
	)
		throw Error(`${at}: 请填写有效文字（最多 ${max} 字节）`);
	return value;
}
function number(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
	at: string,
) {
	const result = value === undefined ? fallback : value;
	if (
		typeof result !== "number" ||
		!Number.isFinite(result) ||
		result < min ||
		result > max
	)
		throw Error(`${at}: 须为 ${min}–${max} 的数值`);
	return result;
}
function flag(value: unknown, fallback: boolean, at: string) {
	if (value !== undefined && typeof value !== "boolean")
		throw Error(`${at}: 必须为布尔值`);
	return value === undefined ? fallback : (value as boolean);
}
export function parseJudgeModel(value: unknown, complete = true): JudgeModel {
	const model = record(value, "Judge 模型");
	fields(
		model,
		["providerId", "modelId", "baseUrl", "apiKeyEnv", "headers", "headersEnv"],
		"Judge 模型",
	);
	const providerId =
			text(model.providerId, "Judge Provider", 200, complete)?.trim() ?? "",
		modelId = text(model.modelId, "Judge 模型", 500, complete)?.trim() ?? "";
	if (
		complete &&
		["claude-code", "openai-codex-cli", "opencode"].includes(providerId)
	)
		throw Error("Judge 请使用无工具的模型 API Provider，不支持 CLI 编码 Agent");
	const baseUrl =
		text(model.baseUrl, "Judge Base URL", 4096)?.trim() || undefined;
	if (
		complete &&
		baseUrl &&
		(new URL(baseUrl).username || new URL(baseUrl).password)
	)
		throw Error("Judge Base URL 不应包含凭据，请使用环境变量");
	if (
		complete &&
		baseUrl &&
		!["http:", "https:"].includes(new URL(baseUrl).protocol)
	)
		throw Error("Judge Base URL 须使用 http 或 https");
	if (complete && providerId === "openai-compatible" && !baseUrl)
		throw Error("Judge 兼容服务需要 Base URL");
	const apiKeyEnv =
		text(model.apiKeyEnv, "Judge 密钥环境变量", 200)?.trim() || undefined;
	if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv))
		throw Error("Judge 密钥环境变量名称无效");
	return {
		providerId,
		modelId,
		...(baseUrl ? { baseUrl } : {}),
		...(apiKeyEnv ? { apiKeyEnv } : {}),
		...parseHeaderConfig(model, "Judge 模型"),
	};
}
export function parseJudgeConfig(
	value: unknown,
	replayMode = "full-task",
): JudgeConfig | undefined {
	if (value === undefined) return;
	const config = record(value, "llmJudge");
	fields(
		config,
		[
			"enabled",
			"referenceAnswer",
			"targets",
			"rubric",
			"model",
			"affectsOutcome",
			"passScore",
			"timeoutMs",
			"maxInputBytes",
			"resultFiles",
		],
		"llmJudge",
	);
	const enabled = flag(config.enabled, true, "启用 LLM 评分");
	const targets = config.targets ?? ["result"];
	if (
		!Array.isArray(targets) ||
		targets.some((v) => !["result", "trajectory"].includes(v)) ||
		new Set(targets).size !== targets.length ||
		(enabled && !targets.length)
	)
		throw Error("请选择执行结果、执行轨迹或两者");
	const resultFiles = config.resultFiles ?? [];
	if (
		!Array.isArray(resultFiles) ||
		resultFiles.length > 20 ||
		resultFiles.some(
			(v) => typeof v !== "string" || !safeRelative(v) || /[?*]/.test(v),
		) ||
		new Set(resultFiles).size !== resultFiles.length
	)
		throw Error("Judge 产物文件须为不重复的工作区相对路径（最多 20 个）");
	if (
		enabled &&
		resultFiles.length &&
		(!targets.includes("result") || replayMode !== "full-task")
	)
		throw Error("归档文件评分需要选择完整任务的执行结果");
	const referenceAnswer =
		text(config.referenceAnswer, "参考答案", 65536, enabled) ?? "";
	const model =
		config.model === undefined
			? undefined
			: parseJudgeModel(config.model, enabled);
	if (enabled && !model)
		throw Error("请选择独立的 Judge 模型或使用全局 Judge 配置");
	return {
		enabled,
		referenceAnswer,
		targets: targets as JudgeConfig["targets"],
		rubric: text(config.rubric, "评分标准", 16384),
		model,
		affectsOutcome: flag(config.affectsOutcome, false, "影响通过结果"),
		passScore: number(config.passScore, 80, 0, 100, "及格分"),
		timeoutMs: number(config.timeoutMs, 120000, 1000, 300000, "Judge 超时"),
		maxInputBytes: number(
			config.maxInputBytes,
			131072,
			1024,
			1048576,
			"Judge 输入上限",
		),
		resultFiles: resultFiles as string[],
	};
}
