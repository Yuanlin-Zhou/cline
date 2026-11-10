import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	type Module,
	type Run,
	type RunDetail,
	type RunItem,
	type SavedCase,
} from "../../contracts/catalog.js";
import type {
	EvalCase,
	EvalDefaults,
	EvalSuite,
} from "../../contracts/evaluation.js";
import { parseEvalSuite } from "../../contracts/schema.js";
import { LocalCatalogService } from "../../modules/catalog/local-service.js";
import {
	RunCommands,
	type RunInput,
	type RunSource,
} from "../../modules/runs/commands.js";
import { Projections, type ItemSummary } from "./projections.js";

import { type TransferPreview } from "../../modules/catalog/transfer.js";

export type { RunInput, RunSource } from "../../modules/runs/commands.js";
const now = () => new Date().toISOString();
const cleanTags = (tags: unknown): string[] =>
	(Array.isArray(tags) ? tags : [])
		.filter((tag) => typeof tag === "string" && tag.trim())
		.map((tag) => (tag as string).trim())
		.slice(0, 20);
export class EvalStore {
	validateCase?: (definition: EvalCase) => void;
	readonly db: Database;
	get projectionEpoch() {
		return this.projections.epoch;
	}
	runRevision(id: string) {
		return (
			(
				this.db
					.query("SELECT revision FROM run_revisions WHERE run_id=?")
					.get(id) as { revision: number } | null
			)?.revision ?? 0
		);
	}
	changedSummaries(runId: string, after: number) {
		return this.projections.summaries("WHERE run_id=? AND seq>?", [
			runId,
			after,
		]);
	}
	attemptSummaries(runId: string, rootId: string) {
		return this.projections.summaries("WHERE run_id=? AND root_id=?", [
			runId,
			rootId,
		]);
	}
	itemCoordinate(itemId: string) {
		return this.db
			.query("SELECT run_id,root_id FROM run_item_summaries WHERE item_id=?")
			.get(itemId) as { run_id: string; root_id: string } | undefined;
	}
	itemProgress(itemId: string) {
		const row = this.db
			.query("SELECT run_id,version,data FROM run_item_state WHERE item_id=?")
			.get(itemId) as { run_id: string; version: number; data: string } | null;
		return row
			? {
					run_id: row.run_id,
					version: row.version,
					state: JSON.parse(row.data),
				}
			: undefined;
	}

