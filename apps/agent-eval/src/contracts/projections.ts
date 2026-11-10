import type { RunItem, SavedCase } from "./catalog.js";
export type CaseSummary = Pick<
	SavedCase,
	"id" | "moduleId" | "revision" | "updatedAt" | "archived"
> & {
	summary: true;
	definition: Pick<
		SavedCase["definition"],
		"id" | "description" | "tags" | "replayMode"
	> & { isBadCase?: boolean };
	defaults: Pick<SavedCase["defaults"], "providerId" | "modelId">;
};
export type ItemSummary = RunItem & {
	summary: true;
	detailVersion: number;
	outputHash?: string;
	judgeGroupKey?: string;
	gradingGroupKey?: string;
	direct: boolean;
	hasContentAssertions: boolean;
};
