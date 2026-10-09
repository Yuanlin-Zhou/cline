import { expect, test } from "bun:test";
import { parseEvalSuite } from "./schema.js";
import { resolveHeaders } from "./headers.js";

test("headers survive schema parsing and merge across sources without mutating inputs", () => {
	const suite = parseEvalSuite({
		defaults: {
			headers: { "X-Tag": "default", "x-session-id": "{{sessionId}}" },
			headersEnv: { Authorization: "UNUSED_AUTH" },
		},
		cases: [
			{
				id: "a",
				prompt: "hi",
				headers: { "x-message-id": "{{evaluationId}}", "x-case": "{{caseId}}" },
				headersEnv: { authorization: "AUTH" },
			},
		],
	});
	const original = JSON.stringify(suite);
	const result = resolveHeaders(
		suite.defaults,
		suite.cases[0],
		{ sessionId: "session", evaluationId: "execution", caseId: "a" },
		{ AUTH: "Bearer fake" },
	);
	expect(result).toEqual({
		"x-tag": "default",
		"x-session-id": "session",
		authorization: "Bearer fake",
		"x-message-id": "execution",
		"x-case": "a",
	});
	expect(JSON.stringify(suite)).toBe(original);
	expect(
		resolveHeaders({}, {}, { sessionId: "s", evaluationId: "e", caseId: "a" }),
	).toBeUndefined();
});

test("rejects invalid headers before saving and validates expanded values", () => {
	for (const headers of [
		{ "bad name": "x" },
		{ Host: "x" },
		{ "Content-Type": "x" },
		{ "x-test": "a\r\nb" },
		{ "x-test": "{{unknown}}" },
		{ Authorization: "secret" },
		{ "X-ID": "a", "x-id": "b" },
	]) {
		expect(() =>
			parseEvalSuite({
				defaults: { headers },
				cases: [{ id: "a", prompt: "hi" }],
			}),
		).toThrow();
	}
	for (const headersEnv of [
		{ authorization: "" },
		{ authorization: "bad-name" },
		{ "x-test": 1 },
	])
		expect(() =>
			parseEvalSuite({
				defaults: { headersEnv },
				cases: [{ id: "a", prompt: "hi" }],
			}),
		).toThrow();
	expect(() =>
		parseEvalSuite({
			defaults: { headers: { "x-id": "a" }, headersEnv: { "X-ID": "ID" } },
			cases: [{ id: "a", prompt: "hi" }],
		}),
	).toThrow("both");
	expect(() =>
		resolveHeaders(
			{ headers: { "x-case": "{{caseId}}" } },
			{},
			{ caseId: "bad\ncase", sessionId: "s", evaluationId: "e" },
		),
	).toThrow();
	expect(() =>
		resolveHeaders(
			{ headersEnv: { Authorization: "AUTH" } },
			{},
			{ caseId: "a", sessionId: "s", evaluationId: "e" },
			{},
		),
	).toThrow("AUTH");
});

test("case source replaces default source case-insensitively and resolutions are isolated", () => {
	const context = { caseId: "a", sessionId: "s", evaluationId: "e" };
	expect(
		resolveHeaders(
			{ headersEnv: { "X-ID": "MISSING" } },
			{ headers: { "x-id": "case" } },
			context,
			{},
		),
	).toEqual({ "x-id": "case" });
	const a = resolveHeaders(
		{ headers: { "x-id": "{{sessionId}}" } },
		{},
		context,
	)!;
	const b = resolveHeaders(
		{ headers: { "x-id": "{{sessionId}}" } },
		{},
		{ ...context, sessionId: "s2" },
	)!;
	a["x-id"] = "changed";
	expect(b["x-id"]).toBe("s2");
});
