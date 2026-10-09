import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MongoClient, MongoError, type ClientSession, type Db, type Collection } from "mongodb";
import type { EvalCase, EvalDefaults, EvalSuite } from "../types.js";
import { CatalogError, type CatalogRepository } from "./catalog.js";
import { caseFromDocument, caseToDocument, moduleFromDocument, moduleToDocument, caseIndexes, moduleIndexes, caseValidator, moduleValidator, type CaseDocument, type ModuleDocument } from "./mongo-schema.js";
import { parseTransfer, planTransfer, TransferError } from "./transfer.js";
import type { Module, SavedCase } from "./types.js";

export type MongoConfig = { uri: string; database: string; caseCollection: string; moduleCollection: string; verifierCollection?: string };
export function mongoConfig(env = process.env): MongoConfig {
	if (!env.EVAL_MONGODB_URI) throw new CatalogError("MongoDB 模式需要 EVAL_MONGODB_URI", 503);
	const config = { uri: env.EVAL_MONGODB_URI, database: env.EVAL_MONGODB_DATABASE || "agent_eval", caseCollection: env.EVAL_MONGODB_CASE_COLLECTION || "agent_eval_cases", moduleCollection: env.EVAL_MONGODB_MODULE_COLLECTION || "agent_eval_modules", verifierCollection: env.EVAL_MONGODB_VERIFIER_COLLECTION || "agent_eval_verifiers" };
	if (new Set([config.caseCollection, config.moduleCollection, config.verifierCollection]).size !== 3) throw new CatalogError("案例、模块与验证脚本集合不能同名");
	return config;
}
export function mongoFailure(error: unknown): Error {
	if (error instanceof CatalogError || error instanceof TransferError) return error;
	if (error instanceof MongoError) {
		if (error.hasErrorLabel("UnknownTransactionCommitResult")) return new CatalogError("MongoDB 提交结果暂无法确认，请刷新并核对数据后再操作", 503);
		if ("code" in error && error.code === 11000) return new CatalogError("模块内案例 ID 或模块名称已存在，请调整后重试", 409);
		if ("code" in error && error.code === 121) return new CatalogError("MongoDB 文档校验失败，请检查文档结构", 422);
	}
	return new CatalogError("MongoDB 暂不可用，请检查服务端连接并重试；不会回退到 SQLite", 503);
}

