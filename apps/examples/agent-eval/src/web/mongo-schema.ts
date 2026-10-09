import type { Db } from "mongodb";
import { parseEvalSuite } from "../schema.js";
import type { Module, SavedCase } from "./types.js";
import { CatalogError } from "./catalog.js";

export type CaseDocument = Omit<SavedCase, "id" | "updatedAt" | "archived"> & { _id: string; schemaVersion: 1; createdAt: Date; updatedAt: Date; archived: boolean; provenance?: Record<string, unknown> };
export type ModuleDocument = Omit<Module, "id" | "createdAt" | "archived"> & { _id: string; nameKey: string; createdAt: Date; archived: boolean; writeVersion: number; provenance?: Record<string, unknown> };
export const caseIndexes = [
	{ key: { moduleId: 1, "definition.id": 1 }, name: "active_module_case_unique", unique: true, partialFilterExpression: { archived: false } },
	{ key: { moduleId: 1, archived: 1, "definition.replayMode": 1, updatedAt: -1 }, name: "module_mode_updated" },
	{ key: { archived: 1, "definition.replayMode": 1, "definition.tags": 1 }, name: "mode_tags" },
] as const;
export const moduleIndexes = [{ key: { nameKey: 1 }, name: "active_module_name_unique", unique: true, partialFilterExpression: { archived: false } }] as const;
const string = { bsonType: "string", minLength: 1 };
const integer = { bsonType: ["int", "long", "double"], minimum: 1, multipleOf: 1 };
export const caseValidator = { $jsonSchema: {
	bsonType: "object", required: ["_id", "schemaVersion", "moduleId", "revision", "archived", "createdAt", "updatedAt", "definition", "defaults"],
	properties: {
		_id: string, schemaVersion: { enum: [1] }, moduleId: string, revision: integer,
		archived: { bsonType: "bool" }, createdAt: { bsonType: "date" }, updatedAt: { bsonType: "date" },
		definition: { bsonType: "object", required: ["id", "replayMode", "prompt", "history"], properties: {
			id: string, replayMode: { enum: ["single-turn", "full-task"] }, prompt: string,
			tags: { bsonType: "array", items: string },
			history: { bsonType: "array", items: { bsonType: "object", required: ["role", "content"], properties: { role: { enum: ["user", "assistant"] }, content: string } } },
		} },
		defaults: { bsonType: "object", required: ["providerId", "modelId"], properties: { providerId: string, modelId: string } },
	},
} };
export const moduleValidator = { $jsonSchema: {
	bsonType: "object", required: ["_id", "name", "nameKey", "createdAt", "archived", "writeVersion"],
	properties: { _id: string, name: { ...string, maxLength: 80 }, nameKey: string, description: { bsonType: "string" }, tags: { bsonType: "array", maxItems: 20, items: string }, createdAt: { bsonType: "date" }, archived: { bsonType: "bool" }, writeVersion: integer },
} };
export function caseToDocument(item: SavedCase): CaseDocument {
	const suite = JSON.parse(JSON.stringify(parseEvalSuite({ defaults: item.defaults, cases: [item.definition] }))) as ReturnType<typeof parseEvalSuite>;
	if (typeof item.id !== "string" || !item.id || !item.moduleId || !Number.isSafeInteger(item.revision) || item.revision < 1 || !Number.isFinite(new Date(item.updatedAt).getTime())) throw new CatalogError("案例 ID、版本或更新时间无效", 422);
	return { _id: item.id, schemaVersion: 1, moduleId: item.moduleId, revision: item.revision, archived: item.archived ?? false, createdAt: new Date(item.updatedAt), updatedAt: new Date(item.updatedAt), definition: { ...suite.cases[0], replayMode: item.definition.replayMode ?? "single-turn" }, defaults: suite.defaults };
}
export function caseFromDocument(doc: CaseDocument): SavedCase {
	try {
		if (typeof doc._id !== "string" || !doc._id || doc.schemaVersion !== 1 || typeof doc.moduleId !== "string" || !doc.moduleId || !Number.isSafeInteger(doc.revision) || doc.revision < 1 || typeof doc.archived !== "boolean" || typeof doc.defaults?.providerId !== "string" || !doc.defaults.providerId || typeof doc.defaults?.modelId !== "string" || !doc.defaults.modelId || !(doc.createdAt instanceof Date) || !Number.isFinite(doc.createdAt.getTime()) || !(doc.updatedAt instanceof Date) || !Number.isFinite(doc.updatedAt.getTime()) || !["single-turn", "full-task"].includes(doc.definition?.replayMode ?? "")) throw new Error("字段类型无效");
		const suite = parseEvalSuite({ defaults: doc.defaults, cases: [doc.definition] });
		return { id: doc._id, moduleId: doc.moduleId, revision: doc.revision, archived: doc.archived, updatedAt: doc.updatedAt.toISOString(), defaults: suite.defaults, definition: suite.cases[0] };
	} catch { throw new CatalogError(`MongoDB 案例文档 ${typeof doc._id === "string" ? doc._id : "(无有效 ID)"} 不符合案例合同，请修正后重试`, 422); }
}
export function moduleToDocument(module: Module): ModuleDocument {
	if (typeof module.id !== "string" || !module.id || !Number.isFinite(new Date(module.createdAt).getTime())) throw new CatalogError("模块 ID 或创建时间无效", 422);
	return { _id: module.id, name: module.name, nameKey: module.name.trim().toLowerCase(), description: module.description, tags: module.tags ?? [], archived: module.archived ?? false, createdAt: new Date(module.createdAt), writeVersion: 1 };
}
export function moduleFromDocument(doc: ModuleDocument): Module {
	if (typeof doc._id !== "string" || !doc._id || typeof doc.name !== "string" || !doc.name.trim() || doc.name.length > 80 || doc.nameKey !== doc.name.trim().toLowerCase() || typeof doc.archived !== "boolean" || !(doc.createdAt instanceof Date) || !Number.isFinite(doc.createdAt.getTime()) || !Number.isSafeInteger(doc.writeVersion) || doc.writeVersion < 1 || (doc.tags !== undefined && (!Array.isArray(doc.tags) || doc.tags.length > 20 || doc.tags.some(t => typeof t !== "string" || !t.trim())))) throw new CatalogError("MongoDB 模块文档不符合合同，请修正后重试", 422);
	return { id: doc._id, name: doc.name, description: doc.description ?? "", tags: doc.tags ?? [], archived: doc.archived, createdAt: doc.createdAt.toISOString() };
}
export async function prepareMongoCollections(db: Db, cases: string, modules: string) {
	for (const [name, validator] of [[cases, caseValidator], [modules, moduleValidator]] as const) {
		if (await db.listCollections({ name }).hasNext()) await db.command({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
		else await db.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
	}
	await db.collection(cases).createIndexes(caseIndexes.map(index => ({ ...index, key: { ...index.key } })));
	await db.collection(modules).createIndexes(moduleIndexes.map(index => ({ ...index, key: { ...index.key } })));
}
