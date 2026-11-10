import { summarize, type Run } from "../../contracts/catalog.js";
import { runArtifacts } from "../../modules/evidence/run-artifacts.js";
import { runCsv, runDocument } from "../../modules/runs/export.js";

import { repeatReportMarkdown } from "../../modules/runs/repeat-report.js";
import { RunService } from "../../modules/runs/service.js";
import { readJsonBody } from "../http/json-body.js";

import type { ApiContext } from "../context.js";
import { json } from "../http/helpers.js";
export function runsRoutes(context: ApiContext) {
	const submissions = new RunService(context);
	const { store, queue, views } = context;
	return async (request: Request, url: URL): Promise<Response | undefined> => {
		const route = url.pathname;
		const method = request.method;
		if (route === "/api/runs" && method === "GET") {
			const items = store.summaries();
			return json(
				store
					.list<Run>("run")
					.reverse()
					.map((run) => ({
						...run,
						summary: summarize(items.filter((i) => i.runId === run.id)),
					})),
			);
		}

		if (route === "/api/runs" && method === "POST") {
			const run = await submissions.submit(await readJsonBody(request));
			queue.kick();
			return json(run, 202);
		}
		const runMatch = route.match(
			/^\/api\/runs\/([^/]+)(?:\/(cancel|export|artifacts|retry))?$/,
		);
		if (runMatch) {
			const [, id, action] = runMatch;
			if (action === "retry" && method === "POST") {
				const response = store.retryRun(id, await readJsonBody(request));
				queue.kick();
				return json(response, 202);
			}
			if (action === "cancel" && method === "POST") {
				queue.cancel(id);
				return json(
					url.searchParams.get("view") === "summary"
						? views.overview(id)
						: store.detail(id),
				);
			}
			if (method === "GET") {
				const run = store.detail(id);
				if (action === "artifacts")
					return json(
						await runArtifacts(
							store.directory,
							run,
							url.searchParams.get("item"),
							url.searchParams.get("file"),
						),
					);
				if (action === "export") {
					if (url.searchParams.get("format") === "markdown")
						return new Response(repeatReportMarkdown(run), {
							headers: {
								"Content-Type": "text/markdown; charset=utf-8",
								"Content-Disposition": `attachment; filename="eval-${id}-repeat-report.md"`,
							},
						});
					if (url.searchParams.get("format") === "csv") {
						return new Response(runCsv(run), {
							headers: {
								"Content-Type": "text/csv; charset=utf-8",
								"Content-Disposition": `attachment; filename="eval-${id}.csv"`,
							},
						});
					}
					return new Response(JSON.stringify(runDocument(run), null, 2), {
						headers: {
							"Content-Type": "application/json",
							"Content-Disposition": `attachment; filename="eval-${id}.json"`,
						},
					});
				}
				return json(runDocument(run));
			}
		}
	};
}
