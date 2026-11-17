import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseEvalSuite } from "../../contracts/schema.js";
import { SqliteCatalog } from "../../infrastructure/sqlite/catalog.js";
import { EvalStore } from "../../infrastructure/sqlite/store.js";
import { applyJudgesOutcome, judgeBindings } from "./bindings.js";
import { parseJudgeConfig } from "./config.js";
import { Scorers } from "./scorers.js";

const config = parseJudgeConfig({
	referenceAnswer: "reference",
	model: {
		providerId: "openai-compatible",
		modelId: "judge",
		baseUrl: "http://localhost/v1",
	},
})!;
test("multiple scorer contracts retain snapshots and reject duplicate/mixed bindings", () => {
	const bindings = [
		{ bindingId: "one", name: "正确性", config },
		{
			bindingId: "two",
			name: "完整性",
			config: { ...config, rubric: "完整性" },
		},
	];
	const parsed = parseEvalSuite({
		cases: [{ id: "case", prompt: "task", llmJudges: bindings }],
	});
	expect(parsed.cases[0].llmJudges).toEqual(bindings);
	expect(() =>
		parseEvalSuite({
			cases: [
				{ id: "case", prompt: "task", llmJudges: bindings, llmJudge: config },
			],
		}),
	).toThrow("不能同时");
	expect(() =>
		parseEvalSuite({
			cases: [
				{ id: "case", prompt: "task", llmJudges: [bindings[0], bindings[0]] },
			],
		}),
	).toThrow("重复");
	expect(judgeBindings({ llmJudge: config })[0].bindingId).toBe("legacy");
});
test("a required failed score takes precedence over insufficient regardless of order", () => {
	const fail: any = {
		affectsOutcome: true,
		status: "scored",
		meetsThreshold: false,
		baseStatus: "passed",
	};
	const unknown: any = {
		affectsOutcome: true,
		status: "insufficient",
		baseStatus: "passed",
	};
	for (const scores of [
		[fail, unknown],
		[unknown, fail],
	]) {
		const result: any = { status: "passed" };
		applyJudgesOutcome(result, scores);
		expect(result.status).toBe("failed");
	}
	const result: any = { status: "passed" };
	applyJudgesOutcome(result, [unknown]);
	expect(result.status).toBe("inconclusive");
	const failed: any = { status: "error" };
	applyJudgesOutcome(failed, [{ ...unknown, baseStatus: "error" }]);
	expect(failed.status).toBe("error");
});
test("scorer revisions, frozen case copies, references and deletion", async () => {
	const directory = await mkdtemp(`${tmpdir()}/scorers-`);
	const store = new EvalStore(directory, { seedModules: false });
	try {
		const catalog = new SqliteCatalog(store);
		const repo = new Scorers(store, catalog);
		const source = await repo.save({
			name: "正确性",
			description: "",
			enabled: true,
			config,
		});
		const module = await catalog.createModule("test");
		const item = await catalog.createCase(
			module.id,
			{},
			{
				id: "case",
				prompt: "task",
				history: [],
				llmJudges: [
					{
						bindingId: "one",
						name: source.name,
						scorerId: source.id,
						sourceRevision: source.revision,
						config,
					},
				],
			},
		);
		const changed = await repo.save(
			{ ...source, config: { ...config, rubric: "新标准" } },
			source.id,
		);
		expect(changed.revision).toBe(2);
		expect(
			(await catalog.getCase(item.id))?.definition.llmJudges?.[0].config.rubric,
		).toBeUndefined();
		await expect(repo.save(source, source.id)).rejects.toThrow("已更新");
		await expect(repo.remove(source.id, 2)).rejects.toThrow("仍被案例引用");
		await catalog.deleteCase(item.id);
		await repo.remove(source.id, 2);
		expect(await repo.list()).toHaveLength(0);
	} finally {
		store.db.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("CSV and summaries keep all scorer identities and costs", async () => {
	const { runCsv } = await import("../runs/export.js");
	const { judgeSummary } = await import("./summary.js");
	const results = ["one", "two"].map((bindingId, i) => ({
		bindingId,
		name: bindingId,
		id: bindingId,
		status: "scored",
		score: 80 + i,
		targets: ["result"],
		affectsOutcome: false,
		passScore: 80,
		meetsThreshold: true,
		configHash: bindingId,
		inputHash: bindingId,
		promptVersion: "v1",
		rationale: "good",
		evidence: [],
		limitations: [],
		startedAt: "now",
		endedAt: "now",
		durationMs: 5,
		usage: { totalCost: 0.1, inputTokens: 2, outputTokens: 3 },
	}));
	const item: any = {
		id: "item",
		runId: "run",
		status: "passed",
		moduleName: "module",
		snapshot: {
			id: "case",
			revision: 1,
			defaults: {},
			definition: {
				id: "case",
				llmJudges: results.map((b) => ({
					bindingId: b.bindingId,
					name: b.name,
					config,
				})),
			},
		},
		result: {
			text: "result",
			durationMs: 1,
			usage: {},
			assertions: [],
			llmJudges: results,
		},
	};
	const summary = judgeSummary([item]);
	expect(summary.scored).toBe(2);
	expect(summary.cost).toBe(0.2);
	const csv = runCsv({ items: [item] } as any);
	expect(csv.split("\r\n")).toHaveLength(3);
	expect(csv).toContain("judge_binding_id");
	expect(csv).toContain('"one"');
	expect(csv).toContain('"two"');
});
