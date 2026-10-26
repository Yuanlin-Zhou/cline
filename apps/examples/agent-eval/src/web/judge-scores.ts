import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseJudgeConfig } from "../judge/config.js";
import {
	preflightJudge,
	scoreWithJudge,
	judgeSecrets,
	redactJudgeInput,
} from "../judge/engine.js";
import { buildJudgeInput } from "../judge/input.js";
import type { JudgeConfig, JudgeInput, JudgeResult } from "../judge/types.js";
import { historicalEvidence } from "../grading/validation-context.js";
import { sha256 } from "../grading/evidence.js";
import { TransferError } from "./transfer.js";
import { EvalStore } from "./store.js";
import type { RunItem } from "./types.js";
export type JudgeScoreTask = {
	id: string;
	runId: string;
	itemId: string;
	status: "queued" | "running" | "completed" | "error" | "cancelled";
	createdAt: string;
	endedAt?: string;
	config: JudgeConfig;
	input: JudgeInput;
	result?: JudgeResult;
	error?: string;
	trial: true;
};
export class JudgeScores {
	private controllers = new Map<string, AbortController>();
	private tasks = new Map<string, Promise<void>>();
	private preparing = 0;
	private closing = false;
	constructor(readonly store: EvalStore) {
		for (const task of store.list<JudgeScoreTask>("judge-score"))
			if (["queued", "running"].includes(task.status)) {
				task.status = "error";
				task.error = "服务重启，试评分已中断；不会自动再次调用模型";
				task.endedAt = new Date().toISOString();
				store.put("judge-score", task.id, task);
			}
	}
	directory(item: RunItem) {
		return path.join(this.store.directory, "runs", item.runId, item.id);
	}
	config(item: RunItem, value: unknown) {
		const config = parseJudgeConfig(value, item.snapshot.definition.replayMode);
		if (!config?.enabled) throw Error("请启用并配置 LLM 评分");
		return config;
	}
	async preview(item: RunItem, value: unknown) {
		if (["queued", "running"].includes(item.status))
			throw Error("请选择已结束的执行进行试评分");
		const config = this.config(item, value);
		const directory = this.directory(item);
		const evidence = await historicalEvidence(directory, item);
		return {
			config,
			input: redactJudgeInput(
				await buildJudgeInput(directory, evidence, config),
				judgeSecrets(config),
			),
		};
	}
	list(item: RunItem) {
		return this.store
			.list<JudgeScoreTask>("judge-score")
			.filter((t) => t.runId === item.runId && t.itemId === item.id)
			.reverse()
			.map((t) => this.public(t));
	}
	get(id: string, item: RunItem) {
		const task = this.store.get<JudgeScoreTask>("judge-score", id);
		if (!task || task.runId !== item.runId || task.itemId !== item.id)
			throw new TransferError("试评分不存在", 404);
		return task;
	}
	public(task: JudgeScoreTask) {
		const { input, ...rest } = task;
		return rest;
	}
	async create(item: RunItem, body: { requestId: string; config: unknown }) {
		if (this.closing) throw Error("评分服务正在停止");
		if (
			typeof body?.requestId !== "string" ||
			!/^[a-zA-Z0-9-]{1,100}$/.test(body.requestId)
		)
			throw Error("试评分请求标识无效");
		const config = this.config(item, body.config),
			key = `${item.id}:${body.requestId}`,
			fingerprint = sha256(JSON.stringify(config));
		const prior = this.store.get<{ fingerprint: string; id: string }>(
			"judge-request",
			key,
		);
		if (prior) {
			if (prior.fingerprint !== fingerprint)
				throw new TransferError("同一试评分请求不能更改配置");
			return this.public(this.get(prior.id, item));
		}
		if (this.tasks.size + this.preparing >= 4)
			throw new TransferError("试评分任务较多，请稍后再试", 429);
		this.preparing++;
		try {
			preflightJudge(config);
			const { input } = await this.preview(item, config);
			if (this.closing) throw Error("评分服务正在停止");
			const task: JudgeScoreTask = {
				id: randomUUID(),
				runId: item.runId,
				itemId: item.id,
				status: "queued",
				createdAt: new Date().toISOString(),
				config: structuredClone(config),
				input: structuredClone(input),
				trial: true,
			};
			const selected = this.store.db
				.transaction(() => {
					const previous = this.store.get<{ fingerprint: string; id: string }>(
						"judge-request",
						key,
					);
					if (previous) {
						if (previous.fingerprint !== fingerprint)
							throw new TransferError("试评分请求配置已变化");
						return { task: this.get(previous.id, item), created: false };
					}
					this.store.put("judge-score", task.id, task);
					this.store.put("judge-request", key, { fingerprint, id: task.id });
					return { task, created: true };
				})
				.immediate();
			if (!selected.created) return this.public(selected.task);
			const controller = new AbortController();
			this.controllers.set(task.id, controller);
			const work = Promise.resolve().then(async () => {
				try {
					task.status = "running";
					this.store.put("judge-score", task.id, task);
					task.result = await scoreWithJudge({
						config: task.config,
						directory: this.directory(item),
						evidence: structuredClone(
							item.result!.evidence ??
								(await historicalEvidence(this.directory(item), item)),
						),
						caseId: item.snapshot.definition.id,
						sessionId: item.result?.sessionId,
						signal: controller.signal,
						id: task.id,
						prepared: task.input,
						outputDirectory: path.join(
							this.directory(item),
							"judge-scores",
							task.id,
						),
					});
					task.status = controller.signal.aborted ? "cancelled" : "completed";
				} catch (error) {
					task.status = controller.signal.aborted ? "cancelled" : "error";
					task.error = error instanceof Error ? error.message : String(error);
				} finally {
					task.endedAt = new Date().toISOString();
					this.store.put("judge-score", task.id, task);
					this.controllers.delete(task.id);
					this.tasks.delete(task.id);
				}
			});
			this.tasks.set(task.id, work);
			return this.public(task);
		} finally {
			this.preparing--;
		}
	}
	cancel(id: string) {
		this.controllers.get(id)?.abort(Error("试评分已取消"));
	}
	async close() {
		this.closing = true;
		for (const c of this.controllers.values()) c.abort(Error("服务停止"));
		while (this.preparing)
			await new Promise((resolve) => setTimeout(resolve, 10));
		await Promise.allSettled(this.tasks.values());
	}
	async officialInput(item: RunItem) {
		if (!item.result?.llmJudge) throw Error("本次执行没有正式评分");
		return JSON.parse(
			await readFile(
				path.join(
					this.directory(item),
					"judge",
					item.result.llmJudge.id,
					"input.json",
				),
				"utf8",
			),
		) as JudgeInput;
	}
}
