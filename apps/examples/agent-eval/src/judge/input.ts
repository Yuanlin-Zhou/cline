import type { JudgeConfig, JudgeInput, JudgeSource } from "./types.js";
import type { EvidenceManifest } from "../grading/types.js";
import { readEvidence } from "../grading/evidence.js";
import { frozenValidationInput } from "../grading/validation-context.js";
export const JUDGE_PROMPT_VERSION = "reference-judge-v1";
export class JudgeInputError extends Error {
	constructor(
		message: string,
		readonly kind = "missing_evidence",
	) {
		super(message);
	}
}
export async function buildJudgeInput(
	directory: string,
	evidence: EvidenceManifest,
	config: JudgeConfig,
): Promise<JudgeInput> {
	const { context: ctx } = await frozenValidationInput(directory, evidence);
	const sources: JudgeSource[] = [],
		limitations: string[] = [];
	if (config.targets.includes("result")) {
		sources.push({
			id: "result.final_response",
			title: "最终回复",
			content: ctx.execution.text,
			completeness: ctx.execution.completeness,
		});
		if (ctx.execution.error)
			limitations.push(`执行提示：${ctx.execution.error}`);
		for (const file of config.resultFiles) {
			const artifact = evidence.artifacts.find((a) => a.path === file),
				ref = evidence.refs.find((r) => r.id === artifact?.ref);
			if (!artifact || !ref) throw new JudgeInputError(`缺少选定产物：${file}`);
			if (artifact.size > 65536)
				throw new JudgeInputError(
					`产物 ${file} 超过 64 KiB，请缩小送审范围`,
					"input_too_large",
				);
			const data = await readEvidence(directory, ref, 65536);
			let content: string;
			try {
				content = new TextDecoder("utf-8", { fatal: true }).decode(data);
				if (content.includes("\0")) throw Error();
			} catch {
				throw new JudgeInputError(`产物 ${file} 不是可评审的 UTF-8 文本`);
			}
			sources.push({
				id: `artifact:${file}`,
				title: file,
				content,
				completeness: ctx.artifacts.completeness,
			});
		}
	}
	if (config.targets.includes("trajectory")) {
		const includeResult = config.targets.includes("result");
		let lastAssistant = -1;
		for (let i = ctx.conversation.messages.length - 1; i >= 0; i--)
			if (ctx.conversation.messages[i].role === "assistant") {
				lastAssistant = i;
				break;
			}
		let observed = false;
		for (const [index, message] of ctx.conversation.messages.entries()) {
			let blocks = message.blocks.filter((b) =>
				["text", "tool_call", "tool_result"].includes(String(b.type)),
			);
			if (
				!includeResult &&
				index === lastAssistant &&
				ctx.execution.text.trim()
			)
				blocks = blocks.filter((b) => b.type !== "text");
			// The final reply has its own opt-in source, not a hidden trajectory fallback.
			const finalReply =
				!includeResult &&
				message.role === "assistant" &&
				blocks.length > 0 &&
				blocks.every((b) => b.type === "text") &&
				blocks.map((b) => b.text ?? "").join("") === ctx.execution.text;
			if (blocks.length && !finalReply) {
				if (
					message.role === "assistant" ||
					message.role === "tool" ||
					blocks.some((b) => b.type === "tool_call" || b.type === "tool_result")
				)
					observed = true;
				sources.push({
					id: `trajectory.message.${index}`,
					title: `会话 ${index + 1} · ${message.role}`,
					content: { role: message.role, blocks },
					completeness: ctx.conversation.completeness,
				});
			}
		}
		if (ctx.diagnostics.tool_calls.length) {
			observed = true;
			sources.push({
				id: "trajectory.tool_calls",
				title: "工具请求与返回（诊断，不证明实际执行）",
				content: ctx.diagnostics.tool_calls,
				completeness: ctx.diagnostics.completeness,
			});
		}
		const native = ctx.diagnostics.function_call_response;
		if (native) {
			try {
				const raw = JSON.parse(native.raw_response);
				const calls =
					raw.choices?.flatMap(
						(c: { message?: { tool_calls?: unknown[] } }) =>
							c.message?.tool_calls ?? [],
					) ?? [];
				if (calls.length) {
					observed = true;
					sources.push({
						id: "trajectory.function_calls",
						title: "原始函数调用请求（工具未执行）",
						content: { calls, tools: native.request_tools },
						completeness: native.completeness,
					});
				}
			} catch {
				limitations.push("原始函数调用响应无法解析");
			}
		}
		if (!observed)
			throw new JudgeInputError(
				"本次执行没有可用的已保存轨迹，未回退为只评最终回复",
			);
		limitations.push(...ctx.conversation.issues, ...ctx.diagnostics.issues);
	}
	if (config.resultFiles.length && ctx.artifacts.completeness !== "complete")
		limitations.push(
			...ctx.artifacts.issues,
			"产物归档不完整；仅评选定的已保存文件",
		);
	const input: JudgeInput = {
		promptVersion: JUDGE_PROMPT_VERSION,
		task: {
			prompt: ctx.case.prompt,
			history: ctx.case.history,
			replayMode: ctx.case.replay_mode,
		},
		referenceAnswer: config.referenceAnswer,
		rubric:
			config.rubric?.trim() ||
			"按正确性、完整性与对任务要求的满足程度给出 0–100 总分，允许合理的不同答案或处理路径。",
		targets: config.targets,
		sources,
		limitations: [...new Set(limitations)],
	};
	if (Buffer.byteLength(JSON.stringify(input)) > config.maxInputBytes)
		throw new JudgeInputError(
			`送审材料超过 ${config.maxInputBytes} 字节，请缩小评分范围；未截断或自动摘要`,
			"input_too_large",
		);
	return input;
}
