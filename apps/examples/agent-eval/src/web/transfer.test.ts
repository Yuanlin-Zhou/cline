import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvalStore } from "./store.js";
import type { SavedCase } from "./types.js";

let store: EvalStore;
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), "eval-transfer-")); store = new EvalStore(directory); });
afterEach(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
const seed = (moduleId: string, id = "a") => store.createCase(moduleId, { ...store.settings(), headersEnv: { authorization: "AUTH" } }, { id, prompt: "hello", replayMode: "full-task", history: [], headers: { "x-case": "{{caseId}}" }, grading: { version: 1, rules: [{ id: "text", kind: "file.exists", path: "output.txt" }] } });
function apply(operation: "copy" | "move", targetModuleId: string, cases: SavedCase[], conflictPolicy = "rename") {
	const request = { operation, targetModuleId, conflictPolicy, items: cases.map(c => ({ id: c.id, revision: c.revision })) };
	const preview = store.previewTransfer(request);
	return store.transferCases({ ...request, items: preview.items.map(item => ({ id: item.id, revision: item.revision, expectedDefinitionId: item.proposedDefinitionId })) });
}

test("copies all configuration independently and moves identity while retaining old snapshots", () => {
	const [source, target] = store.activeModules(); const c = seed(source.id);
	const run = store.createRun({ caseIds: [c.id] }); const before = JSON.stringify(store.detail(run.id));
	const copy = apply("copy", target.id, [c]).cases[0];
	expect(copy.id).not.toBe(c.id); expect(copy.revision).toBe(1); expect(copy.defaults).toEqual(c.defaults); expect(copy.definition).toEqual(c.definition);
	copy.definition.history.push({ role: "user", content: "new" }); expect(store.require<SavedCase>("case", c.id).definition.history).toEqual([]);
	const moved = apply("move", target.id, [c]).cases[0];
	expect(moved.id).toBe(c.id); expect(moved.revision).toBe(2); expect(moved.definition.id).toBe("a-move1");
	expect(JSON.stringify(store.detail(run.id))).toBe(before);
	const rerun = store.createRun({ parentRunId: run.id, rerunScope: "all" });
	expect(store.items(rerun.id)[0].snapshot).toEqual(c);
	expect(store.items(rerun.id)[0].moduleName).toBe(source.name);
	expect(store.list<{ snapshot: SavedCase }>("item").some(item => item.snapshot.id === copy.id)).toBe(false);
	const future = store.createRun({ caseIds: [c.id] }); expect(store.items(future.id)[0].moduleName).toBe(target.name);
	expect(apply("move", target.id, [moved])).toMatchObject({ moved: 0, unchanged: 1 });
});

test("batch name reservation detects internal collisions; abort changes nothing", () => {
	const [a,b,target] = store.activeModules(); const cases = [seed(a.id),seed(b.id)];
	const request = { operation: "copy", targetModuleId: target.id, conflictPolicy: "abort", items: cases.map(c => ({ id:c.id,revision:c.revision })) };
	expect(store.previewTransfer(request).canApply).toBe(false);
	expect(() => store.transferCases({ ...request, items: request.items.map(i => ({ ...i, expectedDefinitionId: "a" })) })).toThrow();
	expect(store.activeCases()).toHaveLength(2);
	expect(apply("copy", target.id, cases).cases.map(c => c.definition.id)).toEqual(["a","a-copy1"]);
	expect(apply("copy", a.id, [cases[0]]).cases[0].definition.id).toBe("a-copy1");
});

test("stale previews and deleted/archived sources reject the entire transaction", () => {
	const [source,target] = store.activeModules(); const cases=[seed(source.id,"a"),seed(source.id,"b")];
	const request={operation:"move",targetModuleId:target.id,conflictPolicy:"rename",items:cases.map(c=>({id:c.id,revision:c.revision,expectedDefinitionId:c.definition.id}))};
	seed(target.id,"b"); expect(() => store.transferCases(request)).toThrow("预览"); expect(store.require<SavedCase>("case",cases[0].id).moduleId).toBe(source.id);
	store.put("case",cases[1].id,{...cases[1],revision:2}); expect(()=>store.previewTransfer(request)).toThrow("版本");
	store.deleteCase(cases[1].id); expect(()=>store.transferCases(request)).toThrow("不存在");
	store.setArchived("module",target.id,true); expect(()=>store.previewTransfer(request)).toThrow("归档");
	expect(()=>store.previewTransfer({...request,targetModuleId:source.id,items:[request.items[0],request.items[0]]})).toThrow("重复");
});

test("database errors roll back earlier writes in a batch", () => {
	const [source, target] = store.activeModules(); const cases = [seed(source.id, "a"), seed(source.id, "b")];
	store.db.exec(`CREATE TRIGGER reject_b BEFORE UPDATE ON records WHEN NEW.kind='case' AND json_extract(NEW.data,'$.definition.id')='b' BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
	expect(() => apply("move", target.id, cases)).toThrow("injected failure");
	for (const c of cases) expect(store.require<SavedCase>("case", c.id)).toEqual(c);
});

test("same module copy gets a suffix even with abort policy; no-op move writes nothing", () => {
	const [module] = store.activeModules(); const c = seed(module.id);
	expect(apply("copy", module.id, [c], "abort").cases[0].definition.id).toBe("a-copy1");
	store.db.exec(`CREATE TRIGGER reject_write BEFORE UPDATE ON records WHEN NEW.kind='case' BEGIN SELECT RAISE(ABORT,'no writes allowed'); END;`);
	expect(apply("move", module.id, [c]).cases[0]).toEqual(c);
});

test("transfer HTTP routes report input, stale revision, and missing module errors", async () => {
	const { createEvalServer } = await import("./server.js");
	const app = await createEvalServer({ storage: "sqlite", directory: path.join(directory, "http"), port: 0 });
	try {
		const [source, target] = app.store.activeModules();
		const c = app.store.createCase(source.id, app.store.settings(), { id: "api-case", prompt: "hello", history: [] });
		const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${app.server.port}/api/cases/transfer${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const body = { operation: "move", targetModuleId: target.id, conflictPolicy: "abort", items: [{ id: c.id, revision: 1 }] };
		expect((await post("/preview", {})).status).toBe(400);
		expect((await post("/preview", { ...body, targetModuleId: "missing" })).status).toBe(404);
		const preview = await (await post("/preview", body)).json();
		const applyBody = { ...body, items: preview.items.map((i: { id: string; revision: number; proposedDefinitionId: string }) => ({ id: i.id, revision: i.revision, expectedDefinitionId: i.proposedDefinitionId })) };
		expect((await post("", applyBody)).status).toBe(200);
		expect((await post("", applyBody)).status).toBe(409);
	} finally { app.server.stop(true); app.store.db.close(); }
});

test("copy drafts are validated, previewed and committed atomically without changing originals", () => {
 const [source,target]=store.activeModules();const a=seed(source.id,"original"),b=seed(source.id,"other");
 const draft={definition:{...a.definition,id:"renamed",prompt:"modified",timeoutMs:12345,headers:{"x-case":"new"}},defaults:{...a.defaults,modelId:"different-model",headersEnv:{Authorization:"OTHER_KEY"}}};
 const body={operation:"copy",targetModuleId:target.id,conflictPolicy:"abort",items:[{id:a.id,revision:a.revision,draft},{id:b.id,revision:b.revision}]};
 const preview=store.previewTransfer(structuredClone(body));expect(preview.items[0].proposedDefinitionId).toBe("renamed");expect(preview.items[0].draftFingerprint).toBeString();
 const input={...body,items:body.items.map((item,index)=>({...item,expectedDefinitionId:preview.items[index].proposedDefinitionId,...(item.draft?{expectedDraftFingerprint:preview.items[index].draftFingerprint}:{})}))};
 expect(()=>store.transferCases({...input,items:input.items.map((item,index)=>index?item:{...item,draft:{...draft,definition:{...draft.definition,prompt:"changed after preview"}}})})).toThrow("预览");
 expect(store.activeCases()).toHaveLength(2);
 const copies=store.transferCases(structuredClone(input)).cases;
 expect(copies[0].definition).toMatchObject({id:"renamed",prompt:"modified",timeoutMs:12345,headers:{"x-case":"new"}});expect(copies[0].defaults).toMatchObject({modelId:"different-model",headersEnv:{authorization:"OTHER_KEY"}});expect(copies[0].revision).toBe(1);expect(copies[0].id).not.toBe(a.id);expect(store.require<SavedCase>("case",a.id)).toEqual(a);
 expect(()=>store.previewTransfer({...body,operation:"move"})).toThrow("只有复制");
 expect(()=>store.previewTransfer({...body,items:[{...body.items[0],draft:{...draft,definition:{...draft.definition,timeoutMs:-1}}}]})).toThrow();
 expect(()=>store.previewTransfer({...body,items:[{...body.items[0],draft:{...draft,defaults:{...draft.defaults,cwd:"relative"}}}]})).toThrow("绝对路径");
});

test("same-module edited copy keeps an explicitly available name",()=>{
 const source=seed(store.activeModules()[0].id,"source");const request={operation:"copy",targetModuleId:source.moduleId,conflictPolicy:"abort",items:[{id:source.id,revision:source.revision,draft:{definition:{...source.definition,id:"explicit-name"},defaults:source.defaults}}]};
 const preview=store.previewTransfer(structuredClone(request));expect(preview.items[0].proposedDefinitionId).toBe("explicit-name");
 const copied=store.transferCases({...request,items:request.items.map(i=>({...i,expectedDefinitionId:"explicit-name",expectedDraftFingerprint:preview.items[0].draftFingerprint}))}).cases[0];expect(copied.definition.id).toBe("explicit-name");
});
