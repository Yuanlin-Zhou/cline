import { randomUUID } from "node:crypto";
import { prepareRequestHeaders } from "./request-headers.js";
import { evaluateAssertions } from "./assertions.js";
import {
	parseFunctionCall,
	functionCallTools,
} from "./function-call-config.js";
import type { EvalCase, EvalDefaults, EvalCaseResult } from "./types.js";
export const FUNCTION_RESPONSE_LIMIT = 512 * 1024;
export type FunctionCallResponse = {
	schema_version: 1;
	protocol: "openai-chat-completions";
	completeness: "complete" | "partial";
	request_tools: ReturnType<typeof functionCallTools>;
	tool_choice: unknown;
	raw_response: string;
	http_status: number;
};
export function preflightFunctionCall(
	definition: EvalCase,
	defaults: EvalDefaults,
) {
	if (definition.replayMode !== "function-call") return;
	if (defaults.providerId !== "openai-compatible")
		throw Error(
			"单轮函数调用首期需要 providerId=openai-compatible，请配置兼容模型服务。",
		);
	if (!defaults.baseUrl)
		throw Error(
			"单轮函数调用需要配置兼容服务 baseUrl（例如 https://服务地址/v1）。",
		);
	const url = new URL(defaults.baseUrl);
	if (!["http:", "https:"].includes(url.protocol))
		throw Error("baseUrl 须使用 http 或 https");
	if (defaults.apiKeyEnv && !process.env[defaults.apiKeyEnv])
		throw Error(`environment variable ${defaults.apiKeyEnv} is not set`);
	parseFunctionCall(definition.functionCall);
}
export async function runFunctionCall(input: {
	definition: EvalCase;
	defaults: EvalDefaults;
	signal?: AbortSignal;
	onSession?: (id: string) => void;
	onText?: (text: string) => void;
}): Promise<EvalCaseResult> {
	const { definition, defaults } = input;
	preflightFunctionCall(definition, defaults);
	const config = parseFunctionCall(definition.functionCall);
	const tools = functionCallTools(config);
	const sessionId = randomUUID();
	const started = Date.now();
	input.onSession?.(sessionId);
	const choice = config.toolChoice ?? "auto";
	const toolChoice = ["auto", "required"].includes(choice)
		? choice
		: { type: "function", function: { name: choice } };
	const controller = new AbortController();
	const abort = () => controller.abort(input.signal?.reason);
	input.signal?.addEventListener("abort", abort, { once: true });
	if (input.signal?.aborted) abort();
	let timedOut = false;
	const timeout = setTimeout(
		() => {
			timedOut = true;
			controller.abort();
		},
		definition.timeoutMs ?? defaults.timeoutMs ?? 180000,
	);
	const result: EvalCaseResult = {
		id: definition.id,
		description: definition.description,
		sessionId,
		status: "passed",
		text: "",
		finishReason: "completed",
		durationMs: 0,
		iterations: 1,
		usage: { inputTokens: 0, outputTokens: 0 },
		toolCalls: [],
		assertions: [],
	};
	let request: ReturnType<typeof prepareRequestHeaders> | undefined;
	try {
		request = prepareRequestHeaders(defaults, definition, {
			sessionId,
			caseId: definition.id,
			evaluationId: randomUUID(),
		});
		const headers = request.headers;
		const requestHeaders = new Headers({ "Content-Type": "application/json" });
		if (defaults.apiKeyEnv)
			requestHeaders.set(
				"Authorization",
				`Bearer ${process.env[defaults.apiKeyEnv]}`,
			);
		for (const [name, value] of Object.entries(headers ?? {}))
			requestHeaders.set(name, value);
		const messages = [
			...((definition.systemPrompt ?? defaults.systemPrompt)
				? [
						{
							role: "system",
							content: definition.systemPrompt ?? defaults.systemPrompt,
						},
					]
				: []),
			...definition.history,
			{ role: "user", content: definition.prompt },
		];
		const response = await request.fetch(
			`${defaults.baseUrl!.replace(/\/$/, "")}/chat/completions`,
			{
				method: "POST",
				headers: requestHeaders,
				body: JSON.stringify({
					model: defaults.modelId,
					messages,
					tools,
					tool_choice: toolChoice,
					stream: false,
					n: 1,
				}),
				signal: controller.signal,
				redirect: "error",
			},
		);
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = response.body?.getReader();
		if (!reader) throw Error("模型服务返回空正文");
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > FUNCTION_RESPONSE_LIMIT) {
					await reader.cancel();
					throw Error("原始 function call 响应超过 512 KiB 上限");
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const part of chunks) {
			bytes.set(part, offset);
			offset += part.length;
		}
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		result.functionCallResponse = {
			schema_version: 1,
			protocol: "openai-chat-completions",
			completeness: response.ok ? "complete" : "partial",
			request_tools: tools,
			tool_choice: toolChoice,
			raw_response: raw,
			http_status: response.status,
		};
		if (!response.ok)
			throw Error(
				`模型 HTTP ${response.status}，请检查模型地址、凭据和服务状态。`,
			);
		// Formatting faults stay in the raw evidence for Python to classify; no tool executor is called.
		let body: any;
		try {
			body = JSON.parse(raw);
		} catch {
			body = {};
		}
		const message = body?.choices?.[0]?.message;
		result.text = typeof message?.content === "string" ? message.content : "";
		if (Array.isArray(message?.tool_calls))
			result.toolCalls = message.tool_calls.map((c: any) => {
				let value: unknown = c?.function?.arguments;
				try {
					if (typeof value === "string") value = JSON.parse(value);
				} catch {}
				return {
					name:
						typeof c?.function?.name === "string"
							? c.function.name
							: "(invalid)",
					input: value,
					output: { not_executed: true },
					durationMs: 0,
				};
			});
		const token = (v: unknown) =>
			typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
		result.usage = {
			inputTokens: token(body?.usage?.prompt_tokens),
			outputTokens: token(body?.usage?.completion_tokens),
		};
		result.assertions = evaluateAssertions(
			result.text,
			result.finishReason,
			definition.assertions,
		);
		result.status = result.assertions.every((a) => a.passed)
			? "passed"
			: "failed";
		if (result.text) input.onText?.(result.text);
	} catch (error) {
		result.status = "error";
		result.error = timedOut
			? "evaluation timed out during function call"
			: input.signal?.aborted
				? "函数调用回放已取消"
				: error instanceof Error
					? error.message
					: String(error);
		result.finishReason = input.signal?.aborted ? "aborted" : "error";
	} finally {
		request?.dispose();
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", abort);
		result.durationMs = Date.now() - started;
	}
	return result;
}
