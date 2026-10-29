import { moduleDeletion } from "./resource-management.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MongoVerifiers, verifierToken } from "../grading/uploaded-verifiers.js";
import { replyTemplate } from "../grading/verifier-guide.js";
import { MongoClient } from "mongodb";
import { MongoCatalog, mongoFailure, type MongoConfig } from "./mongo-catalog.js";
import { prepareMongoCollections, caseToDocument, caseValidator } from "./mongo-schema.js";
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
 mongoTest("summary projections and selected bodies preserve MongoDB visibility and configurations",async()=>{
  const m=await repository.createModule("summaries");
  const c=await repository.createCase(m.id,defaults,{id:"large",prompt:"private "+"x".repeat(150000),replayMode:"single-turn"});
  const summary=await repository.summaries();expect(summary.cases[0].definition).not.toHaveProperty("prompt");
  const selected=await repository.selected({caseIds:[c.id]});expect(selected.cases[0]).toEqual(c);
  await repository.setArchived("case",c.id,true);expect((await repository.summaries()).cases).toHaveLength(0);expect((await repository.selected({caseIds:[c.id]})).cases).toHaveLength(0);
 });

	mongoTest("resource deletion is atomic, serializes against changed previews and Python updates use CAS", async () => {
		const module = await repository.createModule("delete module");
		const a = await repository.createCase(module.id, defaults, { id: "a", prompt: "a" });
		const b = await repository.createCase(module.id, defaults, { id: "b", prompt: "b" });
		let preview = moduleDeletion(module.id, await repository.allResources());
		await repository.setArchived("case", b.id, true);
		await expect(repository.deleteModule(module.id, { name: module.name, expectedToken: preview.token })).rejects.toThrow("清单已变化");
		preview = moduleDeletion(module.id, await repository.allResources());
		const original = repository.cases.deleteMany.bind(repository.cases);
		(repository.cases as any).deleteMany = async (...args: any[]) => { await (original as any)(...args); throw Error("injected after delete"); };
		await expect(repository.deleteModule(module.id, { name: module.name, expectedToken: preview.token })).rejects.toThrow();
		expect(await repository.getCase(a.id)).toBeDefined(); expect(await repository.getModule(module.id)).toBeDefined();
		(repository.cases as any).deleteMany = original;
		await expect(repository.deleteCases({ items: [{ id: a.id, revision: 1 }, { id: b.id, revision: 1 }] })).rejects.toThrow("已变化");
		expect(await repository.deleteCases({ items: [{ id: a.id, revision: 1 }] })).toEqual({ deleted: 1 });
		preview = moduleDeletion(module.id, await repository.allResources());
		expect(await repository.deleteModule(module.id, { name: module.name, expectedToken: preview.token })).toEqual({ deleted: 1 });
		expect(await repository.getModule(module.id)).toBeUndefined(); expect(await repository.getCase(b.id)).toBeUndefined();
		const scripts = new MongoVerifiers(repository.db, "agent_eval_verifiers"); await scripts.preflight();
		const input = { filename: "verify.py", label: "old", content: 'def verify(ctx):\n    return {"verdict":"pass","message":"ok"}\n' };
		const script = await scripts.create(input);
		const results = await Promise.allSettled([scripts.update(script.id, verifierToken(script), { ...input, label: "one" }), scripts.update(script.id, verifierToken(script), { ...input, label: "two" })]);
		expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
		await expect(scripts.delete(script.id, verifierToken(script))).rejects.toThrow("已被其他页面修改");
		const current = (await scripts.get(script.id))!; expect(current.sha256).toBe(script.sha256);
		await scripts.delete(script.id, verifierToken(current)); expect(await scripts.get(script.id)).toBeUndefined();
	});

	mongoTest("batch conversation imports roll back all cases on Mongo validation failure", async () => {
		const module = await repository.createModule("batch conversations");
		const app = await createEvalServer({directory,port:0,storage:"mongodb",catalog:repository});
		const body = {moduleId:module.id,files:[{filename:"first.json",content:'{"messages":[{"role":"assistant","content":"context"}]}'},{filename:"blocked.json",content:'{"messages":[{"role":"user","content":"actual question"}]}'}],options:{tools:["editor"],continuation:"继续"},defaults:{providerId:"openai-compatible",modelId:"mock",baseUrl:"http://localhost/v1"},policy:"skip"};
		const post = () => fetch(`http://127.0.0.1:${app.server.port}/api/import/conversations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
		try {
			await repository.db.command({collMod:config.caseCollection,validator:{$and:[caseValidator,{"definition.id":{$ne:"blocked"}}]},validationLevel:"strict",validationAction:"error"});
			expect((await post()).status).toBe(422);
			expect((await repository.snapshot()).cases).toHaveLength(0);
			await repository.db.command({collMod:config.caseCollection,validator:caseValidator,validationLevel:"strict",validationAction:"error"});
			expect(await(await post()).json()).toEqual({created:2,updated:0,skipped:0});
			const saved=(await repository.snapshot()).cases;
			expect(saved.find(c=>c.definition.id==="first")?.definition.prompt).toBe("继续");
			expect(saved.find(c=>c.definition.id==="blocked")?.definition.prompt).toBe("actual question");
		} finally {await app.close();}
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
        const draft = { definition: { ...sources[1].definition, id: "configured-copy", timeoutMs: 12345 }, defaults: { ...sources[1].defaults, modelId: "copied-model" } };
        const copyRequest = { operation: "copy", targetModuleId: target.id, conflictPolicy: "abort", items: [{ id: sources[1].id, revision: 1, draft }] };
        const preview = await repository.previewTransfer(structuredClone(copyRequest));
        const applyRequest = { ...copyRequest, items: copyRequest.items.map(i => ({ ...i, expectedDefinitionId: preview.items[0].proposedDefinitionId, expectedDraftFingerprint: preview.items[0].draftFingerprint })) };
        await expect(repository.transferCases({ ...applyRequest, items: applyRequest.items.map(i => ({ ...i, draft: { ...draft, defaults: { ...draft.defaults, modelId: "after-preview" } } })) })).rejects.toThrow("预览");
        expect(await repository.cases.countDocuments()).toBe(count);
        const copy = (await repository.transferCases(applyRequest)).cases[0];
        expect(copy.definition).toMatchObject({ id: "configured-copy", timeoutMs: 12345 });
        expect(copy.defaults.modelId).toBe("copied-model");
        expect(await repository.getCase(sources[1].id)).toEqual(sources[1]);

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
	mongoTest("application name checks work without custom indexes and invalid documents still fail on use", async () => {
		const module = await repository.createModule("unique"); const c = await seed(module);
		await expect(seed(module)).rejects.toMatchObject({ status: 409 });
		await expect(repository.createModule(" UNIQUE ")).rejects.toMatchObject({ status: 409 });
		await repository.setArchived("case", c.id, true); await seed(module);
		await expect(repository.setArchived("case", c.id, false)).rejects.toMatchObject({ status: 409 });
		const doc = (await repository.cases.findOne({ _id: c.id }))!;
		await expect(repository.cases.insertOne({ ...doc, _id: randomUUID(), archived: false, definition: { ...doc.definition, id: "bad", history: [{ role: "user", content: "" }] } })).rejects.toMatchObject({ code: 121 });
		await repository.cases.updateOne({ _id: c.id }, { $set: { schemaVersion: 2 as 1 } }, { bypassDocumentValidation: true });
		await expect(repository.snapshot()).rejects.toMatchObject({ status: 422 });
		expect((await repository.cases.listIndexes().toArray()).map(i => i.name)).toEqual(["_id_"]);
		expect((await repository.modules.listIndexes().toArray()).map(i => i.name)).toEqual(["_id_"]);
		await repository.preflight();
		await repository.db.command({collMod: config.caseCollection, validator: {}, validationLevel: "off"});
		await repository.preflight();
		await repository.db.collection("agent_eval_verifiers").drop();
		await expect(new MongoVerifiers(repository.db, "agent_eval_verifiers").preflight()).rejects.toThrow("agent_eval_verifiers");
	});
	mongoTest("Web starts on plain collections while index inspection and DDL are denied", async () => {
		for (const name of [config.caseCollection, config.moduleCollection, "agent_eval_verifiers"]) await repository.db.command({ collMod: name, validator: {}, validationLevel: "off" });
		await repository.db.admin().command({ configureFailPoint: "failCommand", mode: "alwaysOn", data: { failCommands: ["listIndexes", "createIndexes", "collMod", "create"], errorCode: 13 } });
		let app: Awaited<ReturnType<typeof createEvalServer>> | undefined;
		try {
			app = await createEvalServer({ directory, port: 0, storage: "mongodb", mongo: config });
			const response = await fetch(`http://127.0.0.1:${app.server.port}/api/modules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "plain collection" }) });
			expect(response.status).toBe(201);
			expect((await response.json()).name).toBe("plain collection");
		} finally {
			await app?.close();
			await repository.db.admin().command({ configureFailPoint: "failCommand", mode: "off" });
		}
	});

	mongoTest("rename and restore reject active names; archive reuse, copies and concurrent case creation remain valid", async () => {
		const m = await repository.createModule("names"), other = await repository.createModule("other");
		await expect(repository.updateModule(other.id, { name: "NAMES" })).rejects.toMatchObject({ status: 409 });
		await repository.archiveModule(m.id);
		const replacement = await repository.createModule("names");
		await expect(repository.setArchived("module", m.id, false)).rejects.toMatchObject({ status: 409 });
		await repository.updateModule(m.id, { name: "other" });
		await expect(repository.setArchived("module", m.id, false)).rejects.toMatchObject({ status: 409 });
		await repository.updateModule(m.id, { name: "restored" }); await repository.setArchived("module", m.id, false);
		const a = await seed(replacement, "a"), b = await seed(replacement, "b");
		await expect(repository.updateCase(b.id, b.revision, b.defaults, { ...b.definition, id: "a" })).rejects.toMatchObject({ status: 409 });
		await repository.updateCase(a.id, a.revision, a.defaults, a.definition);
		const concurrent = await Promise.allSettled([seed(replacement, "parallel"), seed(replacement, "parallel")]);
		expect(concurrent.filter(r => r.status === "fulfilled")).toHaveLength(1);
		expect((concurrent.find(r => r.status === "rejected") as PromiseRejectedResult).reason.status).toBe(409);
		expect((await repository.duplicateCase(b.id)).definition.id).toBe("b-copy1");
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
