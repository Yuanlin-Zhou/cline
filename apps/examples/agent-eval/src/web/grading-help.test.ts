import { expect, test } from "bun:test";
import { compare } from "../grading/behavior.js";
import { parseGrading } from "../grading/schema.js";
import { guides, readExpected, valueType } from "./client/grading-help.js";

test("JSON input preserves the value type that grading compares", () => {
	const number = readExpected("number", "12");
	const text = readExpected("text", "12");
	expect(valueType(number)).toBe("number");
	expect(valueType(text)).toBe("text");
	expect(compare({ total: 12 }, { pointer: "/total", op: "equals", expected: number }).passed).toBe(true);
	expect(compare({ total: 12 }, { pointer: "/total", op: "equals", expected: text }).passed).toBe(false);
	expect(readExpected("boolean", "false")).toBe(false);
	expect(readExpected("null", "")).toBeNull();
	expect(readExpected("json", '["Bun", 12]')).toEqual(["Bun", 12]);
	expect(() => readExpected("number", "abc")).toThrow("请填写数字");
	expect(() => readExpected("json", "12")).toThrow("数组或对象");
});

test("insertable result examples satisfy the real schema", () => {
	for (const kind of ["file.exists", "file.absent", "file.unchanged", "file.text", "file.json"]) {
		const rule = { id: "example", kind, required: true, ...guides[kind].sample };
		expect(parseGrading({ version: 1, rules: [rule] })?.rules[0]).toEqual(rule);
	}
});
