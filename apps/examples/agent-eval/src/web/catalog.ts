import type { CaseSummary } from "./projections.js";
import { confirmModuleDeletion, checkDeletion } from "./resource-management.js";
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
 summaries?(): Awaitable<{modules:Module[];cases:CaseSummary[]}>;
 selected?(input:{caseIds?:string[];moduleIds?:string[]}):Awaitable<CatalogSnapshot>;
	allResources(): Awaitable<CatalogSnapshot>;
	deleteModule(id: string, input: unknown): Awaitable<{ deleted: number }>;
	deleteCases(input: unknown): Awaitable<{ deleted: number }>;
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
 summaries(){return this.store.db.transaction(()=>({modules:this.store.activeModules(),cases:this.store.projections.cases()}))();}
 selected(input:{caseIds?:string[];moduleIds?:string[]}){
  const {modules,cases}=this.summaries();
  return {modules,cases:cases.filter(c=>input.caseIds?.includes(c.id)||input.moduleIds?.includes(c.moduleId)).map(c=>this.store.require<SavedCase>("case",c.id))};
 }

	allResources() { return this.store.db.transaction(() => ({ modules: this.store.list<Module>("module"), cases: this.store.list<SavedCase>("case") }))(); }
	deleteModule(id: string, input: unknown) {
		return this.store.db.transaction(() => {
			const preview = confirmModuleDeletion(id, this.allResources(), input);
			for (const c of preview.items) this.store.deleteCase(c.id);
			this.store.db.query("DELETE FROM records WHERE kind='module' AND id=?").run(id);
			return { deleted: preview.count };
		}).immediate();
	}
	deleteCases(input: unknown) {
		return this.store.db.transaction(() => {
			const cases = checkDeletion(input, this.allResources().cases);
			for (const c of cases) this.store.deleteCase(c.id);
			return { deleted: cases.length };
		}).immediate();
	}

	getCase(id: string) { return this.store.get<SavedCase>("case", id); }
	getModule(id: string) { return this.store.get<Module>("module", id); }
	createModule(name: string, description?: string, tags?: string[]) { return this.store.createModule(name, description, tags); }
	updateModule(id: string, input: { name?: string; description?: string; tags?: string[] }) { return this.store.db.transaction(() => this.store.updateModule(id, input)).immediate(); }
	archiveModule(id: string) { this.store.db.transaction(() => this.store.archiveModule(id)).immediate(); }
	setArchived(kind: "case" | "module", id: string, archived: boolean) { this.store.db.transaction(() => this.store.setArchived(kind, id, archived)).immediate(); }
	createCase(moduleId: string, defaults: EvalDefaults, definition: EvalCase) { return this.store.db.transaction(() => this.store.createCase(moduleId, defaults, definition)).immediate(); }
	updateCase(id: string, revision: number, defaults: EvalDefaults, definition: EvalCase) {
		return this.store.db.transaction(() => {
			const previous = this.getCase(id);
			if (!previous) throw new CatalogError("案例不存在或已删除", 404);
			if (previous.revision !== revision) throw new CatalogError("案例已被其他页面修改，请刷新后重试", 409);
			if (this.store.projections.cases(previous.moduleId).some(c => c.id !== id && c.moduleId === previous.moduleId && c.definition.id === definition.id)) throw new CatalogError("同模块已有相同案例 ID", 409);
			const next = { ...previous, definition, defaults, revision: revision + 1, updatedAt: new Date().toISOString() };
			this.store.put("case", id, next); return next;
		}).immediate();
	}
	deleteCase(id: string) { this.store.deleteCase(id); }
	duplicateCase(id: string) { return this.store.db.transaction(() => this.store.duplicateCase(id)).immediate(); }
	importCases(moduleId: string, suite: EvalSuite, policy: string) { return this.store.db.transaction(() => this.store.importCases(moduleId, suite, policy)).immediate(); }
	previewTransfer(input: unknown) { return this.store.previewTransfer(input); }
	transferCases(input: unknown) { return this.store.transferCases(input); }
	close() {}
}
