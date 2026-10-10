import { randomUUID } from "node:crypto";
import { CatalogError, SqliteCatalog, type CatalogRepository } from "./catalog.js";
import { MongoCatalog, mongoConfig, type MongoConfig } from "./mongo-catalog.js";
import { TransferError } from "./transfer.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvalSuite } from "../schema.js";
import { EvalStore, type RunSource } from "./store.js";
import { EvalQueue, type Executor } from "./queue.js";
import { summarize, type Module, type Run, type RunItem, type SavedCase } from "./types.js";
import { artifacts, artifactText } from "./workspace.js";
import { buildRepeatReport, repeatReportMarkdown } from "./repeat-report.js";
import { loadVerifiers, publicVerifier, resolveVerifiers, uploadedPlaceholder } from "../grading/verifiers.js";
import { MongoVerifiers, SqliteVerifiers, publicUploaded, type VerifierRepository } from "../grading/uploaded-verifiers.js";
import { preflight } from "../grading/engine.js";
import { CAPABILITIES, readEvidence } from "../grading/evidence.js";
import { gradingSummary } from "../grading/summary.js";
import { readConversation } from "./conversation.js";
import { preparePythonUpload, pythonRuntimeStatus, pythonEnvironment, validatePythonSource } from "../grading/python-runtime.js";
import { parseUpload } from "../grading/uploaded-verifiers.js";
import { frozenValidationInput, historicalEvidence } from "../grading/validation-context.js";
import { parseGrading } from "../grading/schema.js";
import { VerifierTests } from "./verifier-tests.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const client = fileURLToPath(new URL("client/", import.meta.url));
const json = (data: unknown, status = 200) => Response.json(data, { status });
const csvCell = (value: unknown) => `"${String(value ?? "").replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;

export async function createEvalServer(options: { directory?: string; port?: number; execute?: Executor; storage?: "sqlite" | "mongodb"; mongo?: MongoConfig; catalog?: CatalogRepository; verifierRepository?: VerifierRepository } = {}) {
	const storage = options.storage ?? (options.mongo ? "mongodb" : process.env.EVAL_CASE_STORAGE ?? "sqlite");
	if (!["sqlite", "mongodb"].includes(storage)) throw new CatalogError("EVAL_CASE_STORAGE 须为 sqlite 或 mongodb");
	const connected = options.catalog ?? (storage === "mongodb" ? await MongoCatalog.connect(options.mongo ?? mongoConfig()) : undefined);
	let store: EvalStore;
	try { store = new EvalStore(path.resolve(options.directory ?? process.env.EVAL_DATA_DIR ?? path.join(root, ".eval-data")), { seedModules: storage !== "mongodb" }); }
	catch (error) { await connected?.close(); throw error; }
	const catalog = connected ?? new SqliteCatalog(store);
	try {
	const queue = new EvalQueue(store, options.execute);
	const verifierTests = new VerifierTests(store);
	const verifierRepository = options.verifierRepository ?? (catalog instanceof MongoCatalog ? new MongoVerifiers(catalog.db, catalog.config.verifierCollection ?? "agent_eval_verifiers") : new SqliteVerifiers(store));
	if (verifierRepository instanceof MongoVerifiers) await verifierRepository.preflight();
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
					const { cases, modules } = await catalog.snapshot();
					const activeIds = new Set(cases.map(c => c.id));
					const latest = Object.fromEntries(allItems.filter(i => activeIds.has(i.snapshot.id) && !["queued", "running", "cancelled"].includes(i.status)).map(i => [i.snapshot.id, { status: i.status, runId: i.runId, revision: i.snapshot.revision, modelId: i.snapshot.defaults.modelId, sessionId: i.result?.sessionId, durationMs: i.result?.durationMs, endedAt: i.endedAt }]));
					return json({ modules, cases, settings: store.settings(), runs: store.list<Run>("run").reverse().map(run => ({ ...run, summary: summarize(allItems.filter(i => i.runId === run.id)) })), latest });
				}
				if (route === "/api/verifiers" && method === "GET") {
					const configured = await loadVerifiers(); const uploaded = await verifierRepository.list();
					if (uploaded.some(v => configured.some(c => c.id === v.id))) throw new CatalogError("验证器 ID 冲突", 409);
					return json({ verifiers: [...configured.map(publicVerifier), ...uploaded.map(publicUploaded)], capabilities: CAPABILITIES });
				}
				if (route === "/api/verifiers/runtime-status" && method === "GET") return json(await pythonRuntimeStatus());
				if (route === "/api/verifiers" && method === "POST") {
					const body = await request.json(); const parsed = parseUpload(body); const runtime = parsed.extension === ".py" ? await pythonRuntimeStatus() : undefined;
					if (runtime?.ready) await validatePythonSource(parsed.content, await pythonEnvironment());
					return json({ ...publicUploaded(await verifierRepository.create(body)), syntaxStatus: parsed.extension === ".py" ? runtime?.ready ? "checked" : "pending" : "not_applicable" }, 201);
				}
				const validationMatch = route.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/(validation-input|verifier-tests)(?:\/([^/]+))?(?:\/(cancel|evidence)(?:\/([^/]+))?)?$/);
				if (validationMatch) {
					const [, runId, itemId, kind, testId, action, evidenceId] = validationMatch;
					const item = store.get<RunItem>("item", itemId);
					if (!item || item.runId !== runId) return json({ error: "执行记录不存在" }, 404);
					const directory = path.join(store.directory, "runs", runId, itemId);
					if (kind === "validation-input" && method === "GET") {
						if (["queued", "running"].includes(item.status)) throw new Error("执行尚未结束，请等待冻结验证输入");
						const value = await frozenValidationInput(directory, await historicalEvidence(directory, item));
						if (url.searchParams.has("download")) return new Response(JSON.stringify(value.context, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="validation-input-${item.id}.json"` } });
						const preview = JSON.stringify(value.context, null, 2); return json({ text: preview.slice(0, 200000), truncated: preview.length > 200000, sha256: value.sha256 });
					}
					if (kind === "verifier-tests" && !testId && method === "POST") {
						const body = await request.json(); const rule = parseGrading({ version: 1, rules: [{ id: "python-test", kind: "script", verifierId: body.verifierId, params: body.params, required_inputs: body.required_inputs, require_complete: body.require_complete }] })!.rules[0] as Extract<import("../grading/types.js").Rule, { kind: "script" }>;
						if (Object.keys(body).some(k => !["verifierId", "params", "required_inputs", "require_complete"].includes(k))) throw new Error("试验证参数包含未知字段");
						const v = item.verifierSnapshots?.find(v => v.id === body.verifierId) ?? await verifierRepository.get(body.verifierId); if (!v) return json({ error: "脚本不存在" }, 404);
						return json(await verifierTests.create(item, v, rule), 202);
					}
					if (kind === "verifier-tests" && testId) {
						const test = verifierTests.get(testId, runId, itemId); if (!test) return json({ error: "试验证记录不存在" }, 404);
						if (action === "cancel" && method === "POST") { verifierTests.cancel(testId); return json({ status: "cancelling" }); }
						if (action === "evidence" && method === "GET") {
							const ref = test.evidence.refs.find(r => r.id === evidenceId); if (!ref) return json({ error: "试验证证据不存在" }, 404);
							return json({ text: (await readEvidence(directory, ref, 4 * 1024 * 1024)).toString("utf8") });
						}
						if (!action && method === "GET") return json(test);
					}
				}
				const conversationMatch = route.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/conversation$/);
				if (conversationMatch && method === "GET") {
					const [, runId, itemId] = conversationMatch;
					const item = store.detail(runId).items.find(i => i.id === itemId);
					if (!item) return json({ error: "执行记录不存在" }, 404);
					const offset = Number(url.searchParams.get("offset") ?? 0); const limit = Number(url.searchParams.get("limit") ?? 50);
					if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: "会话分页参数无效" }, 400);
					const configured = await loadVerifiers();
					const secrets = [item.snapshot.defaults.apiKeyEnv, ...configured.flatMap(v => v.env)].filter((key): key is string => Boolean(key)).map(key => process.env[key] ?? "");
					const conversation = await readConversation(path.join(store.directory, "runs", runId, itemId), item, { offset, limit, download: url.searchParams.has("download"), secrets });
					if (url.searchParams.has("download")) return new Response(JSON.stringify(conversation, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="conversation-${item.id}.json"` } });
					return json(conversation);
				}
				const evidenceMatch = route.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/(grading|evidence)(?:\/([^/]+))?$/);
				if (evidenceMatch && method === "GET") {
					const [, runId, itemId, kind, evidenceId] = evidenceMatch;
					const item = store.detail(runId).items.find(i => i.id === itemId);
					if (!item?.result?.grading) return json({ error: "判分记录不存在" }, 404);
					if (kind === "grading") return json(item.result.grading);
					const ref = item.result.evidence?.refs.find(r => r.id === evidenceId);
					if (!ref) return json({ error: "证据不存在" }, 404);
					const bytes = await readEvidence(path.join(store.directory, "runs", runId, itemId), ref, 4 * 1024 * 1024);
					return json({ id: ref.id, label: ref.label, text: bytes.includes(0) ? "二进制文件，无法文本预览" : bytes.toString("utf8"), sha256: ref.sha256 });
				}
				if (route === "/api/modules" && method === "POST") { const body = await request.json(); return json(await catalog.createModule(body.name, body.description, body.tags), 201); }
				if (route === "/api/modules" && method === "GET") return json((await catalog.snapshot()).modules);

				const moduleMatch = route.match(/^\/api\/modules\/([^/]+)(?:\/(archive|unarchive))?$/);
				if (moduleMatch) {
					const [, id, action] = moduleMatch;
					if (method === "GET" && !action) { const module = await catalog.getModule(id); if (!module) throw new CatalogError("模块不存在", 404); return json(module); }
					if (action === "archive" && method === "POST") { await catalog.archiveModule(id); return json({ archived: true }); }
					if (action === "unarchive" && method === "POST") { await catalog.setArchived("module", id, false); return json({ archived: false }); }
					if (method === "PUT") return json(await catalog.updateModule(id, await request.json()));
					return json({ error: "接口不存在" }, 404);
				}
				if (route === "/api/settings" && method === "PUT") {
					const body = await request.json(); const settings = parseEvalSuite({ defaults: body, cases: [{ id: "settings", prompt: "settings" }] }).defaults;
					if (settings.cwd && !path.isAbsolute(settings.cwd)) throw new Error("网页 fixture 目录须填写绝对路径");
					store.put("settings", "default", settings); return json(settings);
				}
				if (["/api/import/preview", "/api/import"].includes(route) && method === "POST") {
					const body = await request.json();
					if (!await catalog.getModule(body.moduleId)) throw new CatalogError("模块不存在", 404);
					if (typeof body.content !== "string") throw new Error("缺少导入内容");
					const suite = store.parseImport(body.content, body.format, body.replayMode);
					for (const cwd of [suite.defaults.cwd, ...suite.cases.map(c => c.cwd)]) if (cwd && !path.isAbsolute(cwd)) throw new Error("上传文件的相对 cwd 无法确定，请改为服务端 fixture 绝对路径或删除 cwd 使用空工作区");
					if (route.endsWith("preview")) { const existing = (await catalog.snapshot()).cases.filter(c => c.moduleId === body.moduleId); return json({ suite, cases: suite.cases.map(c => ({ id: c.id, description: c.description, replayMode: c.replayMode, duplicate: existing.some(e => e.definition.id === c.id) })) }); }
					return json(await catalog.importCases(body.moduleId, suite, body.policy));
				}
				if (route === "/api/cases" && method === "POST") {
					const body = await request.json();
					if (!body.moduleId) throw new Error("缺少目标模块");
					const suite = parseEvalSuite({ defaults: body.defaults, cases: [body.definition] });
					for (const cwd of [suite.defaults.cwd, suite.cases[0].cwd]) if (cwd && !path.isAbsolute(cwd)) throw new Error("fixture 目录须为绝对路径");
					return json(await catalog.createCase(body.moduleId, suite.defaults, suite.cases[0]), 201);
				}
				if (route === "/api/cases/transfer/preview" && request.method === "POST") return json(await catalog.previewTransfer(await request.json()));
				if (route === "/api/cases/transfer" && request.method === "POST") return json(await catalog.transferCases(await request.json()));

				const caseActionMatch = route.match(/^\/api\/cases\/([^/]+)\/(duplicate|archive|unarchive)$/);
				if (caseActionMatch && method === "POST") {
					const [, id, action] = caseActionMatch;
					if (action === "duplicate") return json(await catalog.duplicateCase(id), 201);
					if (action === "archive") { await catalog.setArchived("case", id, true); return json({ archived: true }); }
					await catalog.setArchived("case", id, false); return json({ archived: false });
				}
				const caseRunsMatch = route.match(/^\/api\/cases\/([^/]+)\/runs$/);
				if (caseRunsMatch && method === "GET") {
					const targetId = caseRunsMatch[1];
					const allItems = store.list<RunItem>("item");
					if (!allItems.some(i => i.snapshot.id === targetId) && !await catalog.getCase(targetId)) throw new CatalogError("案例不存在或已删除", 404);
					return json(store.list<Run>("run").reverse().map(run => {
						const items = allItems.filter(i => i.runId === run.id && i.snapshot.id === targetId);
						return { ...run, summary: summarize(items), items: items.map(i => ({ id: i.id, round: i.round ?? 1, status: i.status, revision: i.snapshot.revision, modelId: i.snapshot.defaults.modelId, sessionId: i.result?.sessionId, durationMs: i.result?.durationMs, endedAt: i.endedAt })) };
					}).filter(run => run.items.length > 0));
				}
				const caseMatch = route.match(/^\/api\/cases\/([^/]+)$/);
				if (caseMatch && method === "GET") {
					const item = await catalog.getCase(caseMatch[1]); if (!item) throw new CatalogError("案例不存在或已删除", 404);
					return json(item);
				}
				if (caseMatch && method === "DELETE") {
					if (!await catalog.getCase(caseMatch[1])) return json({ error: "案例不存在或已删除" }, 404);
					await catalog.deleteCase(caseMatch[1]); return json({ deleted: true });
				}
				if (caseMatch && method === "PUT") {
					const body = await request.json();
					const suite = parseEvalSuite({ defaults: body.defaults, cases: [body.definition] });
					for (const cwd of [suite.defaults.cwd, suite.cases[0].cwd]) if (cwd && !path.isAbsolute(cwd)) throw new Error("fixture 目录须为绝对路径");
					return json(await catalog.updateCase(caseMatch[1], body.revision, suite.defaults, suite.cases[0]));
				}
				if (route === "/api/runs" && method === "GET") {
					const items = store.list<RunItem>("item");
					return json(store.list<Run>("run").reverse().map(run => ({ ...run, summary: summarize(items.filter(i => i.runId === run.id)) })));
				}
				if (route === "/api/settings" && method === "GET") return json(store.settings());

				if (route === "/api/runs" && method === "POST") {
					const body = await request.json();
					if (body.defaults) {
						const parsed = parseEvalSuite({ defaults: body.defaults, cases: [{ id: "run-defaults", prompt: "run-defaults" }] }).defaults;
						if (parsed.cwd && !path.isAbsolute(parsed.cwd)) throw new Error("fixture 目录须为绝对路径");
					}
					if (Array.isArray(body.draft)) for (const draft of body.draft) {
						const module = await catalog.getModule(draft.moduleId);
						if (!module || module.archived) throw new CatalogError("草稿目标模块不存在或已归档", 409);
						const suite = parseEvalSuite({ defaults: draft.defaults, cases: [draft.definition] });
						for (const cwd of [suite.defaults.cwd, suite.cases[0].cwd]) if (cwd && !path.isAbsolute(cwd)) throw new Error("fixture 目录须为绝对路径");
						draft.definition = suite.cases[0]; draft.defaults = suite.defaults;
					}
					let sources: RunSource[] | undefined;
					if (body.draft?.length) {
						sources = [];
						for (const draft of body.draft) {
							const module = await catalog.getModule(draft.moduleId);
							if (!module || module.archived) throw new CatalogError("草稿目标模块不存在或已归档", 409);
							sources.push({ snapshot: { id: randomUUID(), moduleId: draft.moduleId, revision: 0, definition: draft.definition, defaults: draft.defaults, updatedAt: new Date().toISOString() }, moduleName: module.name });
						}
					} else if (!body.parentRunId) {
						const snapshot = await catalog.snapshot();
						if (body.caseIds?.some((id: string) => !snapshot.cases.some(c => c.id === id)) || body.moduleIds?.some((id: string) => !snapshot.modules.some(m => m.id === id))) throw new CatalogError("选中的案例或模块不存在或已归档", 404);
						sources = snapshot.cases.filter(c => body.caseIds?.includes(c.id) || body.moduleIds?.includes(c.moduleId)).map(c => ({ snapshot: c, moduleName: snapshot.modules.find(m => m.id === c.moduleId)!.name }));
					}
					if (!sources && body.parentRunId) {
						const items = store.detail(body.parentRunId).items.filter(i => body.rerunScope === "all" || ["failed", "error", "cancelled", "inconclusive"].includes(i.status));
						sources = [...new Map(items.map(i => [i.snapshot.id, { snapshot: i.snapshot, moduleName: i.moduleName, verifierSnapshots: i.verifierSnapshots }])).values()];
					}
					const prepared = [];
					for (const source of sources ?? []) {
						const definition = parseEvalSuite({ defaults: source.snapshot.defaults, cases: [{ ...source.snapshot.definition, ...(body.replayMode ? { replayMode: body.replayMode } : {}) }] }).cases[0];
						const frozen = body.parentRunId ? source.verifierSnapshots ?? [] : undefined;
						const resolved = await resolveVerifiers(definition, frozen === undefined ? verifierRepository : undefined, frozen);
						resolved.uploaded = await Promise.all(resolved.uploaded.map(v => preparePythonUpload(v)));
						preflight(definition, [...resolved.configured, ...resolved.uploaded.map(uploadedPlaceholder)]);
						prepared.push({ ...source, verifierSnapshots: resolved.uploaded });
					}
					const run = store.createRun(body, prepared); queue.kick(); return json(run, 202);
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
			} catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof TransferError || error instanceof CatalogError ? error.status : 400); }
		},
	});
	let closing: Promise<void> | undefined;
	const close = () => closing ??= (async () => {
		for (const run of store.list<Run>("run")) if (["queued", "running"].includes(run.status)) queue.cancel(run.id);
		await server.stop(true); await queue.idle(); await verifierTests.close(); await catalog.close(); store.db.close();
	})();
	return { server, store, queue, catalog, close };
	} catch (error) { await catalog.close(); store.db.close(); throw error; }
}
if (import.meta.main) {
	const app = await createEvalServer();
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
	console.log(`Agent Eval → http://127.0.0.1:${app.server.port}\nData: ${app.store.directory}`);
}
