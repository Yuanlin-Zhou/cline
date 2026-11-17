import type { EvalCase, EvalCaseResult } from "../../contracts/evaluation.js";
import { parseJudgeConfig } from "./config.js";
import type { JudgeConfig, JudgeResult } from "./types.js";
export type JudgeBinding = {
	bindingId: string;
	name: string;
	scorerId?: string;
	sourceRevision?: number;
	config: JudgeConfig;
};
export type BoundJudgeResult = JudgeResult & {
	bindingId: string;
	name: string;
	scorerId?: string;
	sourceRevision?: number;
};
export function judgeBindings(
	value: Pick<EvalCase, "llmJudge" | "llmJudges">,
): JudgeBinding[] {
	return (
		value.llmJudges ??
		(value.llmJudge
			? [
					{
						bindingId: "legacy",
						name: "原案例评分配置",
						config: value.llmJudge,
					},
				]
			: [])
	);
}
export function judgeResults(
	value?: Pick<EvalCaseResult, "llmJudge" | "llmJudges">,
): BoundJudgeResult[] {
	return (
		value?.llmJudges ??
		(value?.llmJudge
			? [{ ...value.llmJudge, bindingId: "legacy", name: "原案例评分配置" }]
			: [])
	);
}
export function parseJudgeBindings(
	value: unknown,
	legacy: unknown,
	mode: string,
): JudgeBinding[] | undefined {
	if (value === undefined) return;
	if (legacy !== undefined) throw Error("llmJudge 与 llmJudges 不能同时配置");
	if (!Array.isArray(value)) throw Error("llmJudges 必须为数组");
	const ids = new Set<string>(),
		sources = new Set<string>();
	return value.map((b, i) => {
		if (
			!b ||
			typeof b !== "object" ||
			Array.isArray(b) ||
			Object.keys(b).some(
				(k) =>
					![
						"bindingId",
						"name",
						"scorerId",
						"sourceRevision",
						"config",
					].includes(k),
			)
		)
			throw Error(`评分器 ${i + 1} 格式无效`);
		if (
			typeof b.bindingId !== "string" ||
			!/^[a-zA-Z0-9-]{1,100}$/.test(b.bindingId) ||
			ids.has(b.bindingId)
		)
			throw Error("评分绑定 ID 无效或重复");
		ids.add(b.bindingId);
		if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120)
			throw Error("评分器名称须为 1–120 个字符");
		if (b.scorerId !== undefined) {
			if (
				typeof b.scorerId !== "string" ||
				!b.scorerId ||
				sources.has(b.scorerId) ||
				!Number.isSafeInteger(b.sourceRevision) ||
				b.sourceRevision < 1
			)
				throw Error("评分器来源无效或重复");
			sources.add(b.scorerId);
		}
		try {
			const config = parseJudgeConfig(b.config, mode);
			if (!config) throw Error("缺少配置");
			return { ...b, config };
		} catch (e) {
			throw Error(`${b.name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	});
}
export function judgeDecision(
	score: JudgeResult,
): "pass" | "fail" | "insufficient" {
	if (!["scored", "insufficient"].includes(score.status)) return "insufficient";
	if (score.criteria?.length || score.criteriaResults?.length) {
		const results = score.criteriaResults;
		if (!results?.length) return "insufficient";
		return results.some((r) => r.status === "fail")
			? "fail"
			: results.some((r) => r.status === "insufficient")
				? "insufficient"
				: "pass";
	}
	return score.status === "scored"
		? score.meetsThreshold
			? "pass"
			: "fail"
		: "insufficient";
}
export function applyJudgesOutcome(
	result: EvalCaseResult,
	scores: JudgeResult[],
) {
	const base = scores[0]?.baseStatus ?? result.status;
	if (base !== "passed") return;
	const decisions = scores.filter((s) => s.affectsOutcome).map(judgeDecision);
	result.status = decisions.includes("fail")
		? "failed"
		: decisions.includes("insufficient")
			? "inconclusive"
			: "passed";
}
