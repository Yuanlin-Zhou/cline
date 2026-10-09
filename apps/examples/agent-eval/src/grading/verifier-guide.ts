// Browser-safe documentation and executable templates share one source of truth.
export const verifierFields = [
	["protocolVersion", "输入协议版本，当前为 1。"],
	["workspace", "运行结束后产物快照的独立副本；通过这个目录读取交付文件。"],
	["rule", "当前规则的 id、kind、required 和 verifierId 等配置。"],
	["evidence", "证据清单：baseline、artifacts、refs，以及 complete、eventsComplete、capabilities、issues。证据引用使用 refs 中已有的 id。"],
	["execution.id / description?", "案例 ID、可选描述。"],
	["execution.sessionId", "会话 ID；启动失败时可能为空。"],
	["execution.text", "最终回复文字，可用于文本或业务检查。"],
	["execution.finishReason?", "可选结束原因；completed 不能单独证明业务验收通过。"],
	["execution.execution.status / reason?", "执行状态 completed / error / cancelled；可选原因如 task_timeout。优先使用此状态。"],
	["execution.status", "执行阶段沿用的旧状态，不是当前验证脚本的判定或最终验收结论。"],
	["execution.error?", "可选执行错误。缺省字段先判断存在或使用默认值。"],
	["execution.durationMs / iterations", "执行耗时（毫秒）、迭代次数。"],
	["execution.usage", "inputTokens、outputTokens；可选 cacheReadTokens、cacheWriteTokens、totalCost。"],
	["execution.toolCalls", "数组：name、input、output、durationMs、可选 error。仅供诊断，不能证明真实执行或审批合规。"],
	["execution.assertions", "此时可能为空，不能用作最终验收结论。"],
] as const;
export const replyTemplate = `import { readFile } from "node:fs/promises";

// EVAL_CONTEXT is a path to the evaluator's input JSON.
const context = JSON.parse(await readFile(process.env.EVAL_CONTEXT, "utf8"));
const expected = { executionStatus: "completed", contains: "已完成" };
const actual = {
  executionStatus: context.execution.execution?.status ?? "unknown",
  text: context.execution.text ?? ""
};
const passed = actual.executionStatus === expected.executionStatus
  && actual.text.includes(expected.contains);
// stdout must contain exactly one JSON object; use console.error for diagnostics.
console.log(JSON.stringify({
  protocolVersion: 1, verdict: passed ? "pass" : "fail", expected, actual,
  message: passed ? "最终回复符合要求" : "执行未完成或最终回复不符合要求",
  evidence: []
}));
`;
export const artifactTemplate = `import { readFile } from "node:fs/promises";
import path from "node:path";

const context = JSON.parse(await readFile(process.env.EVAL_CONTEXT, "utf8"));
const expected = { total: 12 };
let actual;
let passed = false;
try {
  actual = JSON.parse(await readFile(path.join(context.workspace, "summary.json"), "utf8"));
  passed = actual?.total === expected.total;
} catch (error) {
  // Missing or malformed task output is a business failure, not a script error.
  actual = { outputError: String(error) };
}
console.log(JSON.stringify({
  protocolVersion: 1, verdict: passed ? "pass" : "fail", expected, actual,
  message: passed ? "产物满足要求" : "summary.json 缺失或 total 不等于 12",
  evidence: context.evidence.artifacts.filter(file => file.path === "summary.json").map(file => file.ref)
}));
`;
export const verifierProtocolHelp = "脚本通过 readFile(process.env.EVAL_CONTEXT, 'utf8') 读取 JSON。stdout 只能输出一个 JSON 对象，必须包含 protocolVersion: 1、verdict: 'pass' 或 'fail'、expected、actual、message（文字）、evidence（已有证据 ID 数组，可为空）。脚本退出 0 且格式合法才接受 verdict；退出 0 本身不表示通过。业务不符返回 fail；脚本异常、非零退出、非法输出、超时或超限属于验证错误。诊断写 stderr（console.error）。";
export const verifierTimingHelp = "输入 execution 是 Agent 执行结果，最终报告的 execution.grading、execution.evidence 尚未写入；请读取顶层 evidence。可选字段使用默认值。数据可能已脱敏，快照也可能不完整。默认脚本超时 60 秒，案例验证总超时 180 秒。上传只保存脚本，实际执行发生在任务结束后。";
