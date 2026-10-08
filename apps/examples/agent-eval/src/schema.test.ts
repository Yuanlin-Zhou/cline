import { describe, expect, test } from "bun:test";
import { evaluateAssertions } from "./assertions.js";
import { parseCliArgs } from "./cli.js";
import { parseEvalSuite } from "./schema.js";

describe("parseEvalSuite", () => {
	test("applies lightweight defaults and preserves history", () => {
		const suite = parseEvalSuite({
			cases: [
				{
					id: "context",
					history: [
						{ role: "user", content: "Use Bun" },
						{ role: "assistant", content: "Understood" },
					],
					prompt: "Which package manager should be used?",
				},
			],
		});

		expect(suite.defaults.providerId).toBe("cline");
		expect(suite.defaults.tools).toBe("read-only");
		expect(suite.cases[0]?.history).toHaveLength(2);
	});

	test("rejects duplicate case ids", () => {
		expect(() =>
			parseEvalSuite({
				cases: [
					{ id: "same", prompt: "one" },
					{ id: "same", prompt: "two" },
				],
			}),
		).toThrow("duplicate case id");
	});

	test("rejects invalid regular expressions before running a model", () => {
		expect(() =>
			parseEvalSuite({
				cases: [
					{
						id: "bad-regex",
						prompt: "answer",
						assertions: { matches: ["["] },
					},
				],
			}),
		).toThrow("not a valid regular expression");
	});
});

describe("evaluateAssertions", () => {
	test("checks finish reason, substrings, and regular expressions", () => {
		const results = evaluateAssertions("Bun 1.3.13 is required", "completed", {
			contains: ["Bun"],
			notContains: ["npm"],
			matches: ["1\\.3\\.13"],
		});
		expect(results.every((result) => result.passed)).toBe(true);
	});
});

describe("parseCliArgs", () => {
	test("supports positional input and overrides", () => {
		const options = parseCliArgs([
			"suite.json",
			"--model",
			"test-model",
			"--tools",
			"none",
		]);
		expect("help" in options).toBe(false);
		if (!("help" in options)) {
			expect(options.inputPath).toBe("suite.json");
			expect(options.overrides.modelId).toBe("test-model");
			expect(options.overrides.tools).toBe("none");
		}
	});
});
