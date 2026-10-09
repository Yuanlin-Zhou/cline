import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseEvalSuite } from "../schema.js";
import type { EvalCase, EvalDefaults, EvalSuite } from "../types.js";
import type { Module, Run, RunDetail, RunItem, SavedCase } from "./types.js";

import { planTransfer, parseTransfer, TransferError, type TransferRequest, type TransferPreview } from "./transfer.js";

export type RunInput = { caseIds?: string[]; moduleIds?: string[]; name?: string; note?: string; concurrency?: number; repeatCount?: number; useSettings?: boolean; replayMode?: string; parentRunId?: string; rerunScope?: "all" | "failed"; defaults?: EvalDefaults; draft?: Array<{ moduleId: string; definition: EvalCase; defaults: EvalDefaults }> };
export type RunSource = { snapshot: SavedCase; moduleName: string };

const now = () => new Date().toISOString();
const cleanTags = (tags: unknown): string[] => (Array.isArray(tags) ? tags : []).filter(tag => typeof tag === "string" && tag.trim()).map(tag => (tag as string).trim()).slice(0, 20);
export class EvalStore {
	validateCase?: (definition: EvalCase) => void;
	readonly db: Database;
	constructor(readonly directory: string, options: { seedModules?: boolean } = {}) {
		mkdirSync(directory, { recursive: true });
		this.db = new Database(path.join(directory, "eval.sqlite"));
		this.db.exec(`PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));`);
		if (!this.get<EvalDefaults>("settings", "default")) {
			this.put("settings", "default", parseEvalSuite({ cases: [{ id: "default", prompt: "default" }] }).defaults);
			if (options.seedModules !== false) for (const [name, description] of [["read_file", "文件读取、路径处理与边界行为"], ["write_file", "文件创建、内容修改与写入验证"], ["execute_command", "命令执行与错误处理"], ["task_completion", "完整任务执行与最终结果验证"]]) this.createModule(name, description);
		}
		this.db.transaction(() => {
			for (const run of this.list<Run>("run")) if (["queued", "running"].includes(run.status)) {
				run.status = "interrupted"; run.endedAt = now(); this.put("run", run.id, run);
				for (const item of this.items(run.id)) if (["queued", "running"].includes(item.status)) {
					item.status = "error"; item.interrupted = true; item.error = "服务重启，执行已中断。请创建重跑批次。"; item.endedAt = now(); this.put("item", item.id, item);
				}
			}
		})();
	}
	list<T>(kind: string): T[] { return (this.db.query("SELECT data FROM records WHERE kind=? ORDER BY rowid").all(kind) as { data: string }[]).map(row => JSON.parse(row.data) as T); }
	get<T>(kind: string, id: string): T | undefined { const row = this.db.query("SELECT data FROM records WHERE kind=? AND id=?").get(kind, id) as { data: string } | null; return row ? JSON.parse(row.data) as T : undefined; }
	put(kind: string, id: string, value: unknown) { this.db.query("INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(kind, id, JSON.stringify(value)); }
	require<T>(kind: string, id: string): T { const value = this.get<T>(kind, id); if (!value) throw new Error("记录不存在"); return value; }
	settings() { return this.require<EvalDefaults>("settings", "default"); }
	activeModules() { return this.list<Module>("module").filter(module => !module.archived); }
	activeCases() { return this.list<SavedCase>("case").filter(item => !item.archived); }
	createModule(name: string, description = "", tags: string[] = []): Module {
		if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("模块名称须为 1–80 个字符");
		if (this.activeModules().some(m => m.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("模块名称已存在");
		const module = { id: randomUUID(), name: name.trim(), description, tags: cleanTags(tags), createdAt: now() }; this.put("module", module.id, module); return module;
	}
	updateModule(id: string, input: { name?: string; description?: string; tags?: string[] }): Module {
		const module = this.require<Module>("module", id);
		if (input.name !== undefined) {
			if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80) throw new Error("模块名称须为 1–80 个字符");
			if (this.activeModules().some(m => m.id !== id && m.name.toLowerCase() === input.name!.trim().toLowerCase())) throw new Error("模块名称已存在");
			module.name = input.name.trim();
		}
		if (input.description !== undefined) module.description = input.description;
		if (input.tags !== undefined) module.tags = cleanTags(input.tags);
		this.put("module", id, module); return module;
	}
	setArchived(kind: "module" | "case", id: string, archived: boolean) {
		const record = this.require<Module | SavedCase>(kind, id) as { archived?: boolean };
		record.archived = archived; this.put(kind, id, record);
	}
	archiveModule(id: string) {
		this.db.transaction(() => {
			this.setArchived("module", id, true);
			for (const item of this.activeCases()) if (item.moduleId === id) this.setArchived("case", item.id, true);
		})();
	}
	createCase(moduleId: string, defaults: EvalDefaults, definition: EvalCase): SavedCase {
		this.require<Module>("module", moduleId);
		if (this.activeCases().some(c => c.moduleId === moduleId && c.definition.id === definition.id)) throw new Error("同模块已有相同案例 ID");
		const item: SavedCase = { id: randomUUID(), moduleId, revision: 1, definition, defaults, updatedAt: now() }; this.put("case", item.id, item); return item;
	}
	duplicateCase(id: string): SavedCase {
		const source = this.require<SavedCase>("case", id);
		const base = source.definition.id;
		let suffix = 1; while (this.activeCases().some(c => c.moduleId === source.moduleId && c.definition.id === `${base}-copy${suffix}`)) suffix++;
		const definition = structuredClone(source.definition); definition.id = `${base}-copy${suffix}`; definition.description = definition.description ? `${definition.description}（副本）` : "副本";
		return this.createCase(source.moduleId, structuredClone(source.defaults), definition);
	}
	private planTransfer(request: TransferRequest): TransferPreview {
		return planTransfer(request, this.list<Module>("module"), this.list<SavedCase>("case"));
	}
	previewTransfer(input: unknown): TransferPreview {
		const request = parseTransfer(input);
		return this.db.transaction(() => this.planTransfer(request))();
	}
	transferCases(input: unknown) {
		const request = parseTransfer(input, true);
		return this.db.transaction(() => {
			const plan = this.planTransfer(request);
			if (!plan.canApply) throw new TransferError("目标模块存在同名案例，请调整冲突策略");
			if (plan.items.some((item, index) => item.proposedDefinitionId !== request.items[index].expectedDefinitionId)) throw new TransferError("预览已变化，请重新预览并确认");
			const cases: SavedCase[] = [];
			let copied = 0; let moved = 0; let unchanged = 0;
			for (const item of plan.items) {
				const source = this.require<SavedCase>("case", item.id);
				if (item.result === "unchanged") { cases.push(source); unchanged++; continue; }
				const next = structuredClone(source);
				next.moduleId = request.targetModuleId;
				next.definition.id = item.proposedDefinitionId;
				next.updatedAt = now();
				if (request.operation === "copy") { next.id = randomUUID(); next.revision = 1; copied++; }
				else { next.revision++; moved++; }
				this.put("case", next.id, next); cases.push(next);
			}
			return { cases, copied, moved, unchanged };
		}).immediate();
	}

	deleteCase(id: string) {
		this.require<SavedCase>("case", id);
		// Executions own their snapshots, so deleting a case preserves queued work and history.
		this.db.query("DELETE FROM records WHERE kind='case' AND id=?").run(id);
	}
	parseImport(content: string, mode: string, replayMode: string): EvalSuite {
		if (!["single-turn", "full-task"].includes(replayMode)) throw new Error("请选择有效回放方式");
		let raw: Record<string, unknown>;
		if (mode === "jsonl") {
			const cases = content.split(/\r?\n/).map((line, index) => { if (!line.trim()) return null; try { return JSON.parse(line); } catch { throw new Error(`第 ${index + 1} 行不是有效 JSON`); } }).filter(Boolean);
			raw = { cases };
		} else {
			const parsed = JSON.parse(content);
			raw = Array.isArray(parsed) ? { cases: parsed } : parsed;
		}
		if (!raw || typeof raw !== "object") throw new Error("请输入案例集 JSON 或案例数组");
		if (!Array.isArray(raw.cases) || raw.cases.length > 1000) throw new Error("每次导入 1–1000 个案例");
		const suite = parseEvalSuite({ ...raw, cases: raw.cases.map(c => c && typeof c === "object" ? { ...c, replayMode: c.replayMode ?? replayMode } : c), defaults: { ...this.settings(), ...(raw.defaults as object ?? {}) } });
		for (const item of suite.cases) item.replayMode ??= replayMode as "single-turn" | "full-task";
		return suite;
	}
	importCases(moduleId: string, suite: EvalSuite, policy: string) {
		this.require<Module>("module", moduleId);
		if (!["skip", "version"].includes(policy)) throw new Error("重复项策略无效");
		const existing = this.activeCases().filter(c => c.moduleId === moduleId);
		let created = 0; let updated = 0; let skipped = 0;
		this.db.transaction(() => {
			for (const definition of suite.cases) {
				const previous = existing.find(c => c.definition.id === definition.id);
				if (previous && policy === "skip") { skipped++; continue; }
				if (previous) updated++; else created++;
				const item: SavedCase = { id: previous?.id ?? randomUUID(), moduleId, definition, defaults: suite.defaults, revision: (previous?.revision ?? 0) + 1, updatedAt: now() };
				this.put("case", item.id, item);
			}
		})();
		return { created, updated, skipped };
	}
	items(runId: string) { return this.list<RunItem>("item").filter(item => item.runId === runId); }
	detail(id: string): RunDetail { return { ...this.require<Run>("run", id), items: this.items(id) }; }
	createRun(input: RunInput, resolvedSources?: RunSource[]): Run {
		const concurrency = input.concurrency ?? 1;
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("并发数须为 1–4");
		const repeatCount = input.repeatCount === undefined ? 1 : input.repeatCount;
		if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100) throw new Error("重复轮数须为 1–100 的整数");
		if (input.rerunScope !== undefined && !["all", "failed"].includes(input.rerunScope)) throw new Error("重跑范围无效");
		if (input.replayMode && !["single-turn", "full-task"].includes(input.replayMode)) throw new Error("回放方式无效");
		let sources: RunSource[];
		if (resolvedSources) sources = resolvedSources;
		else if (input.draft?.length) {
			sources = input.draft.map(draft => ({ snapshot: { id: randomUUID(), moduleId: draft.moduleId, revision: 0, definition: { ...draft.definition, replayMode: input.replayMode as "single-turn" | "full-task" }, defaults: draft.defaults, updatedAt: now() }, moduleName: this.require<Module>("module", draft.moduleId).name }));
		} else if (input.parentRunId) {
			const items = this.detail(input.parentRunId).items.filter(i => input.rerunScope === "all" || ["failed", "error", "cancelled", "inconclusive"].includes(i.status));
			// Repeated failures select a case once, retaining the original input snapshot.
			sources = [...new Map(items.map(i => [i.snapshot.id, { snapshot: i.snapshot, moduleName: i.moduleName }])).values()];
		}
		else {
			if (input.caseIds?.some(id => !this.get("case", id)) || input.moduleIds?.some(id => !this.get("module", id))) throw new Error("选中的案例或模块不存在");
			sources = this.activeCases().filter(c => input.caseIds?.includes(c.id) || input.moduleIds?.includes(c.moduleId)).map(snapshot => ({ snapshot, moduleName: this.require<Module>("module", snapshot.moduleId).name }));
		}
		if (!sources.length) throw new Error("请选择至少一个案例；空模块无法执行");
		for (const source of sources) {
			const definition = { ...source.snapshot.definition, ...(input.replayMode ? { replayMode: input.replayMode } : {}) };
			const parsed = parseEvalSuite({ defaults: source.snapshot.defaults, cases: [definition] }).cases[0];
			this.validateCase?.(parsed);
		}
		const run: Run = { id: randomUUID(), name: input.name?.trim() || `回归评测 · ${new Date().toLocaleString("zh-CN")}`, note: input.note?.trim(), status: "queued", concurrency, repeatCount, createdAt: now(), parentRunId: input.parentRunId };
		this.db.transaction(() => {
			this.put("run", run.id, run);
			for (let round = 1; round <= repeatCount; round++) for (const source of sources) {
				const snapshot = structuredClone(source.snapshot);
				if (input.useSettings) snapshot.defaults = this.settings();
				if (input.defaults) snapshot.defaults = { ...snapshot.defaults, ...input.defaults };
				if (input.replayMode) snapshot.definition.replayMode = input.replayMode as "single-turn" | "full-task";
				const item: RunItem = { id: randomUUID(), runId: run.id, round, snapshot, moduleName: source.moduleName, status: "queued", text: "" }; this.put("item", item.id, item);
			}
		})(); return run;
	}
}
