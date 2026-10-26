import { latestAttempts, type RunItem } from "../web/types.js";
import type { JudgeResult } from "./types.js";
export function judgeSummary(items: RunItem[]) {
	const current = latestAttempts(items).filter(
		(i) => i.snapshot.definition.llmJudge?.enabled,
	);
	const groups = new Map<
		string,
		{ model: string; rubric: string; scored: number; sum: number }
	>();
	for (const item of current) {
		const score = item.result?.llmJudge;
		if (score?.status !== "scored" || score.score === null) continue;
		const config = item.snapshot.definition.llmJudge!;
		const key = JSON.stringify([config.model, config.rubric ?? ""]);
		const g = groups.get(key) ?? {
			model: `${config.model?.providerId} / ${config.model?.modelId}`,
			rubric: config.rubric ?? "默认评分标准",
			scored: 0,
			sum: 0,
		};
		g.scored++;
		g.sum += score.score;
		groups.set(key, g);
	}
	const scores = items
		.map((i) => i.result?.llmJudge)
		.filter((s): s is JudgeResult => !!s);
	const known =
		scores.length > 0 && scores.every((s) => s.usage.totalCost !== undefined);
	return {
		expected: current.length,
		scored: current.filter((i) => i.result?.llmJudge?.status === "scored")
			.length,
		errors: current.filter((i) => i.result?.llmJudge?.status === "error")
			.length,
		insufficient: current.filter(
			(i) => i.result?.llmJudge?.status === "insufficient",
		).length,
		unscored: current.filter((i) => i.result?.llmJudge?.status !== "scored")
			.length,
		pending: current.filter((i) => !i.result?.llmJudge).length,
		groups: [...groups.values()].map((g) => ({
			...g,
			average: g.sum / g.scored,
		})),
		inputTokens: scores.reduce((n, s) => n + (s.usage.inputTokens ?? 0), 0),
		outputTokens: scores.reduce((n, s) => n + (s.usage.outputTokens ?? 0), 0),
		durationMs: scores.reduce((n, s) => n + s.durationMs, 0),
		cost: known ? scores.reduce((n, s) => n + s.usage.totalCost!, 0) : null,
	};
}
