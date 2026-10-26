import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
	existsSync,
	openSync,
	writeFileSync,
	closeSync,
	unlinkSync,
	readFileSync,
} from "node:fs";
import path from "node:path";
import type { SavedCase, RunItem } from "./types.js";

export type CaseSummary = Pick<
	SavedCase,
	"id" | "moduleId" | "revision" | "updatedAt" | "archived"
> & {
	summary: true;
	definition: Pick<
		SavedCase["definition"],
		"id" | "description" | "tags" | "replayMode"
	>;
	defaults: Pick<SavedCase["defaults"], "providerId" | "modelId">;
};
export function caseSummary(c: SavedCase): CaseSummary {
	return {
		summary: true,
		id: c.id,
		moduleId: c.moduleId,
		revision: c.revision,
		updatedAt: c.updatedAt,
		archived: c.archived,
		definition: {
			id: c.definition.id,
			description: c.definition.description,
			tags: c.definition.tags,
			replayMode: c.definition.replayMode,
		},
		defaults: {
			providerId: c.defaults.providerId,
			modelId: c.defaults.modelId,
		},
	};
}
export type ItemSummary = RunItem & {
	summary: true;
	detailVersion: number;
	outputHash?: string;
	judgeGroupKey?: string;
	gradingGroupKey?: string;
	direct: boolean;
	hasContentAssertions: boolean;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function itemSummary(item: RunItem, version: number): ItemSummary {
	const r = item.result,
		g = r?.grading,
		j = r?.llmJudge,
		config = item.snapshot.definition.llmJudge;
	const snapshot = caseSummary(item.snapshot) as unknown as SavedCase;
	if (item.snapshot.definition.grading)
		snapshot.definition.grading = { version: 1, rules: [] };
	if (config?.enabled)
		snapshot.definition.llmJudge = {
			...config,
			referenceAnswer: "",
			resultFiles: [],
			model: config.model
				? { providerId: config.model.providerId, modelId: config.model.modelId }
				: undefined,
		};
	return {
		summary: true,
		detailVersion: version,
		id: item.id,
		runId: item.runId,
		rootItemId: item.rootItemId,
		previousItemId: item.previousItemId,
		attempt: item.attempt,
		round: item.round,
		snapshot,
		moduleName: item.moduleName,
		status: item.status,
		phase: item.phase,
		sessionId: item.sessionId,
		startedAt: item.startedAt,
		endedAt: item.endedAt,
		lastActivityAt: item.lastActivityAt,
		interrupted: item.interrupted,
		text: "",
		hasContentAssertions: Boolean(
			item.snapshot.definition.grading ||
				item.snapshot.definition.assertions?.contains?.length ||
				item.snapshot.definition.assertions?.notContains?.length ||
				item.snapshot.definition.assertions?.matches?.length,
		),
		direct:
			(item.snapshot.definition.workspace ?? item.snapshot.defaults.workspace)
				?.mode === "direct",
		gradingGroupKey: item.snapshot.definition.grading
			? (g?.ruleHash ?? hash(JSON.stringify(item.snapshot.definition.grading)))
			: undefined,
		outputHash: r ? hash(r.text.replace(/\r\n?/g, "\n").trim()) : undefined,
		judgeGroupKey: config
			? hash(JSON.stringify([config.model, config.rubric ?? ""]))
			: undefined,
		result: r
			? {
					id: r.id,
					status: r.status,
					sessionId: r.sessionId,
					text: "",
					durationMs: r.durationMs,
					iterations: r.iterations,
					usage: r.usage,
					assertions: [],
					toolCalls: [],
					execution: r.execution ? { status: r.execution.status } : undefined,
					grading: g
						? {
								...g,
								verifiers: [],
								results: g.results.map((v) => ({
									id: v.id,
									kind: v.kind,
									required: v.required,
									status: v.status,
									message: "",
									durationMs: v.durationMs,
									evidenceRefs: [],
								})),
							}
						: undefined,
					llmJudge: j
						? {
								...j,
								rationale: "",
								evidence: [],
								limitations: [],
								model: j.model
									? { providerId: j.model.providerId, modelId: j.model.modelId }
									: undefined,
							}
						: undefined,
				}
			: undefined,
	};
}
const stateKeys = [
	"status",
	"phase",
	"sessionId",
	"lastActivityAt",
	"activity",
	"activities",
	"workspace",
	"startedAt",
	"endedAt",
	"interrupted",
	"error",
	"text",
] as const;
export function itemState(item: RunItem) {
	return Object.fromEntries(
		stateKeys.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]),
	);
}

