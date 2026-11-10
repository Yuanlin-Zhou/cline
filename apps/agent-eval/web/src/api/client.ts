import { useQuery } from "@tanstack/react-query";

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly details?: unknown,
	) {
		super(message);
	}
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.method && init.method !== "GET")
		headers.set("Content-Type", "application/json");
	const response = await fetch(path, { ...init, headers });
	const body = await response.text();
	let value: any;
	try {
		value = body ? JSON.parse(body) : undefined;
	} catch {
		throw new ApiError("服务返回了无法解析的响应", response.status);
	}
	if (!response.ok)
		throw new ApiError(
			value?.error ?? `请求失败（${response.status}）`,
			response.status,
			value,
		);
	return value as T;
}
export const send = <T>(path: string, body?: unknown, method = "POST") =>
	api<T>(path, {
		method,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
export function useApi<T>(path: string, enabled = true) {
	return useQuery({
		queryKey: [path],
		queryFn: ({ signal }) => api<T>(path, { signal }),
		enabled,
	});
}
export const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);
