import { resolveFullTaskRuntime } from "../execution/full-task-runtime.js";
import { type ItemSummary } from "../../contracts/projections.js";
import { preflightJudge } from "../../modules/judging/engine.js";

import { randomUUID } from "node:crypto";

import {
	canRetry,
	latestAttempts,
	type Module,
	type Run,
	type RunItem,
	type SavedCase,
} from "../../contracts/catalog.js";
import type { EvalCase, EvalDefaults } from "../../contracts/evaluation.js";
import { parseEvalSuite } from "../../contracts/schema.js";

import { TransferError } from "../../modules/catalog/transfer.js";

export type RunInput = {
	caseIds?: string[];
	moduleIds?: string[];
	name?: string;
	note?: string;
	concurrency?: number;
	repeatCount?: number;
	useSettings?: boolean;
	replayMode?: string;
	parentRunId?: string;
	rerunScope?: "all" | "failed";
	defaults?: EvalDefaults;
	draft?: Array<{
		moduleId: string;
		definition: EvalCase;
		defaults: EvalDefaults;
	}>;
};
export type RunSource = {
	snapshot: SavedCase;
	moduleName: string;
	verifierSnapshots?: import("../../modules/grading/uploaded-verifiers.js").UploadedVerifier[];
};

export interface RunRepository {
	transaction<T>(fn: () => T): { (): T; immediate(): T };
	get<T>(kind: string, id: string): T | undefined;
	require<T>(kind: string, id: string): T;
	put(kind: string, id: string, value: unknown): void;
	summaries(runId?: string): ItemSummary[];
	activeCases(): SavedCase[];
	settings(): EvalDefaults;
	validateCase?: (definition: EvalCase) => void;
}
const now = () => new Date().toISOString();
export class RunCommands {
	constructor(private repository: RunRepository) {}
	retryRun(id: string, input: unknown): { run: Run; itemIds: string[] } {
		const body = input as {
			requestId: string;
			expectedRetryRevision: number;
			itemIds?: string[];
			statuses?: string[];
		};
		if (
			!body ||
			typeof body.requestId !== "string" ||
			!/^[a-zA-Z0-9-]{1,100}$/.test(body.requestId) ||
			!Number.isInteger(body.expectedRetryRevision) ||
			body.expectedRetryRevision < 0 ||
			(body.itemIds !== undefined &&
				(!Array.isArray(body.itemIds) ||
					!body.itemIds.length ||
					body.itemIds.some((x) => typeof x !== "string") ||
					new Set(body.itemIds).size !== body.itemIds.length))
		)
			throw new TransferError("重试参数无效", 400);
		if (
			body.statuses !== undefined &&
			(!Array.isArray(body.statuses) ||
				!body.statuses.length ||
				new Set(body.statuses).size !== body.statuses.length ||
				body.statuses.some((status) => !canRetry({ status })))
		)
			throw new TransferError("请选择有效的失败原因", 400);
		const fingerprint = JSON.stringify([
			body.expectedRetryRevision,
			body.itemIds ? [...body.itemIds].sort() : null,
			body.statuses ? [...body.statuses].sort() : null,
		]);
		return this.repository
			.transaction(() => {
				const saved = this.repository.get<{
					fingerprint: string;
					response: { run: Run; itemIds: string[] };
				}>("retry", `${id}:${body.requestId}`);
				if (saved) {
					if (saved.fingerprint !== fingerprint)
						throw new TransferError("重试请求标识已用于其他参数");
					return saved.response;
				}
				const run = this.repository.get<Run>("run", id);
				if (!run) throw new TransferError("评测不存在", 404);
				if (
					["queued", "running"].includes(run.status) ||
					(run.retryRevision ?? 0) !== body.expectedRetryRevision
				)
					throw new TransferError("评测已变化或仍在运行，请刷新后重试");
				const latest = latestAttempts(this.repository.summaries(id));
				const selected = body.itemIds
					? latest.filter((i) => body.itemIds!.includes(i.id))
					: latest.filter(
							(i) =>
								canRetry(i) &&
								(!body.statuses || body.statuses.includes(i.status)),
						);
				if (
					!selected.length ||
					(body.itemIds && selected.length !== body.itemIds.length) ||
					selected.some(
						(i) =>
							!canRetry(i) ||
							(body.statuses && !body.statuses.includes(i.status)),
					)
				)
					throw new TransferError("请选择当前未通过的最新执行");
				const itemIds: string[] = [];
				for (const previous of selected) {
					const root = this.repository.require<RunItem>(
						"item",
						previous.rootItemId ?? previous.id,
					);

					const item: RunItem = {
						id: randomUUID(),
						runId: id,
						rootItemId: root.id,
						previousItemId: previous.id,
						attempt: (previous.attempt ?? 0) + 1,
						round: root.round ?? 1,
						snapshot: structuredClone(root.snapshot),
						moduleName: root.moduleName,
						verifierSnapshots: structuredClone(root.verifierSnapshots ?? []),
						status: "queued",
						text: "",
					};
					this.repository.put("item", item.id, item);
					itemIds.push(item.id);
				}
				run.status = "queued";
				delete run.endedAt;
				run.retryRevision = (run.retryRevision ?? 0) + 1;
				this.repository.put("run", id, run);
				const response = { run, itemIds };
				this.repository.put("retry", `${id}:${body.requestId}`, {
					fingerprint,
					response,
				});
				return response;
			})
			.immediate();
	}
	createRun(
		input: RunInput,
		resolvedSources?: RunSource[],
		validated = false,
	): Run {
		const concurrency = input.concurrency ?? 1;
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
			throw new Error("并发数须为 1–4");
		const repeatCount = input.repeatCount === undefined ? 1 : input.repeatCount;
		if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100)
			throw new Error("重复轮数须为 1–100 的整数");
		if (
			input.rerunScope !== undefined &&
			!["all", "failed"].includes(input.rerunScope)
		)
			throw new Error("重跑范围无效");
		if (
			input.replayMode &&
			!["single-turn", "full-task", "function-call"].includes(input.replayMode)
		)
			throw new Error("回放方式无效");
		let sources: RunSource[];
		if (resolvedSources) sources = resolvedSources;
		else if (input.draft?.length) {
			sources = input.draft.map((draft) => ({
				snapshot: {
					id: randomUUID(),
					moduleId: draft.moduleId,
					revision: 0,
					definition: {
						...draft.definition,
						replayMode: input.replayMode as
							| "single-turn"
							| "full-task"
							| "function-call",
					},
					defaults: draft.defaults,
					updatedAt: now(),
				},
				moduleName: this.repository.require<Module>("module", draft.moduleId)
					.name,
			}));
		} else if (input.parentRunId) {
			const items = latestAttempts(
				this.repository.summaries(input.parentRunId),
			).filter(
				(i) =>
					input.rerunScope === "all" ||
					["failed", "error", "cancelled", "inconclusive"].includes(i.status),
			);
			// Repeated failures select a case once, retaining the original input snapshot.
			sources = [
				...new Map(
					items.map((s) => {
						const i = this.repository.require<RunItem>("item", s.id);
						return [
							i.snapshot.id,
							{
								snapshot: i.snapshot,
								moduleName: i.moduleName,
								verifierSnapshots: i.verifierSnapshots,
							},
						] as const;
					}),
				).values(),
			];
		} else {
			if (
				input.caseIds?.some((id) => !this.repository.get("case", id)) ||
				input.moduleIds?.some((id) => !this.repository.get("module", id))
			)
				throw new Error("选中的案例或模块不存在");
			sources = this.repository
				.activeCases()
				.filter(
					(c) =>
						input.caseIds?.includes(c.id) ||
						input.moduleIds?.includes(c.moduleId),
				)
				.map((snapshot) => ({
					snapshot,
					moduleName: this.repository.require<Module>(
						"module",
						snapshot.moduleId,
					).name,
				}));
		}
		if (!sources.length) throw new Error("请选择至少一个案例；空模块无法执行");
		for (const source of validated ? [] : sources) {
			const definition = {
				...source.snapshot.definition,
				...(input.replayMode ? { replayMode: input.replayMode } : {}),
			};
			const parsed = parseEvalSuite({
				defaults: source.snapshot.defaults,
				cases: [definition],
			}).cases[0];
			preflightJudge(parsed.llmJudge);
			this.repository.validateCase?.(parsed);
		}
		const run: Run = {
			id: randomUUID(),
			name:
				input.name?.trim() ||
				`回归评测 · ${new Date().toLocaleString("zh-CN")}`,
			note: input.note?.trim(),
			status: "queued",
			concurrency,
			repeatCount,
			createdAt: now(),
			parentRunId: input.parentRunId,
		};
		this.repository.transaction(() => {
			this.repository.put("run", run.id, run);
			for (let round = 1; round <= repeatCount; round++)
				for (const source of sources) {
					const snapshot = structuredClone(source.snapshot);
					if (input.useSettings) snapshot.defaults = this.repository.settings();
					if (input.defaults)
						snapshot.defaults = { ...snapshot.defaults, ...input.defaults };
					if (input.replayMode)
						snapshot.definition.replayMode = input.replayMode as
							| "single-turn"
							| "full-task"
							| "function-call";
					if (snapshot.definition.replayMode === "full-task")
						snapshot.definition.fullTaskRuntime = resolveFullTaskRuntime(
							snapshot.definition,
							snapshot.defaults,
							!!input.parentRunId,
						);
					const item: RunItem = {
						id: randomUUID(),
						runId: run.id,
						round,
						snapshot,
						verifierSnapshots: source.verifierSnapshots,
						moduleName: source.moduleName,
						status: "queued",
						text: "",
					};
					this.repository.put("item", item.id, item);
				}
		})();
		return run;
	}
}
