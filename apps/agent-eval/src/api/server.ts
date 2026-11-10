import path from "node:path";
import { type Run } from "../contracts/catalog.js";
import { defaultDataDirectory } from "../infrastructure/filesystem/paths.js";
import { acquireServiceLock } from "../infrastructure/filesystem/service-lock.js";
import {
	MongoCatalog,
	mongoConfig,
	type MongoConfig,
} from "../infrastructure/mongodb/catalog.js";
import { SqliteCatalog } from "../infrastructure/sqlite/catalog.js";
import { EvalStore } from "../infrastructure/sqlite/store.js";
import { BATCH_BYTE_LIMIT } from "../modules/catalog/batch-conversations.js";
import {
	CatalogError,
	type CatalogRepository,
} from "../modules/catalog/repository.js";
import { settingsRoutes } from "./routes/settings.js";

import { MongoVerifiers } from "../infrastructure/mongodb/verifiers.js";
import { SqliteVerifiers } from "../infrastructure/sqlite/verifiers.js";
import { TransferError } from "../modules/catalog/transfer.js";
import { type VerifierRepository } from "../modules/grading/uploaded-verifiers.js";

import { VerifierTests } from "../modules/grading/verifier-tests.js";
import { JudgeScores } from "../modules/judging/scores.js";
import { RunViews } from "../modules/runs/queries.js";
import { EvalQueue, type Executor } from "../modules/runs/queue.js";
import { json } from "./http/helpers.js";
import { staticResponse, webDirectory } from "./http/static.js";
import { catalogRoutes } from "./routes/catalog.js";
import { evidenceRoutes } from "./routes/evidence.js";
import { judgingRoutes } from "./routes/judging.js";
import { runsRoutes } from "./routes/runs.js";
import { verifiersRoutes } from "./routes/verifiers.js";
import { viewsRoutes } from "./routes/views.js";

export async function createEvalServer(
	options: {
		directory?: string;
		port?: number;
		execute?: Executor;
		storage?: "sqlite" | "mongodb";
		mongo?: MongoConfig;
		catalog?: CatalogRepository;
		verifierRepository?: VerifierRepository;
	} = {},
) {
	const storage =
		options.storage ??
		(options.mongo ? "mongodb" : (process.env.EVAL_CASE_STORAGE ?? "sqlite"));
	if (!["sqlite", "mongodb"].includes(storage))
		throw new CatalogError("EVAL_CASE_STORAGE 须为 sqlite 或 mongodb");
	const connected =
		options.catalog ??
		(storage === "mongodb"
			? await MongoCatalog.connect(options.mongo ?? mongoConfig())
			: undefined);
	const directory = path.resolve(
		options.directory ?? process.env.EVAL_DATA_DIR ?? defaultDataDirectory(),
	);
	let release: () => void;
	try {
		release = acquireServiceLock(directory);
	} catch (error) {
		await connected?.close();
		throw error;
	}
	let store: EvalStore;
	try {
		store = new EvalStore(directory, { seedModules: storage !== "mongodb" });
	} catch (error) {
		release();
		await connected?.close();
		throw error;
	}
	const catalog = connected ?? new SqliteCatalog(store);
	try {
		const queue = new EvalQueue(store, options.execute);
		const views = new RunViews(store);
		const verifierTests = new VerifierTests(store);
		const judgeScores = new JudgeScores(store);
		const verifierRepository =
			options.verifierRepository ??
			(catalog instanceof MongoCatalog
				? new MongoVerifiers(
						catalog.db,
						catalog.config.verifierCollection ?? "agent_eval_verifiers",
					)
				: new SqliteVerifiers(store));
		if (verifierRepository instanceof MongoVerifiers)
			await verifierRepository.preflight();
		const context = {
			store,
			catalog,
			queue,
			views,
			verifierRepository,
			verifierTests,
			judgeScores,
		};
		const routes = [
			settingsRoutes(context),
			catalogRoutes(context),
			viewsRoutes(context),
			judgingRoutes(context),
			verifiersRoutes(context),
			evidenceRoutes(context),
			runsRoutes(context),
		];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: options.port ?? Number(process.env.EVAL_PORT ?? 3130),
			maxRequestBodySize: BATCH_BYTE_LIMIT,
			async fetch(request) {
				const url = new URL(request.url);
				if (!["127.0.0.1", "localhost"].includes(url.hostname))
					return json({ error: "仅支持本机访问" }, 403);
				const origin = request.headers.get("origin");
				if (origin && origin !== url.origin)
					return json({ error: "不允许跨站请求" }, 403);
				if (request.headers.get("sec-fetch-site") === "cross-site")
					return json({ error: "不允许跨站请求" }, 403);
				try {
					const route = url.pathname;
					const method = request.method;
					if (!route.startsWith("/api/")) return staticResponse(request, url);
					if (
						method !== "GET" &&
						!request.headers.get("content-type")?.startsWith("application/json")
					)
						return json({ error: "请求须为 application/json" }, 415);
					for (const routeHandler of routes) {
						const response = await routeHandler(request, url);
						if (response) return response;
					}
					return json({ error: "接口不存在" }, 404);
				} catch (error) {
					const status =
						error instanceof TransferError || error instanceof CatalogError
							? error.status
							: 400;
					const response = json(
						{ error: error instanceof Error ? error.message : String(error) },
						status,
					);
					// A rejected body may still be arriving; never reuse that HTTP connection.
					if (status === 413) response.headers.set("Connection", "close");
					return response;
				}
			},
		});
		let closing: Promise<void> | undefined;
		const close = () =>
			(closing ??= (async () => {
				for (const run of store.list<Run>("run"))
					if (["queued", "running"].includes(run.status)) queue.cancel(run.id);
				await server.stop(true);
				await queue.idle();
				await verifierTests.close();
				await judgeScores.close();
				await catalog.close();
				store.db.close();
				release();
			})());
		return { server, store, queue, catalog, close };
	} catch (error) {
		await catalog.close();
		store.db.close();
		release();
		throw error;
	}
}
if (import.meta.main) {
	if (!(await Bun.file(path.join(webDirectory, "index.html")).exists()))
		throw Error("前端资源不存在，请先运行 bun run build:web。");
	const app = await createEvalServer();
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			void app.close().then(() => process.exit(0));
		});
	console.log(
		`Agent Eval → http://127.0.0.1:${app.server.port}\nData: ${app.store.directory}`,
	);
}
