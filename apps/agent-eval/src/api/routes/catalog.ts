import {
	latestAttempts,
	summarize,
	type Run,
} from "../../contracts/catalog.js";
import { caseSummary } from "../../modules/catalog/summary.js";
import { BATCH_BYTE_LIMIT } from "../../modules/catalog/batch-conversations.js";
import { CatalogError } from "../../modules/catalog/repository.js";
import { moduleDeletion } from "../../modules/catalog/resource-management.js";
import { CatalogService } from "../../modules/catalog/service.js";
import { judgeSummary } from "../../modules/judging/summary.js";
import { readJsonBody } from "../http/json-body.js";

import type { ApiContext } from "../context.js";
import { json } from "../http/helpers.js";
export function catalogRoutes(context: ApiContext) {
	const application = new CatalogService(
		context.catalog,
		context.verifierRepository,
		context.store,
	);
	const { store, catalog, verifierRepository } = context;
	const catalogSummaries = async () =>
		catalog.summaries ? catalog.summaries() : summariesFallback();
	async function summariesFallback() {
		const snapshot = await catalog.snapshot();
		return {
			modules: snapshot.modules,
			cases: snapshot.cases.map(caseSummary),
		};
	}
	return async (request: Request, url: URL): Promise<Response | undefined> => {
		const route = url.pathname;
		const method = request.method;
		if (route === "/api/state" && method === "GET") {
			const allItems = store.summaries();
			const { cases, modules } = await catalog.snapshot();
			const activeIds = new Set(cases.map((c) => c.id));
			const latest = Object.fromEntries(
				latestAttempts(allItems)
					.filter(
						(i) =>
							activeIds.has(i.snapshot.id) &&
							((i.attempt ?? 0) > 0 ||
								!["queued", "running", "cancelled"].includes(i.status)),
					)
					.map((i) => [
						i.snapshot.id,
						{
							status: i.status,
							runId: i.runId,
							revision: i.snapshot.revision,
							modelId: i.snapshot.defaults.modelId,
							sessionId: i.result?.sessionId,
							durationMs: i.result?.durationMs,
							endedAt: i.endedAt,
						},
					]),
			);
			return json({
				modules,
				cases,
				settings: store.settings(),
				runs: store
					.list<Run>("run")
					.reverse()
					.map((run) => ({
						...run,
						summary: summarize(allItems.filter((i) => i.runId === run.id)),
						judgeSummary: judgeSummary(
							allItems.filter((i) => i.runId === run.id),
						),
					})),
				latest,
			});
		}
		if (route === "/api/cases" && method === "GET") {
			const { cases } = await catalogSummaries();
			const moduleId = url.searchParams.get("moduleId");
			const selected = moduleId
				? cases.filter((c) => c.moduleId === moduleId)
				: cases;
			const activeIds = new Set(selected.map((c) => c.id));
			const latest = Object.fromEntries(
				latestAttempts(store.summaries())
					.filter(
						(i) =>
							activeIds.has(i.snapshot.id) &&
							((i.attempt ?? 0) > 0 ||
								!["queued", "running", "cancelled"].includes(i.status)),
					)
					.map((i) => [
						i.snapshot.id,
						{
							status: i.status,
							runId: i.runId,
							revision: i.snapshot.revision,
							modelId: i.snapshot.defaults.modelId,
							sessionId: i.result?.sessionId,
							durationMs: i.result?.durationMs,
							endedAt: i.endedAt,
						},
					]),
			);
			return json({ cases: selected, latest });
		}
		if (route === "/api/cases/tags" && method === "GET")
			return json([
				...new Set(
					(await catalogSummaries()).cases.flatMap(
						(c) => c.definition.tags ?? [],
					),
				),
			]);
		if (
			route === "/api/modules" &&
			method === "GET" &&
			url.searchParams.get("view") === "summary"
		) {
			const { cases, modules } = await catalogSummaries();
			return json({
				modules,
				counts: Object.fromEntries(
					modules.map((m) => [
						m.id,
						cases.filter((c) => c.moduleId === m.id).length,
					]),
				),
			});
		}

		if (route === "/api/modules" && method === "POST") {
			const body = await readJsonBody(request);
			return json(
				await catalog.createModule(body.name, body.description, body.tags),
				201,
			);
		}
		if (route === "/api/modules" && method === "GET")
			return json(
				url.searchParams.get("includeArchived") === "1"
					? (await catalog.allResources()).modules
					: (await catalog.snapshot()).modules,
			);

		const modulePreview = route.match(
			/^\/api\/modules\/([^/]+)\/delete-preview$/,
		);
		if (modulePreview && method === "POST")
			return json(
				moduleDeletion(modulePreview[1], await catalog.allResources()),
			);
		if (route === "/api/cases/delete-batch" && method === "POST")
			return json(await catalog.deleteCases(await readJsonBody(request)));

		const moduleMatch = route.match(
			/^\/api\/modules\/([^/]+)(?:\/(archive|unarchive))?$/,
		);
		if (moduleMatch) {
			const [, id, action] = moduleMatch;
			if (method === "GET" && !action) {
				const module = await catalog.getModule(id);
				if (!module) throw new CatalogError("模块不存在", 404);
				return json(module);
			}
			if (action === "archive" && method === "POST") {
				await catalog.archiveModule(id);
				return json({ archived: true });
			}
			if (action === "unarchive" && method === "POST") {
				await catalog.setArchived("module", id, false);
				return json({ archived: false });
			}
			if (method === "DELETE" && !action)
				return json(
					await catalog.deleteModule(id, await readJsonBody(request)),
				);
			if (method === "PUT")
				return json(
					await catalog.updateModule(id, await readJsonBody(request)),
				);
			return json({ error: "接口不存在" }, 404);
		}

		if (
			[
				"/api/import/conversations/preview",
				"/api/import/conversations",
			].includes(route) &&
			method === "POST"
		) {
			const response = await application.importConversations(
				await readJsonBody(request, BATCH_BYTE_LIMIT),
				!route.endsWith("/preview"),
			);
			return json(response.value, response.status);
		}
		if (
			["/api/import/preview", "/api/import"].includes(route) &&
			method === "POST"
		) {
			return json(
				await application.importSuite(
					await readJsonBody(request),
					!route.endsWith("preview"),
				),
			);
		}
		if (route === "/api/cases" && method === "POST") {
			return json(await application.create(await readJsonBody(request)), 201);
		}
		if (
			["/api/cases/transfer/preview", "/api/cases/transfer"].includes(route) &&
			method === "POST"
		) {
			return json(
				await application.transfer(
					await readJsonBody(request),
					route === "/api/cases/transfer",
				),
			);
		}

		const caseActionMatch = route.match(
			/^\/api\/cases\/([^/]+)\/(duplicate|archive|unarchive)$/,
		);
		if (caseActionMatch && method === "POST") {
			const [, id, action] = caseActionMatch;
			if (action === "duplicate")
				return json(await catalog.duplicateCase(id), 201);
			if (action === "archive") {
				await catalog.setArchived("case", id, true);
				return json({ archived: true });
			}
			await catalog.setArchived("case", id, false);
			return json({ archived: false });
		}
		const caseRunsMatch = route.match(/^\/api\/cases\/([^/]+)\/runs$/);
		if (caseRunsMatch && method === "GET") {
			const targetId = caseRunsMatch[1];
			const allItems = store.caseItems(caseRunsMatch[1]);
			if (
				!allItems.some((i) => i.snapshot.id === targetId) &&
				!(await catalog.getCase(targetId))
			)
				throw new CatalogError("案例不存在或已删除", 404);
			return json(
				store
					.list<Run>("run")
					.reverse()
					.map((run) => {
						const items = allItems.filter(
							(i) => i.runId === run.id && i.snapshot.id === targetId,
						);
						return {
							...run,
							summary: summarize(items),
							items: items.map((i) => ({
								id: i.id,
								rootItemId: i.rootItemId,
								attempt: i.attempt ?? 0,
								round: i.round ?? 1,
								status: i.status,
								revision: i.snapshot.revision,
								modelId: i.snapshot.defaults.modelId,
								sessionId: i.result?.sessionId,
								durationMs: i.result?.durationMs,
								endedAt: i.endedAt,
							})),
						};
					})
					.filter((run) => run.items.length > 0),
			);
		}
		const caseMatch = route.match(/^\/api\/cases\/([^/]+)$/);
		if (caseMatch && method === "GET") {
			const item = await catalog.getCase(caseMatch[1]);
			if (!item) throw new CatalogError("案例不存在或已删除", 404);
			return json(item);
		}
		if (caseMatch && method === "DELETE") {
			if (!(await catalog.getCase(caseMatch[1])))
				return json({ error: "案例不存在或已删除" }, 404);
			await catalog.deleteCase(caseMatch[1]);
			return json({ deleted: true });
		}
		if (caseMatch && method === "PUT") {
			return json(
				await application.update(caseMatch[1], await readJsonBody(request)),
			);
		}
	};
}
