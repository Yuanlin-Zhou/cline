import { CatalogError } from "../../modules/catalog/repository.js";
import type { ApiContext } from "../context.js";
import { json } from "../http/helpers.js";
import { readJsonBody } from "../http/json-body.js";
export function scorerRoutes({ scorers }: ApiContext) {
	return async (request: Request, url: URL) => {
		const match = url.pathname.match(
			/^\/api\/llm-scorers(?:\/([a-zA-Z0-9-]+))?$/,
		);
		if (!match) return;
		const id = match[1];
		if (request.method === "GET") {
			if (!id) return json(await scorers.list());
			const value = await scorers.get(id);
			if (!value) throw new CatalogError("评分器不存在", 404);
			return json(value);
		}
		if (request.method === "POST" || request.method === "PUT")
			return json(await scorers.save(await readJsonBody(request), id));
		if (id && request.method === "DELETE") {
			const body = await readJsonBody(request);
			await scorers.remove(id, body.revision);
			return json({ deleted: true });
		}
		throw new CatalogError("不支持的评分器操作");
	};
}
