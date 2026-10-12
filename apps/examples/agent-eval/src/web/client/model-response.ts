import type { EvalCaseResult } from "../../types.js";
import { node, action, row, fold } from "./verifier-ui.js";

/** Displays model evidence, including malformed calls, without rebuilding it from grading checks. */
export function modelResponse(result: EvalCaseResult) {
	const root = node("section", "", "Box Box-body mt-3 ModelResponse");
	root.append(node("h3", "本轮模型响应", "section-title"));
	const trace = result.functionCallResponse;
	if (!trace) {
		root.append(
			node(
				"p",
				"本次执行未归档原始模型响应；请求未成功完成时可能没有响应正文。已有检查结果不能补齐原始输出。",
				"form-hint",
			),
		);
		if (result.text) root.append(node("pre", result.text, "output"));
		return root;
	}
	const raw = trace.raw_response;
	root.append(
		node(
			"p",
			`来自本次模型请求 · HTTP ${trace.http_status} · 工具未执行${trace.completeness === "partial" ? " · 响应不完整" : ""}`,
			"form-hint",
		),
	);
	const status = node("p", "", "form-hint");
	status.setAttribute("role", "status");
	const copy = action("复制原始响应", () => {
		void navigator.clipboard
			.writeText(raw)
			.then(() => {
				status.textContent = "原始响应已复制";
			})
			.catch(() => {
				status.textContent = "复制失败，请下载原始响应或手动复制。";
			});
	});
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {}
	const download = action("下载原始响应", () => {
		const url = URL.createObjectURL(
			new Blob([raw], { type: "text/plain;charset=utf-8" }),
		);
		const link = node("a");
		link.href = url;
		link.download = `model-response-${result.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}.${body === undefined ? "txt" : "json"}`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
	root.append(row(copy, download), status);
	const record = (value: unknown): value is Record<string, unknown> =>
		!!value && typeof value === "object" && !Array.isArray(value);
	const show = (value: unknown) =>
		typeof value === "string"
			? value
			: (JSON.stringify(value, null, 2) ?? "（字段缺失）");
	const choices =
		record(body) && Array.isArray(body.choices) ? body.choices : [];
	let displayed = false;
	for (const [index, choice] of choices.entries()) {
		if (!record(choice) || !record(choice.message)) continue;
		const message = choice.message;
		displayed = true;
		if (choices.length > 1) root.append(node("strong", `响应 ${index + 1}`));
		root.append(
			node(
				"p",
				`角色：${show(message.role)} · 结束原因：${show(choice.finish_reason)}`,
				"form-hint",
			),
		);
		if (
			message.content !== null &&
			message.content !== undefined &&
			message.content !== ""
		)
			root.append(
				node("strong", "模型回复"),
				node("pre", show(message.content), "output ModelResponse-text"),
			);
		if (
			message.reasoning_content !== null &&
			message.reasoning_content !== undefined
		) {
			const reasoning = fold("模型返回的思考内容");
			reasoning.append(node("pre", show(message.reasoning_content), "output"));
			root.append(reasoning);
		}
		const calls = message.tool_calls;
		if (Array.isArray(calls) && calls.length) {
			root.append(node("strong", `模型返回的工具调用（${calls.length}）`));
			for (const [callIndex, call] of calls.entries()) {
				const card = node("div", "", "ModelResponse-call");
				if (record(call) && record(call.function)) {
					card.append(
						node(
							"strong",
							`调用 ${callIndex + 1} · ${show(call.function.name)}`,
						),
						node(
							"p",
							`id：${show(call.id)} · type：${show(call.type)}`,
							"form-hint",
						),
						node(
							"span",
							`arguments（原始${typeof call.function.arguments === "string" ? "字符串" : "值，非字符串"}）`,
							"form-hint",
						),
						node(
							"pre",
							show(call.function.arguments),
							"code ModelResponse-arguments",
						),
					);
				} else
					card.append(
						node("strong", `调用 ${callIndex + 1} · 格式异常`),
						node("pre", show(call), "code ModelResponse-arguments"),
					);
				root.append(card);
			}
		} else {
			root.append(node("p", "本轮未返回有效的 tool_calls 数组。", "form-hint"));
			if (calls !== undefined) root.append(node("pre", show(calls), "code"));
		}
	}
	if (!displayed)
		root.append(
			node("p", "响应结构无法提取模型消息，以下保留原始正文。", "form-hint"),
			node("pre", raw || "（响应正文为空）", "code ModelResponse-raw"),
		);
	const full = fold("查看完整原始响应");
	full.append(
		node(
			"p",
			"保留响应原文，包括字段缺失、错误参数、重复 JSON 字段和服务返回的其他内容。",
			"form-hint",
		),
		node("pre", raw || "（响应正文为空）", "code ModelResponse-raw"),
	);
	root.append(full);
	return root;
}
