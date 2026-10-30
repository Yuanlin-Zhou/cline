import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { caseExample, replayConfig } from "./replay.js";
import { EvalStore } from "./web/store.js";

test("import examples work in JSON and JSONL and explicit modes override the fallback", () => {
	const store = new EvalStore(mkdtempSync(path.join(os.tmpdir(), "eval-import-test-")));
	try {
		for (const mode of ["single-turn", "full-task"] as const) {
			for (const format of ["json", "jsonl"]) {
				const example = caseExample(mode);
				const content = JSON.stringify(format === "json" ? { cases: [example] } : example);
				const suite = store.parseImport(content, format, mode === "single-turn" ? "full-task" : "single-turn");
				expect(suite.cases[0]!.replayMode).toBe(mode);
				expect(suite.defaults.modelId).toBe(store.settings().modelId);
			}
		}
		expect(store.parseImport('[{"id":"fallback","prompt":"hello"}]', "json", "full-task").cases[0]!.replayMode).toBe("full-task");
		expect(() => store.parseImport('{"id":"bad","prompt":"hello"}\n{"id":', "jsonl", "single-turn")).toThrow("第 2 行");
	} finally { store.db.close(); }
});

test("multi-turn preserves case configuration and missing mode uses single-turn constraints", () => {
	const defaults = { providerId: "cline", modelId: "test", tools: "full" as const, maxIterations: 20 };
	expect(replayConfig({ id: "legacy", history: [], prompt: "hello" }, defaults)).toEqual({ tools: "none", maxIterations: 1 });
	expect(replayConfig(caseExample("full-task"), defaults)).toEqual({ tools: "full", maxIterations: 30 });
});

test("import validation distinguishes wrong source/structure from actual case count limits", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "eval-import-errors-"));
	const store = new EvalStore(directory);
	try {
		expect(() => store.parseImport('{"moduleId":"m","source":{}}', "json", "single-turn")).toThrow("Python 接入参数");
		expect(() => store.parseImport('{"messages":[]}', "json", "single-turn")).toThrow("历史对话 JSON");
		expect(() => store.parseImport('{"id":"case","prompt":"hi"}', "json", "single-turn")).toThrow("需要包含 cases 数组");
		expect(() => store.parseImport('{"cases":[]}', "json", "single-turn")).toThrow("1–1000");
		expect(() => store.parseImport(JSON.stringify({cases:Array.from({length:1001},(_,i)=>({id:String(i),prompt:"hi"}))}), "json", "single-turn")).toThrow("1–1000");
		expect(store.parseImport('{"cases":[{"id":"one","prompt":"hi"}]}', "json", "single-turn").cases).toHaveLength(1);
	} finally { store.db.close(); rmSync(directory,{recursive:true,force:true}); }
});
