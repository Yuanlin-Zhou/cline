import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { RunChanges, RunOverview } from "../../../../src/contracts/api";
import type { ItemSummary } from "../../../../src/contracts/projections";
import { api } from "../../api/client";

export function useRun(runId: string) {
	const client = useQueryClient();
	const path = `/api/runs/${runId}/overview`;
	return useQuery<RunOverview>({
		queryKey: [path],
		queryFn: async ({ signal }) => {
			const prior = client.getQueryData<RunOverview>([path]);
			if (!prior?.cursor) return api<RunOverview>(path, { signal });
			const delta = await api<RunChanges>(
				`/api/runs/${runId}/changes?cursor=${encodeURIComponent(prior.cursor)}`,
				{ signal },
			);
			if (delta.resync) return api<RunOverview>(path, { signal });
			const items = new Map<string, ItemSummary>(
				prior.items.map((item: ItemSummary) => [
					item.rootItemId ?? item.id,
					item,
				]),
			);
			for (const item of delta.items ?? [])
				items.set(item.rootItemId ?? item.id, item);
			return { ...prior, ...delta, items: Array.from(items.values()) };
		},
		refetchInterval: (query) =>
			["queued", "running"].includes(query.state.data?.status ?? "")
				? 1000
				: false,
	});
}
export function useRunItem(runId: string, item: any) {
	const client = useQueryClient();
	const path = `/api/runs/${runId}/items/${item.id}`;
	const running = ["queued", "running"].includes(item.status);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running)
			void client.invalidateQueries({ queryKey: [path], exact: true });
		wasRunning.current = running;
	}, [running, path, client]);
	return useQuery<any>({
		queryKey: [path],
		queryFn: async ({ signal }) => {
			const prior = client.getQueryData<any>([path]);
			if (!prior || !running) return api(path, { signal });
			const update = await api<any>(
				`${path}/progress?version=${prior.detailVersion ?? ""}`,
				{ signal },
			);
			return {
				...prior,
				...(update.state ?? {}),
				detailVersion: update.version,
			};
		},
		refetchInterval: running ? 1000 : false,
	});
}
