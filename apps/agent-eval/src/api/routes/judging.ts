import { type RunItem } from "../../contracts/catalog.js";
import { CatalogError } from "../../modules/catalog/repository.js";
import { readJsonBody } from "../http/json-body.js";

import type { ApiContext } from "../context.js";
import { json } from "../http/helpers.js";
export function judgingRoutes(context: ApiContext) {
	const { store, catalog, judgeScores } = context;
	return async (request: Request, url: URL): Promise<Response | undefined> => {
		const route = url.pathname;
		const method = request.method;
		const judgeMatch = route.match(
			/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/judge-scores(?:\/(preview|official-input|[a-zA-Z0-9-]+)(?:\/(cancel))?)?$/,
		);
		if (judgeMatch) {
			const [, runId, itemId, scoreId, action] = judgeMatch;
			const item = store.get<RunItem>("item", itemId);
			if (!item || item.runId !== runId)
				throw new CatalogError("执行记录不存在", 404);
			if (!scoreId) {
				if (method === "GET") return json(judgeScores.list(item));
				if (method === "POST")
					return json(
						await judgeScores.create(item, await readJsonBody(request)),
						202,
					);
			}
			if (scoreId === "preview" && method === "POST")
				return json(
					await judgeScores.preview(item, (await readJsonBody(request)).config),
				);
			if (scoreId === "official-input" && method === "GET")
				return json(await judgeScores.officialInput(item));
			if (scoreId && !["preview", "official-input"].includes(scoreId)) {
				const score = judgeScores.get(scoreId, item);
				if (action === "cancel" && method === "POST") {
					judgeScores.cancel(scoreId);
					return json(judgeScores.public(score));
				}
				if (!action && method === "GET")
					return json(
						url.searchParams.get("input") === "1"
							? score
							: judgeScores.public(score),
					);
			}
			throw new CatalogError("不支持的评分操作", 400);
		}
	};
}
