import { randomUUID } from "node:crypto";
import {
	resolveHeaders,
	requestIdHeaderNames,
	type HeaderConfig,
} from "./headers.js";

/** A per-execution transport, injected only into model calls, never global fetch. */
export function prepareRequestHeaders(
	defaults: HeaderConfig,
	definition: HeaderConfig,
	context: { sessionId: string; caseId: string; evaluationId: string },
	baseFetch: typeof fetch = globalThis.fetch,
	env: Record<string, string | undefined> = process.env,
) {
	const names = requestIdHeaderNames(defaults, definition);
	const token = `eval-request-${randomUUID()}`;
	const headers = resolveHeaders(
		defaults,
		definition,
		{ ...context, requestId: token },
		env,
	);
	let active = true;
	const send: typeof fetch = Object.assign(
		async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			if (!names.length) return baseFetch(input, init);
			if (!active) throw Error("模型请求已结束，不能继续发送动态请求头");
			// init.headers replaces Request.headers, matching standard fetch semantics.
			const effective = new Headers(
				init?.headers ?? (input instanceof Request ? input.headers : undefined),
			);
			let id: string | undefined;
			let changed = false;
			for (const name of names) {
				const value = effective.get(name);
				if (!value?.includes(token)) continue;
				id ??= randomUUID();
				effective.set(name, value.replaceAll(token, id));
				changed = true;
			}
			return baseFetch(input, changed ? { ...init, headers: effective } : init);
		},
		baseFetch,
	);
	return {
		headers,
		fetch: send,
		dynamic: names.length > 0,
		dispose: () => {
			active = false;
		},
	};
}
