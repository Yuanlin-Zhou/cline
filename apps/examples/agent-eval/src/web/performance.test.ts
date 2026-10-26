import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvalStore } from "./store.js";
import { Projections } from "./projections.js";
import { RunViews } from "./run-views.js";
import { createEvalServer } from "./server.js";
import { parseEvalSuite } from "../schema.js";
import { summarize, type Run, type RunItem } from "./types.js";
const suite = parseEvalSuite({
	cases: [
		{ id: "large", prompt: "PRIVATE INPUT " + "x".repeat(200000), history: [] },
	],
});
const result = (i: RunItem) => ({
	id: i.snapshot.definition.id,
	status: "failed" as const,
	text: "PRIVATE OUTPUT",
	durationMs: 17,
	iterations: 1,
	usage: { inputTokens: 7, outputTokens: 3, totalCost: 0.2 },
	toolCalls: [],
	assertions: [{ passed: false, message: "expected absent" }],
});
async function temp(fn: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(path.join(tmpdir(), "eval-performance-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("legacy migration backs up consistent SQLite, preserves bodies, and rebuild preserves authoritative progress", async () =>
	temp(async (dir) => {
		const db = new Database(path.join(dir, "eval.sqlite"));
		db.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id))",
		);
		const put = (kind: string, id: string, data: unknown) =>
			db
				.query("INSERT INTO records VALUES(?,?,?)")
				.run(kind, id, JSON.stringify(data));
		put("settings", "default", suite.defaults);
		put("module", "m", {
			id: "m",
			name: "m",
			description: "",
			createdAt: new Date().toISOString(),
		});
		const c = {
			id: "c",
			moduleId: "m",
			revision: 1,
			updatedAt: new Date().toISOString(),
			definition: suite.cases[0],
			defaults: suite.defaults,
		};
		put("case", "c", c);
		put("run", "r", {
			id: "r",
			name: "legacy",
			status: "completed",
			concurrency: 1,
			createdAt: new Date().toISOString(),
		});
		const item: RunItem = {
			id: "i",
			runId: "r",
			snapshot: c,
			moduleName: "m",
			status: "failed",
			text: "",
			result: undefined,
		};
		item.result = result(item);
		put("item", "i", item);
		db.close();
		let store = new EvalStore(dir);
		expect(store.require<RunItem>("item", "i")).toEqual(item);
		expect(store.projections.cases()[0].definition).not.toHaveProperty(
			"prompt",
		);
		expect(store.summaries("r")[0].result?.text).toBe("");
		expect(
			(await readdir(dir)).filter((n) => n.startsWith("eval.pre-performance-")),
		).toHaveLength(1);
		const before = store.projections.epoch;
		const live = store.require<RunItem>("item", "i");
		live.text = "LATEST PROGRESS";
		live.phase = "judging";
		store.progress(live);
		expect(
			JSON.parse(
				(
					store.db
						.query("SELECT data FROM records WHERE kind='item' AND id='i'")
						.get() as any
				).data,
			).text,
		).toBe("");
		expect(store.require<RunItem>("item", "i").text).toBe("LATEST PROGRESS");
		store.db.close();
		const raw = new Database(path.join(dir, "eval.sqlite"));
		new Projections(raw, dir, true);
		raw.close();
		store = new EvalStore(dir);
		expect(store.projections.epoch).not.toBe(before);
		expect(store.require<RunItem>("item", "i").text).toBe("LATEST PROGRESS");
		expect(store.require<RunItem>("item", "i").snapshot.definition.prompt).toBe(
			c.definition.prompt,
		);
		store.db.close();
	}));

