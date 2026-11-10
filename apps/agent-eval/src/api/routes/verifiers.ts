import { CatalogError } from "../../modules/catalog/repository.js";
import { verifierReferences } from "../../modules/catalog/resource-management.js";
import { CAPABILITIES } from "../../modules/evidence/evidence.js";
import {
	pythonEnvironment,
	pythonRuntimeStatus,
	validatePythonSource,
} from "../../modules/grading/python-runtime.js";
import {
	parseUpload,
	publicUploaded,
	verifierToken,
} from "../../modules/grading/uploaded-verifiers.js";
import {
	loadVerifiers,
	publicVerifier,
} from "../../modules/grading/verifiers.js";
import { readJsonBody } from "../http/json-body.js";

import type { ApiContext } from "../context.js";
import { json } from "../http/helpers.js";
export function verifiersRoutes(context: ApiContext) {
	const { catalog, verifierRepository } = context;
	return async (request: Request, url: URL): Promise<Response | undefined> => {
		const route = url.pathname;
		const method = request.method;
		if (route === "/api/verifiers" && method === "GET") {
			const configured = await loadVerifiers();
			const uploaded = await verifierRepository.list();
			if (uploaded.some((v) => configured.some((c) => c.id === v.id)))
				throw new CatalogError("验证器 ID 冲突", 409);
			const all =
				url.searchParams.get("manage") === "1"
					? await catalog.allResources()
					: undefined;
			return json({
				verifiers: [
					...configured.map(publicVerifier),
					...uploaded.map((v) => ({
						...publicUploaded(v),
						...(all
							? { referenceCount: verifierReferences(v.id, all).length }
							: {}),
					})),
				],
				capabilities: CAPABILITIES,
			});
		}
		if (route === "/api/verifiers/runtime-status" && method === "GET")
			return json(await pythonRuntimeStatus());
		if (route === "/api/verifiers" && method === "POST") {
			const body = await readJsonBody(request);
			const parsed = parseUpload(body);
			const runtime =
				parsed.extension === ".py" ? await pythonRuntimeStatus() : undefined;
			if (runtime?.ready)
				await validatePythonSource(parsed.content, await pythonEnvironment());
			return json(
				{
					...publicUploaded(await verifierRepository.create(body)),
					syntaxStatus:
						parsed.extension === ".py"
							? runtime?.ready
								? "checked"
								: "pending"
							: "not_applicable",
				},
				201,
			);
		}
		const scriptMatch = route.match(/^\/api\/verifiers\/([^/]+)$/);
		if (scriptMatch) {
			const id = scriptMatch[1];
			const script = await verifierRepository.get(id);
			if (!script)
				throw new CatalogError("仅能管理已上传的脚本；脚本不存在或已删除", 404);
			if (script.extension !== ".py")
				throw new CatalogError("仅支持管理用户上传的 Python 脚本", 403);
			if (method === "GET")
				return json({
					...publicUploaded(script),
					content: script.content,
					token: verifierToken(script),
					references: verifierReferences(id, await catalog.allResources()),
				});
			if (method === "PUT") {
				const { expectedToken, ...input } = await readJsonBody(request);
				const parsed = parseUpload(input);
				if (parsed.extension !== ".py")
					throw new CatalogError("请选择 .py 文件");
				await validatePythonSource(parsed.content, await pythonEnvironment());
				const saved = await verifierRepository.update(id, expectedToken, input);
				return json({ ...publicUploaded(saved), token: verifierToken(saved) });
			}
			if (method === "DELETE") {
				const body = await readJsonBody(request);
				const references = verifierReferences(id, await catalog.allResources());
				if (references.length)
					return json(
						{ error: "脚本仍被案例引用，请先替换或移除这些规则", references },
						409,
					);
				await verifierRepository.delete(id, body.expectedToken);
				return json({ deleted: true });
			}
		}
	};
}
