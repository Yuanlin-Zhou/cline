import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MongoVerifiers } from "../grading/uploaded-verifiers.js";
import { replyTemplate } from "../grading/verifier-guide.js";
import { MongoClient } from "mongodb";
import { MongoCatalog, mongoFailure, type MongoConfig } from "./mongo-catalog.js";
import { prepareMongoCollections, caseToDocument } from "./mongo-schema.js";
import { EvalStore } from "./store.js";
import { createEvalServer } from "./server.js";
import { migrateSqliteCatalog } from "./mongo/migrate.js";
import type { SavedCase, Module } from "./types.js";

const uri = process.env.EVAL_TEST_MONGODB_URI;
const mongoTest = uri ? test : test.skip;
describe("MongoDB replica-set catalog (set EVAL_TEST_MONGODB_URI)", () => {
	let repository: MongoCatalog; let config: MongoConfig; let directory: string; let defaults: ReturnType<EvalStore["settings"]>;
	beforeEach(async () => {
		if (!uri) return;
		config = { uri, database: `eval_test_${randomUUID().replaceAll("-", "")}`, caseCollection: "cases", moduleCollection: "modules" };
		repository = await MongoCatalog.connect(config, false);
		await prepareMongoCollections(repository.db, config.caseCollection, config.moduleCollection); await repository.preflight();
		directory = mkdtempSync(path.join(os.tmpdir(), "eval-mongo-test-"));
		const store = new EvalStore(directory); defaults = store.settings(); store.db.close();
	});
	afterEach(async () => {
		if (!uri) return;
		const cleanup = new MongoClient(uri); await cleanup.connect();
		try {
			await cleanup.db("admin").command({ configureFailPoint: "failCommand", mode: "off" }).catch(() => {});
			await cleanup.db(config.database).dropDatabase();
		} finally { await cleanup.close(); await repository.close(); rmSync(directory, { recursive: true, force: true }); }
	});
	mongoTest("uploaded scripts persist in Mongo and snapshots rerun after the connection closes", async () => {
		const scripts = new MongoVerifiers(repository.db, "agent_eval_verifiers"); await scripts.preflight();
		const python = await scripts.create({ filename: "verify.py", content: 'def verify(ctx):\n    return {"verdict": "pass", "message": "ok"}\n' });
		expect((await new MongoVerifiers(repository.db, "agent_eval_verifiers").get(python.id))?.runtime).toBe("python");
		expect(python.contractVersion).toBe(2);
		const upload = await scripts.create({ filename: "verify.mjs", content: replyTemplate });
		const module = await repository.createModule("scripts");
		const c = await repository.createCase(module.id, defaults, { id: "script-case", prompt: "task", history: [], replayMode: "full-task", grading: { version: 1, rules: [{ id: "accept", kind: "script", verifierId: upload.id }] } });
		const app = await createEvalServer({ directory, port: 0, storage: "mongodb", catalog: repository, execute: async item => ({ id: c.id, sessionId: item.id, text: "已完成", status: "passed", durationMs: 1, iterations: 1, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], assertions: [] }) });
		const post = async (body: unknown) => { const res = await fetch(`http://127.0.0.1:${app.server.port}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, value: await res.json() }; };
		try {
			const run = await post({ caseIds: [c.id] }); expect(run.status).toBe(202); await app.queue.idle();
			expect(app.store.items(run.value.id)[0].verifierSnapshots?.[0].content).toBe(replyTemplate);
			expect(await new MongoVerifiers(repository.db, "agent_eval_verifiers").get(upload.id)).toEqual(upload);
			await repository.close();
			const rerun = await post({ parentRunId: run.value.id, rerunScope: "all" }); expect(rerun.status).toBe(202); await app.queue.idle();
			expect(app.store.items(rerun.value.id)[0].verifierSnapshots?.[0].sha256).toBe(upload.sha256);
			expect((await post({ caseIds: [c.id] })).status).toBe(503);
		} finally { await app.close(); }
	});
	const seed = (module: Module, name = "a", mode: "single-turn" | "full-task" = "single-turn") => repository.createCase(module.id, defaults, { id: name, prompt: "hello", history: [{ role: "user", content: "Bun" }], replayMode: mode, tags: ["comma,tag"], headersEnv: { authorization: "AUTH" } });
	async function transfer(operation: "copy" | "move", target: Module, cases: SavedCase[], policy = "rename") {
		const request = { operation, targetModuleId: target.id, conflictPolicy: policy, items: cases.map(c => ({ id: c.id, revision: c.revision })) };
		const preview = await repository.previewTransfer(request);
		return repository.transferCases({ ...request, items: preview.items.map(i => ({ id: i.id, revision: i.revision, expectedDefinitionId: i.proposedDefinitionId })) });
	}
	mongoTest("external documents appear live, metadata survives edits and concurrent revision checks", async () => {
		const module = await repository.createModule("external"); const time = new Date().toISOString();
		const doc = caseToDocument({ id: randomUUID(), moduleId: module.id, revision: 1, updatedAt: time, defaults, definition: { id: "external", replayMode: "single-turn", prompt: "from generator", history: [] } });
		doc.provenance = { source: "generator", sourceId: "42" }; await repository.cases.insertOne(doc);
		expect((await repository.snapshot()).cases[0].definition.prompt).toBe("from generator");
		const results = await Promise.allSettled([repository.updateCase(doc._id, 1, defaults, { ...doc.definition, prompt: "edited one" }), repository.updateCase(doc._id, 1, defaults, { ...doc.definition, prompt: "edited two" })]);
		expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
		expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.status).toBe(409);
		expect((await repository.getCase(doc._id))!.revision).toBe(2);
		expect((await repository.cases.findOne({ _id: doc._id }))!.provenance).toEqual(doc.provenance);
		const item = (await repository.getCase(doc._id))!;
		await repository.updateCase(item.id, item.revision, item.defaults, { ...item.definition, replayMode: "full-task" });
		expect((await repository.getCase(doc._id))!.definition.replayMode).toBe("full-task");
	});
	mongoTest("mixed-mode transfers reserve names, detect stale previews, keep no-op revisions and roll back", async () => {
		const a = await repository.createModule("a"); const b = await repository.createModule("b"); const target = await repository.createModule("target");
		const sources = [await seed(a), await seed(b, "a", "full-task")];
		expect((await transfer("copy", target, sources)).cases.map(c => c.definition.id)).toEqual(["a", "a-copy1"]);
		const first = (await transfer("move", target, [sources[0]])).cases[0]; expect(first.definition.id).toBe("a-move1"); expect(first.revision).toBe(2);
		expect((await transfer("move", target, [first])).unchanged).toBe(1);
		expect((await repository.getCase(first.id))!.revision).toBe(2);
		expect((await transfer("copy", b, [sources[1]], "abort")).cases[0].definition.id).toBe("a-copy1");
		const request = { operation: "move", targetModuleId: a.id, conflictPolicy: "rename", items: [{ id: sources[1].id, revision: 1, expectedDefinitionId: "a" }] };
		await seed(a); await expect(repository.transferCases(request)).rejects.toThrow("预览"); expect((await repository.getCase(sources[1].id))!.moduleId).toBe(b.id);
		const count = await repository.cases.countDocuments();
		// Second insert fails after the first insert in the same transaction succeeded.
		await repository.db.admin().command({ configureFailPoint: "failCommand", mode: { skip: 1 }, data: { failCommands: ["insert"], errorCode: 2 } });
		await expect(transfer("copy", target, [first, sources[1]])).rejects.toMatchObject({ status: 503 });
		await repository.db.admin().command({ configureFailPoint: "failCommand", mode: "off" });
		expect(await repository.cases.countDocuments()).toBe(count);
	});
	mongoTest("commit retry produces one copy; module archive serializes against transfer and restores only module", async () => {
		const source = await repository.createModule("source"); const target = await repository.createModule("target"); const c = await seed(source);
		await repository.db.admin().command({ configureFailPoint: "failCommand", mode: { times: 1 }, data: { failCommands: ["commitTransaction"], closeConnection: true } });
		expect((await transfer("copy", target, [c])).copied).toBe(1);
		expect(await repository.cases.countDocuments({ moduleId: target.id })).toBe(1);
		const results = await Promise.allSettled([transfer("move", target, [c]), repository.archiveModule(source.id)]);
		expect(results[1].status).toBe("fulfilled");
		const item = (await repository.getCase(c.id))!;
		if (results[0].status === "fulfilled") { expect(item.moduleId).toBe(target.id); expect(item.archived).toBe(false); }
		else { expect(item.moduleId).toBe(source.id); expect(item.archived).toBe(true); }
		await repository.setArchived("module", source.id, false);
		const archived = await seed(source, "archive-test"); await repository.archiveModule(source.id); await repository.setArchived("module", source.id, false);
		expect((await repository.getCase(archived.id))!.archived).toBe(true);
	});
	mongoTest("unique indexes, invalid external documents and preflight enforce the contract", async () => {
		const module = await repository.createModule("unique"); const c = await seed(module);
		await expect(seed(module)).rejects.toMatchObject({ status: 409 });
		await expect(repository.createModule(" UNIQUE ")).rejects.toMatchObject({ status: 409 });
		await repository.setArchived("case", c.id, true); await seed(module);
		await expect(repository.setArchived("case", c.id, false)).rejects.toMatchObject({ status: 409 });
		const doc = (await repository.cases.findOne({ _id: c.id }))!;
		await expect(repository.cases.insertOne({ ...doc, _id: randomUUID(), archived: false, definition: { ...doc.definition, id: "bad", history: [{ role: "user", content: "" }] } })).rejects.toMatchObject({ code: 121 });
		await repository.cases.updateOne({ _id: c.id }, { $set: { schemaVersion: 2 as 1 } }, { bypassDocumentValidation: true });
		await expect(repository.snapshot()).rejects.toMatchObject({ status: 422 });
		await repository.cases.dropIndex("active_module_case_unique"); await expect(repository.preflight()).rejects.toThrow("索引");
	});
	mongoTest("migration is read-only, atomic, repeatable and reports conflicting existing documents", async () => {
		const store = new EvalStore(directory); const modules = store.activeModules();
		const c = store.createCase(modules[0].id, defaults, { id: "old", prompt: "hello", history: [], tags: ["legacy,tag"] });
		const run = store.createRun({ caseIds: [c.id] }); const history = JSON.stringify(store.detail(run.id)); store.db.close();
		const filename = path.join(directory, "eval.sqlite");
		const dry = await migrateSqliteCatalog(repository, filename); expect(dry.cases.created).toBe(1); expect(await repository.cases.countDocuments()).toBe(0);
		expect((await migrateSqliteCatalog(repository, filename, false)).modules.created).toBe(4);
		expect((await repository.getCase(c.id))!.definition.replayMode).toBe("single-turn");
		const repeat = await migrateSqliteCatalog(repository, filename, false); expect(repeat.cases.skipped).toBe(1);
		const { Database } = await import("bun:sqlite"); const sqlite = new Database(filename, { readonly: true });
		try {
			expect(JSON.parse((sqlite.query("SELECT data FROM records WHERE kind='run' AND id=?").get(run.id) as { data: string }).data).status).toBe("queued");
		} finally { sqlite.close(); }
		expect(history).toContain(c.id);
		const item = (await repository.getCase(c.id))!; await repository.updateCase(c.id, item.revision, defaults, { ...item.definition, prompt: "changed" });
		expect((await migrateSqliteCatalog(repository, filename)).conflicts).toHaveLength(1);
		await expect(migrateSqliteCatalog(repository, filename, false)).rejects.toMatchObject({ status: 409 });
	});
	mongoTest("HTTP reads external cases, edits Mongo only, creates frozen snapshots and retains history during Mongo outage", async () => {
		const source = await repository.createModule("http-source"); const target = await repository.createModule("http-target"); const c = await seed(source);
		const app = await createEvalServer({ directory, port: 0, mongo: config, execute: async () => ({ status: "passed", text: "mock", assertions: [], usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 }) });
		const request = (route: string, body?: unknown, method = "POST") => fetch(`http://127.0.0.1:${app.server.port}${route}`, body === undefined ? undefined : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		try {
			expect((await (await request(`/api/cases/${c.id}`)).json()).definition.tags).toEqual(["comma,tag"]);
			expect(app.store.list("case")).toHaveLength(0);
			const update = { revision: c.revision, definition: { ...c.definition, prompt: "http edit" }, defaults };
			expect((await request(`/api/cases/${c.id}`, update, "PUT")).status).toBe(200);
			expect((await repository.getCase(c.id))!.definition.prompt).toBe("http edit");
			expect((await request(`/api/cases/${c.id}`, update, "PUT")).status).toBe(409);
			const run = await (await request("/api/runs", { caseIds: [c.id] })).json(); await app.queue.idle();
			const snapshot = app.store.items(run.id)[0].snapshot;
			await transfer("move", target, [(await repository.getCase(c.id))!]); await repository.deleteCase(c.id);
			expect(app.store.items(run.id)[0].snapshot).toEqual(snapshot);
			expect((await request(`/api/cases/${c.id}/runs`)).status).toBe(200);
			await (app.catalog as MongoCatalog).close();
			expect((await request("/api/state")).status).toBe(503);
			expect((await request("/api/runs")).status).toBe(200);
			expect((await request(`/api/runs/${run.id}/export`)).status).toBe(200);
			expect((await request(`/api/cases/${c.id}/runs`)).status).toBe(200);
			const rerun = await request("/api/runs", { parentRunId: run.id, rerunScope: "all" }); expect(rerun.status).toBe(202); await app.queue.idle();
			expect((await request("/api/runs", { caseIds: [c.id] })).status).toBe(503);
			expect(app.store.list("run")).toHaveLength(2);
		} finally { await app.close(); }
	});
});

test("Mongo configuration/startup errors never expose connection credentials", async () => {
	const { mongoConfig } = await import("./mongo-catalog.js");
	expect(() => mongoConfig({})).toThrow("EVAL_MONGODB_URI");
	expect(mongoFailure(new Error("mongodb://secret:password@host")).message).not.toContain("password");
});
