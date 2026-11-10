import { randomUUID } from "node:crypto";
import {
	canRetry,
	latestAttempts,
	summarize,
	type Run,
	type RunItem,
} from "../../contracts/catalog.js";
import { CatalogError } from "../catalog/repository.js";
import { gradingSummary } from "../grading/summary.js";
import { judgeSummary } from "../judging/summary.js";
import type { RunReadRepository } from "./ports.js";
import { buildRepeatReport } from "./repeat-report.js";

import type { RunOverview } from "../../contracts/api.js";
export type { RunOverview } from "../../contracts/api.js";
type ReportView = {
	revision: number;
	repeatReport: ReturnType<typeof buildRepeatReport>;
};
export class RunViews {
	private readonly instance = randomUUID();
	private cache = new Map<string, { revision: number; value: RunOverview }>();
	private reports = new Map<string, { revision: number; value: ReportView }>();
	constructor(readonly store: RunReadRepository) {}
	private run(id: string) {
		const run = this.store.get<Run>("run", id);
		if (!run) throw new CatalogError("评测不存在", 404);
		return run;
	}
	revision(id: string) {
		return this.store.runRevision(id);
	}

	cursor(id: string, revision = this.revision(id)) {
		return `${this.store.projectionEpoch}.${this.instance}:${revision}`;
	}
	overview(id: string): RunOverview {
		return this.store.transaction(() => {
			const run = this.run(id),
				revision = this.revision(id);
			const cached = this.cache.get(id);
			if (cached?.revision === revision) return cached.value;
			const all = this.store.summaries(id),
				items = latestAttempts(all);
			const moduleSummary = Object.fromEntries(
				[...new Set(all.map((i) => i.moduleName))].map((name) => {
					const group = all.filter((i) => i.moduleName === name);
					return [name, summarize(group)];
				}),
			);
			const value = {
				...run,
				revision,
				cursor: this.cursor(id, revision),
				summary: summarize(all),
				gradingSummary: gradingSummary(all),
				judgeSummary: judgeSummary(all),
				moduleSummary,
				items,
			};
			this.cache.set(id, { revision, value });
			if (this.cache.size > 50)
				this.cache.delete(this.cache.keys().next().value!);
			return value;
		})();
	}
	changes(id: string, cursor: string | null) {
		return this.store.transaction(() => {
			const revision = this.revision(id);
			this.run(id);
			const prefix = `${this.store.projectionEpoch}.${this.instance}:`;
			const suffix = cursor?.startsWith(prefix)
				? cursor.slice(prefix.length)
				: "";
			const parsed = /^(0|[1-9][0-9]*)$/.test(suffix) ? Number(suffix) : NaN;
			if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > revision)
				return { resync: true, cursor: this.cursor(id, revision) };
			if (parsed === revision) return { cursor, items: [] };
			const { items, ...overview } = this.overview(id);
			const changed = this.store.changedSummaries(id, parsed);
			const roots = new Set(changed.map((i) => i.rootItemId ?? i.id));
			return {
				...overview,
				items: items.filter((i: RunItem) => roots.has(i.rootItemId ?? i.id)),
			};
		})();
	}
	attempts(runId: string, itemId: string) {
		const item = this.store.itemCoordinate(itemId);
		if (!item || item.run_id !== runId)
			throw new CatalogError("执行记录不存在", 404);
		return this.store.attemptSummaries(runId, item.root_id);
	}
	progress(runId: string, itemId: string, version: string | null) {
		const row = this.store.itemProgress(itemId);
		if (!row || row.run_id !== runId)
			throw new CatalogError("执行记录不存在", 404);
		return String(row.version) === version
			? { version: row.version }
			: { version: row.version, state: row.state };
	}
	retryPreview(id: string) {
		const overview = this.overview(id);
		return { ...overview, items: overview.items.filter(canRetry) };
	}
	report(id: string, first: boolean) {
		const key = `${id}:${first}`,
			revision = this.revision(id),
			cached = this.reports.get(key);
		if (cached?.revision === revision) return cached.value;
		const run = {
			...this.run(id),
			items: this.store.summaries(id),
		};
		const value = {
			revision,
			repeatReport: buildRepeatReport(
				first ? { ...run, items: run.items.filter((i) => !i.attempt) } : run,
			),
		};
		this.reports.set(key, { revision, value });
		if (this.reports.size > 10)
			this.reports.delete(this.reports.keys().next().value!);
		return value;
	}
}