export class MongoCatalog implements CatalogRepository {
	readonly cases: Collection<CaseDocument>;
	readonly modules: Collection<ModuleDocument>;
	constructor(readonly client: MongoClient, readonly db: Db, readonly config: MongoConfig) {
		if (new Set([config.caseCollection, config.moduleCollection, config.verifierCollection ?? "agent_eval_verifiers"]).size !== 3) throw new CatalogError("案例、模块与验证脚本集合不能同名");
		this.cases = db.collection(config.caseCollection); this.modules = db.collection(config.moduleCollection);
	}
	static async connect(config: MongoConfig, check = true) {
		let client: MongoClient | undefined;
		try {
			client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 10000, maxPoolSize: 10, ignoreUndefined: true });
			await client.connect();
			const repository = new MongoCatalog(client, client.db(config.database), config);
			if (check) await repository.preflight();
			return repository;
		} catch (error) { await client?.close(); throw mongoFailure(error); }
	}
	async preflight() {
		const hello = await this.db.command({ hello: 1 });
		if (!hello.setName && hello.msg !== "isdbgrid") throw new CatalogError("MongoDB 必须使用副本集或分片部署以支持批量事务", 503);
		for (const [collection, indexes, validator] of [[this.cases, caseIndexes, caseValidator], [this.modules, moduleIndexes, moduleValidator]] as const) {
			if (!(await this.db.listCollections({ name: collection.collectionName }).hasNext())) throw new CatalogError("MongoDB 集合尚未准备，请先运行 mongo:prepare", 503);
			const actual = await collection.listIndexes().toArray();
			for (const expected of indexes) {
				const index = actual.find(i => i.name === expected.name);
				if (!index || !isDeepStrictEqual(index.key, expected.key) || ("unique" in expected && (!index.unique || !isDeepStrictEqual(index.partialFilterExpression, expected.partialFilterExpression))) || (index.collation && index.collation.locale !== "simple")) throw new CatalogError("MongoDB 索引不符合合同，请先运行 mongo:prepare", 503);
			}
			const options = await collection.options();
			if (!isDeepStrictEqual(options.validator, validator) || (options.validationAction && options.validationAction !== "error") || (options.validationLevel && options.validationLevel !== "strict")) throw new CatalogError("MongoDB 文档验证器不符合合同，请先运行 mongo:prepare", 503);
		}
	}
	private async guard<T>(callback: () => Promise<T>): Promise<T> { try { return await callback(); } catch (error) { throw mongoFailure(error); } }
	private async transaction<T>(callback: (session: ClientSession) => Promise<T>): Promise<T> {
		return this.guard(async () => {
			const session = this.client.startSession();
			try { return await session.withTransaction(() => callback(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 5000, timeoutMS: 15000 }); }
			finally { await session.endSession(); }
		});
	}
	private async all(session: ClientSession) {
		const modules = (await this.modules.find({}, { session }).sort({ createdAt: 1, _id: 1 }).toArray()).map(moduleFromDocument);
		const cases = (await this.cases.find({}, { session }).sort({ createdAt: 1, _id: 1 }).toArray()).map(caseFromDocument);
		const ids = new Set(modules.map(m => m.id));
		if (cases.some(c => !ids.has(c.moduleId))) throw new CatalogError("MongoDB 案例引用了不存在的模块，请修正 moduleId", 422);
		return { modules, cases };
	}
	async snapshot() {
		return this.transaction(async session => {
			const { modules, cases } = await this.all(session);
			const active = modules.filter(m => !m.archived); const ids = new Set(active.map(m => m.id));
			return { modules: active, cases: cases.filter(c => !c.archived && ids.has(c.moduleId)) };
		});
	}
	async getCase(id: string) { return this.guard(async () => { const doc = await this.cases.findOne({ _id: id }); return doc ? caseFromDocument(doc) : undefined; }); }
	async getModule(id: string) { return this.guard(async () => { const doc = await this.modules.findOne({ _id: id }); return doc ? moduleFromDocument(doc) : undefined; }); }
	private async source(id: string, session: ClientSession) {
		const doc = await this.cases.findOne({ _id: id }, { session });
		if (!doc) throw new CatalogError("案例不存在或已删除", 404);
		caseFromDocument(doc); return doc;
	}
	private async touch(moduleIds: string[], session: ClientSession, active = true) {
		// Writes on both source and target modules serialize case changes against module archive.
		for (const id of [...new Set(moduleIds)].sort()) {
			const doc = await this.modules.findOne({ _id: id }, { session });
			if (!doc) throw new CatalogError("模块不存在", 404);
			moduleFromDocument(doc);
			if (active && doc.archived) throw new CatalogError("模块已归档", 409);
			await this.modules.updateOne({ _id: id }, { $inc: { writeVersion: 1 } }, { session });
		}
	}
	private moduleName(name: unknown) { if (typeof name !== "string" || !name.trim() || name.length > 80) throw new CatalogError("模块名称须为 1–80 个字符"); return name.trim(); }
	private tags(input: unknown) { return (Array.isArray(input) ? input : []).filter(t => typeof t === "string" && t.trim()).map(t => t.trim()).slice(0, 20) as string[]; }
	async createModule(name: string, description = "", tags: string[] = []) {
		const module: Module = { id: randomUUID(), name: this.moduleName(name), description, tags: this.tags(tags), archived: false, createdAt: new Date().toISOString() };
		await this.guard(() => this.modules.insertOne(moduleToDocument(module))); return module;
	}
	async updateModule(id: string, input: { name?: string; description?: string; tags?: string[] }) {
		return this.transaction(async session => {
			await this.touch([id], session, false);
			const changes: Partial<ModuleDocument> = {};
			if (input.name !== undefined) { changes.name = this.moduleName(input.name); changes.nameKey = changes.name.toLowerCase(); }
			if (input.description !== undefined) changes.description = input.description;
			if (input.tags !== undefined) changes.tags = this.tags(input.tags);
			await this.modules.updateOne({ _id: id }, { $set: changes }, { session });
			return moduleFromDocument((await this.modules.findOne({ _id: id }, { session }))!);
		});
	}
	async archiveModule(id: string) {
		await this.transaction(async session => {
			await this.touch([id], session, false);
			await this.modules.updateOne({ _id: id }, { $set: { archived: true } }, { session });
			await this.cases.updateMany({ moduleId: id, archived: false }, { $set: { archived: true, updatedAt: new Date() }, $inc: { revision: 1 } }, { session });
		});
	}
	async setArchived(kind: "case" | "module", id: string, archived: boolean) {
		if (kind === "module" && archived) return this.archiveModule(id);
		await this.transaction(async session => {
			if (kind === "module") { await this.touch([id], session, false); await this.modules.updateOne({ _id: id }, { $set: { archived } }, { session }); }
			else {
				const doc = await this.source(id, session); await this.touch([doc.moduleId], session, !archived);
				await this.cases.updateOne({ _id: id }, { $set: { archived, updatedAt: new Date() }, $inc: { revision: 1 } }, { session });
			}
		});
	}
	async createCase(moduleId: string, defaults: EvalDefaults, definition: EvalCase) {
		const item: SavedCase = { id: randomUUID(), moduleId, defaults, definition, revision: 1, archived: false, updatedAt: new Date().toISOString() };
		const doc = caseToDocument(item);
		return this.transaction(async session => { await this.touch([moduleId], session); await this.cases.insertOne(doc, { session }); return caseFromDocument(doc); });
	}
	async updateCase(id: string, revision: number, defaults: EvalDefaults, definition: EvalCase) {
		return this.transaction(async session => {
			const source = await this.source(id, session);
			if (source.revision !== revision) throw new CatalogError("案例已被其他页面修改，请刷新后重试", 409);
			if (source.archived) throw new CatalogError("案例已归档", 409);
			await this.touch([source.moduleId], session);
			const next = caseToDocument({ ...caseFromDocument(source), defaults, definition, revision: revision + 1, updatedAt: new Date().toISOString() });
			const result = await this.cases.updateOne({ _id: id, revision }, { $set: { definition: next.definition, defaults: next.defaults, revision: next.revision, updatedAt: next.updatedAt } }, { session });
			if (!result.matchedCount) throw new CatalogError("案例版本已变化", 409);
			return caseFromDocument(next);
		});
	}
	async deleteCase(id: string) {
		await this.transaction(async session => { const source = await this.source(id, session); await this.touch([source.moduleId], session, false); await this.cases.deleteOne({ _id: id }, { session }); });
	}
	async duplicateCase(id: string) {
		const copyId = randomUUID();
		return this.transaction(async session => {
			const doc = await this.source(id, session); if (doc.archived) throw new CatalogError("案例已归档", 409);
			await this.touch([doc.moduleId], session);
			const names = new Set((await this.cases.find({ moduleId: doc.moduleId, archived: false }, { session }).toArray()).map(c => c.definition.id));
			let suffix = 1; while (names.has(`${doc.definition.id}-copy${suffix}`)) suffix++;
			const definition = { ...doc.definition, id: `${doc.definition.id}-copy${suffix}`, description: doc.definition.description ? `${doc.definition.description}（副本）` : "副本" };
			const next: CaseDocument = { ...doc, _id: copyId, revision: 1, archived: false, createdAt: new Date(), updatedAt: new Date(), definition };
			await this.cases.insertOne(next, { session }); return caseFromDocument(next);
		});
	}
	async importCases(moduleId: string, suite: EvalSuite, policy: string) {
		if (!["skip", "version"].includes(policy)) throw new CatalogError("重复项策略无效");
		const ids = suite.cases.map(() => randomUUID());
		return this.transaction(async session => {
			await this.touch([moduleId], session);
			let created = 0; let updated = 0; let skipped = 0;
			for (const [index, definition] of suite.cases.entries()) {
				const previous = await this.cases.findOne({ moduleId, archived: false, "definition.id": definition.id }, { session });
				if (previous && policy === "skip") { skipped++; continue; }
				const next = caseToDocument({ id: previous?._id ?? ids[index], moduleId, definition, defaults: suite.defaults, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() });
				if (previous) { caseFromDocument(previous); await this.cases.updateOne({ _id: previous._id, revision: previous.revision }, { $set: { definition: next.definition, defaults: next.defaults, revision: next.revision, updatedAt: next.updatedAt } }, { session }); updated++; }
				else { await this.cases.insertOne(next, { session }); created++; }
			}
			return { created, updated, skipped };
		});
	}
	async previewTransfer(input: unknown) { const request = parseTransfer(input); return this.transaction(async session => { const all = await this.all(session); return planTransfer(request, all.modules, all.cases); }); }
	async transferCases(input: unknown) {
		const request = parseTransfer(input, true); const ids = request.items.map(() => randomUUID());
		return this.transaction(async session => {
			const all = await this.all(session); const plan = planTransfer(request, all.modules, all.cases);
			if (!plan.canApply) throw new TransferError("目标模块存在同名案例，请调整冲突策略");
			if (plan.items.some((item, index) => item.proposedDefinitionId !== request.items[index].expectedDefinitionId)) throw new TransferError("预览已变化，请重新预览并确认");
			const changing = plan.items.filter(item => item.result !== "unchanged");
			if (changing.length) await this.touch([request.targetModuleId, ...changing.map(i => all.cases.find(c => c.id === i.id)!.moduleId)], session);
			const cases: SavedCase[] = [];
			for (const [index, item] of plan.items.entries()) {
				const source = await this.source(item.id, session);
				if (item.result === "unchanged") { cases.push(caseFromDocument(source)); continue; }
				const next: CaseDocument = { ...source, moduleId: request.targetModuleId, definition: { ...source.definition, id: item.proposedDefinitionId }, updatedAt: new Date() };
				if (request.operation === "copy") { next._id = ids[index]; next.revision = 1; next.createdAt = new Date(); await this.cases.insertOne(next, { session }); }
				else { next.revision++; await this.cases.updateOne({ _id: source._id, revision: source.revision }, { $set: { moduleId: next.moduleId, definition: next.definition, revision: next.revision, updatedAt: next.updatedAt } }, { session }); }
				cases.push(caseFromDocument(next));
			}
			return { cases, copied: plan.summary.copied, moved: plan.summary.moved, unchanged: plan.summary.unchanged };
		});
	}
	async close() { await this.client.close(); }
}
