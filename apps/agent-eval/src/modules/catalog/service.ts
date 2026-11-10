import type {
	EvalCase,
	EvalDefaults,
	EvalSuite,
} from "../../contracts/evaluation.js";
import { parseEvalSuite } from "../../contracts/schema.js";
import { validateWorkspacePaths } from "../execution/workspace-validation.js";
import type { VerifierRepository } from "../grading/uploaded-verifiers.js";
import { resolveVerifiers } from "../grading/verifiers.js";
import { previewConversations } from "./batch-conversations.js";
import { CatalogError, type CatalogRepository } from "./repository.js";
import { parseTransfer } from "./transfer.js";

export interface SuiteImportParser {
	parseImport(content: string, format: string, replayMode: string): EvalSuite;
}
export class CatalogService {
	constructor(
		readonly catalog: CatalogRepository,
		private verifiers: VerifierRepository,
		private imports: SuiteImportParser,
	) {}
	private async writeInput(body: {
		defaults: EvalDefaults;
		definition: EvalCase;
	}) {
		const suite = parseEvalSuite({
			defaults: body.defaults,
			cases: [body.definition],
		});
		validateWorkspacePaths(suite.cases[0], suite.defaults);
		await resolveVerifiers(suite.cases[0], this.verifiers);
		return suite;
	}
	async create(body: any) {
		if (!body.moduleId) throw new Error("缺少目标模块");
		const suite = await this.writeInput(body);
		return this.catalog.createCase(
			body.moduleId,
			suite.defaults,
			suite.cases[0],
		);
	}
	async update(id: string, body: any) {
		const suite = await this.writeInput(body);
		return this.catalog.updateCase(
			id,
			body.revision,
			suite.defaults,
			suite.cases[0],
		);
	}
	async transfer(body: unknown, apply: boolean) {
		const parsed = parseTransfer(body, apply);
		for (const item of parsed.items)
			if (item.draft) await this.writeInput(item.draft);
		return apply
			? this.catalog.transferCases(parsed)
			: this.catalog.previewTransfer(parsed);
	}
	async importSuite(body: any, apply: boolean) {
		if (!(await this.catalog.getModule(body.moduleId)))
			throw new CatalogError("模块不存在", 404);
		if (typeof body.content !== "string") throw new Error("缺少导入内容");
		const suite = this.imports.parseImport(
			body.content,
			body.format,
			body.replayMode,
		);
		for (const definition of suite.cases)
			validateWorkspacePaths(definition, suite.defaults);
		if (apply)
			return this.catalog.importCases(body.moduleId, suite, body.policy);
		const existing = (await this.catalog.snapshot()).cases.filter(
			(c) => c.moduleId === body.moduleId,
		);
		return {
			suite,
			cases: suite.cases.map((c) => ({
				id: c.id,
				description: c.description,
				replayMode: c.replayMode,
				duplicate: existing.some((e) => e.definition.id === c.id),
			})),
		};
	}
	async importConversations(body: any, apply: boolean) {
		const preview = previewConversations(body);
		const module = await this.catalog.getModule(body.moduleId);
		if (!module || module.archived)
			throw new CatalogError("目标模块不存在或已归档", 404);
		for (const definition of preview.suite.cases)
			validateWorkspacePaths(definition, preview.suite.defaults);
		if (body.options.verifierId) {
			const verifier = await this.verifiers.get(body.options.verifierId);
			if (!verifier || verifier.extension !== ".py")
				throw new CatalogError(
					"所选 Python 验证器不存在或类型不正确，请刷新选择",
					422,
				);
		}
		const existing = (await this.catalog.snapshot()).cases.filter(
			(c) => c.moduleId === body.moduleId,
		);
		for (const row of preview.rows)
			row.duplicate = existing.some((c) => c.definition.id === row.caseId);
		if (!apply) return { status: 200, value: preview };
		if (preview.rows.some((row) => row.error))
			return {
				status: 422,
				value: {
					error: "存在未通过校验的文件，未写入任何案例；请修正或移除错误文件",
					rows: preview.rows,
				},
			};
		return {
			status: 201,
			value: await this.catalog.importCases(
				body.moduleId,
				preview.suite,
				body.policy,
			),
		};
	}
}