/** Projections are maintained in the same SQLite transaction as their source writes. */
export class Projections {
	readonly epoch: string;
	constructor(
		readonly db: Database,
		readonly directory: string,
		rebuild = false,
	) {
		this.migrate(rebuild);
		this.epoch = (
			db.query("SELECT value FROM eval_schema WHERE key='epoch'").get() as {
				value: string;
			}
		).value;
	}
	private migrate(rebuild = false) {
		const found = this.db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='eval_schema'",
			)
			.get();
		if (found) {
			const version = (
				this.db
					.query("SELECT value FROM eval_schema WHERE key='version'")
					.get() as any
			)?.value;
			if (version && version !== "1")
				throw Error(`本地数据库版本 ${version} 不受支持，请使用匹配的应用版本`);
		}
		if (
			!rebuild &&
			found &&
			(
				this.db
					.query("SELECT value FROM eval_schema WHERE key='version'")
					.get() as any
			)?.value === "1"
		) {
			for (const [kind, table, key] of [
				["case", "case_summaries", "case_id"],
				["item", "run_item_summaries", "item_id"],
			]) {
				const source = (
					this.db
						.query("SELECT count(*) AS n FROM records WHERE kind=?")
						.get(kind!) as { n: number }
				).n;
				const target = (
					this.db.query(`SELECT count(*) AS n FROM ${table}`).get() as {
						n: number;
					}
				).n;
				const missing = this.db
					.query(
						`SELECT id FROM records r WHERE kind=? AND NOT EXISTS(SELECT 1 FROM ${table} s WHERE s.${key}=r.id) LIMIT 1`,
					)
					.get(kind!);
				if (source !== target || missing)
					throw Error(
						"本地摘要与原记录不一致，请停止服务后运行 performance-storage.ts --rebuild",
					);
			}
			const state = (
				this.db.query("SELECT count(*) AS n FROM run_item_state").get() as {
					n: number;
				}
			).n;
			const items = (
				this.db.query("SELECT count(*) AS n FROM run_item_summaries").get() as {
					n: number;
				}
			).n;
			if (state !== items)
				throw Error("本地进度摘要不一致，请停止服务后重建索引");
			return;
		}
		const lock = path.join(this.directory, "performance-migration.lock");
		if (existsSync(lock)) {
			const pid = Number(readFileSync(lock, "utf8"));
			let active = true;
			try {
				process.kill(pid, 0);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ESRCH") active = false;
			}
			if (active)
				throw Error("性能索引迁移已在其他进程进行，请停止其他实例后重试");
			unlinkSync(lock);
		}
		const fd = openSync(lock, "wx");
		writeFileSync(fd, String(process.pid));
		try {
			const count = (
				this.db.query("SELECT count(*) AS n FROM records").get() as {
					n: number;
				}
			).n;
			if (count) {
				const backup = path.join(
					this.directory,
					`eval.pre-performance-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`,
				);
				this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
				console.error(`[storage] 性能索引迁移备份：${backup}`);
			}
			this.db
				.transaction(() => {
					const hasState = this.db
						.query(
							"SELECT name FROM sqlite_master WHERE type='table' AND name='run_item_state'",
						)
						.get();
					this.db.exec("DROP TABLE IF EXISTS temp.previous_item_state");
					if (hasState)
						this.db.exec(
							"CREATE TEMP TABLE previous_item_state AS SELECT item_id,data FROM run_item_state; CREATE UNIQUE INDEX previous_state_id ON previous_item_state(item_id)",
						);
					this.db.exec(`CREATE TABLE IF NOT EXISTS eval_schema(key TEXT PRIMARY KEY,value TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS case_summaries(case_id TEXT PRIMARY KEY,module_id TEXT NOT NULL,archived INTEGER NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS case_summaries_module ON case_summaries(module_id,archived,ordinal);
     CREATE INDEX IF NOT EXISTS case_summaries_active ON case_summaries(archived,ordinal);
     CREATE TABLE IF NOT EXISTS run_revisions(run_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE IF NOT EXISTS run_item_summaries(item_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,case_id TEXT NOT NULL,root_id TEXT NOT NULL,attempt INTEGER NOT NULL,round INTEGER NOT NULL,status TEXT NOT NULL,ordinal INTEGER NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS items_run ON run_item_summaries(run_id,ordinal);
     CREATE INDEX IF NOT EXISTS items_root ON run_item_summaries(run_id,root_id,attempt);
     CREATE INDEX IF NOT EXISTS items_case ON run_item_summaries(case_id,ordinal);
     CREATE INDEX IF NOT EXISTS items_changes ON run_item_summaries(run_id,seq);
     CREATE INDEX IF NOT EXISTS items_pending ON run_item_summaries(run_id,status,round,ordinal);
     CREATE TABLE IF NOT EXISTS run_item_state(item_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS state_run ON run_item_state(run_id);
     DELETE FROM case_summaries; DELETE FROM run_item_summaries; DELETE FROM run_item_state; DELETE FROM run_revisions;`);
					let after = 0;
					while (true) {
						const rows = this.db
							.query(
								"SELECT rowid AS ordinal,kind,id,data FROM records WHERE rowid>? ORDER BY rowid LIMIT 50",
							)
							.all(after) as {
							ordinal: number;
							kind: string;
							id: string;
							data: string;
						}[];
						if (!rows.length) break;
						for (const row of rows) {
							after = row.ordinal;
							if (!["case", "item", "run"].includes(row.kind)) continue;
							try {
								const value = JSON.parse(row.data);
								if (value.id !== row.id) throw Error("记录 ID 不一致");
								if (row.kind === "item" && hasState) {
									const state = this.db
										.query(
											"SELECT data FROM previous_item_state WHERE item_id=?",
										)
										.get(row.id) as { data: string } | null;
									if (state) Object.assign(value, JSON.parse(state.data));
								}
								this.write(row.kind, value, row.ordinal);
							} catch (error) {
								throw Error(`迁移失败：${row.kind}/${row.id}：${error}`);
							}
						}
					}
					for (const [kind, table] of [
						["case", "case_summaries"],
						["item", "run_item_summaries"],
					]) {
						const source = (
							this.db
								.query("SELECT count(*) AS n FROM records WHERE kind=?")
								.get(kind!) as any
						).n;
						const target = (
							this.db.query(`SELECT count(*) AS n FROM ${table}`).get() as any
						).n;
						if (source !== target) throw Error(`迁移记录数不一致：${kind}`);
					}
					const orphan = this.db
						.query(
							"SELECT i.item_id FROM run_item_summaries i LEFT JOIN records r ON r.kind='run' AND r.id=i.run_id LEFT JOIN run_item_summaries root ON root.item_id=i.root_id AND root.run_id=i.run_id WHERE r.id IS NULL OR root.item_id IS NULL LIMIT 1",
						)
						.get() as { item_id: string } | null;
					if (orphan) throw Error(`迁移执行关联不完整：${orphan.item_id}`);
					this.db
						.query("INSERT OR REPLACE INTO eval_schema VALUES('epoch',?)")
						.run(randomUUID());
					this.db
						.query("INSERT OR REPLACE INTO eval_schema VALUES('version','1')")
						.run();
					this.db.exec("DROP TABLE IF EXISTS temp.previous_item_state");
				})
				.immediate();
		} finally {
			closeSync(fd);
			unlinkSync(lock);
		}
	}
	bump(runId: string) {
		this.db
			.query(
				"INSERT INTO run_revisions VALUES(?,1) ON CONFLICT(run_id) DO UPDATE SET revision=revision+1",
			)
			.run(runId);
		return (
			this.db
				.query("SELECT revision FROM run_revisions WHERE run_id=?")
				.get(runId) as { revision: number }
		).revision;
	}
	write(kind: string, value: any, ordinal: number) {
		if (kind === "case") {
			const s = caseSummary(value);
			this.db
				.query(
					"INSERT INTO case_summaries VALUES(?,?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET module_id=excluded.module_id,archived=excluded.archived,data=excluded.data",
				)
				.run(s.id, s.moduleId, s.archived ? 1 : 0, ordinal, JSON.stringify(s));
		} else if (kind === "run") this.bump(value.id);
		else if (kind === "item") {
			if (
				!value?.id ||
				!value.runId ||
				!value.snapshot?.id ||
				!value.snapshot.definition ||
				typeof value.snapshot.definition.id !== "string"
			)
				throw Error("执行记录缺少关联或快照");
			const seq = this.bump(value.runId),
				s = itemSummary(value, seq);
			this.db
				.query(
					"INSERT INTO run_item_summaries VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET run_id=excluded.run_id,case_id=excluded.case_id,root_id=excluded.root_id,attempt=excluded.attempt,round=excluded.round,status=excluded.status,seq=excluded.seq,data=excluded.data",
				)
				.run(
					value.id,
					value.runId,
					value.snapshot.id,
					value.rootItemId ?? value.id,
					value.attempt ?? 0,
					value.round ?? 1,
					value.status,
					ordinal,
					seq,
					JSON.stringify(s),
				);
			this.db
				.query(
					"INSERT INTO run_item_state VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET version=excluded.version,data=excluded.data",
				)
				.run(value.id, value.runId, seq, JSON.stringify(itemState(value)));
		}
	}
	summaries(where = "", params: any[] = []): ItemSummary[] {
		return (
			this.db
				.query(`SELECT data FROM run_item_summaries ${where} ORDER BY ordinal`)
				.all(...params) as { data: string }[]
		).map((r) => JSON.parse(r.data));
	}
	cases(moduleId?: string): CaseSummary[] {
		return (
			this.db
				.query(
					`SELECT data FROM case_summaries WHERE archived=0 ${moduleId ? "AND module_id=?" : ""} ORDER BY ordinal`,
				)
				.all(...(moduleId ? [moduleId] : [])) as { data: string }[]
		).map((r) => JSON.parse(r.data));
	}
}
