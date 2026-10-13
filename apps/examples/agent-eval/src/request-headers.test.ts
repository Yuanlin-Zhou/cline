import { test, expect } from "bun:test";
import { prepareRequestHeaders } from "./request-headers.js";
import { resolveHeaders } from "./headers.js";

const context = {
	sessionId: "session",
	caseId: "case",
	evaluationId: "evaluation",
};
test("each attempt gets a UUID; references agree, streams and cancellation survive", async () => {
	const received: Array<{ input: any; headers: Headers }> = [];
	const base = (async (input: any, init: any) => {
		received.push({
			input,
			headers: new Headers(init?.headers ?? input.headers),
		});
		return new Response("ok");
	}) as typeof fetch;
	const config = {
		headers: {
			"x-id": "{{requestId}}",
			"x-trace": "{{sessionId}}/{{requestId}}/{{requestId}}",
		},
		headersEnv: { authorization: "AUTH" },
	};
	const plan = prepareRequestHeaders(config, {}, context, base, {
		AUTH: "Bearer {{requestId}}",
	});
	const controller = new AbortController();
	const body = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("stream"));
			c.close();
		},
	});
	await plan.fetch(
		new Request("https://example.com", {
			method: "POST",
			headers: plan.headers,
			body,
			duplex: "half",
			signal: controller.signal,
		} as RequestInit),
	);
	await plan.fetch("https://example.com", { headers: plan.headers });
	const id = received[0].headers.get("x-id");
	expect(id).toMatch(/^[0-9a-f-]{36}$/);
	expect(received[1].headers.get("x-id")).not.toBe(id);
	expect(received[0].headers.get("x-trace")).toBe(`session/${id}/${id}`);
	expect(received[0].headers.get("authorization")).toBe("Bearer {{requestId}}");
	expect(await received[0].input.text()).toBe("stream");
	controller.abort();
	expect(received[0].input.signal.aborted).toBe(true);
	expect(plan.headers?.["x-id"]).toStartWith("eval-request-");
	plan.dispose();
	await expect(
		plan.fetch("https://example.com", { headers: plan.headers }),
	).rejects.toThrow("已结束");
});

test("init headers replace Request headers, static overrides and unmarked calls stay unchanged", async () => {
	const calls: any[] = [];
	const base = (async (input: any, init: any) => {
		calls.push({ input, init });
		return new Response();
	}) as typeof fetch;
	const plan = prepareRequestHeaders(
		{ headers: { "x-id": "{{requestId}}" } },
		{},
		context,
		base,
	);
	const original = new Request("https://example.com", {
		headers: plan.headers,
	});
	const init = { headers: { "x-other": "literal" } };
	await plan.fetch(original, init);
	expect(calls[0].init).toBe(init);
	expect(new Headers(calls[0].init.headers).has("x-id")).toBe(false);
	const overridden = prepareRequestHeaders(
		{ headers: { "x-id": "{{requestId}}" } },
		{ headers: { "x-id": "static" } },
		context,
		base,
	);
	expect(overridden.dynamic).toBe(false);
	await overridden.fetch(original, init);
	expect(calls[1].init).toBe(init);
	expect(() =>
		resolveHeaders({ headers: { "x-id": "{{requestId}}" } }, {}, context),
	).toThrow("request sending");
});

test("concurrent executions never expand each other's markers or environment values", async () => {
	const calls: Headers[] = [];
	const base = (async (_: any, init: any) => {
		calls.push(new Headers(init.headers));
		return new Response();
	}) as typeof fetch;
	const config = { headers: { "x-id": "{{requestId}}" } };
	const a = prepareRequestHeaders(config, {}, context, base),
		b = prepareRequestHeaders(config, {}, context, base);
	await Promise.all([
		a.fetch("https://example.com", { headers: a.headers }),
		b.fetch("https://example.com", { headers: b.headers }),
	]);
	expect(calls[0].get("x-id")).not.toBe(calls[1].get("x-id"));
	a.dispose();
	await b.fetch("https://example.com", { headers: b.headers });
	expect(calls[2].get("x-id")).toMatch(/^[0-9a-f-]{36}$/);
});