test("projection failure rolls back source records and revision; queries use batch and sequence indexes", async () =>
	temp(async (dir) => {
		const store = new EvalStore(dir);
		const m = store.activeModules()[0];
		store.db.exec(
			"CREATE TRIGGER reject_projection BEFORE INSERT ON case_summaries BEGIN SELECT RAISE(ABORT,'projection blocked'); END",
		);
		expect(() =>
			store.createCase(m.id, suite.defaults, suite.cases[0]),
		).toThrow("projection blocked");
		expect(store.activeCases()).toHaveLength(0);
		store.db.exec("DROP TRIGGER reject_projection");
		const c = store.createCase(m.id, suite.defaults, suite.cases[0]);
		const run = store.createRun({ caseIds: [c.id] });
		const views = new RunViews(store),
			first = views.overview(run.id);
		expect(new RunViews(store).changes(run.id, first.cursor)).toHaveProperty(
			"resync",
			true,
		);
		const item = store.items(run.id)[0];
		store.db.exec(
			"CREATE TRIGGER reject_state BEFORE UPDATE ON run_item_state BEGIN SELECT RAISE(ABORT,'state blocked'); END",
		);
		item.text = "not committed";
		expect(() => store.progress(item)).toThrow("state blocked");
		expect(views.overview(run.id).cursor).toBe(first.cursor);
		expect(store.require<RunItem>("item", item.id).text).toBe("");
		const plan = JSON.stringify(
			store.db
				.query(
					"EXPLAIN QUERY PLAN SELECT item_id FROM run_item_summaries WHERE run_id=? AND seq>?",
				)
				.all(run.id, 0),
		);
		expect(plan).toContain("items_changes");
		store.db.close();
	}));

test("metadata API avoids full inputs and unrelated history, cursor sync reconciles retries, and full exports remain intact", async () =>
	temp(async (dir) => {
		const app = await createEvalServer({
			directory: dir,
			port: 0,
			storage: "sqlite",
		});
		app.queue.kick = () => {};
		const { store } = app,
			origin = `http://127.0.0.1:${app.server.port}`,
			m = store.activeModules()[0];
		const c = store.createCase(m.id, suite.defaults, suite.cases[0]);
		const run = store.createRun({ caseIds: [c.id] });
		const item = store.items(run.id)[0];
		item.status = "failed";
		item.result = result(item);
		item.endedAt = new Date().toISOString();
		store.put("item", item.id, item);
		run.status = "completed";
		store.put("run", run.id, run);
		const fullItems = store.items.bind(store),
			activeCases = store.activeCases.bind(store),
			snapshot = app.catalog.snapshot.bind(app.catalog);
		store.items = () => {
			throw Error("hot path loaded body");
		};
		store.activeCases = () => {
			throw Error("hot path loaded cases");
		};
		app.catalog.snapshot = () => {
			throw Error("hot path loaded catalog");
		};
		const get = async (route: string) => {
			const response = await fetch(origin + route);
			expect(response.status).toBe(200);
			return response.json() as Promise<any>;
		};
		try {
			const cases = await get("/api/cases?view=summary");
			expect(cases.cases).toHaveLength(1);
			expect(JSON.stringify(cases)).not.toContain("PRIVATE INPUT");
			await get("/api/modules?view=summary");
			await get(`/api/runs/${run.id}/report?attemptMode=latest`);
			await get(`/api/cases/${c.id}/runs`);
			await get("/api/runs");
			const overview = await get(`/api/runs/${run.id}/overview`);
			expect(overview.summary).toEqual(summarize([item]));
			expect(overview.items[0].summary).toBe(true);
			expect(JSON.stringify(overview)).not.toContain("PRIVATE INPUT");
			expect(JSON.stringify(overview)).not.toContain("PRIVATE OUTPUT");
			const unchanged = await get(
				`/api/runs/${run.id}/changes?cursor=${encodeURIComponent(overview.cursor)}`,
			);
			expect(unchanged.items).toEqual([]);
			expect(JSON.stringify(unchanged).length).toBeLessThan(2000);
			expect(
				(await get(`/api/runs/${run.id}/changes?cursor=wrong`)).resync,
			).toBe(true);
			const preview = await get(`/api/runs/${run.id}/retry-preview`);
			expect(preview.items).toHaveLength(1);
			const response = await fetch(origin + `/api/runs/${run.id}/retry`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "once",
					expectedRetryRevision: 0,
					statuses: ["failed"],
				}),
			});
			expect(response.status).toBe(202);
			const change = await get(
				`/api/runs/${run.id}/changes?cursor=${encodeURIComponent(overview.cursor)}`,
			);
			expect(change.items).toHaveLength(1);
			expect(change.items[0].attempt).toBe(1);
			expect(change.summary.retryCount).toBe(1);
			expect(change.summary.tokens).toBe(10);
			const attempts = await get(
				`/api/runs/${run.id}/items/${change.items[0].id}/attempts`,
			);
			expect(attempts).toHaveLength(2);
			const detail = await get(`/api/runs/${run.id}/items/${item.id}`);
			expect(detail.result.text).toBe("PRIVATE OUTPUT");
			expect(detail.snapshot.definition.prompt).toContain("PRIVATE INPUT");
			const progress = await get(
				`/api/runs/${run.id}/items/${item.id}/progress`,
			);
			expect(progress.state).not.toHaveProperty("snapshot");
			expect(
				(
					await get(
						`/api/runs/${run.id}/items/${item.id}/progress?version=${progress.version}`,
					)
				).state,
			).toBeUndefined();
			store.items = fullItems;
			store.activeCases = activeCases;
			app.catalog.snapshot = snapshot;
			const exported = await get(`/api/runs/${run.id}/export?format=json`);
			expect(exported.items).toHaveLength(2);
			expect(exported.items[0].result.text).toBe("PRIVATE OUTPUT");
			expect(exported.items[1].snapshot.definition.prompt).toContain(
				"PRIVATE INPUT",
			);
		} finally {
			store.items = fullItems;
			store.activeCases = activeCases;
			app.catalog.snapshot = snapshot;
			await app.close();
		}
	}));

