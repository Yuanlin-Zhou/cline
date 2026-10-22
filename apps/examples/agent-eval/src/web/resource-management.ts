import { createHash } from "node:crypto";
import { CatalogError, type CatalogSnapshot } from "./catalog.js";
import type { SavedCase } from "./types.js";

export const stateToken = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function deletionItems(input: unknown) {
	const body = input as { items?: Array<{ id: string; revision: number }> };
	if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 1000)
		throw new CatalogError("请选择 1–1000 个案例");
	if (body.items.some(i => !i || typeof i.id !== "string" || !i.id || !Number.isSafeInteger(i.revision) || i.revision < 1) || new Set(body.items.map(i => i.id)).size !== body.items.length)
		throw new CatalogError("案例清单无效或包含重复项");
	return body.items;
}
export function checkDeletion(input: unknown, cases: SavedCase[]) {
	return deletionItems(input).map(i => {
		const c = cases.find(c => c.id === i.id);
		if (!c) throw new CatalogError("选中案例不存在或已删除，请刷新核对", 409);
		if (c.revision !== i.revision) throw new CatalogError(`案例「${c.definition.description || c.definition.id}」已变化，请刷新后重新确认`, 409);
		return c;
	});
}
export function moduleDeletion(id: string, all: CatalogSnapshot) {
	const module = all.modules.find(m => m.id === id);
	if (!module) throw new CatalogError("模块不存在或已删除", 404);
	const cases = all.cases.filter(c => c.moduleId === id).sort((a,b) => a.id.localeCompare(b.id));
	return { module, count: cases.length, items: cases.map(c => ({ id: c.id, revision: c.revision, name: c.definition.description || c.definition.id, archived: !!c.archived })), token: stateToken({ module, cases }) };
}
export function confirmModuleDeletion(id: string, all: CatalogSnapshot, input: unknown) {
	const preview = moduleDeletion(id, all);
	const body = input as { expectedToken?: string; name?: string };
	if (!body || body.expectedToken !== preview.token) throw new CatalogError("模块或案例清单已变化，请重新预览并确认", 409);
	if (body.name !== preview.module.name) throw new CatalogError("请输入完整模块名称以确认删除");
	return preview;
}
export function verifierReferences(id: string, all: CatalogSnapshot) {
	return all.cases.filter(c => c.definition.grading?.rules.some(r => r.kind === "script" && r.verifierId === id))
		.map(c => ({ id: c.id, name: c.definition.description || c.definition.id, moduleId: c.moduleId, moduleName: all.modules.find(m => m.id === c.moduleId)?.name ?? "未知模块", archived: !!c.archived || !!all.modules.find(m => m.id === c.moduleId)?.archived }));
}
