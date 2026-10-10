import { expect, test } from "bun:test";
import { compare } from "../grading/behavior.js";
import { parseGrading } from "../grading/schema.js";
import { guides, readExpected, valueType, ruleTitle } from "./client/grading-help.js";

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


test("result titles explain the business check and distinguish JSON types", () => {
	expect(ruleTitle({ id: "rule-1", kind: "file.exists", path: "out.txt" })).toBe("out.txt 存在");
	expect(ruleTitle({ kind: "file.json", path: "summary.json", pointer: "/total", op: "equals", expected: 12 })).toBe('summary.json · /total 等于 12');
	expect(ruleTitle({ kind: "file.json", path: "summary.json", pointer: "/total", op: "equals", expected: "12" })).toBe('summary.json · /total 等于 "12"');
	expect(ruleTitle({ kind: "file.json", path: "summary.json", pointer: "/total", op: "exists", expected: "old value" })).toBe("summary.json · /total 字段存在");
	expect(ruleTitle({ kind: "script", verifierId: "uploaded-internal" }, "报告业务检查")).toBe("脚本：报告业务检查");
	expect(ruleTitle({ kind: "file.exists", path: "out.txt", label: "交付报告" })).toBe("交付报告");
	expect(ruleTitle({ kind: "text.legacy" })).toBe("最终回复与结束状态检查");
});
