import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { replayConfig } from "./replay.js";
import { EvalStore } from "./web/store.js";

const examplesDirectory = path.resolve(import.meta.dir, "../examples/importable");
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("portable example suites import with the current Web model settings", () => {
	expect(existsSync(examplesDirectory)).toBe(true);
	const files = readdirSync(examplesDirectory).filter((file) => file.endsWith(".json")).sort();
	expect(files).toEqual([
		"full-task.json",
		"grading.json",
		"registered-verifier.json",
		"single-turn.json",
	]);

	const directory = mkdtempSync(path.join(os.tmpdir(), "eval-importable-examples-"));
	temporaryDirectories.push(directory);
	const store = new EvalStore(directory);
	store.put("settings", "default", {
		providerId: "configured-provider",
		modelId: "configured-model",
		tools: "read-only",
		maxIterations: 7,
		timeoutMs: 90000,
	});

	try {
		for (const file of files) {
			const content = readFileSync(path.join(examplesDirectory, file), "utf8");
			const raw = JSON.parse(content) as {
				defaults?: Record<string, unknown>;
				cases: Array<{ replayMode?: string }>;
			};
			for (const key of ["providerId", "modelId", "apiKeyEnv", "baseUrl"]) {
				expect(Object.hasOwn(raw.defaults ?? {}, key)).toBe(false);
			}
			expect(
				raw.cases.every(
					(item) =>
						Object.hasOwn(item, "replayMode") &&
						(item.replayMode === "single-turn" || item.replayMode === "full-task"),
				),
			).toBe(true);
			const suite = store.parseImport(content, "json", "single-turn");
			expect(suite.defaults.providerId).toBe("configured-provider");
			expect(suite.defaults.modelId).toBe("configured-model");

			const projectCheck = suite.cases.find((item) => item.id === "deepseek-full-project-check");
			if (projectCheck) expect(replayConfig(projectCheck, suite.defaults).tools).toBe("full");
			const rememberPackageManager = suite.cases.find((item) => item.id === "remember-package-manager");
			if (rememberPackageManager) {
				expect(rememberPackageManager.timeoutMs ?? suite.defaults.timeoutMs).toBe(120000);
			}
		}
	} finally {
		store.db.close();
	}
});

test("portable example suites contain every user-facing case exactly once", () => {
	expect(existsSync(examplesDirectory)).toBe(true);
	const actualIds = readdirSync(examplesDirectory)
		.filter((file) => file.endsWith(".json"))
		.flatMap((file) => {
			const raw = JSON.parse(readFileSync(path.join(examplesDirectory, file), "utf8")) as {
				cases: Array<{ id: string }>;
			};
			return raw.cases.map((item) => item.id);
		});

	expect(actualIds).toHaveLength(new Set(actualIds).size);
	expect(actualIds.sort()).toEqual([
		"build-and-test-slugify",
		"build-slugify",
		"deepseek-bun-command",
		"deepseek-chinese-summary",
		"deepseek-full-create-readme",
		"deepseek-full-project-check",
		"deepseek-full-write-json",
		"deepseek-history-test",
		"deepseek-json-reasoning",
		"deepseek-structured-answer",
		"grading-behavior-optional",
		"grading-json-pass",
		"grading-missing-fail",
		"grading-text-pass",
		"grading-tolerance-pass",
		"grading-value-fail",
		"history-bun-install",
		"multi-turn-project-requirements",
		"remember-package-manager",
		"summary-json",
	].sort());
});
