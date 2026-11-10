import { randomUUID } from "node:crypto";
import type { Module, SavedCase } from "../../contracts/catalog.js";
import type {
	EvalCase,
	EvalDefaults,
	EvalSuite,
} from "../../contracts/evaluation.js";
import type { CaseSummary } from "../../contracts/projections.js";
import { parseEvalSuite } from "../../contracts/schema.js";
import {
	parseTransfer,
	planTransfer,
	TransferError,
	type TransferPreview,
	type TransferRequest,
} from "./transfer.js";
const now = () => new Date().toISOString();
const cleanTags = (tags: unknown): string[] =>
	(Array.isArray(tags) ? tags : [])
		.filter((t) => typeof t === "string" && t.trim())
		.map((t) => t.trim())
		.slice(0, 20);
export interface CatalogRecords {
	transaction<T>(fn: () => T): { (): T; immediate(): T };
	get<T>(kind: string, id: string): T | undefined;
	require<T>(kind: string, id: string): T;
	put(kind: string, id: string, value: unknown): void;
	list<T>(kind: string): T[];
	settings(): EvalDefaults;
	caseSummaries(moduleId?: string): CaseSummary[];
	deleteRecord(kind: string, id: string): void;
}
export class LocalCatalogService {
	constructor(private repository: CatalogRecords) {}
	activeModules() {
		return this.repository
			.list<Module>("module")
			.filter((module) => !module.archived);
	}
	activeCases() {
		return this.repository
			.list<SavedCase>("case")
			.filter((item) => !item.archived);
	}
	createModule(name: string, description = "", tags: string[] = []): Module {
		if (typeof name !== "string" || !name.trim() || name.length > 80)
			throw new Error("模块名称须为 1–80 个字符");
		if (
			this.activeModules().some(
				(m) => m.name.toLowerCase() === name.trim().toLowerCase(),
			)
		)
			throw new Error("模块名称已存在");
		const module = {
			id: randomUUID(),
			name: name.trim(),
			description,
			tags: cleanTags(tags),
			createdAt: now(),
		};
		this.repository.put("module", module.id, module);
		return module;
	}
	updateModule(
		id: string,
		input: { name?: string; description?: string; tags?: string[] },
	): Module {
		const module = this.repository.require<Module>("module", id);
		if (input.name !== undefined) {
			if (
				typeof input.name !== "string" ||
				!input.name.trim() ||
				input.name.length > 80
			)
				throw new Error("模块名称须为 1–80 个字符");
			if (
				this.activeModules().some(
					(m) =>
						m.id !== id &&
						m.name.toLowerCase() === input.name!.trim().toLowerCase(),
				)
			)
				throw new Error("模块名称已存在");
			module.name = input.name.trim();
		}
		if (input.description !== undefined) module.description = input.description;
		if (input.tags !== undefined) module.tags = cleanTags(input.tags);
		this.repository.put("module", id, module);
		return module;
	}
	setArchived(kind: "module" | "case", id: string, archived: boolean) {
		const record = this.repository.require<Module | SavedCase>(kind, id) as {
			archived?: boolean;
		};
		record.archived = archived;
		this.repository.put(kind, id, record);
	}
	archiveModule(id: string) {
		this.repository.transaction(() => {
			this.setArchived("module", id, true);
			for (const item of this.activeCases())
				if (item.moduleId === id) this.setArchived("case", item.id, true);
		})();
	}
	createCase(
		moduleId: string,
		defaults: EvalDefaults,
		definition: EvalCase,
	): SavedCase {
		this.repository.require<Module>("module", moduleId);
		if (
			this.repository
				.caseSummaries(moduleId)
				.some((c) => c.definition.id === definition.id)
		)
			throw new Error("同模块已有相同案例 ID");
		const item: SavedCase = {
			id: randomUUID(),
			moduleId,
			revision: 1,
			definition,
			defaults,
			updatedAt: now(),
		};
		this.repository.put("case", item.id, item);
		return item;
	}
	duplicateCase(id: string): SavedCase {
		const source = this.repository.require<SavedCase>("case", id);
		const base = source.definition.id;
		let suffix = 1;
		while (
			this.activeCases().some(
				(c) =>
					c.moduleId === source.moduleId &&
					c.definition.id === `${base}-copy${suffix}`,
			)
		)
			suffix++;
		const definition = structuredClone(source.definition);
		definition.id = `${base}-copy${suffix}`;
		definition.description = definition.description
			? `${definition.description}（副本）`
			: "副本";
		return this.createCase(
			source.moduleId,
			structuredClone(source.defaults),
			definition,
		);
	}
	private planTransfer(request: TransferRequest): TransferPreview {
		return planTransfer(
			request,
			this.repository.list<Module>("module"),
			this.repository.list<SavedCase>("case"),
		);
	}
	previewTransfer(input: unknown): TransferPreview {
		const request = parseTransfer(input);
		return this.repository.transaction(() => this.planTransfer(request))();
	}
	transferCases(input: unknown) {
		const request = parseTransfer(input, true);
		return this.repository
			.transaction(() => {
				const plan = this.planTransfer(request);
				if (!plan.canApply)
					throw new TransferError("目标模块存在同名案例，请调整冲突策略");
				if (
					plan.items.some(
						(item, index) =>
							item.proposedDefinitionId !==
							request.items[index].expectedDefinitionId,
					)
				)
					throw new TransferError("预览已变化，请重新预览并确认");
				const cases: SavedCase[] = [];
				let copied = 0;
				let moved = 0;
				let unchanged = 0;
				for (const [index, item] of plan.items.entries()) {
					const source = this.repository.require<SavedCase>("case", item.id);
					if (item.result === "unchanged") {
						cases.push(source);
						unchanged++;
						continue;
					}
					const next = structuredClone(source);
					const draft = request.items[index].draft;
					if (draft) {
						next.definition = structuredClone(draft.definition);
						next.defaults = structuredClone(draft.defaults);
					}
					next.moduleId = request.targetModuleId;
					next.definition.id = item.proposedDefinitionId;
					next.updatedAt = now();
					if (request.operation === "copy") {
						next.id = randomUUID();
						next.revision = 1;
						copied++;
					} else {
						next.revision++;
						moved++;
					}
					this.repository.put("case", next.id, next);
					cases.push(next);
				}
				return { cases, copied, moved, unchanged };
			})
			.immediate();
	}
	deleteCase(id: string) {
		this.repository.require<SavedCase>("case", id);
		this.repository.transaction(() =>
			this.repository.deleteRecord("case", id),
		)();
	}
	parseImport(content: string, mode: string, replayMode: string): EvalSuite {
		if (!["single-turn", "full-task", "function-call"].includes(replayMode))
			throw new Error("请选择有效回放方式");
		let raw: Record<string, unknown>;
		if (mode === "jsonl") {
			const cases = content
				.split(/\r?\n/)
				.map((line, index) => {
					if (!line.trim()) return null;
					try {
						return JSON.parse(line);
					} catch {
						throw new Error(`第 ${index + 1} 行不是有效 JSON`);
					}
				})
				.filter(Boolean);
			raw = { cases };
		} else {
			const parsed = JSON.parse(content);
			raw = Array.isArray(parsed) ? { cases: parsed } : parsed;
		}
		if (!raw || typeof raw !== "object")
			throw new Error("请输入案例集 JSON 或案例数组");
		if (!Array.isArray(raw.cases)) {
			if ("source" in raw && "moduleId" in raw)
				throw new Error(
					"这是 Python 接入参数，请通过 Python 导入入口写入；网页导入需要包含 cases 数组的案例集 JSON。",
				);
			if ("messages" in raw || "messgaes" in raw)
				throw new Error(
					"这是历史对话 JSON，请切换到「历史对话 JSON（批量生成案例）」后上传。",
				);
			throw new Error(
				"案例集 JSON 需要包含 cases 数组，也可直接上传案例数组或 JSONL。",
			);
		}
		if (raw.cases.length < 1 || raw.cases.length > 1000)
			throw new Error("每次导入 1–1000 个案例");
		const suite = parseEvalSuite({
			...raw,
			cases: raw.cases.map((c) =>
				c && typeof c === "object"
					? { ...c, replayMode: c.replayMode ?? replayMode }
					: c,
			),
			defaults: {
				...this.repository.settings(),
				...((raw.defaults as object) ?? {}),
			},
		});
		for (const item of suite.cases)
			item.replayMode ??= replayMode as
				| "single-turn"
				| "full-task"
				| "function-call";
		return suite;
	}
	importCases(moduleId: string, suite: EvalSuite, policy: string) {
		if (this.repository.require<Module>("module", moduleId).archived)
			throw new Error("目标模块已归档");
		if (!["skip", "version"].includes(policy))
			throw new Error("重复项策略无效");
		const existing = this.activeCases().filter((c) => c.moduleId === moduleId);
		let created = 0;
		let updated = 0;
		let skipped = 0;
		this.repository.transaction(() => {
			for (const definition of suite.cases) {
				const previous = existing.find(
					(c) => c.definition.id === definition.id,
				);
				if (previous && policy === "skip") {
					skipped++;
					continue;
				}
				if (previous) updated++;
				else created++;
				const item: SavedCase = {
					id: previous?.id ?? randomUUID(),
					moduleId,
					definition,
					defaults: suite.defaults,
					revision: (previous?.revision ?? 0) + 1,
					updatedAt: now(),
				};
				this.repository.put("case", item.id, item);
			}
		})();
		return { created, updated, skipped };
	}
}
