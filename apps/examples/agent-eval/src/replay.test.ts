import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
