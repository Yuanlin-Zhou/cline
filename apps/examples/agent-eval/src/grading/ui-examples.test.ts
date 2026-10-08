import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import examples from "../../examples/grading/ui-examples.json";
import { parseEvalSuite } from "../schema.js";
import { preflight, verdict } from "./engine.js";
import { manifest, snapshot } from "./evidence.js";
import { checkRule } from "./check.js";

test("UI examples accept intended artifacts, reject negative cases, and retain unsupported optional diagnostics", async () => {
	const suite = parseEvalSuite(examples);
	const outputs: Record<string, Record<string, string>> = {
		"grading-json-pass": { "summary.json": '{"items":[1,2,3],"total":12}' },
		"grading-text-pass": { "guide.txt": "Bun\nbun install" },
		"grading-tolerance-pass": { "ratio.json": '{"ratio":0.3333}' },
		"grading-missing-fail": {},
		"grading-value-fail": { "summary.json": '{"total":10}' },
		"grading-behavior-optional": { "note.txt": "Bun" },
	};
	expect(suite.cases).toHaveLength(6);
	for (const c of suite.cases) {
		preflight(c, []);
		const directory = await mkdtemp(path.join(os.tmpdir(), "grading-ui-example-"));
		try {
			const workspace = path.join(directory, "workspace"); await mkdir(workspace);
			const evidence = manifest();
			await snapshot(workspace, directory, "baseline", evidence, []);
			for (const [name, contents] of Object.entries(outputs[c.id])) await writeFile(path.join(workspace, name), contents);
			await snapshot(workspace, directory, "artifacts", evidence, []);
			const results = await Promise.all(c.grading!.rules.map(async rule => ({ id: rule.id, kind: rule.kind, required: rule.required !== false, durationMs: 0, ...await checkRule(rule, { directory, evidence, events: [] }) })));
			expect(verdict(results)).toBe(c.id.endsWith("-fail") ? "failed" : "passed");
			if (c.id === "grading-behavior-optional") expect(results[1].status).toBe("insufficient");
		} finally {
			if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("grading-ui-example-")) await rm(directory, { recursive: true, force: true });
		}
	}
});
