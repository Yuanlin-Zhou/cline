import { expect, test } from "bun:test";
import { parseEvalSuite } from "./schema.js";
import { parseBadCase, parseImportSource } from "./case-origin.js";
import { EvalStore } from "./web/store.js";
import { SqliteCatalog } from "./web/catalog.js";
import { caseSummary } from "./web/projections.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("bad output and source validation reject invalid data without changing existing replay modes", () => {
	expect(parseEvalSuite({cases:[{id:"old",prompt:"question"}]}).cases[0].badCase).toBeUndefined();
	for (const value of [{observedOutput:""},{observedOutput:"汉".repeat(400000)},{observedOutput:"bad JSON",outputFormat:"json"},{observedOutput:"x",unknown:true}]) expect(()=>parseBadCase(value)).toThrow();
	expect(()=>parseImportSource({platform:"logs",taskId:"t",turnId:"r",url:"javascript:alert(1)"})).toThrow();
	expect(parseBadCase({observedOutput:'{"error":1}',outputFormat:"json"})).toEqual({observedOutput:'{"error":1}',outputFormat:"json"});
});

test("SQLite saves, edits, copies, exports and freezes bad output while summaries omit it", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "bad-case-"));
	const store = new EvalStore(directory);
	try {
		const module = store.activeModules()[0]!;
		const definition = {id:"bad",prompt:"question",history:[],replayMode:"single-turn" as const,badCase:{observedOutput:"WRONG_OUTPUT",reason:"wrong"},importSource:{platform:"logs",taskId:"task",turnId:"turn"}};
		const saved = store.createCase(module.id, store.settings(), definition);
		const summary = caseSummary(saved);
		expect(summary.definition.isBadCase).toBe(true);
		expect(JSON.stringify(summary)).not.toContain("WRONG_OUTPUT");
		expect(store.duplicateCase(saved.id).definition.badCase).toEqual(saved.definition.badCase);
		const run = store.createRun({caseIds:[saved.id]});
		expect(store.items(run.id)[0]!.snapshot.definition.badCase).toEqual(saved.definition.badCase);
		const roundtrip = parseEvalSuite({defaults:saved.defaults,cases:[saved.definition]});
		expect(roundtrip.cases[0]!.importSource).toEqual(definition.importSource);
		new SqliteCatalog(store).updateCase(saved.id, saved.revision, saved.defaults, {...definition,badCase:undefined});
		expect(store.activeCases().find(c=>c.id===saved.id)!.definition.badCase).toBeUndefined();
		expect(store.items(run.id)[0]!.snapshot.definition.badCase).toBeDefined();
	} finally { store.db.close(); rmSync(directory,{recursive:true,force:true}); }
});
