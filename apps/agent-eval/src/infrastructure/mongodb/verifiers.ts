import type { Collection, Db } from "mongodb";
import type { UploadedVerifier } from "../../contracts/verifiers.js";
import { CatalogError } from "../../modules/catalog/repository.js";
import {
	editable,
	parseUpload,
	replacement,
	SCRIPT_LIMIT,
	validateUploaded,
	type VerifierRepository,
} from "../../modules/grading/uploaded-verifiers.js";
import { mongoFailure } from "./catalog.js";
type VerifierDocument = Omit<UploadedVerifier, "id" | "createdAt"> & {
	_id: string;
	createdAt: Date;
};
export const verifierValidator = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"_id",
			"schemaVersion",
			"label",
			"filename",
			"extension",
			"content",
			"version",
			"sha256",
			"timeoutMs",
			"createdAt",
		],
		properties: {
			_id: { bsonType: "string", pattern: "^uploaded-[0-9a-f-]{36}$" },
			schemaVersion: { enum: [1] },
			label: { bsonType: "string", minLength: 1, maxLength: 80 },
			filename: { bsonType: "string", minLength: 1, maxLength: 160 },
			extension: { enum: [".js", ".mjs", ".ts", ".py"] },
			content: { bsonType: "string", minLength: 1, maxLength: SCRIPT_LIMIT },
			version: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
			sha256: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
			timeoutMs: { enum: [60000] },
			runtime: { enum: ["bun", "python"] },
			entrypoint: { enum: ["verify"] },
			contractVersion: { enum: [1, 2] },
			createdAt: { bsonType: "date" },
		},
	},
};
export async function prepareVerifierCollection(db: Db, name: string) {
	if (await db.listCollections({ name }).hasNext())
		await db.command({
			collMod: name,
			validator: verifierValidator,
			validationLevel: "strict",
			validationAction: "error",
		});
	else
		await db.createCollection(name, {
			validator: verifierValidator,
			validationLevel: "strict",
			validationAction: "error",
		});
}
export class MongoVerifiers implements VerifierRepository {
	private collection: Collection<VerifierDocument>;
	constructor(
		private db: Db,
		name: string,
	) {
		this.collection = db.collection(name);
	}
	async preflight() {
		try {
			const exists = await this.db
				.listCollections(
					{ name: this.collection.collectionName, type: "collection" },
					{ nameOnly: true },
				)
				.hasNext();
			if (!exists)
				throw new CatalogError(
					`MongoDB 集合 ${this.collection.collectionName} 尚未创建，请由管理员执行建集合命令`,
					503,
				);
		} catch (error) {
			throw mongoFailure(error);
		}
	}
	private decode(doc: VerifierDocument) {
		const { _id, createdAt, ...fields } = doc;
		if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime()))
			throw new CatalogError("验证脚本日期无效", 422);
		return validateUploaded({
			...fields,
			id: _id,
			createdAt: createdAt.toISOString(),
		});
	}
	async list() {
		try {
			return (
				await this.collection
					.find({}, { maxTimeMS: 5000 })
					.sort({ createdAt: 1, _id: 1 })
					.toArray()
			).map((doc) => this.decode(doc));
		} catch (error) {
			throw mongoFailure(error);
		}
	}
	async get(id: string) {
		try {
			const doc = await this.collection.findOne(
				{ _id: id },
				{ maxTimeMS: 5000 },
			);
			return doc ? this.decode(doc) : undefined;
		} catch (error) {
			throw mongoFailure(error);
		}
	}
	async create(input: unknown) {
		const v = parseUpload(input);
		const { id, createdAt, ...fields } = v;
		try {
			await this.collection.insertOne(
				{ ...fields, _id: id, createdAt: new Date(createdAt) },
				{ writeConcern: { w: "majority" } },
			);
			return v;
		} catch (error) {
			throw mongoFailure(error);
		}
	}
	private condition(previous: UploadedVerifier) {
		return {
			_id: previous.id,
			label: previous.label,
			filename: previous.filename,
			content: previous.content,
			version: previous.version,
			createdAt: new Date(previous.createdAt),
			...(previous.pythonEnvironment
				? { pythonEnvironment: previous.pythonEnvironment }
				: { pythonEnvironment: { $exists: false } }),
		};
	}
	async update(id: string, expectedToken: string, input: unknown) {
		try {
			const previous = editable(await this.get(id), expectedToken);
			const next = replacement(previous, input);
			const { id: _unusedId, createdAt, ...fields } = next;
			const result = await this.collection.replaceOne(
				this.condition(previous),
				{ ...fields, createdAt: new Date(createdAt) },
				{ writeConcern: { w: "majority" } },
			);
			if (!result.matchedCount)
				throw new CatalogError("脚本已变化，请重新打开后重试", 409);
			return next;
		} catch (error) {
			throw mongoFailure(error);
		}
	}
	async delete(id: string, expectedToken: string) {
		try {
			const previous = editable(await this.get(id), expectedToken);
			const result = await this.collection.deleteOne(this.condition(previous), {
				writeConcern: { w: "majority" },
			});
			if (!result.deletedCount)
				throw new CatalogError("脚本已变化，请重新打开后重试", 409);
		} catch (error) {
			throw mongoFailure(error);
		}
	}
}
