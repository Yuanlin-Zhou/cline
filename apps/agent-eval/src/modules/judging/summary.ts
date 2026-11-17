import { latestAttempts, type RunItem } from "../../contracts/catalog.js";
import { judgeBindings, judgeResults } from "./bindings.js";
export function judgeSummary(items: RunItem[]) {
	const expand = (items: RunItem[]) =>
		items.flatMap((item) =>
			judgeBindings(item.snapshot.definition).map((b) => ({
				...item,
				id: `${item.id}:${b.bindingId}`,
				judgeGroupKey: JSON.stringify([
					b.scorerId,
					b.sourceRevision,
					b.config.model,
					b.config.rubric,
					b.config.targets,
					b.config.passScore,
					b.config.criteria,
				]),
				scorerName: `${b.name}${b.sourceRevision ? ` · v${b.sourceRevision}` : ""}`,
				snapshot: {
					...item.snapshot,
					definition: { ...item.snapshot.definition, llmJudge: b.config },
				},
				result: item.result
					? {
							...item.result,
							llmJudge: judgeResults(item.result).find(
								(s) => s.bindingId === b.bindingId,
							),
						}
					: undefined,
			})),
		);
	const current = expand(latestAttempts(items)).filter(
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
		const key =
			(item as RunItem & { judgeGroupKey?: string }).judgeGroupKey ??
			JSON.stringify([config.model, config.rubric ?? ""]);
		const g = groups.get(key) ?? {
			model: `${item.scorerName} · ${config.model?.providerId} / ${config.model?.modelId}`,
			rubric: config.rubric ?? "默认评分标准",
			scored: 0,
			sum: 0,
		};
		g.scored++;
		g.sum += score.score;
		groups.set(key, g);
	}
	const scores = expand(items)
		.map((i) => i.result?.llmJudge)
		.filter((s) => s !== undefined);
	const known =
		scores.length > 0 && scores.every((s) => s.usage.totalCost !== undefined);
	return {
		expected: current.length,
		scored: current.filter((i) => i.result?.llmJudge?.status === "scored")
			.length,
		errors: current.filter((i) => i.result?.llmJudge?.status === "error")
			.length,
		insufficient: current.filter(
			(i) =>
				i.result?.llmJudge?.status === "insufficient" ||
				i.result?.llmJudge?.criteriaOutcome === "insufficient",
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
