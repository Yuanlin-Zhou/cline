import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvalStore } from "./store.js";
import { headersFromRows } from "./client/header-editor.js";
import { parseEvalSuite } from "../schema.js";

test("Web editor preserves literals, empty values and environment references and rejects duplicate rows", () => {
	expect(
		headersFromRows([
			{ name: "Authorization", source: "env", value: "AUTH" },
			{ name: "X-ID", source: "literal", value: "{{sessionId}}" },
			{ name: "x-empty", source: "literal", value: "" },
		]),
	).toEqual({
		headers: { "x-id": "{{sessionId}}", "x-empty": "" },
		headersEnv: { authorization: "AUTH" },
	});
	expect(() =>
		headersFromRows([
			{ name: "X-ID", source: "literal", value: "a" },
			{ name: "x-id", source: "env", value: "ID" },
		]),
	).toThrow("重复");
	expect(() =>
		headersFromRows([
			{ name: "Authorization", source: "literal", value: "secret" },
		]),
	).toThrow("headersEnv");
	expect(headersFromRows([])).toEqual({});
});

test("imports, case revisions, repeated run snapshots and worker-shaped suites retain header references", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "eval-header-store-"));
	const store = new EvalStore(directory);
	try {
		const defaults = {
			...store.settings(),
			headers: { "x-session-id": "{{sessionId}}" },
			headersEnv: { authorization: "AUTH" },
		};
		store.put("settings", "default", defaults);
		const suite = store.parseImport(
			JSON.stringify({
				cases: [
					{
						id: "a",
						prompt: "hi",
						headers: { "x-case": "{{caseId}}" },
						headersEnv: { "x-extra": "EXTRA" },
					},
				],
			}),
			"json",
			"single-turn",
		);
		const module = store.activeModules()[0];
		store.importCases(module.id, suite, "version");
		const item = store.activeCases()[0];
		const run = store.createRun({
			caseIds: [item.id],
			repeatCount: 2,
			useSettings: true,
		});
		for (const entry of store.items(run.id)) {
			const parsed = parseEvalSuite(
				JSON.parse(
					JSON.stringify({
						version: 1,
						defaults: entry.snapshot.defaults,
						cases: [entry.snapshot.definition],
					}),
				),
			);
			expect(parsed.defaults.headersEnv).toEqual({ authorization: "AUTH" });
			expect(parsed.cases[0].headers).toEqual({ "x-case": "{{caseId}}" });
			expect(parsed.cases[0].headersEnv).toEqual({ "x-extra": "EXTRA" });
		}
		store.importCases(
			module.id,
			parseEvalSuite({
				defaults,
				cases: [{ ...suite.cases[0], headers: { "x-case": "changed" } }],
			}),
			"version",
		);
		expect(store.activeCases()[0].revision).toBe(2);
		expect(store.items(run.id)[0].snapshot.definition.headers?.["x-case"]).toBe(
			"{{caseId}}",
		);
		expect(
			store.parseImport(
				'{"id":"jsonl","prompt":"hi","headers":{"x-id":"fixed"}}',
				"jsonl",
				"single-turn",
			).cases[0].headers,
		).toEqual({ "x-id": "fixed" });
	} finally {
		store.db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
