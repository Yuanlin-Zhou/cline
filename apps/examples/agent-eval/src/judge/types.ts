import type { HeaderConfig } from "../headers.js";
export type JudgeModel = HeaderConfig & {
	providerId: string;
	modelId: string;
	apiKeyEnv?: string;
	baseUrl?: string;
};
export type JudgeConfig = {
	enabled: boolean;
	referenceAnswer: string;
	targets: Array<"result" | "trajectory">;
	rubric?: string;
	model?: JudgeModel;
	affectsOutcome: boolean;
	passScore: number;
	timeoutMs: number;
	maxInputBytes: number;
	resultFiles: string[];
};
export type JudgeSource = {
	id: string;
	title: string;
	content: unknown;
	completeness: string;
};
export type JudgeInput = {
	promptVersion: string;
	task: { prompt: string; history: unknown[]; replayMode: string };
	referenceAnswer: string;
	rubric: string;
	targets: JudgeConfig["targets"];
	sources: JudgeSource[];
	limitations: string[];
};
export type JudgeResult = {
	baseStatus?: import("../types.js").EvalCaseResult["status"];
	id: string;
	status: "scored" | "insufficient" | "error" | "skipped" | "cancelled";
	score: number | null;
	rationale: string;
	evidence: Array<{ ref: string; quote?: string }>;
	targets: JudgeConfig["targets"];
	model?: JudgeModel;
	affectsOutcome: boolean;
	passScore: number;
	meetsThreshold?: boolean;
	configHash: string;
	inputHash?: string;
	promptVersion: string;
	limitations: string[];
	startedAt: string;
	endedAt: string;
	durationMs: number;
	usage: { inputTokens?: number; outputTokens?: number; totalCost?: number };
	errorType?: string;
	/** Source and raw response paths are local to this score, never supplied by a client. */
};
export const JUDGE_STATUS: Record<JudgeResult["status"], string> = {
	scored: "已评分",
	insufficient: "信息不足",
	error: "评分错误",
	skipped: "已跳过",
	cancelled: "已取消",
};
