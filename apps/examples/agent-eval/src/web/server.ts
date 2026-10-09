import { TransferError } from "./transfer.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvalSuite } from "../schema.js";
import { EvalStore } from "./store.js";
import { EvalQueue, type Executor } from "./queue.js";
import { summarize, type Module, type Run, type RunItem, type SavedCase } from "./types.js";
import { artifacts, artifactText } from "./workspace.js";
import { buildRepeatReport, repeatReportMarkdown } from "./repeat-report.js";
import { loadVerifiers, publicVerifier } from "../grading/verifiers.js";
import { preflight } from "../grading/engine.js";
import { CAPABILITIES, readEvidence } from "../grading/evidence.js";
import { gradingSummary } from "../grading/summary.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const client = fileURLToPath(new URL("client/", import.meta.url));
const json = (data: unknown, status = 200) => Response.json(data, { status });
const csvCell = (value: unknown) => `"${String(value ?? "").replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;

export async function createEvalServer(options: { directory?: string; port?: number; execute?: Executor } = {}) {
	const store = new EvalStore(path.resolve(options.directory ?? process.env.EVAL_DATA_DIR ?? path.join(root, ".eval-data")));
	const queue = new EvalQueue(store, options.execute);
	const verifiers = await loadVerifiers();
	store.validateCase = definition => preflight(definition, verifiers);
	const build = await Bun.build({ entrypoints: [path.join(client, "app.ts")], target: "browser", minify: false });
	if (!build.success) throw new Error(build.logs.map(String).join("\n"));
	const js = await build.outputs[0].text();
	const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? Number(process.env.EVAL_PORT ?? 3130), maxRequestBodySize: 8 * 1024 * 1024,
		async fetch(request) {
			const url = new URL(request.url);
			if (!["127.0.0.1", "localhost"].includes(url.hostname)) return json({ error: "仅支持本机访问" }, 403);
			const origin = request.headers.get("origin");
			if (origin && origin !== url.origin) return json({ error: "不允许跨站请求" }, 403);
			if (request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "不允许跨站请求" }, 403);
			try {
				const route = url.pathname; const method = request.method;
				if (!route.startsWith("/api/")) {
					if (method !== "GET") return new Response("Method not allowed", { status: 405 });
					const headers = { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'", "X-Content-Type-Options": "nosniff" };
					if (route === "/app.js") return new Response(js, { headers: { ...headers, "Content-Type": "text/javascript" } });
					if (route === "/style.css") return new Response(Bun.file(path.join(client, "style.css")), { headers: { ...headers, "Content-Type": "text/css" } });
					if (route === "/" || route === "/index.html") return new Response(Bun.file(path.join(client, "index.html")), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
					return new Response("Not found", { status: 404 });
				}
				if (method !== "GET" && !request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "请求须为 application/json" }, 415);
				if (route === "/api/state" && method === "GET") {
					const allItems = store.list<import("./types.js").RunItem>("item");
					const cases = store.activeCases();
					const activeIds = new Set(cases.map(c => c.id));
					const latest = Object.fromEntries(allItems.filter(i => activeIds.has(i.snapshot.id) && !["queued", "running", "cancelled"].includes(i.status)).map(i => [i.snapshot.id, { status: i.status, runId: i.runId, revision: i.snapshot.revision, modelId: i.snapshot.defaults.modelId, sessionId: i.result?.sessionId, durationMs: i.result?.durationMs, endedAt: i.endedAt }]));
					return json({ modules: store.activeModules(), cases, settings: store.settings(), runs: store.list<Run>("run").reverse().map(run => ({ ...run, summary: summarize(allItems.filter(i => i.runId === run.id)) })), latest });
				}
				if (route === "/api/verifiers" && method === "GET") return json({ verifiers: verifiers.map(publicVerifier), capabilities: CAPABILITIES });
				const evidenceMatch = route.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/(grading|evidence)(?:\/([^/]+))?$/);
				if (evidenceMatch && method === "GET") {
					const [, runId, itemId, kind, evidenceId] = evidenceMatch;
					const item = store.detail(runId).items.find(i => i.id === itemId);
					if (!item?.result?.grading) return json({ error: "判分记录不存在" }, 404);
					if (kind === "grading") return json(item.result.grading);
					const ref = item.result.evidence?.refs.find(r => r.id === evidenceId);
					if (!ref) return json({ error: "证据不存在" }, 404);
					const bytes = await readEvidence(path.join(store.directory, "runs", runId, itemId), ref);
					return json({ id: ref.id, label: ref.label, text: bytes.includes(0) ? "二进制文件，无法文本预览" : bytes.toString("utf8"), sha256: ref.sha256 });
				}
				if (route === "/api/modules" && method === "POST") { const body = await request.json(); return json(store.createModule(body.name, body.description, body.tags), 201); }
				const moduleMatch = route.match(/^\/api\/modules\/([^/]+)(?:\/(archive|unarchive))?$/);
				if (moduleMatch) {
					const [, id, action] = moduleMatch;
					if (action === "archive" && method === "POST") { store.archiveModule(id); return json({ archived: true }); }
					if (action === "unarchive" && method === "POST") { store.setArchived("module", id, false); return json({ archived: false }); }
					if (method === "PUT") return json(store.updateModule(id, await request.json()));
					return json({ error: "接口不存在" }, 404);
				}
				if (route === "/api/settings" && method === "PUT") {
					const body = await request.json(); const settings = parseEvalSuite({ defaults: body, cases: [{ id: "settings", prompt: "settings" }] }).defaults;
					if (settings.cwd && !path.isAbsolute(settings.cwd)) throw new Error("网页 fixture 目录须填写绝对路径");
					store.put("settings", "default", settings); return json(settings);
				}
				if (["/api/import/preview", "/api/import"].includes(route) && method === "POST") {
					const body = await request.json(); store.require("module", body.moduleId);
					if (typeof body.content !== "string") throw new Error("缺少导入内容");
					const suite = store.parseImport(body.content, body.format, body.replayMode);
					for (const cwd of [suite.defaults.cwd, ...suite.cases.map(c => c.cwd)]) if (cwd && !path.isAbsolute(cwd)) throw new Error("上传文件的相对 cwd 无法确定，请改为服务端 fixture 绝对路径或删除 cwd 使用空工作区");
					if (route.endsWith("preview")) { const existing = store.activeCases().filter(c => c.moduleId === body.moduleId); return json({ suite, cases: suite.cases.map(c => ({ id: c.id, description: c.description, replayMode: c.replayMode, duplicate: existing.some(e => e.definition.id === c.id) })) }); }
					return json(store.importCases(body.moduleId, suite, body.policy));
				}
				if (route === "/api/cases" && method === "POST") {
					const body = await request.json();
					if (!body.moduleId) throw new Error("缺少目标模块");
					const suite = parseEvalSuite({ defaults: body.defaults, cases: [body.definition] });
					for (const cwd of [suite.defaults.cwd, suite.cases[0].cwd]) if (cwd && !path.isAbsolute(cwd)) throw new Error("fixture 目录须为绝对路径");
					return json(store.createCase(body.moduleId, suite.defaults, suite.cases[0]), 201);
				}
				if (route === "/api/cases/transfer/preview" && request.method === "POST") return json(store.previewTransfer(await request.json()));
				if (route === "/api/cases/transfer" && request.method === "POST") return json(store.transferCases(await request.json()));

				const caseActionMatch = route.match(/^\/api\/cases\/([^/]+)\/(duplicate|archive|unarchive)$/);
				if (caseActionMatch && method === "POST") {
					const [, id, action] = caseActionMatch;
					if (action === "duplicate") return json(store.duplicateCase(id), 201);
					if (action === "archive") { store.setArchived("case", id, true); return json({ archived: true }); }
					store.setArchived("case", id, false); return json({ archived: false });
				}
				const caseRunsMatch = route.match(/^\/api\/cases\/([^/]+)\/runs$/);
				if (caseRunsMatch && method === "GET") {
					const target = store.require<SavedCase>("case", caseRunsMatch[1]);
					const allItems = store.list<RunItem>("item");
					return json(store.list<Run>("run").reverse().map(run => {
						const items = allItems.filter(i => i.runId === run.id && i.snapshot.id === target.id);
						return { ...run, summary: summarize(items), items: items.map(i => ({ id: i.id, round: i.round ?? 1, status: i.status, revision: i.snapshot.revision, modelId: i.snapshot.defaults.modelId, sessionId: i.result?.sessionId, durationMs: i.result?.durationMs, endedAt: i.endedAt })) };
					}).filter(run => run.items.length > 0));
				}
				const caseMatch = route.match(/^\/api\/cases\/([^/]+)$/);
				if (caseMatch && method === "DELETE") {
					if (!store.get<SavedCase>("case", caseMatch[1])) return json({ error: "案例不存在或已删除" }, 404);
					store.deleteCase(caseMatch[1]); return json({ deleted: true });
				}
				if (caseMatch && method === "PUT") {
					const previous = store.require<SavedCase>("case", caseMatch[1]); const body = await request.json();
					if (body.revision !== previous.revision) return json({ error: "案例已被其他页面修改，请刷新后重试" }, 409);
					const suite = parseEvalSuite({ defaults: body.defaults, cases: [body.definition] });
					if (store.activeCases().some(c => c.id !== previous.id && c.moduleId === previous.moduleId && c.definition.id === suite.cases[0].id)) throw new Error("同模块已有相同案例 ID");
					for (const cwd of [suite.defaults.cwd, suite.cases[0].cwd]) if (cwd && !path.isAbsolute(cwd)) throw new Error("fixture 目录须为绝对路径");
					const updated = { ...previous, definition: suite.cases[0], defaults: suite.defaults, revision: previous.revision + 1, updatedAt: new Date().toISOString() }; store.put("case", updated.id, updated); return json(updated);
				}
				if (route === "/api/runs" && method === "POST") {
					const body = await request.json();
					if (body.defaults) {
						const parsed = parseEvalSuite({ defaults: body.defaults, cases: [{ id: "run-defaults", prompt: "run-defaults" }] }).defaults;
						if (parsed.cwd && !path.isAbsolute(parsed.cwd)) throw new Error("fixture 目录须为绝对路径");
					}
					if (Array.isArray(body.draft)) for (const draft of body.draft) {
						store.require("module", draft.moduleId);
						const suite = parseEvalSuite({ defaults: draft.defaults, cases: [draft.definition] });
						for (const cwd of [suite.defaults.cwd, suite.cases[0].cwd]) if (cwd && !path.isAbsolute(cwd)) throw new Error("fixture 目录须为绝对路径");
						draft.definition = suite.cases[0]; draft.defaults = suite.defaults;
					}
					const run = store.createRun(body); queue.kick(); return json(run, 202);
				}
				const runMatch = route.match(/^\/api\/runs\/([^/]+)(?:\/(cancel|export|artifacts))?$/);
				if (runMatch) {
					const [, id, action] = runMatch;
					if (action === "cancel" && method === "POST") { queue.cancel(id); return json(store.detail(id)); }
					if (method === "GET") {
						const run = store.detail(id);
						if (action === "artifacts") { const item = run.items.find(i => i.id === url.searchParams.get("item")); if (!item?.workspace) throw new Error("运行工作区尚未建立"); const directory = path.dirname(item.workspace); return json(url.searchParams.has("file") ? await artifactText(directory, url.searchParams.get("file")!) : await artifacts(directory)); }
						if (action === "export") {
							if (url.searchParams.get("format") === "markdown") return new Response(repeatReportMarkdown(run), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="eval-${id}-repeat-report.md"` } });
							if (url.searchParams.get("format") === "csv") {
								const rows = [["module", "case", "revision", "mode", "model", "status", "duration_ms", "tokens", "cost", "error", "round", "item_id", "output", "failed_assertions", "session_id", "grading_mode", "grading_verdict", "grading_status", "failed_rules", "evidence_ids", "rule_hash"], ...run.items.map(i => [i.moduleName, i.snapshot.definition.id, i.snapshot.revision, i.snapshot.definition.replayMode ?? "single-turn", i.snapshot.defaults.modelId, i.status, i.result?.durationMs, (i.result?.usage.inputTokens ?? 0) + (i.result?.usage.outputTokens ?? 0), i.result?.usage.totalCost ?? "", i.error ?? i.result?.error ?? "", i.round ?? 1, i.id, i.result?.text ?? i.text, i.result?.assertions.filter(a => !a.passed).map(a => a.message).join("; "), i.result?.sessionId, i.snapshot.definition.grading ? "task" : "legacy-text", i.result?.grading?.verdict, i.result?.grading?.status, i.result?.grading?.results.filter(r => r.status === "fail").map(r => r.id).join("; "), i.result?.evidence?.refs.map(r => r.id).join("; "), i.result?.grading?.ruleHash])];
								return new Response(`\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="eval-${id}.csv"` } });
							}
							return new Response(JSON.stringify({ ...run, summary: summarize(run.items), gradingSummary: gradingSummary(run.items), repeatReport: buildRepeatReport(run) }, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="eval-${id}.json"` } });
						}
						return json({ ...run, summary: summarize(run.items), gradingSummary: gradingSummary(run.items), repeatReport: buildRepeatReport(run) });
					}
				}
				return json({ error: "接口不存在" }, 404);
			} catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof TransferError ? error.status : 400); }
		},
	});
	return { server, store, queue };
}
if (import.meta.main) {
	const app = await createEvalServer();
	console.log(`Agent Eval → http://127.0.0.1:${app.server.port}\nData: ${app.store.directory}`);
}
