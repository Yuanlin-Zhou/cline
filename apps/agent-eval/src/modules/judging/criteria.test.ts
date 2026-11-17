import { expect, test } from "bun:test";
import { applyJudgesOutcome, judgeDecision } from "./bindings.js";
import { parseJudgeConfig } from "./config.js";
import { applyJudgeOutcome, parseJudgeResponse } from "./engine.js";
import type { JudgeInput, JudgeResult } from "./types.js";

const criteria = [
	{ id: "a", name: "准确性", standard: "结论准确" },
	{ id: "b", name: "完整性", standard: "覆盖全部任务要求" },
];
const input: JudgeInput = {
	promptVersion: "reference-judge-criteria-v2",
	task: { prompt: "task", history: [], replayMode: "single-turn" },
	referenceAnswer: "answer",
	rubric: "标准",
	criteria,
	targets: ["result"],
	sources: [
		{
			id: "result.final_response",
			title: "回复",
			content: "answer",
			completeness: "complete",
		},
	],
	limitations: [],
};
const criterion = (criterionId: string, status = "pass") => ({
	criterionId,
	status,
	rationale: "条目理由",
	evidence:
		status === "insufficient"
			? []
			: [{ ref: "result.final_response", quote: "answer" }],
});
const response = (statuses = ["pass", "pass"], score = 5) => ({
	status: "scored",
	score,
	rationale: "总分仅展示",
	evidence: [{ ref: "result.final_response" }],
	criteriaResults: statuses.map((s, i) => criterion(criteria[i].id, s)),
});
test("criteria config validates stable unique ids and nonempty standards", () => {
	const base = {
		referenceAnswer: "answer",
		model: {
			providerId: "openai-compatible",
			modelId: "judge",
			baseUrl: "http://localhost/v1",
		},
	};
	expect(parseJudgeConfig({ ...base, criteria })?.criteria).toEqual(criteria);
	expect(() =>
		parseJudgeConfig({ ...base, criteria: [criteria[0], criteria[0]] }),
	).toThrow("重复");
	expect(() =>
		parseJudgeConfig({
			...base,
			criteria: [{ ...criteria[0], standard: " " }],
		}),
	).toThrow("判定标准");
	expect(parseJudgeConfig(base)?.criteria).toBeUndefined();
});
test("per-criterion decisions override numeric score and preserve reason, evidence and configured ordering", () => {
	for (const [statuses, score, expected] of [
		[["pass", "pass"], 0, "passed"],
		[["pass", "fail"], 100, "failed"],
		[["pass", "insufficient"], 100, "inconclusive"],
		[["insufficient", "fail"], 100, "failed"],
	] as const) {
		const raw = response([...statuses], score);
		raw.criteriaResults.reverse();
		const parsed = parseJudgeResponse(JSON.stringify(raw), input);
		const judge = {
			...parsed,
			criteria,
			affectsOutcome: true,
			passScore: 80,
			meetsThreshold: score >= 80,
			baseStatus: "passed",
		} as JudgeResult;
		expect(parsed.criteriaResults?.map((c) => c.criterionId)).toEqual([
			"a",
			"b",
		]);
		const result: any = { status: "passed" };
		applyJudgesOutcome(result, [judge]);
		expect(result.status).toBe(expected);
		const legacyPath: any = { status: "passed" };
		applyJudgeOutcome(legacyPath, judge);
		expect(legacyPath.status).toBe(expected);
		const readonly: any = { status: "passed" };
		applyJudgesOutcome(readonly, [{ ...judge, affectsOutcome: false }]);
		expect(readonly.status).toBe("passed");
	}
});
test("missing, duplicate, unknown criteria and fabricated evidence are errors rather than passes", () => {
	const valid = response();
	for (const entries of [
		undefined,
		[],
		[criterion("a")],
		[criterion("a"), criterion("a")],
		[criterion("a"), criterion("unknown")],
		[criterion("a", "unknown"), criterion("b")],
		[{ ...criterion("a"), status: ["pass"] }, criterion("b")],
		[criterion("a"), { ...criterion("b"), evidence: [{ ref: "not-sent" }] }],
		[
			criterion("a"),
			{
				...criterion("b"),
				evidence: [{ ref: "result.final_response", quote: "fabricated" }],
			},
		],
		[criterion("a"), { ...criterion("b"), evidence: [] }],
	])
		expect(() =>
			parseJudgeResponse(
				JSON.stringify({ ...valid, criteriaResults: entries }),
				input,
			),
		).toThrow();
	const noCriteria = { ...input, criteria: undefined };
	expect(() => parseJudgeResponse(JSON.stringify(valid), noCriteria)).toThrow(
		"未配置",
	);
	const parsed = parseJudgeResponse(
		JSON.stringify({ ...valid, criteriaResults: undefined }),
		noCriteria,
	);
	expect(parsed.criteriaResults).toBeUndefined();
	expect(
		judgeDecision({
			...parsed,
			passScore: 80,
			meetsThreshold: false,
		} as JudgeResult),
	).toBe("fail");
});