test("Mongo summary uses projection without full document parsing; selection returns intact source configuration", async () => {
	const { MongoCatalog } = await import("./mongo-catalog.js");
	const { caseToDocument, moduleToDocument } = await import(
		"./mongo-schema.js"
	);
	const c = {
		id: "c",
		moduleId: "m",
		revision: 1,
		updatedAt: new Date().toISOString(),
		defaults: suite.defaults,
		definition: { ...suite.cases[0], replayMode: "single-turn" as const },
	};
	const full = caseToDocument(c),
		module = moduleToDocument({
			id: "m",
			name: "m",
			description: "",
			createdAt: new Date().toISOString(),
		});
	let projection: any, filter: any;
	const session = {
		withTransaction: async (fn: () => unknown) => fn(),
		endSession: async () => {},
	};
	const cases = {
		find: (query: any, options: any) => {
			filter = query;
			projection = options.projection;
			return {
				sort: () => ({
					toArray: async () =>
						options.projection
							? [
									{
										...full,
										definition: {
											id: full.definition.id,
											replayMode: full.definition.replayMode,
										},
									},
								]
							: [full],
				}),
			};
		},
	};
	const modules = {
		find: () => ({ sort: () => ({ toArray: async () => [module] }) }),
	};
	const repository = new MongoCatalog(
		{ startSession: () => session } as any,
		{
			collection: (name: string) => (name === "cases" ? cases : modules),
		} as any,
		{
			uri: "unused",
			database: "d",
			caseCollection: "cases",
			moduleCollection: "modules",
		},
	);
	const summary = await repository.summaries();
	expect(summary.cases[0].definition).not.toHaveProperty("prompt");
	expect(projection["definition.id"]).toBe(1);
	expect(projection).not.toHaveProperty("definition.prompt");
	expect(filter.moduleId.$in).toEqual(["m"]);
	const selected = await repository.selected({ caseIds: ["c"] });
	expect(projection).toBeUndefined();
	expect(selected.cases[0].definition.prompt).toBe(c.definition.prompt);
	expect(filter.$or[0]._id.$in).toEqual(["c"]);
});

