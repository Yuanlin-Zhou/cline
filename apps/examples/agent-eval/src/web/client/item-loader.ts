import type { RunItem } from "../types.js";
import type { ItemSummary } from "../projections.js";
type Api = <T>(path: string) => Promise<T>;
/** Cache static input only for recently inspected items; progress never downloads it again. */
export function itemLoader(api: Api) {
	const cache = new Map<string, { item: RunItem; version: number }>();
	const pending = new Map<string, Promise<RunItem>>();
	const load = async (runId: string, summary: RunItem): Promise<RunItem> => {
		const id = summary.id,
			base = `/api/runs/${runId}/items/${id}`,
			cached = cache.get(id),
			s = summary as ItemSummary;
		if (!(summary as Partial<ItemSummary>).summary) return summary;
		if (
			cached?.version === s.detailVersion &&
			(!summary.result || cached.item.result)
		)
			return cached.item;
		if (!cached || summary.result) {
			const item = await api<RunItem>(base);
			// The source may have advanced after overview; a subsequent progress read reconciles it.
			cache.set(id, { item, version: s.detailVersion });
			if (cache.size > 32) cache.delete(cache.keys().next().value!);
			return item;
		}
		const progress = await api<{ version: number; state?: Partial<RunItem> }>(
			`${base}/progress?version=${cached.version}`,
		);
		const item = { ...cached.item, ...progress.state };
		cache.set(id, { item, version: progress.version });
		return item;
	};
	return (runId: string, summary: RunItem) => {
		const key = `${runId}:${summary.id}:${(summary as ItemSummary).detailVersion ?? 0}`;
		if (pending.has(key)) return pending.get(key)!;
		const task = load(runId, summary).finally(() => pending.delete(key));
		pending.set(key, task);
		return task;
	};
}
