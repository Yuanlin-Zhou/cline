import type { RunItem } from "../../contracts/catalog.js";
import type { ItemSummary } from "../../contracts/projections.js";
import type { RecordRepository } from "../records.js";

export interface RunReadRepository extends RecordRepository {
	readonly projectionEpoch: string;
	transaction<T>(fn: () => T): { (): T; immediate(): T };
	runRevision(id: string): number;
	summaries(runId?: string): ItemSummary[];
	changedSummaries(runId: string, after: number): ItemSummary[];
	attemptSummaries(runId: string, rootId: string): ItemSummary[];
	itemCoordinate(
		itemId: string,
	): { run_id: string; root_id: string } | undefined;
	itemProgress(
		itemId: string,
	):
		| { run_id: string; version: number; state: Record<string, unknown> }
		| undefined;
}
export interface QueueRepository extends RecordRepository {
	itemIds(runId: string, status?: string, round?: number): string[];
	progress(item: RunItem): void;
}
