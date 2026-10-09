import { readFile } from "node:fs/promises";

// EVAL_CONTEXT is a path to the evaluator's input JSON.
const context = JSON.parse(await readFile(process.env.EVAL_CONTEXT, "utf8"));
const expected = { executionStatus: "completed", contains: "已完成" };
const actual = {
  executionStatus: context.execution.execution?.status ?? "unknown",
  text: context.execution.text ?? ""
};
const passed = actual.executionStatus === expected.executionStatus
  && actual.text.includes(expected.contains);
// stdout must contain exactly one JSON object; use console.error for diagnostics.
console.log(JSON.stringify({
  protocolVersion: 1, verdict: passed ? "pass" : "fail", expected, actual,
  message: passed ? "最终回复符合要求" : "执行未完成或最终回复不符合要求",
  evidence: []
}));
