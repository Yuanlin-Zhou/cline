import {
	latestAttempts,
	summarize,
	type RunDetail,
} from "../../contracts/catalog.js";
import { gradingSummary } from "../grading/summary.js";
import { judgeSummary } from "../judging/summary.js";
import { buildRepeatReport } from "./repeat-report.js";

export const csvCell = (value: unknown) =>
	`"${String(value ?? "")
		.replace(/^[=+@\-\t\r]/, "'$&")
		.replaceAll('"', '""')}"`;

export function runDocument(run: RunDetail) {
	return {
		...run,
		latestItemIds: latestAttempts(run.items).map((i) => i.id),
		retryCount: run.items.filter((i) => (i.attempt ?? 0) > 0).length,
		summary: summarize(run.items),
		judgeSummary: judgeSummary(run.items),
		gradingSummary: gradingSummary(run.items),
		repeatReport: buildRepeatReport(run),
	};
}
export function runCsv(run: RunDetail) {
	const latestIds = new Set(latestAttempts(run.items).map((i) => i.id));
	const rows = [
		[
			"module",
			"case",
			"revision",
			"mode",
			"model",
			"status",
			"duration_ms",
			"tokens",
			"cost",
			"error",
			"round",
			"item_id",
			"output",
			"failed_assertions",
			"session_id",
			"grading_mode",
			"grading_verdict",
			"grading_status",
			"failed_rules",
			"evidence_ids",
			"rule_hash",
			"root_item_id",
			"attempt",
			"previous_item_id",
			"is_latest",
			"judge_score",
			"judge_status",
			"judge_targets",
			"judge_threshold",
			"judge_affects_outcome",
			"judge_meets_threshold",
			"judge_reason",
			"judge_provider",
			"judge_model",
			"judge_id",
			"judge_input_hash",
			"judge_config_hash",
			"judge_prompt_version",
			"judge_input_tokens",
			"judge_output_tokens",
			"judge_cost",
			"judge_duration_ms",
		],
		...run.items.map((i) => [
			i.moduleName,
			i.snapshot.definition.id,
			i.snapshot.revision,
			i.snapshot.definition.replayMode ?? "single-turn",
			i.snapshot.defaults.modelId,
			i.status,
			i.result?.durationMs,
			(i.result?.usage.inputTokens ?? 0) + (i.result?.usage.outputTokens ?? 0),
			i.result?.usage.totalCost ?? "",
			i.error ?? i.result?.error ?? "",
			i.round ?? 1,
			i.id,
			i.result?.text ?? i.text,
			i.result?.assertions
				.filter((a) => !a.passed)
				.map((a) => a.message)
				.join("; "),
			i.result?.sessionId,
			i.snapshot.definition.grading ? "task" : "legacy-text",
			i.result?.grading?.verdict,
			i.result?.grading?.status,
			i.result?.grading?.results
				.filter((r) => r.status === "fail")
				.map((r) => r.id)
				.join("; "),
			i.result?.evidence?.refs.map((r) => r.id).join("; "),
			i.result?.grading?.ruleHash,
			i.rootItemId ?? i.id,
			i.attempt ?? 0,
			i.previousItemId ?? "",
			latestIds.has(i.id),
			i.result?.llmJudge?.score,
			i.result?.llmJudge?.status,
			i.result?.llmJudge?.targets.join(";"),
			i.result?.llmJudge?.passScore,
			i.result?.llmJudge?.affectsOutcome,
			i.result?.llmJudge?.meetsThreshold,
			i.result?.llmJudge?.rationale,
			i.result?.llmJudge?.model?.providerId,
			i.result?.llmJudge?.model?.modelId,
			i.result?.llmJudge?.id,
			i.result?.llmJudge?.inputHash,
			i.result?.llmJudge?.configHash,
			i.result?.llmJudge?.promptVersion,
			i.result?.llmJudge?.usage.inputTokens,
			i.result?.llmJudge?.usage.outputTokens,
			i.result?.llmJudge?.usage.totalCost,
			i.result?.llmJudge?.durationMs,
		]),
	];
	return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}