test("corrupt legacy data rolls migration back and can be repaired without losing the original records", async () =>
	temp(async (dir) => {
		const db = new Database(path.join(dir, "eval.sqlite"));
		db.exec(
			"CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id)); INSERT INTO records VALUES('case','broken','not-json')",
		);
		db.close();
		expect(() => new EvalStore(dir)).toThrow("迁移失败");
		const raw = new Database(path.join(dir, "eval.sqlite"));
		expect(
			(raw.query("SELECT data FROM records WHERE id='broken'").get() as any)
				.data,
		).toBe("not-json");
		expect(
			raw
				.query("SELECT name FROM sqlite_master WHERE name='eval_schema'")
				.get(),
		).toBeNull();
		raw.query("DELETE FROM records WHERE id='broken'").run();
		raw.close();
		const store = new EvalStore(dir);
		expect(store.projections.cases()).toEqual([]);
		store.db.close();
	}));

test("running service prevents concurrent startup and offline rebuild without changing its records", async () =>
	temp(async (directory) => {
		const { assertServiceStopped } = await import("./service-lock.js");
		const app = await createEvalServer({
			directory,
			port: 0,
			storage: "sqlite",
		});
		expect(() => assertServiceStopped(directory)).toThrow("运行中的评测服务");
		await expect(
			createEvalServer({ directory, port: 0, storage: "sqlite" }),
		).rejects.toThrow("运行中的评测服务");
		expect(app.store.activeModules()).toHaveLength(4);
		await app.close();
		expect(() => assertServiceStopped(directory)).not.toThrow();
		const reopened = await createEvalServer({
			directory,
			port: 0,
			storage: "sqlite",
		});
		await reopened.close();
	}));

test("selected item loader fetches input once, reconciles progress and completion races, and coalesces duplicate loads", async () =>
	temp(async (directory) => {
		const { itemLoader } = await import("./client/item-loader.js");
		const store = new EvalStore(directory),
			m = store.activeModules()[0],
			c = store.createCase(m.id, suite.defaults, suite.cases[0]),
			run = store.createRun({ caseIds: [c.id] });
		const item = store.items(run.id)[0];
		item.status = "running";
		store.progress(item);
		const initial = store.summaries(run.id)[0],
			full = { ...item };
		let gets = 0,
			progress = 0;
		const load = itemLoader(async <T>(url: string): Promise<T> => {
			if (url.includes("/progress")) {
				progress++;
				return {
					version: initial.detailVersion + 2,
					state: {
						status: "failed",
						text: "final preview",
						endedAt: "finished",
					},
				} as T;
			}
			gets++;
			await Bun.sleep(1);
			return structuredClone(full) as T;
		});
		const [a, b] = await Promise.all([
			load(run.id, initial),
			load(run.id, initial),
		]);
		expect(a).toEqual(b);
		expect(gets).toBe(1);
		expect(a.snapshot.definition.prompt).toContain("PRIVATE INPUT");
		const during = { ...initial, detailVersion: initial.detailVersion + 1 };
		expect((await load(run.id, during)).status).toBe("failed");
		expect(progress).toBe(1);
		full.result = result(item);
		full.status = "failed";
		full.endedAt = "finished";
		const completed = {
			...initial,
			status: "failed" as const,
			detailVersion: initial.detailVersion + 2,
			result: full.result,
		};
		expect((await load(run.id, completed)).result?.text).toBe("PRIVATE OUTPUT");
		expect(gets).toBe(2);
		await load(run.id, completed);
		expect(gets).toBe(2);
		store.db.close();
	}));

test("missing summary is reported instead of hiding source records; offline rebuild restores it", async () =>
	temp(async (directory) => {
		let store = new EvalStore(directory);
		const c = store.createCase(
			store.activeModules()[0].id,
			suite.defaults,
			suite.cases[0],
		);
		store.db.query("DELETE FROM case_summaries WHERE case_id=?").run(c.id);
		store.db.close();
		expect(() => new EvalStore(directory)).toThrow("本地摘要与原记录不一致");
		const db = new Database(path.join(directory, "eval.sqlite"));
		new Projections(db, directory, true);
		db.close();
		store = new EvalStore(directory);
		expect(store.projections.cases()[0].id).toBe(c.id);
		expect(store.require<any>("case", c.id).definition.prompt).toBe(
			c.definition.prompt,
		);
		store.db.close();
	}));
