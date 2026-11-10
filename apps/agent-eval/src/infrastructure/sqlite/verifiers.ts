import type { Database } from "bun:sqlite";
import type { UploadedVerifier } from "../../contracts/verifiers.js";
import {
	editable,
	parseUpload,
	replacement,
	validateUploaded,
	type VerifierRepository,
} from "../../modules/grading/uploaded-verifiers.js";
type Records = {
	db: Database;
	list<T>(kind: string): T[];
	get<T>(kind: string, id: string): T | undefined;
	put(kind: string, id: string, value: unknown): void;
};
export class SqliteVerifiers implements VerifierRepository {
	constructor(private records: Records) {}
	async list() {
		return this.records
			.list<UploadedVerifier>("verifier")
			.map(validateUploaded);
	}
	async get(id: string) {
		const value = this.records.get<UploadedVerifier>("verifier", id);
		return value && validateUploaded(value);
	}
	async create(input: unknown) {
		const v = parseUpload(input);
		this.records.put("verifier", v.id, v);
		return v;
	}
	async update(id: string, expectedToken: string, input: unknown) {
		return this.records.db
			.transaction(() => {
				const previous = editable(
					this.records.get<UploadedVerifier>("verifier", id),
					expectedToken,
				);
				const next = replacement(previous, input);
				this.records.put("verifier", id, next);
				return next;
			})
			.immediate();
	}
	async delete(id: string, expectedToken: string) {
		this.records.db
			.transaction(() => {
				editable(
					this.records.get<UploadedVerifier>("verifier", id),
					expectedToken,
				);
				this.records.db
					.query("DELETE FROM records WHERE kind='verifier' AND id=?")
					.run(id);
			})
			.immediate();
	}
}
