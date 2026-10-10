import { createHash, randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { CatalogError } from "../web/catalog.js";
import { mongoFailure } from "../web/mongo-catalog.js";

export const SCRIPT_LIMIT = 1024 * 1024;
export type UploadedVerifier = { id: string; schemaVersion: 1; label: string; filename: string; extension: ".js" | ".mjs" | ".ts" | ".py"; runtime?: "bun" | "python"; entrypoint?: "verify"; contractVersion?: 1 | 2; pythonEnvironment?: import("./python-runtime.js").PythonEnvironment; content: string; version: string; sha256: string; timeoutMs: number; createdAt: string };
export interface VerifierRepository {
	list(): Promise<UploadedVerifier[]>;
	get(id: string): Promise<UploadedVerifier | undefined>;
	create(input: unknown): Promise<UploadedVerifier>;
}
export const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");
export function parseUpload(input: unknown): UploadedVerifier {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new CatalogError("缺少验证脚本");
	const v = input as Record<string, unknown>;
	if (Object.keys(v).some(k => !["filename", "content", "label"].includes(k))) throw new CatalogError("上传脚本包含未知字段");
	if (typeof v.filename !== "string" || !v.filename.trim() || v.filename.length > 160 || /[\\/\x00-\x1f]/.test(v.filename)) throw new CatalogError("文件名须为 1–160 个字符，不能包含路径");
	const extension = v.filename.slice(v.filename.lastIndexOf("."));
	if (![".js", ".mjs", ".ts", ".py"].includes(extension)) throw new CatalogError("支持 .py、.js、.mjs、.ts 单文件脚本");
	if (typeof v.content !== "string" || !v.content.trim() || v.content.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v.content)) throw new CatalogError("脚本须为非空 UTF-8 文本");
	if (Buffer.byteLength(v.content) > SCRIPT_LIMIT) throw new CatalogError("脚本不能超过 1 MiB", 413);
	if (v.label !== undefined && (typeof v.label !== "string" || !v.label.trim() || v.label.length > 80)) throw new CatalogError("显示名称须为 1–80 个字符");
	const hash = contentHash(v.content);
	return { id: `uploaded-${randomUUID()}`, schemaVersion: 1, label: (v.label as string | undefined)?.trim() ?? v.filename.slice(0, 80), filename: v.filename, extension: extension as UploadedVerifier["extension"], content: v.content, version: hash, sha256: hash, timeoutMs: 60000, createdAt: new Date().toISOString(), ...(extension === ".py" ? { runtime: "python" as const, entrypoint: "verify" as const, contractVersion: 2 as const } : {}) };
}
export function validateUploaded(value: UploadedVerifier): UploadedVerifier {
	try {
		const parsed = parseUpload({ filename: value.filename, content: value.content, label: value.label });
		if (!/^uploaded-[0-9a-f-]{36}$/.test(value.id) || value.schemaVersion !== 1 || value.extension !== parsed.extension || value.sha256 !== parsed.sha256 || value.version !== parsed.version || value.timeoutMs !== 60000 || !Number.isFinite(Date.parse(value.createdAt))) throw new Error();
		if (value.extension === ".py" ? value.runtime !== "python" || value.entrypoint !== "verify" || value.contractVersion !== 2 : value.runtime !== undefined && value.runtime !== "bun" || value.contractVersion !== undefined && value.contractVersion !== 1) throw new Error();
		return value;
	} catch { throw new CatalogError("上传脚本文档或内容摘要无效", 422); }
}
type Records = { list<T>(kind: string): T[]; get<T>(kind: string, id: string): T | undefined; put(kind: string, id: string, value: unknown): void };
export class SqliteVerifiers implements VerifierRepository {
	constructor(private records: Records) {}
	async list() { return this.records.list<UploadedVerifier>("verifier").map(validateUploaded); }
	async get(id: string) { const value = this.records.get<UploadedVerifier>("verifier", id); return value && validateUploaded(value); }
	async create(input: unknown) { const v = parseUpload(input); this.records.put("verifier", v.id, v); return v; }
}
type VerifierDocument = Omit<UploadedVerifier, "id" | "createdAt"> & { _id: string; createdAt: Date };
export const verifierValidator = { $jsonSchema: {
	bsonType: "object", required: ["_id", "schemaVersion", "label", "filename", "extension", "content", "version", "sha256", "timeoutMs", "createdAt"],
	properties: { _id: { bsonType: "string", pattern: "^uploaded-[0-9a-f-]{36}$" }, schemaVersion: { enum: [1] }, label: { bsonType: "string", minLength: 1, maxLength: 80 }, filename: { bsonType: "string", minLength: 1, maxLength: 160 }, extension: { enum: [".js", ".mjs", ".ts", ".py"] }, content: { bsonType: "string", minLength: 1, maxLength: SCRIPT_LIMIT }, version: { bsonType: "string", pattern: "^[0-9a-f]{64}$" }, sha256: { bsonType: "string", pattern: "^[0-9a-f]{64}$" }, timeoutMs: { enum: [60000] }, runtime: { enum: ["bun", "python"] }, entrypoint: { enum: ["verify"] }, contractVersion: { enum: [1, 2] }, createdAt: { bsonType: "date" } },
} };
export async function prepareVerifierCollection(db: Db, name: string) {
	if (await db.listCollections({ name }).hasNext()) await db.command({ collMod: name, validator: verifierValidator, validationLevel: "strict", validationAction: "error" });
	else await db.createCollection(name, { validator: verifierValidator, validationLevel: "strict", validationAction: "error" });
}
export class MongoVerifiers implements VerifierRepository {
	private collection: Collection<VerifierDocument>;
	constructor(private db: Db, name: string) { this.collection = db.collection(name); }
	async preflight() {
		try {
			if (!await this.db.listCollections({ name: this.collection.collectionName }).hasNext()) throw new CatalogError("验证脚本集合尚未准备，请运行 mongo:prepare", 503);
			const options = await this.collection.options();
			if (!isDeepStrictEqual(options.validator, verifierValidator) || options.validationLevel !== "strict" || options.validationAction !== "error") throw new CatalogError("验证脚本集合合同不符，请运行 mongo:prepare", 503);
		} catch (error) { throw mongoFailure(error); }
	}
	private decode(doc: VerifierDocument) { const { _id, createdAt, ...fields } = doc; if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) throw new CatalogError("验证脚本日期无效", 422); return validateUploaded({ ...fields, id: _id, createdAt: createdAt.toISOString() }); }
	async list() { try { return (await this.collection.find({}, { maxTimeMS: 5000 }).sort({ createdAt: 1, _id: 1 }).toArray()).map(doc => this.decode(doc)); } catch (error) { throw mongoFailure(error); } }
	async get(id: string) { try { const doc = await this.collection.findOne({ _id: id }, { maxTimeMS: 5000 }); return doc ? this.decode(doc) : undefined; } catch (error) { throw mongoFailure(error); } }
	async create(input: unknown) { const v = parseUpload(input); const { id, createdAt, ...fields } = v; try { await this.collection.insertOne({ ...fields, _id: id, createdAt: new Date(createdAt) }, { writeConcern: { w: "majority" } }); return v; } catch (error) { throw mongoFailure(error); } }
}
export const publicUploaded = (v: UploadedVerifier) => ({ id: v.id, label: v.label, version: v.version.slice(0, 12), sha256: v.sha256, timeoutMs: v.timeoutMs, dependencies: [v.filename], source: "uploaded", runtime: v.runtime ?? "bun", contractVersion: v.contractVersion ?? 1, filename: v.filename, createdAt: v.createdAt });
