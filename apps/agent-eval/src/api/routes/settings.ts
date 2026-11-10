import { SettingsService } from "../../modules/settings/service.js";
import type { ApiContext } from "../context.js";
import { json } from "../http/helpers.js";
import { readJsonBody } from "../http/json-body.js";
export function settingsRoutes(context: ApiContext) {
	const service = new SettingsService(context.store);
	return async (request: Request, url: URL): Promise<Response | undefined> => {
		if (url.pathname === "/api/settings") {
			if (request.method === "GET") return json(service.get());
			if (request.method === "PUT")
				return json(service.save(await readJsonBody(request)));
		}
		if (url.pathname === "/api/judge-settings") {
			if (request.method === "GET") return json(service.getJudge());
			if (request.method === "PUT")
				return json(service.saveJudge(await readJsonBody(request)));
		}
	};
}