	caseSummaries(moduleId?: string) {
		return this.projections.cases(moduleId);
	}
	deleteRecord(kind: string, id: string) {
		this.db.query("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
		if (kind === "case")
			this.db.query("DELETE FROM case_summaries WHERE case_id=?").run(id);
	}

	transaction<T>(fn: () => T) {
		return this.db.transaction(fn);
	}
	readonly projections: Projections;
	constructor(
		readonly directory: string,
		options: { seedModules?: boolean } = {},
	) {
		mkdirSync(directory, { recursive: true });
		this.db = new Database(path.join(directory, "eval.sqlite"));
		this.db.exec(`PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));`);
		try {
			this.projections = new Projections(this.db, directory);
		} catch (error) {
			this.db.close();
			throw error;
		}
		if (!this.get<EvalDefaults>("settings", "default")) {
			this.put(
				"settings",
				"default",
				parseEvalSuite({ cases: [{ id: "default", prompt: "default" }] })
					.defaults,
			);
			if (options.seedModules !== false)
				for (const [name, description] of [
					["read_file", "文件读取、路径处理与边界行为"],
					["write_file", "文件创建、内容修改与写入验证"],
					["execute_command", "命令执行与错误处理"],
					["task_completion", "完整任务执行与最终结果验证"],
				])
					this.createModule(name, description);
		}
		this.db.transaction(() => {
			for (const run of this.list<Run>("run"))
				if (["queued", "running"].includes(run.status)) {
					run.status = "interrupted";
					run.endedAt = now();
					this.put("run", run.id, run);
					for (const summary of this.summaries(run.id).filter((i) =>
						["queued", "running"].includes(i.status),
					)) {
						const item = this.require<RunItem>("item", summary.id);
						item.status = "error";
						item.interrupted = true;
						item.error = "服务重启，执行已中断。请在当前评测内重试。";
						item.endedAt = now();
						this.put("item", item.id, item);
					}
				}
		})();
	}
	list<T>(kind: string): T[] {
		if (kind === "item")
			return this.projections
				.summaries()
				.map((i) => this.require<RunItem>("item", i.id)) as T[];
		return (
			this.db
				.query("SELECT data FROM records WHERE kind=? ORDER BY rowid")
				.all(kind) as { data: string }[]
		).map((row) => JSON.parse(row.data) as T);
	}
	get<T>(kind: string, id: string): T | undefined {
		const row = this.db
			.query("SELECT data FROM records WHERE kind=? AND id=?")
			.get(kind, id) as { data: string } | null;
		if (!row) return;
		const value = JSON.parse(row.data);
		if (kind === "item") {
			const state = this.db
				.query("SELECT data FROM run_item_state WHERE item_id=?")
				.get(id) as { data: string } | null;
			if (state) Object.assign(value, JSON.parse(state.data));
		}
		return value;
	}
	put(kind: string, id: string, value: unknown) {
		this.db.transaction(() => {
			if (
				["case", "item", "run"].includes(kind) &&
				(value as { id?: string })?.id !== id
			)
				throw Error("记录 ID 不一致");
			this.db
				.query(
					"INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
				)
				.run(kind, id, JSON.stringify(value));
			if (["case", "item", "run"].includes(kind)) {
				const row = this.db
					.query("SELECT rowid AS ordinal FROM records WHERE kind=? AND id=?")
					.get(kind, id) as { ordinal: number };
				this.projections.write(kind, value, row.ordinal);
			}
		})();
	}
	progress(item: RunItem) {
		this.db.transaction(() => {
			const row = this.db
				.query("SELECT ordinal FROM run_item_summaries WHERE item_id=?")
				.get(item.id) as { ordinal: number } | null;
			if (!row) throw Error("执行摘要不存在");
			this.projections.write("item", item, row.ordinal);
		})();
	}
	summaries(runId?: string): ItemSummary[] {
		return this.projections.summaries(
			runId ? "WHERE run_id=?" : "",
			runId ? [runId] : [],
		);
	}
	caseItems(caseId: string) {
		return this.projections.summaries("WHERE case_id=?", [caseId]);
	}
	itemIds(runId: string, status?: string, round?: number): string[] {
		return (
			this.db
				.query(
					`SELECT item_id FROM run_item_summaries WHERE run_id=? ${status ? "AND status=?" : ""} ${round ? "AND round=?" : ""} ORDER BY ordinal`,
				)
				.all(runId, ...(status ? [status] : []), ...(round ? [round] : [])) as {
				item_id: string;
			}[]
		).map((r) => r.item_id);
	}

	require<T>(kind: string, id: string): T {
		const value = this.get<T>(kind, id);
		if (!value) throw new Error("记录不存在");
		return value;
	}
	settings() {
		return this.require<EvalDefaults>("settings", "default");
	}
	activeModules() {
		return new LocalCatalogService(this).activeModules();
	}
	activeCases() {
		return new LocalCatalogService(this).activeCases();
	}
	createModule(name: string, description = "", tags: string[] = []): Module {
		return new LocalCatalogService(this).createModule(name, description, tags);
	}
	updateModule(
		id: string,
		input: { name?: string; description?: string; tags?: string[] },
	): Module {
		return new LocalCatalogService(this).updateModule(id, input);
	}
	setArchived(kind: "module" | "case", id: string, archived: boolean) {
		return new LocalCatalogService(this).setArchived(kind, id, archived);
	}
	archiveModule(id: string) {
		return new LocalCatalogService(this).archiveModule(id);
	}
	createCase(
		moduleId: string,
		defaults: EvalDefaults,
		definition: EvalCase,
	): SavedCase {
		return new LocalCatalogService(this).createCase(
			moduleId,
			defaults,
			definition,
		);
	}
	duplicateCase(id: string): SavedCase {
		return new LocalCatalogService(this).duplicateCase(id);
	}

	previewTransfer(input: unknown): TransferPreview {
		return new LocalCatalogService(this).previewTransfer(input);
	}
	transferCases(input: unknown) {
		return new LocalCatalogService(this).transferCases(input);
	}

	deleteCase(id: string) {
		return new LocalCatalogService(this).deleteCase(id);
	}
	parseImport(content: string, mode: string, replayMode: string): EvalSuite {
		return new LocalCatalogService(this).parseImport(content, mode, replayMode);
	}
	importCases(moduleId: string, suite: EvalSuite, policy: string) {
		return new LocalCatalogService(this).importCases(moduleId, suite, policy);
	}
	items(runId: string) {
		return this.itemIds(runId).map((id) => this.require<RunItem>("item", id));
	}
	detail(id: string): RunDetail {
		return { ...this.require<Run>("run", id), items: this.items(id) };
	}
	retryRun(id: string, input: unknown): { run: Run; itemIds: string[] } {
		return new RunCommands(this).retryRun(id, input);
	}

	createRun(input: RunInput, sources?: RunSource[], validated = false): Run {
		return new RunCommands(this).createRun(input, sources, validated);
	}
}
