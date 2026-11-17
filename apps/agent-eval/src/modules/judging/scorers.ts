import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { EvalStore } from "../../infrastructure/sqlite/store.js";
import { CatalogError, type CatalogRepository } from "../catalog/repository.js";
import { parseJudgeConfig } from "./config.js";
import type { Scorer } from "./types.js";

export type { Scorer } from "./types.js";
export class Scorers {
	constructor(
		private store: EvalStore,
		private catalog: CatalogRepository,
		private db?: Db,
	) {}
	private collection() {
		if (!this.db) throw Error("MongoDB 未配置");
		return this.db.collection<Scorer & { _id: string }>(
			"agent_eval_llm_scorers",
		);
	}
	async list(): Promise<Scorer[]> {
		if (
			this.db &&
			!(await this.db
				.listCollections(
					{ name: "agent_eval_llm_scorers", type: "collection" },
					{ nameOnly: true },
				)
				.hasNext())
		)
			throw new CatalogError("评分器集合尚未准备，请运行 mongo:prepare", 503);
		return this.db
			? (await this.collection().find().toArray()).map(({ _id, ...s }) => s)
			: this.store.list<Scorer>("llm-scorer");
	}
	async get(id: string) {
		return (await this.list()).find((s) => s.id === id);
	}
	async save(input: any, id?: string) {
		if (this.db) await this.list();
		if (!input || typeof input !== "object")
			throw new CatalogError("缺少评分器配置");
		if (
			typeof input.name !== "string" ||
			!input.name.trim() ||
			input.name.length > 120
		)
			throw new CatalogError("名称须为 1–120 个字符");
		if (
			typeof input.description !== "string" ||
			input.description.length > 4000
		)
			throw new CatalogError("说明须为最多 4000 个字符的文字");
		if (typeof input.enabled !== "boolean")
			throw new CatalogError("启用状态无效");
		const old = id ? await this.get(id) : undefined;
		if (id && !old) throw new CatalogError("评分器不存在", 404);
		if (old && input.revision !== old.revision)
			throw new CatalogError("评分器已更新，请重新加载", 409);
		// A reusable scorer has no case-specific reference answer or artifact paths.
		const parsed = parseJudgeConfig({
			...input.config,
			enabled: true,
			referenceAnswer: "评分器配置校验",
			resultFiles: [],
		});
		const config = { ...parsed!, referenceAnswer: "", resultFiles: [] };
		const at = new Date().toISOString();
		const value: Scorer = {
			id: old?.id ?? randomUUID(),
			name: input.name.trim(),
			description: input.description,
			enabled: input.enabled,
			revision: (old?.revision ?? 0) + 1,
			config,
			createdAt: old?.createdAt ?? at,
			updatedAt: at,
		};
		if (this.db) {
			if (old) {
				const r = await this.collection().replaceOne(
					{ _id: old.id, revision: old.revision },
					value,
				);
				if (!r.matchedCount) throw new CatalogError("评分器已更新", 409);
			} else await this.collection().insertOne({ ...value, _id: value.id });
		} else
			this.store
				.transaction(() => {
					if (
						old &&
						this.store.get<Scorer>("llm-scorer", old.id)?.revision !==
							old.revision
					)
						throw new CatalogError("评分器已更新", 409);
					this.store.put("llm-scorer", value.id, value);
				})
				.immediate();
		return value;
	}
	async validateBindings(
		definition: import("../../contracts/evaluation.js").EvalCase,
		previous?: import("../../contracts/evaluation.js").EvalCase,
		imported = false,
	) {
		for (const b of definition.llmJudges ?? []) {
			if (!b.scorerId) continue;
			const source = await this.get(b.scorerId);
			if (imported && !source) {
				delete b.scorerId;
				delete b.sourceRevision;
				continue;
			}
			const old = previous?.llmJudges?.find(
				(v) =>
					v.bindingId === b.bindingId &&
					v.scorerId === b.scorerId &&
					v.sourceRevision === b.sourceRevision,
			);
			if (!source)
				throw new CatalogError(
					`${b.name} 的来源已删除，请重新选择或改用独立配置`,
					409,
				);
			if (
				!old &&
				!imported &&
				(!source.enabled || source.revision !== b.sourceRevision)
			)
				throw new CatalogError(`${b.name} 已停用或更新，请刷新评分器列表`, 409);
		}
	}
	async remove(id: string, revision: number) {
		const old = await this.get(id);
		if (!old) throw new CatalogError("评分器不存在", 404);
		if (old.revision !== revision) throw new CatalogError("评分器已更新", 409);
		const refs = (await this.catalog.allResources()).cases.filter((c) =>
			c.definition.llmJudges?.some((b) => b.scorerId === id),
		);
		if (refs.length)
			throw new CatalogError(
				`评分器仍被案例引用：${refs.map((c) => c.definition.id).join("、")}。请先移除引用或停用评分器。`,
				409,
			);
		if (this.db) {
			const r = await this.collection().deleteOne({ _id: id, revision });
			if (!r.deletedCount) throw new CatalogError("评分器已更新", 409);
		} else
			this.store
				.transaction(() => {
					if (this.store.get<Scorer>("llm-scorer", id)?.revision !== revision)
						throw new CatalogError("评分器已更新", 409);
					this.store.deleteRecord("llm-scorer", id);
				})
				.immediate();
	}
}
