import {
	parseNativeHistory,
	parseHistorySource,
	type NativeHistoryMessage,
	type HistorySource,
} from "./function-call-history.js";
import schemas from "./function-call-schemas.json" with { type: "json" };
export const FUNCTION_CALL_TOOLS = Object.keys(schemas) as Array<
	keyof typeof schemas
>;
export type FunctionCallConfig = {
	tools: Array<keyof typeof schemas>;
	toolChoice?: "auto" | "required" | keyof typeof schemas;
	history?: NativeHistoryMessage[];
	historySource?: HistorySource;
};
export function parseFunctionCall(value: unknown): FunctionCallConfig {
	if (value === undefined)
		return { tools: [...FUNCTION_CALL_TOOLS], toolChoice: "auto" };
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("functionCall 须为配置对象");
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).some(
			(k) => !["tools", "toolChoice", "history", "historySource"].includes(k),
		)
	)
		throw Error("functionCall 包含未知字段");
	if (
		!Array.isArray(v.tools) ||
		!v.tools.length ||
		v.tools.some((n) => !FUNCTION_CALL_TOOLS.includes(n)) ||
		new Set(v.tools).size !== v.tools.length
	)
		throw Error("functionCall.tools 须为不重复的六种可用工具名称数组");
	const choice = v.toolChoice ?? "auto";
	if (choice !== "auto" && choice !== "required" && !v.tools.includes(choice))
		throw Error("functionCall.toolChoice 须为 auto、required 或已选择的工具名");
	const history =
		v.history !== undefined ? parseNativeHistory(v.history) : undefined;
	const historySource = parseHistorySource(v.historySource);
	if (
		historySource &&
		(!history ||
			historySource.messages.length !== history.length ||
			historySource.messages.some((m, i) => m.index !== i))
	)
		throw Error("functionCall.historySource 必须对应完整原生历史");
	return {
		...(history !== undefined ? { history } : {}),
		...(historySource ? { historySource } : {}),
		tools: [...v.tools] as FunctionCallConfig["tools"],
		toolChoice: choice as FunctionCallConfig["toolChoice"],
	};
}
export function functionCallTools(config: FunctionCallConfig) {
	return config.tools.map((name) => ({
		type: "function" as const,
		function: {
			name,
			description: `Cline ${name}; generate a tool call without executing it.`,
			parameters: schemas[name],
		},
	}));
}
