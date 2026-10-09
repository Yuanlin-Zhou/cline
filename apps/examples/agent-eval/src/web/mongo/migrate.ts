import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { MongoCatalog, mongoFailure } from "../mongo-catalog.js";
import { caseFromDocument, caseToDocument, moduleFromDocument, moduleToDocument, type CaseDocument, type ModuleDocument } from "../mongo-schema.js";
import type { Module, SavedCase } from "../types.js";
import { CatalogError } from "../catalog.js";

/** Read-only SQLite input. The caller must stop writers during the migration window. */
export async function migrateSqliteCatalog(repository: MongoCatalog, filename: string, dryRun = true) {
	const sqlite = new Database(filename, { readonly: true });
	let modules: ModuleDocument[]; let cases: CaseDocument[];
	try {
		const read = <T>(kind: string) => (sqlite.query("SELECT data FROM records WHERE kind=? ORDER BY rowid").all(kind) as { data: string }[]).map(row => JSON.parse(row.data) as T);
		({ modules, cases } = sqlite.transaction(() => ({ modules: read<Module>("module").map(moduleToDocument), cases: read<SavedCase>("case").map(caseToDocument) }))());
	} finally { sqlite.close(); }
	modules.forEach(moduleFromDocument); cases.forEach(caseFromDocument);
	const session = repository.client.startSession();
	try {
		return await session.withTransaction(async () => {
			const existingModules = await repository.modules.find({}, { session }).toArray();
			const existingCases = await repository.cases.find({}, { session }).toArray();
			const moduleIds = new Set([...existingModules, ...modules].map(m => m._id));
			const report = { dryRun, modules: { created: 0, skipped: 0 }, cases: { created: 0, skipped: 0 }, conflicts: [] as string[] };
			const inserts: { modules: ModuleDocument[]; cases: CaseDocument[] } = { modules: [], cases: [] };
			const activeModuleNames = new Map(existingModules.filter(m => !m.archived).map(m => [m.nameKey, m._id]));
			const activeCaseNames = new Map(existingCases.filter(c => !c.archived).map(c => [JSON.stringify([c.moduleId, c.definition.id]), c._id]));
			for (const module of modules) {
				const previous = existingModules.find(m => m._id === module._id);
				if (previous) {
					if (isDeepStrictEqual(moduleFromDocument(previous), moduleFromDocument(module))) report.modules.skipped++;
					else report.conflicts.push(`模块 ID 冲突：${module._id}`);
					continue;
				}
				if (!module.archived && activeModuleNames.has(module.nameKey)) { report.conflicts.push(`模块名称冲突：${module.name}`); continue; }
				if (!module.archived) activeModuleNames.set(module.nameKey, module._id);
				inserts.modules.push(module); report.modules.created++;
			}
			for (const item of cases) {
				if (!moduleIds.has(item.moduleId)) { report.conflicts.push(`案例 ${item._id} 引用了不存在的模块`); continue; }
				const previous = existingCases.find(c => c._id === item._id);
				if (previous) {
					if (isDeepStrictEqual(caseFromDocument(previous), caseFromDocument(item))) report.cases.skipped++;
					else report.conflicts.push(`案例 ID 冲突：${item._id}`);
					continue;
				}
				const key = JSON.stringify([item.moduleId, item.definition.id]);
				if (!item.archived && activeCaseNames.has(key)) { report.conflicts.push(`模块内业务案例 ID 冲突：${item.definition.id}`); continue; }
				if (!item.archived) activeCaseNames.set(key, item._id);
				inserts.cases.push(item); report.cases.created++;
			}
			if (!dryRun && report.conflicts.length) throw new CatalogError(`迁移停止，存在 ${report.conflicts.length} 项冲突，请先运行 dry-run 查看报告`, 409);
			if (!dryRun) {
				// Read/write conflicts prevent concurrent application archive/edit during migration.
				for (const id of [...new Set(cases.map(c => c.moduleId))].sort()) {
					if (existingModules.some(m => m._id === id)) await repository.modules.updateOne({ _id: id }, { $inc: { writeVersion: 1 } }, { session });
				}
				if (inserts.modules.length) await repository.modules.insertMany(inserts.modules, { session });
				if (inserts.cases.length) await repository.cases.insertMany(inserts.cases, { session });
			}
			return report;
		}, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, timeoutMS: 15000 });
	} catch (error) { throw mongoFailure(error); }
	finally { await session.endSession(); }
}
