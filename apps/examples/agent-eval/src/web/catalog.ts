import type { EvalCase, EvalDefaults, EvalSuite } from "../types.js";
import type { Module, SavedCase } from "./types.js";
import { EvalStore } from "./store.js";
import type { TransferPreview } from "./transfer.js";

export class CatalogError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}
export type CatalogSnapshot = { modules: Module[]; cases: SavedCase[] };
export type TransferResult = { cases: SavedCase[]; copied: number; moved: number; unchanged: number };
type Awaitable<T> = T | Promise<T>;
export interface CatalogRepository {
	snapshot(): Awaitable<CatalogSnapshot>;
	getCase(id: string): Awaitable<SavedCase | undefined>;
	getModule(id: string): Awaitable<Module | undefined>;
	createModule(name: string, description?: string, tags?: string[]): Awaitable<Module>;
	updateModule(id: string, input: { name?: string; description?: string; tags?: string[] }): Awaitable<Module>;
	archiveModule(id: string): Awaitable<void>;
	setArchived(kind: "case" | "module", id: string, archived: boolean): Awaitable<void>;
	createCase(moduleId: string, defaults: EvalDefaults, definition: EvalCase): Awaitable<SavedCase>;
	updateCase(id: string, revision: number, defaults: EvalDefaults, definition: EvalCase): Awaitable<SavedCase>;
	deleteCase(id: string): Awaitable<void>;
	duplicateCase(id: string): Awaitable<SavedCase>;
	importCases(moduleId: string, suite: EvalSuite, policy: string): Awaitable<{ created: number; updated: number; skipped: number }>;
	previewTransfer(input: unknown): Awaitable<TransferPreview>;
	transferCases(input: unknown): Awaitable<TransferResult>;
	close(): Awaitable<void>;
}
export class SqliteCatalog implements CatalogRepository {
	constructor(readonly store: EvalStore) {}
	snapshot() { return this.store.db.transaction(() => ({ modules: this.store.activeModules(), cases: this.store.activeCases() }))(); }
	getCase(id: string) { return this.store.get<SavedCase>("case", id); }
	getModule(id: string) { return this.store.get<Module>("module", id); }
	createModule(name: string, description?: string, tags?: string[]) { return this.store.createModule(name, description, tags); }
	updateModule(id: string, input: { name?: string; description?: string; tags?: string[] }) { return this.store.updateModule(id, input); }
	archiveModule(id: string) { this.store.archiveModule(id); }
	setArchived(kind: "case" | "module", id: string, archived: boolean) { this.store.setArchived(kind, id, archived); }
	createCase(moduleId: string, defaults: EvalDefaults, definition: EvalCase) { return this.store.createCase(moduleId, defaults, definition); }
	updateCase(id: string, revision: number, defaults: EvalDefaults, definition: EvalCase) {
		return this.store.db.transaction(() => {
			const previous = this.getCase(id);
			if (!previous) throw new CatalogError("案例不存在或已删除", 404);
			if (previous.revision !== revision) throw new CatalogError("案例已被其他页面修改，请刷新后重试", 409);
			if (this.store.activeCases().some(c => c.id !== id && c.moduleId === previous.moduleId && c.definition.id === definition.id)) throw new CatalogError("同模块已有相同案例 ID", 409);
			const next = { ...previous, definition, defaults, revision: revision + 1, updatedAt: new Date().toISOString() };
			this.store.put("case", id, next); return next;
		}).immediate();
	}
	deleteCase(id: string) { this.store.deleteCase(id); }
	duplicateCase(id: string) { return this.store.duplicateCase(id); }
	importCases(moduleId: string, suite: EvalSuite, policy: string) { return this.store.importCases(moduleId, suite, policy); }
	previewTransfer(input: unknown) { return this.store.previewTransfer(input); }
	transferCases(input: unknown) { return this.store.transferCases(input); }
	close() {}
}
