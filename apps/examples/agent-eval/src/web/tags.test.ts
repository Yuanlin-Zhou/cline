import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TagSelection } from "./client/tag-editor.js";
import { EvalStore } from "./store.js";

test("tag arrays preserve imported strings and order without comma splitting", () => {
	const original = ["a,b", " 大小写 ", "Regression", "重复", "重复"];
	const selection = new TagSelection(original);
	expect(selection.read()).toEqual(original);
	expect(selection.add(" 新增 ")).toBe("新增");
	expect(() => selection.add(" 新增 ")).toThrow("已添加");
	expect(() => selection.add("  ")).toThrow("名称");
	selection.select("new,tag"); selection.select("Regression"); selection.remove(0);
	expect(selection.read()).toEqual([...original.slice(1), "新增", "new,tag"]);
	const read = selection.read(); read.push("outside"); expect(selection.read()).not.toContain("outside");
	expect(original).toHaveLength(5);
});

test("module limit rejects additional tags without changing the selection and permits removal", () => {
	const state = new TagSelection(Array.from({ length: 20 }, (_, i) => `tag${i}`), 20);
	expect(() => state.add("extra")).toThrow("20"); expect(() => state.select("extra")).toThrow("20");
	state.select("tag0"); expect(state.read()).toHaveLength(20);
	state.unselect("tag0"); state.select("extra"); expect(state.read().at(-1)).toBe("extra");
	const cases = new TagSelection([]); for (let i = 0; i < 21; i++) cases.add(`${i}`); expect(cases.read()).toHaveLength(21);
});

test("saved comma-containing tags survive copies, moves, and run snapshots", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "eval-tags-")); const store = new EvalStore(directory);
	try {
		const [a, b] = store.activeModules(); const selection = new TagSelection(["导入,标签"]); selection.add("回归");
		const c = store.createCase(a.id, store.settings(), { id: "tags", prompt: "hello", history: [], tags: selection.read() });
		const run = store.createRun({ caseIds: [c.id] });
		for (const operation of ["copy", "move"] as const) {
			const request = { operation, targetModuleId: b.id, conflictPolicy: "rename", items: [{ id: c.id, revision: c.revision }] };
			const preview = store.previewTransfer(request);
			const result = store.transferCases({ ...request, items: preview.items.map(i => ({ id: i.id, revision: i.revision, expectedDefinitionId: i.proposedDefinitionId })) });
			expect(result.cases[0].definition.tags).toEqual(selection.read());
		}
		expect(store.items(run.id)[0].snapshot.definition.tags).toEqual(["导入,标签", "回归"]);
		store.updateModule(a.id, { tags: ["模块,分类", "回归"] }); expect(store.activeModules()[0].tags).toEqual(["模块,分类", "回归"]);
	} finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
