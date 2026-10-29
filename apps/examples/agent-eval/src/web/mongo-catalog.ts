import { caseSummary, type CaseSummary } from "./projections.js";
import { confirmModuleDeletion, checkDeletion } from "./resource-management.js";
import { randomUUID } from "node:crypto";
import { MongoClient, MongoError, type ClientSession, type Db, type Collection } from "mongodb";
import type { EvalCase, EvalDefaults, EvalSuite } from "../types.js";
import { CatalogError, type CatalogRepository } from "./catalog.js";
import { caseFromDocument, caseToDocument, moduleFromDocument, moduleToDocument, type CaseDocument, type ModuleDocument } from "./mongo-schema.js";
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
		for (const collection of [this.cases, this.modules]) {
			const exists = await this.db
				.listCollections(
					{ name: collection.collectionName, type: "collection" },
					{ nameOnly: true },
				)
				.hasNext();
			if (!exists)
				throw new CatalogError(
					`MongoDB 集合 ${collection.collectionName} 尚未创建，请由管理员执行建集合命令`,
					503,
				);
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
 async summaries(){
  return this.transaction(async session=>{
   const modules=(await this.modules.find({archived:false},{session}).sort({createdAt:1,_id:1}).toArray()).map(moduleFromDocument);
   const docs=await this.cases.find({archived:false,moduleId:{$in:modules.map(m=>m.id)}},{session,projection:{_id:1,moduleId:1,revision:1,updatedAt:1,archived:1,"definition.id":1,"definition.description":1,"definition.tags":1,"definition.replayMode":1,"defaults.providerId":1,"defaults.modelId":1}}).sort({createdAt:1,_id:1}).toArray();
   const cases=docs.map(doc=>{
    if(typeof doc._id!=="string"||typeof doc.moduleId!=="string"||!Number.isSafeInteger(doc.revision)||doc.revision<1||!(doc.updatedAt instanceof Date)||!Number.isFinite(doc.updatedAt.getTime())||typeof doc.definition?.id!=="string"||!doc.definition.id||typeof doc.defaults?.providerId!=="string"||typeof doc.defaults.modelId!=="string"||!doc.defaults.providerId||!doc.defaults.modelId||(doc.definition.description!==undefined&&typeof doc.definition.description!=="string")||(doc.definition.tags!==undefined&&(!Array.isArray(doc.definition.tags)||doc.definition.tags.some(t=>typeof t!=="string"||!t.trim())))||!["single-turn","full-task","function-call"].includes(doc.definition.replayMode??""))throw new CatalogError("MongoDB 案例摘要不符合合同",422);
    return caseSummary({...doc,id:doc._id,updatedAt:doc.updatedAt.toISOString()});
   });
   return {modules,cases};
  });
 }
 async selected(input:{caseIds?:string[];moduleIds?:string[]}){
  return this.transaction(async session=>{
   const modules=(await this.modules.find({archived:false},{session}).sort({createdAt:1,_id:1}).toArray()).map(moduleFromDocument);
   const docs=await this.cases.find({archived:false,moduleId:{$in:modules.map(m=>m.id)},$or:[{_id:{$in:input.caseIds??[]}},{moduleId:{$in:input.moduleIds??[]}}]},{session}).sort({createdAt:1,_id:1}).toArray();
   return {modules,cases:docs.map(caseFromDocument)};
  });
 }

	async allResources() { return this.transaction(session => this.all(session)); }
	async deleteModule(id: string, input: unknown) {
		return this.transaction(async session => {
			await this.touch([id], session, false);
			const preview = confirmModuleDeletion(id, await this.all(session), input);
			await this.cases.deleteMany({ moduleId: id }, { session });
			await this.modules.deleteOne({ _id: id }, { session });
			return { deleted: preview.count };
		});
	}
	async deleteCases(input: unknown) {
		return this.transaction(async session => {
			const cases = checkDeletion(input, (await this.all(session)).cases);
			await this.touch(cases.map(c => c.moduleId), session, false);
			await this.cases.deleteMany({ _id: { $in: cases.map(c => c.id) } }, { session });
			return { deleted: cases.length };
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
	private async assertModuleNameAvailable(
		nameKey: string,
		session?: ClientSession,
		excludeId?: string,
	) {
		const duplicate = await this.modules.findOne(
			{
				nameKey,
				archived: false,
				...(excludeId ? { _id: { $ne: excludeId } } : {}),
			},
			{ session, projection: { _id: 1 }, collation: { locale: "simple" } },
		);
		if (duplicate)
			throw new CatalogError("模块名称已存在，请使用其他名称", 409);
	}
	private async assertCaseNameAvailable(
		moduleId: string,
		name: string,
		session: ClientSession,
		excludeId?: string,
	) {
		const duplicate = await this.cases.findOne(
			{
				moduleId,
				"definition.id": name,
				archived: false,
				...(excludeId ? { _id: { $ne: excludeId } } : {}),
			},
			{ session, projection: { _id: 1 }, collation: { locale: "simple" } },
		);
		if (duplicate)
			throw new CatalogError("模块内案例 ID 已存在，请使用其他名称", 409);
	}
	private moduleName(name: unknown) { if (typeof name !== "string" || !name.trim() || name.length > 80) throw new CatalogError("模块名称须为 1–80 个字符"); return name.trim(); }
	private tags(input: unknown) { return (Array.isArray(input) ? input : []).filter(t => typeof t === "string" && t.trim()).map(t => t.trim()).slice(0, 20) as string[]; }
	async createModule(name: string, description = "", tags: string[] = []) {
		const module: Module = { id: randomUUID(), name: this.moduleName(name), description, tags: this.tags(tags), archived: false, createdAt: new Date().toISOString() };
		await this.guard(async () => {
			await this.assertModuleNameAvailable(module.name.trim().toLowerCase());
			await this.modules.insertOne(moduleToDocument(module));
		}); return module;
	}
	async updateModule(id: string, input: { name?: string; description?: string; tags?: string[] }) {
		return this.transaction(async session => {
			await this.touch([id], session, false);
			const changes: Partial<ModuleDocument> = {};
			if (input.name !== undefined) {
				changes.name = this.moduleName(input.name); changes.nameKey = changes.name.toLowerCase();
				const current = await this.modules.findOne({ _id: id }, { session });
				if (!current!.archived) await this.assertModuleNameAvailable(changes.nameKey, session, id);
			}
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
			if (kind === "module") {
				await this.touch([id], session, false);
				if (!archived) {
					const current = await this.modules.findOne({ _id: id }, { session });
					await this.assertModuleNameAvailable(current!.nameKey, session, id);
				}
				await this.modules.updateOne({ _id: id }, { $set: { archived } }, { session });
			}
			else {
				const doc = await this.source(id, session); await this.touch([doc.moduleId], session, !archived);
				if (!archived) await this.assertCaseNameAvailable(doc.moduleId, doc.definition.id, session, id);
				await this.cases.updateOne({ _id: id }, { $set: { archived, updatedAt: new Date() }, $inc: { revision: 1 } }, { session });
			}
		});
	}
	async createCase(moduleId: string, defaults: EvalDefaults, definition: EvalCase) {
		const item: SavedCase = { id: randomUUID(), moduleId, defaults, definition, revision: 1, archived: false, updatedAt: new Date().toISOString() };
		const doc = caseToDocument(item);
		return this.transaction(async session => { await this.touch([moduleId], session); await this.assertCaseNameAvailable(moduleId, doc.definition.id, session); await this.cases.insertOne(doc, { session }); return caseFromDocument(doc); });
	}
	async updateCase(id: string, revision: number, defaults: EvalDefaults, definition: EvalCase) {
		return this.transaction(async session => {
			const source = await this.source(id, session);
			if (source.revision !== revision) throw new CatalogError("案例已被其他页面修改，请刷新后重试", 409);
			if (source.archived) throw new CatalogError("案例已归档", 409);
			await this.touch([source.moduleId], session);
			const next = caseToDocument({ ...caseFromDocument(source), defaults, definition, revision: revision + 1, updatedAt: new Date().toISOString() });
			await this.assertCaseNameAvailable(source.moduleId, next.definition.id, session, id);
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
				const draft = request.items[index].draft;
                const next: CaseDocument = { ...source, ...(draft ? { defaults: structuredClone(draft.defaults) } : {}), moduleId: request.targetModuleId, definition: { ...(draft?.definition ?? source.definition), id: item.proposedDefinitionId }, updatedAt: new Date() };
				if (request.operation === "copy") { next._id = ids[index]; next.revision = 1; next.createdAt = new Date(); await this.cases.insertOne(next, { session }); }
				else { next.revision++; await this.cases.updateOne({ _id: source._id, revision: source.revision }, { $set: { moduleId: next.moduleId, definition: next.definition, revision: next.revision, updatedAt: next.updatedAt } }, { session }); }
				cases.push(caseFromDocument(next));
			}
			return { cases, copied: plan.summary.copied, moved: plan.summary.moved, unchanged: plan.summary.unchanged };
		});
	}
	async close() { await this.client.close(); }
}
