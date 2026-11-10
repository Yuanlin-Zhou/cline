import { type RunItem } from "../../contracts/catalog.js";
import { CatalogError } from "../../modules/catalog/repository.js";

import type { ApiContext } from "../context.js";
import { json } from "../http/helpers.js";
export function viewsRoutes(context: ApiContext) {
	const { store, catalog, views } = context;
	return async (request: Request, url: URL): Promise<Response | undefined> => {
		const route = url.pathname;
		const method = request.method;
		const viewMatch = route.match(
			/^\/api\/runs\/([^/]+)\/(overview|changes|retry-preview|report)$/,
		);
		if (viewMatch && method === "GET") {
			const [, id, view] = viewMatch;
			return json(
				view === "overview"
					? views.overview(id)
					: view === "changes"
						? views.changes(id, url.searchParams.get("cursor"))
						: view === "retry-preview"
							? views.retryPreview(id)
							: views.report(
									id,
									url.searchParams.get("attemptMode") === "first",
								),
			);
		}
		const itemView = route.match(
			/^\/api\/runs\/([^/]+)\/items\/([^/]+)(?:\/(attempts|progress))?$/,
		);
		if (itemView && method === "GET") {
			const [, runId, itemId, view] = itemView;
			if (view === "attempts") return json(views.attempts(runId, itemId));
			if (view === "progress")
				return json(
					views.progress(runId, itemId, url.searchParams.get("version")),
				);
			const item = store.get<RunItem>("item", itemId);
			if (!item || item.runId !== runId)
				throw new CatalogError("执行记录不存在", 404);
			return json(item);
		}
	};
}
