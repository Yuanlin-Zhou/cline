import type { EvalCase, EvalDefaults, ToolMode } from "./types.js";

export type ReplayMode = "single-turn" | "full-task";

export const REPLAY_MODES: Array<{ value: ReplayMode; label: string; description: string; prompt: string }> = [
	{ value: "single-turn", label: "单轮回放", description: "提供历史上下文和本轮问题，只生成一次模型回复，不调用工具。", prompt: "安装项目依赖应该执行什么命令？" },
	{ value: "full-task", label: "多轮回放（完整任务）", description: "提供初始任务，Agent 可调用工具连续执行，直到完成或达到限制；历史消息不是逐轮执行脚本。", prompt: "实现 TypeScript slugify 函数，编写并使用 Bun 运行测试，失败后修复，最后总结结果。" },
];

export function replayConfig(definition: EvalCase, defaults: EvalDefaults, overrideTools?: ToolMode) {
	const single = definition.replayMode !== "full-task";
	return {
		tools: single ? "none" as const : overrideTools ?? definition.tools ?? defaults.tools ?? "read-only",
		maxIterations: single ? 1 : definition.maxIterations ?? defaults.maxIterations ?? 10,
	};
}

export function caseExample(mode: ReplayMode): EvalCase {
	return mode === "single-turn" ? {
		id: "history-bun-install", replayMode: mode, description: "验证模型遵循历史上下文", tags: ["回归", "上下文"],
		history: [{ role: "user", content: "项目使用 Bun，请用中文回答。" }, { role: "assistant", content: "好的。" }],
		prompt: REPLAY_MODES[0]!.prompt, assertions: { contains: ["bun install"], finishReason: "completed" },
	} : {
		id: "build-slugify", replayMode: mode, description: "实现函数并运行测试", history: [],
		prompt: REPLAY_MODES[1]!.prompt, tools: "full", maxIterations: 30, timeoutMs: 600000,
		assertions: { finishReason: "completed" },
	};
}

export const IMPORT_FIELDS: Array<[string, string, string, string]> = [
	["id", "string · 必填", "模块内唯一；已有 ID 可跳过或更新版本", "history-bun-install"],
	["prompt", "string · 必填", "单轮：本轮问题；多轮：任务初始指令", "安装依赖应该执行什么命令？"],
	["replayMode", "string · 可选", "未填写时使用页面的缺省回放方式", "single-turn / full-task"],
	["description / tags", "string / string[] · 可选", "案例说明和用于筛选的标签", '"上下文检查" / ["回归"]'],
	["history", "object[] · 可选", "历史上下文，默认空数组；不会逐条执行", '[{"role":"user","content":"使用 Bun"}]'],
	["history[].role / content", "string · 每条必填", "role 仅 user 或 assistant；content 为非空文本", "user / 使用 Bun"],
	["cwd", "string · 多轮可选", "服务端绝对路径，运行时复制到独立工作区；留空使用空工作区", "D:/eval-fixtures/demo"],
	["tools", "string · 多轮可选", "工具权限；单轮固定禁用", "none / read-only / full"],
	["maxIterations", "正整数 · 多轮可选", "Agent 迭代上限；单轮固定一次", "30"],
	["timeoutMs", "正整数 · 可选", "整个案例的超时，单位毫秒", "300000（5 分钟）"],
	["systemPrompt", "string · 可选", "系统提示词，未配置时使用默认提示词", "请用中文回答"],
	["headers", "object · 可选", "非敏感模型请求头；按名称覆盖 defaults，支持执行标识模板", '{"x-session-id":"{{sessionId}}","x-message-id":"{{evaluationId}}"}'],
	["headersEnv", "object · 可选", "请求头→服务端环境变量名；Authorization 必须用此方式，不填写密钥值", '{"Authorization":"EVAL_AUTHORIZATION"}'],
	["assertions.contains / notContains", "string[] · 可选", "输出必须包含所有 contains 项，不能包含任何 notContains 项", '["bun install"]'],
	["assertions.matches", "string[] · 可选", "输出必须匹配所有正则；JSON 中反斜杠需转义", '["Bun|bun"]'],
	["assertions.finishReason", "string · 可选", "期望结束原因；未提供时按正常完成判定", "completed / max_iterations / aborted / mistake_limit / error"],
	["defaults", "object · 可选，仅案例集对象", "文件默认配置；案例执行配置优先于文件默认值，文件默认值优先于全局配置", '{"tools":"read-only","timeoutMs":300000}'],
	["defaults.providerId / modelId", "string · 可选", "模型供应商和模型名，未填写继承全局配置", "openai-compatible / 已配置的模型名"],
	["defaults.apiKeyEnv / baseUrl", "string · 可选", "密钥环境变量名（不是密钥本身）及自定义服务端点", "DEEPSEEK_API_KEY / https://api.deepseek.com"],
	["version / cases", "1 / object[]", "案例集对象的 cases 必填；也支持直接传案例数组", '{"version":1,"cases":[…]}'],
];
