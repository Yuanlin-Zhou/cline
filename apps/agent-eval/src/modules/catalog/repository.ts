import type { Module, SavedCase } from "../../contracts/catalog.js";
import type {
	EvalCase,
	EvalDefaults,
	EvalSuite,
} from "../../contracts/evaluation.js";
import type { CaseSummary } from "../../contracts/projections.js";

import type { TransferPreview } from "./transfer.js";

export class CatalogError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}
export type CatalogSnapshot = { modules: Module[]; cases: SavedCase[] };
export type TransferResult = {
	cases: SavedCase[];
	copied: number;
	moved: number;
	unchanged: number;
};
type Awaitable<T> = T | Promise<T>;
export interface CatalogRepository {
	snapshot(): Awaitable<CatalogSnapshot>;
	summaries?(): Awaitable<{ modules: Module[]; cases: CaseSummary[] }>;
	selected?(input: {
		caseIds?: string[];
		moduleIds?: string[];
	}): Awaitable<CatalogSnapshot>;
	allResources(): Awaitable<CatalogSnapshot>;
	deleteModule(id: string, input: unknown): Awaitable<{ deleted: number }>;
	deleteCases(input: unknown): Awaitable<{ deleted: number }>;
	getCase(id: string): Awaitable<SavedCase | undefined>;
	getModule(id: string): Awaitable<Module | undefined>;
	createModule(
		name: string,
		description?: string,
		tags?: string[],
	): Awaitable<Module>;
	updateModule(
		id: string,
		input: { name?: string; description?: string; tags?: string[] },
	): Awaitable<Module>;
	archiveModule(id: string): Awaitable<void>;
	setArchived(
		kind: "case" | "module",
		id: string,
		archived: boolean,
	): Awaitable<void>;
	createCase(
		moduleId: string,
		defaults: EvalDefaults,
		definition: EvalCase,
	): Awaitable<SavedCase>;
	updateCase(
		id: string,
		revision: number,
		defaults: EvalDefaults,
		definition: EvalCase,
	): Awaitable<SavedCase>;
	deleteCase(id: string): Awaitable<void>;
	duplicateCase(id: string): Awaitable<SavedCase>;
	importCases(
		moduleId: string,
		suite: EvalSuite,
		policy: string,
	): Awaitable<{ created: number; updated: number; skipped: number }>;
	previewTransfer(input: unknown): Awaitable<TransferPreview>;
	transferCases(input: unknown): Awaitable<TransferResult>;
	close(): Awaitable<void>;
}
