import type { Module, Run, Summary } from "./catalog.js";
import type { CaseSummary, ItemSummary } from "./projections.js";

export type ModuleSummaryResponse = {
	modules: Module[];
	counts: Record<string, number>;
};
export type RecentCaseResult = {
	status: string;
	runId: string;
	revision: number;
	modelId: string;
	sessionId?: string;
	durationMs?: number;
	endedAt?: string;
};
export type CaseListResponse = {
	cases: CaseSummary[];
	latest: Record<string, RecentCaseResult>;
};
export type RunSummary = Run & { summary: Summary };
export type RunOverview = Run & {
	revision: number;
	cursor: string;
	items: ItemSummary[];
	summary: Summary;
	gradingSummary: ReturnType<
		typeof import("../modules/grading/summary.js").gradingSummary
	>;
	judgeSummary: ReturnType<
		typeof import("../modules/judging/summary.js").judgeSummary
	>;
	moduleSummary: Record<string, Summary>;
};
export type RunChanges = Partial<Omit<RunOverview, "items">> & {
	resync?: boolean;
	items?: ItemSummary[];
};
