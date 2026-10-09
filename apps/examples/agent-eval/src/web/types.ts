import type { EvalCase, EvalCaseResult, EvalDefaults } from "../types.js";

export type Module = { id: string; name: string; description: string; tags?: string[]; archived?: boolean; createdAt: string };
export type SavedCase = {
	id: string; moduleId: string; revision: number; definition: EvalCase;
	defaults: EvalDefaults; updatedAt: string; archived?: boolean;
};
export type ItemStatus = "queued" | "running" | "passed" | "failed" | "error" | "cancelled" | "inconclusive";
export type RunItem = {
	id: string; runId: string; verifierSnapshots?: import("../grading/uploaded-verifiers.js").UploadedVerifier[]; snapshot: SavedCase; moduleName: string;
	status: ItemStatus; text: string; result?: EvalCaseResult; error?: string;
	phase?: "executing" | "verifying";
	workspace?: string; startedAt?: string; endedAt?: string;
	/** One-based repetition index; legacy items belong to round 1. */
	round?: number;
	interrupted?: boolean;
};
export type Run = {
	id: string; name: string; note?: string; status: "queued" | "running" | "completed" | "cancelled" | "interrupted";
	createdAt: string; endedAt?: string; concurrency: number; parentRunId?: string;
	repeatCount?: number;
};
export type RunDetail = Run & { items: RunItem[] };
export type Summary = {
	total: number; passed: number; failed: number; error: number; cancelled: number; inconclusive: number;
	queued: number; running: number; tokens: number; cost: number | null; durationMs: number;
};
export function summarize(items: RunItem[]): Summary {
	const value: Summary = { total: items.length, passed: 0, failed: 0, error: 0, cancelled: 0, inconclusive: 0, queued: 0, running: 0, tokens: 0, cost: null, durationMs: 0 };
	let knownCost = 0;
	let costComplete = items.length > 0;
	for (const item of items) {
		value[item.status]++;
		value.tokens += (item.result?.usage.inputTokens ?? 0) + (item.result?.usage.outputTokens ?? 0);
		value.durationMs += item.result?.durationMs ?? 0;
		if (item.result?.usage.totalCost === undefined) costComplete = false;
		else knownCost += item.result.usage.totalCost;
	}
	value.cost = costComplete ? knownCost : null;
	return value;
}
