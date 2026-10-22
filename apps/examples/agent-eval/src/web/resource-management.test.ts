import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvalServer } from "./server.js";
import { SqliteCatalog } from "./catalog.js";
import { EvalStore } from "./store.js";
import { moduleDeletion } from "./resource-management.js";
import { SqliteVerifiers, verifierToken } from "../grading/uploaded-verifiers.js";
const source = 'def verify(ctx):\n    return {"verdict":"pass","message":"中文结果"}\n';
const defaults = { providerId: "openai-compatible", modelId: "mock", baseUrl: "http://localhost/v1" };

test("module and batch deletion check confirmed state and roll back all records on failure", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "eval-resources-"));
	const store = new EvalStore(dir), catalog = new SqliteCatalog(store);
	try {
		const m = store.createModule("remove me"), other = store.createModule("keep me");
		const a = store.createCase(m.id, defaults, { id: "a", prompt: "a" }), b = store.createCase(m.id, defaults, { id: "b", prompt: "b" });
		const keep = store.createCase(other.id, defaults, { id: "keep", prompt: "keep" });
		const run = store.createRun({ caseIds: [a.id] });
		const before = JSON.stringify(store.items(run.id));
		let preview = moduleDeletion(m.id, catalog.allResources());
		store.setArchived("case", b.id, true);
		expect(() => catalog.deleteModule(m.id, { name: m.name, expectedToken: preview.token })).toThrow("清单已变化");
		preview = moduleDeletion(m.id, catalog.allResources());
		expect(preview.count).toBe(2);
		expect(() => catalog.deleteModule(m.id, { name: "wrong", expectedToken: preview.token })).toThrow("完整模块名称");
		expect(() => catalog.deleteCases({ items: [{ id: a.id, revision: 2 }, { id: keep.id, revision: 1 }] })).toThrow("已变化");
		expect(() => catalog.deleteCases({ items: [{ id: a.id, revision: 1 }, { id: a.id, revision: 1 }] })).toThrow("重复");
		expect(() => catalog.deleteCases({ items: [] })).toThrow();
		expect(() => catalog.deleteCases({ items: Array(1001).fill({ id: a.id, revision: 1 }) })).toThrow();
		store.db.exec(`CREATE TRIGGER reject_case_delete BEFORE DELETE ON records WHEN OLD.kind='case' AND json_extract(OLD.data,'$.definition.id')='b' BEGIN SELECT RAISE(ABORT,'blocked'); END`);
		expect(() => catalog.deleteModule(m.id, { name: m.name, expectedToken: preview.token })).toThrow("blocked");
		expect(catalog.getCase(a.id)).toBeDefined(); expect(catalog.getCase(b.id)).toBeDefined(); expect(catalog.getModule(m.id)).toBeDefined();
		expect(() => catalog.deleteCases({ items: [a,b].map(c => ({ id: c.id, revision: 1 })) })).toThrow("blocked");
		expect(catalog.getCase(a.id)).toBeDefined();
		store.db.exec("DROP TRIGGER reject_case_delete");
		expect(catalog.deleteModule(m.id, { name: m.name, expectedToken: preview.token })).toEqual({ deleted: 2 });
		expect(catalog.getModule(m.id)).toBeUndefined(); expect(catalog.getCase(b.id)).toBeUndefined(); expect(catalog.getCase(keep.id)).toBeDefined();
		expect(JSON.stringify(store.items(run.id))).toBe(before);
		expect(catalog.deleteCases({ items: [{ id: keep.id, revision: 1 }] })).toEqual({ deleted: 1 });
		const empty = store.createModule("empty"); store.archiveModule(empty.id); preview = moduleDeletion(empty.id, catalog.allResources());
		expect(preview.module.archived).toBe(true);
		expect(catalog.deleteModule(empty.id, { name: empty.name, expectedToken: preview.token })).toEqual({ deleted: 0 });
	} finally { store.db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Python management edits preserve bindings, reject stale metadata and respect archived references and snapshots", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "eval-script-manage-"));
	const app = await createEvalServer({ directory: dir, port: 0, storage: "sqlite", execute: async item => ({ id: item.snapshot.definition.id, sessionId: item.id, text: "done", status: "passed", durationMs: 1, iterations: 1, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], assertions: [] }) });
	const api = (route: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${app.server.port}${route}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
	try {
		const uploaded = await api("/api/verifiers", "POST", { filename: "verify.py", label: "old", content: source }); expect(uploaded.status).toBe(201);
		const script = await uploaded.json(), route = `/api/verifiers/${script.id}`, detail = await (await api(route)).json();
		const module = app.store.activeModules()[0];
		const c = app.store.createCase(module.id, defaults, { id: "bound", prompt: "task", grading: { version: 1, rules: [{ id: "check", kind: "script", verifierId: script.id }] } });
		const scripts = new SqliteVerifiers(app.store), old = (await scripts.get(script.id))!;
		const run = app.store.createRun({ caseIds: [c.id] }, [{ snapshot: c, moduleName: module.name, verifierSnapshots: [old] }]);
		const frozen = JSON.stringify(app.store.items(run.id));
		app.store.setArchived("case", c.id, true);
		expect((await (await api(route)).json()).references[0].archived).toBe(true);
		const rejected = await api(route, "DELETE", { expectedToken: detail.token }); expect(rejected.status).toBe(409); expect((await rejected.json()).references[0].id).toBe(c.id);
		for (const content of ["def verify(ctx)\n    pass", "def other(ctx):\n    pass"])
			expect((await api(route, "PUT", { expectedToken: detail.token, filename: "verify.py", label: "bad", content })).status).toBe(400);
		expect((await api(route, "PUT", { expectedToken: detail.token, filename: "verify.ts", content: source })).status).toBe(400);
		const changed = await api(route, "PUT", { expectedToken: detail.token, filename: "changed.py", label: "new", content: source }); expect(changed.status).toBe(200);
		const update = await changed.json(); expect(update.id).toBe(script.id); expect(update.sha256).toBe(old.sha256); expect(update.token).not.toBe(detail.token);
		expect((await api(route, "PUT", { expectedToken: detail.token, filename: "other.py", content: source })).status).toBe(409);
		const newSource = source.replace('"pass"', '"fail"');
		expect((await api(route, "PUT", { expectedToken: update.token, filename: "changed.py", label: "new", content: newSource })).status).toBe(200);
		expect((await scripts.get(script.id))!.sha256).not.toBe(old.sha256);
		expect(app.store.get<any>("case", c.id).definition.grading.rules[0].verifierId).toBe(script.id);
		expect(JSON.stringify(app.store.items(run.id))).toBe(frozen);
		const managed = await (await api("/api/verifiers?manage=1")).json(); expect(managed.verifiers.find((v: any) => v.id === script.id).referenceCount).toBe(1);
		expect((await api(`/api/cases/${c.id}/unarchive`, "POST")).status).toBe(200);
		const latest = (await scripts.get(script.id))!;
		const nextResponse = await api("/api/runs", "POST", { caseIds: [c.id] }); expect(nextResponse.status).toBe(202);
		const nextRun = await nextResponse.json(); await app.queue.idle();
		expect(app.store.items(nextRun.id)[0].verifierSnapshots![0].content).toBe(newSource);
		expect((await api("/api/cases/delete-batch", "POST", { items: [{ id: c.id, revision: 1 }] })).status).toBe(200);
		expect((await api(route, "DELETE", { expectedToken: detail.token })).status).toBe(409);
		expect((await api(route, "DELETE", { expectedToken: verifierToken(latest) })).status).toBe(200);
		expect((await api(route)).status).toBe(404);
		expect(app.store.items(run.id)[0].verifierSnapshots![0].content).toBe(source);
		const rerunResponse = await api("/api/runs", "POST", { parentRunId: run.id, rerunScope: "all" });
		expect(rerunResponse.status).toBe(202);
		const rerun = await rerunResponse.json(); await app.queue.idle();
		expect(app.store.items(rerun.id)[0].verifierSnapshots![0].content).toBe(source);
		expect((await api("/api/cases", "POST", { moduleId: module.id, defaults, definition: c.definition })).status).toBe(400);
		const js = await (await api("/api/verifiers", "POST", { filename: "readonly.js", content: "// old" })).json();
		expect((await api(`/api/verifiers/${js.id}`, "DELETE", { expectedToken: "anything" })).status).toBe(403);
		const preview = await (await api(`/api/modules/${module.id}/delete-preview`, "POST")).json();
		expect((await api(`/api/modules/${module.id}`, "DELETE", { name: module.name, expectedToken: preview.token })).status).toBe(200);
	} finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
