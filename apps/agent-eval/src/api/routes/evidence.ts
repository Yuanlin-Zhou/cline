import path from "node:path";
import { type RunItem } from "../../contracts/catalog.js";
import { readConversation } from "../../modules/evidence/conversation.js";
import { readEvidence } from "../../modules/evidence/evidence.js";
import { parseGrading } from "../../modules/grading/schema.js";
import {
	frozenValidationInput,
	historicalEvidence,
} from "../../modules/grading/validation-context.js";
import { loadVerifiers } from "../../modules/grading/verifiers.js";
import { readJsonBody } from "../http/json-body.js";

import type { ApiContext } from "../context.js";
import { json } from "../http/helpers.js";
export function evidenceRoutes(context: ApiContext) {
	const { store, catalog, verifierRepository, verifierTests } = context;
	return async (request: Request, url: URL): Promise<Response | undefined> => {
		const route = url.pathname;
		const method = request.method;
		const validationMatch = route.match(
			/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/(validation-input|verifier-tests)(?:\/([^/]+))?(?:\/(cancel|evidence)(?:\/([^/]+))?)?$/,
		);
		if (validationMatch) {
			const [, runId, itemId, kind, testId, action, evidenceId] =
				validationMatch;
			const item = store.get<RunItem>("item", itemId);
			if (!item || item.runId !== runId)
				return json({ error: "执行记录不存在" }, 404);
			const directory = path.join(store.directory, "runs", runId, itemId);
			if (kind === "validation-input" && method === "GET") {
				if (["queued", "running"].includes(item.status))
					throw new Error("执行尚未结束，请等待冻结验证输入");
				const value = await frozenValidationInput(
					directory,
					await historicalEvidence(directory, item),
				);
				if (url.searchParams.has("download"))
					return new Response(JSON.stringify(value.context, null, 2), {
						headers: {
							"Content-Type": "application/json",
							"Content-Disposition": `attachment; filename="validation-input-${item.id}.json"`,
						},
					});
				const preview = JSON.stringify(value.context, null, 2);
				return json({
					text: preview.slice(0, 200000),
					truncated: preview.length > 200000,
					sha256: value.sha256,
				});
			}
			if (kind === "verifier-tests" && !testId && method === "POST") {
				const body = await readJsonBody(request);
				const rule = parseGrading({
					version: 1,
					rules: [
						{
							id: "python-test",
							kind: "script",
							verifierId: body.verifierId,
							params: body.params,
							required_inputs: body.required_inputs,
							require_complete: body.require_complete,
						},
					],
				})!.rules[0] as Extract<
					import("../../modules/grading/types.js").Rule,
					{ kind: "script" }
				>;
				if (
					Object.keys(body).some(
						(k) =>
							![
								"verifierId",
								"params",
								"required_inputs",
								"require_complete",
							].includes(k),
					)
				)
					throw new Error("试验证参数包含未知字段");
				const v =
					item.verifierSnapshots?.find((v) => v.id === body.verifierId) ??
					(await verifierRepository.get(body.verifierId));
				if (!v) return json({ error: "脚本不存在" }, 404);
				return json(await verifierTests.create(item, v, rule), 202);
			}
			if (kind === "verifier-tests" && testId) {
				const test = verifierTests.get(testId, runId, itemId);
				if (!test) return json({ error: "试验证记录不存在" }, 404);

				if (action === "cancel" && method === "POST") {
					verifierTests.cancel(testId);
					return json({ status: "cancelling" });
				}
				if (action === "evidence" && method === "GET") {
					const ref = test.evidence.refs.find((r) => r.id === evidenceId);
					if (!ref) return json({ error: "试验证证据不存在" }, 404);
					return json({
						text: (
							await readEvidence(directory, ref, 4 * 1024 * 1024)
						).toString("utf8"),
					});
				}
				if (!action && method === "GET") return json(test);
			}
		}
		const conversationMatch = route.match(
			/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/conversation$/,
		);
		if (conversationMatch && method === "GET") {
			const [, runId, itemId] = conversationMatch;
			const item = store.detail(runId).items.find((i) => i.id === itemId);
			if (!item) return json({ error: "执行记录不存在" }, 404);
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const limit = Number(url.searchParams.get("limit") ?? 50);
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 100
			)
				return json({ error: "会话分页参数无效" }, 400);
			const configured = await loadVerifiers();
			const secrets = [
				item.snapshot.defaults.apiKeyEnv,
				...configured.flatMap((v) => v.env),
			]
				.filter((key): key is string => Boolean(key))
				.map((key) => process.env[key] ?? "");
			const conversation = await readConversation(
				path.join(store.directory, "runs", runId, itemId),
				item,
				{ offset, limit, download: url.searchParams.has("download"), secrets },
			);
			if (url.searchParams.has("download"))
				return new Response(JSON.stringify(conversation, null, 2), {
					headers: {
						"Content-Type": "application/json; charset=utf-8",
						"Content-Disposition": `attachment; filename="conversation-${item.id}.json"`,
					},
				});
			return json(conversation);
		}
		const evidenceMatch = route.match(
			/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/(grading|evidence)(?:\/([^/]+))?$/,
		);
		if (evidenceMatch && method === "GET") {
			const [, runId, itemId, kind, evidenceId] = evidenceMatch;
			const item = store.detail(runId).items.find((i) => i.id === itemId);
			if (!item?.result?.grading) return json({ error: "判分记录不存在" }, 404);
			if (kind === "grading") return json(item.result.grading);
			const ref = item.result.evidence?.refs.find((r) => r.id === evidenceId);
			if (!ref) return json({ error: "证据不存在" }, 404);
			const bytes = await readEvidence(
				path.join(store.directory, "runs", runId, itemId),
				ref,
				4 * 1024 * 1024,
			);
			return json({
				id: ref.id,
				label: ref.label,
				text: bytes.includes(0)
					? "二进制文件，无法文本预览"
					: bytes.toString("utf8"),
				sha256: ref.sha256,
			});
		}
	};
}
