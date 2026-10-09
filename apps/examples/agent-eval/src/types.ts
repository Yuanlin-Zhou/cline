import type { HeaderConfig } from "./headers.js";
import type { GradingConfig, Grade, EvidenceManifest } from "./grading/types.js";

export type EvalMessage = {
	role: "user" | "assistant";
	content: string;
};

export type ToolMode = "none" | "read-only" | "full";

export type EvalAssertions = {
	contains?: string[];
	notContains?: string[];
	matches?: string[];
	finishReason?:
		| "completed"
		| "max_iterations"
		| "aborted"
		| "mistake_limit"
		| "error";
};

export type EvalDefaults = HeaderConfig & {
	providerId: string;
	modelId: string;
	apiKeyEnv?: string;
	baseUrl?: string;
	cwd?: string;
	systemPrompt?: string;
	maxIterations?: number;
	timeoutMs?: number;
	tools?: ToolMode;
};

export type EvalCase = HeaderConfig & {
	id: string;
	replayMode?: "single-turn" | "full-task";
	tags?: string[];
	description?: string;
	history: EvalMessage[];
	prompt: string;
	cwd?: string;
	systemPrompt?: string;
	maxIterations?: number;
	timeoutMs?: number;
	tools?: ToolMode;
	assertions?: EvalAssertions;
	grading?: GradingConfig;
};

export type EvalSuite = {
	version: 1;
	defaults: EvalDefaults;
	cases: EvalCase[];
};

export type CliOverrides = {
	providerId?: string;
	modelId?: string;
	apiKeyEnv?: string;
	cwd?: string;
	tools?: ToolMode;
	stream: boolean;
};

export type AssertionResult = {
	passed: boolean;
	message: string;
};

export type EvalCaseResult = {
	id: string;
	description?: string;
	status: "passed" | "failed" | "error" | "inconclusive";
	execution?: { status: "completed" | "error" | "cancelled"; reason?: string };
	grading?: Grade;
	evidence?: EvidenceManifest;
	sessionId: string;
	text: string;
	finishReason?: string;
	durationMs: number;
	iterations: number;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		totalCost?: number;
	};
	toolCalls: Array<{
		name: string;
		input: unknown;
		output: unknown;
		error?: string;
		durationMs: number;
	}>;
	assertions: AssertionResult[];
	error?: string;
};

export type EvalReport = {
	version: 1;
	startedAt: string;
	endedAt: string;
	providerId: string;
	modelId: string;
	summary: {
		total: number;
		passed: number;
		failed: number;
		inconclusive?: number;
		executionErrors?: number;
		grading?: ReturnType<typeof import("./grading/summary.js").gradingSummary>;
		durationMs: number;
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};
	cases: EvalCaseResult[];
};
