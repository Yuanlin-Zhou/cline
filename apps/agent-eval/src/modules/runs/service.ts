import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	latestAttempts,
	type Run,
	type RunItem,
} from "../../contracts/catalog.js";
import { parseEvalSuite } from "../../contracts/schema.js";
import {
	EvalStore,
	type RunSource,
} from "../../infrastructure/sqlite/store.js";
import {
	CatalogError,
	type CatalogRepository,
} from "../../modules/catalog/repository.js";
import { preflight } from "../../modules/grading/engine.js";
import { preparePythonUpload } from "../../modules/grading/python-runtime.js";
import { type VerifierRepository } from "../../modules/grading/uploaded-verifiers.js";
import {
	resolveVerifiers,
	uploadedPlaceholder,
} from "../../modules/grading/verifiers.js";
import { preflightJudge } from "../../modules/judging/engine.js";

export type RunSubmissionDependencies = {
	store: EvalStore;
	catalog: CatalogRepository;
	verifierRepository: VerifierRepository;
};
export class RunService {
	constructor(private dependencies: RunSubmissionDependencies) {}
	async submit(body: any): Promise<Run> {
		const { store, catalog, verifierRepository } = this.dependencies;

		for (const key of ["caseIds", "moduleIds"])
			if (
				body[key] !== undefined &&
				(!Array.isArray(body[key]) ||
					body[key].some((id: unknown) => typeof id !== "string" || !id))
			)
				throw Error("案例/模块选择参数无效");
		if (body.defaults) {
			const parsed = parseEvalSuite({
				defaults: body.defaults,
				cases: [{ id: "run-defaults", prompt: "run-defaults" }],
			}).defaults;
			if (parsed.cwd && !path.isAbsolute(parsed.cwd))
				throw new Error("fixture 目录须为绝对路径");
		}
		if (Array.isArray(body.draft))
			for (const draft of body.draft) {
				const module = await catalog.getModule(draft.moduleId);
				if (!module || module.archived)
					throw new CatalogError("草稿目标模块不存在或已归档", 409);
				const suite = parseEvalSuite({
					defaults: draft.defaults,
					cases: [draft.definition],
				});
				for (const cwd of [suite.defaults.cwd, suite.cases[0].cwd])
					if (cwd && !path.isAbsolute(cwd))
						throw new Error("fixture 目录须为绝对路径");
				draft.definition = suite.cases[0];
				draft.defaults = suite.defaults;
			}
		let sources: RunSource[] | undefined;
		if (body.draft?.length) {
			sources = [];
			for (const draft of body.draft) {
				const module = await catalog.getModule(draft.moduleId);
				if (!module || module.archived)
					throw new CatalogError("草稿目标模块不存在或已归档", 409);
				sources.push({
					snapshot: {
						id: randomUUID(),
						moduleId: draft.moduleId,
						revision: 0,
						definition: draft.definition,
						defaults: draft.defaults,
						updatedAt: new Date().toISOString(),
					},
					moduleName: module.name,
				});
			}
		} else if (!body.parentRunId) {
			const snapshot = catalog.selected
				? await catalog.selected(body)
				: await catalog.snapshot();
			if (
				body.caseIds?.some(
					(id: string) => !snapshot.cases.some((c) => c.id === id),
				) ||
				body.moduleIds?.some(
					(id: string) => !snapshot.modules.some((m) => m.id === id),
				)
			)
				throw new CatalogError("选中的案例或模块不存在或已归档", 404);
			sources = snapshot.cases
				.filter(
					(c) =>
						body.caseIds?.includes(c.id) ||
						body.moduleIds?.includes(c.moduleId),
				)
				.map((c) => ({
					snapshot: c,
					moduleName: snapshot.modules.find((m) => m.id === c.moduleId)!.name,
				}));
		}
		if (!sources && body.parentRunId) {
			const items = latestAttempts(store.summaries(body.parentRunId)).filter(
				(i) =>
					body.rerunScope === "all" ||
					["failed", "error", "cancelled", "inconclusive"].includes(i.status),
			);
			sources = [
				...new Map(
					items.map((s) => {
						const i = store.require<RunItem>("item", s.id);
						return [
							i.snapshot.id,
							{
								snapshot: i.snapshot,
								moduleName: i.moduleName,
								verifierSnapshots: i.verifierSnapshots,
							},
						] as const;
					}),
				).values(),
			];
		}
		const prepared = [];
		let preparedCount = 0;
		for (const source of sources ?? []) {
			const definition = parseEvalSuite({
				defaults: source.snapshot.defaults,
				cases: [
					{
						...source.snapshot.definition,
						...(body.replayMode ? { replayMode: body.replayMode } : {}),
					},
				],
			}).cases[0];
			const frozen = body.parentRunId
				? (source.verifierSnapshots ?? [])
				: undefined;
			const resolved = await resolveVerifiers(
				definition,
				frozen === undefined ? verifierRepository : undefined,
				frozen,
			);
			resolved.uploaded = await Promise.all(
				resolved.uploaded.map((v) => preparePythonUpload(v)),
			);
			preflightJudge(definition.llmJudge);
			preflight(definition, [
				...resolved.configured,
				...resolved.uploaded.map(uploadedPlaceholder),
			]);
			prepared.push({
				...source,
				snapshot: { ...source.snapshot, definition },
				verifierSnapshots: resolved.uploaded,
			});
			if (++preparedCount % 10 === 0) await Bun.sleep(0);
		}
		return store.createRun(body, prepared, true);
	}
}
