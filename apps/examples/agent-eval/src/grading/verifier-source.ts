import { Database } from "bun:sqlite";
import path from "node:path";
import type { EvalCase } from "../types.js";
import { MongoCatalog, mongoConfig } from "../web/mongo-catalog.js";
import { MongoVerifiers, validateUploaded, type UploadedVerifier } from "./uploaded-verifiers.js";

// Only CLI runs without a frozen Web snapshot need to open the script library.
export async function loadCliVerifierSnapshots(definition: EvalCase, directory: string): Promise<UploadedVerifier[]> {
	const ids = [...new Set((definition.grading?.rules ?? []).flatMap(r => "verifierId" in r && r.verifierId.startsWith("uploaded-") ? [r.verifierId] : []))];
	if (!ids.length) return [];
	if (process.env.EVAL_CASE_STORAGE === "mongodb") {
		const catalog = await MongoCatalog.connect(mongoConfig(), false);
		try {
			const repository = new MongoVerifiers(catalog.db, catalog.config.verifierCollection ?? "agent_eval_verifiers"); await repository.preflight();
			return await Promise.all(ids.map(async id => { const v = await repository.get(id); if (!v) throw new Error(`上传脚本 ${id} 不存在`); return v; }));
		} finally { await catalog.close(); }
	}
	if (process.env.EVAL_CASE_STORAGE && process.env.EVAL_CASE_STORAGE !== "sqlite") throw new Error("EVAL_CASE_STORAGE 须为 sqlite 或 mongodb");
	const db = new Database(path.join(directory, "eval.sqlite"), { readonly: true });
	try {
		return ids.map(id => { const row = db.query("SELECT data FROM records WHERE kind='verifier' AND id=?").get(id) as { data: string } | null; if (!row) throw new Error(`上传脚本 ${id} 不存在`); return validateUploaded(JSON.parse(row.data)); });
	} finally { db.close(); }
}
