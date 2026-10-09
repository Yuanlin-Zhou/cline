import { readFile } from "node:fs/promises";
import path from "node:path";

const context = JSON.parse(await readFile(process.env.EVAL_CONTEXT, "utf8"));
const expected = { total: 12 };
let actual;
let passed = false;
try {
  actual = JSON.parse(await readFile(path.join(context.workspace, "summary.json"), "utf8"));
  passed = actual?.total === expected.total;
} catch (error) {
  // Missing or malformed task output is a business failure, not a script error.
  actual = { outputError: String(error) };
}
console.log(JSON.stringify({
  protocolVersion: 1, verdict: passed ? "pass" : "fail", expected, actual,
  message: passed ? "产物满足要求" : "summary.json 缺失或 total 不等于 12",
  evidence: context.evidence.artifacts.filter(file => file.path === "summary.json").map(file => file.ref)
}));
