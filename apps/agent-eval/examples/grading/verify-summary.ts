import { readFile } from "node:fs/promises";
import path from "node:path";

const context = JSON.parse(await readFile(process.env.EVAL_CONTEXT!, "utf8"));
const expected = { total: 12, items: [1, 2, 3] };
let actual: unknown;
let passed = false;
try {
	actual = JSON.parse(await readFile(path.join(context.workspace, "summary.json"), "utf8"));
	const value = actual as typeof expected;
	passed = value?.total === 12 && JSON.stringify(value?.items) === JSON.stringify(expected.items);
} catch (error) {
	// A missing/malformed task output is an acceptance failure, not a broken verifier.
	actual = { outputError: String(error) };
}
console.log(JSON.stringify({ protocolVersion: 1, verdict: passed ? "pass" : "fail", expected, actual, message: passed ? "统计 JSON 满足要求" : "统计 JSON 未满足要求", evidence: [] }));
