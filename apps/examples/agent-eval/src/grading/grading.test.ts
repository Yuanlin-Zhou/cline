import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEvalSuite } from "../schema.js";
import { checkRule } from "./check.js";
import { compare, checkBehavior } from "./behavior.js";
import { gradeCase, preflight, verdict } from "./engine.js";
import { manifest, snapshot, readEvidence } from "./evidence.js";
import { loadVerifiers } from "./verifiers.js";
import { runProcess } from "./process.js";
import { gradingSummary } from "./summary.js";
import type { EvidenceEvent, GradingConfig, Rule, RuleResult } from "./types.js";
import type { EvalCaseResult } from "../types.js";

let directory: string; let workspace: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "eval-grading-test-")); workspace = path.join(directory, "workspace"); await mkdir(workspace); });
afterEach(async () => { if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("eval-grading-test-")) await rm(directory, { recursive: true, force: true }); });
const result = (): EvalCaseResult => ({ id: "test", status: "passed", sessionId: "session", text: "Done", durationMs: 1, iterations: 1, usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [], assertions: [], execution: { status: "completed" } });
const config = (rules: Rule[]): GradingConfig => ({ version: 1, rules });
const definition = (rules: Rule[]) => parseEvalSuite({ cases: [{ id: "test", prompt: "do it", replayMode: "full-task", grading: config(rules) }] }).cases[0];
const allCapabilities = { requested: true, started: true, completed: true, approval: true };
const event = (seq: number, type: EvidenceEvent["type"], toolCallId: string, name: string, extra: object = {}): EvidenceEvent => ({ schemaVersion: 1, eventId: `event-${seq}`, seq, itemId: "item", sessionId: "session", timestamp: "2026-09-16", type, toolCallId, payload: { name, ...extra } });

describe("grading schema and capability checks", () => {
	test("round trips rules; rejects unknown fields, invalid paths, modes, IDs and tolerances", () => {
		const rules: Rule[] = [{ id: "json", kind: "file.json", path: "out.json", pointer: "/count", op: "approx", expected: 10, absTolerance: 1 }];
		expect(definition(rules).grading).toEqual(config(rules));
		for (const change of [{ unknown: true }, { path: "../secret" }, { path: "C:\\secret" }, { path: "file:stream" }, { op: "no" }, { absTolerance: -1 }, { pointer: "/a~2" }]) expect(() => definition([{ ...rules[0], ...change } as Rule])).toThrow();
		expect(() => definition([rules[0], rules[0]])).toThrow();
		expect(() => definition([])).toThrow();
		expect(() => parseEvalSuite({ cases: [{ id: "single", prompt: "x", grading: config(rules) }] })).toThrow("full-task");
	});
	test("rejects required SDK-dependent rules but allows optional unsupported diagnostics", () => {
		expect(() => preflight(definition([{ id: "tool", kind: "tool.count", match: { name: "read_files", phase: "started" }, min: 1 }]), [])).toThrow("不支持");
		expect(() => preflight(definition([{ id: "file", kind: "file.exists", path: "out" }, { id: "tool", kind: "tool.count", required: false, match: { name: "read_files", phase: "started" }, min: 1 }]), [])).not.toThrow();
	});
});

describe("file evidence and deterministic result checks", () => {
	test("missing output fails despite success text; correct alternatives and boundary tolerances pass", async () => {
		const evidence = manifest(); await snapshot(workspace, directory, "baseline", evidence, []);
		await writeFile(path.join(workspace, "out.json"), '{"sum":10,"nullable":null,"a/b":{"~x":3}}'); await snapshot(workspace, directory, "artifacts", evidence, []);
		const input = { directory, evidence, events: [] };
		expect((await checkRule({ id: "missing", kind: "file.exists", path: "missing.json" }, input)).status).toBe("fail");
		for (const expected of [9, 10, 11]) expect((await checkRule({ id: "sum", kind: "file.json", path: "out.json", pointer: "/sum", op: "approx", expected, absTolerance: 1 }, input)).status).toBe("pass");
		expect((await checkRule({ id: "sum", kind: "file.json", path: "out.json", pointer: "/sum", op: "approx", expected: 11.001, absTolerance: 1 }, input)).status).toBe("fail");
		expect(compare({ nullable: null }, { pointer: "/nullable", op: "equals", expected: null }).passed).toBe(true);
		expect(compare({}, { pointer: "/nullable", op: "equals", expected: null }).passed).toBe(false);
		expect(compare({ a: 1, b: 2 }, { pointer: "", op: "equals", expected: { b: 2, a: 1 } }).passed).toBe(true);
		expect(compare([1, 2], { pointer: "", op: "equals", expected: [2, 1] }).passed).toBe(false);
		expect((await checkRule({ id: "pointer", kind: "file.json", path: "out.json", pointer: "/a~1b/~0x", op: "equals", expected: 3 }, input)).status).toBe("pass");
	});
	test("invalid JSON, altered protected files, tampering and missing baseline do not pass", async () => {
		const evidence = manifest(); await writeFile(path.join(workspace, "keep.txt"), "before"); await snapshot(workspace, directory, "baseline", evidence, []);
		await writeFile(path.join(workspace, "keep.txt"), "after"); await writeFile(path.join(workspace, "bad.json"), "{bad"); await snapshot(workspace, directory, "artifacts", evidence, []);
		const input = { directory, evidence, events: [] };
		expect((await checkRule({ id: "keep", kind: "file.unchanged", path: "keep.txt" }, input)).status).toBe("fail");
		expect((await checkRule({ id: "none", kind: "file.unchanged", path: "absent.txt" }, input)).status).toBe("fail");
		expect((await checkRule({ id: "json", kind: "file.json", path: "bad.json", pointer: "", op: "exists" }, input)).status).toBe("fail");
		const ref = evidence.refs[0]; await writeFile(path.join(directory, ref.path), "tampered");
		await expect(readEvidence(directory, ref)).rejects.toThrow("摘要");
		await expect(readEvidence(directory, { ...ref, path: "../outside" })).rejects.toThrow("路径");
	});
	test("secret-bearing files are not persisted and incomplete snapshots cannot establish absence", async () => {
		await writeFile(path.join(workspace, "key.txt"), "private-credential"); const evidence = manifest(); await snapshot(workspace, directory, "artifacts", evidence, ["private-credential"]);
		expect(evidence.complete).toBe(false); expect(evidence.refs).toHaveLength(0);
		expect((await checkRule({ id: "no", kind: "file.absent", path: "key.txt" }, { directory, evidence, events: [] })).status).toBe("insufficient");
	});
});

describe("behavior semantics using explicit synthetic events only", () => {
	test("denied requests are not executions; duplicates are deduplicated and retries count", () => {
		const events = [event(1, "tool.requested", "1", "write"), event(2, "approval.resolved", "1", "write", { approved: false })];
		const rule = (phase: "requested" | "started"): Rule => ({ id: "deny", kind: "tool.count", match: { name: "write", phase }, max: 0 });
		expect(checkBehavior(rule("started"), events, allCapabilities, true).status).toBe("pass");
		expect(checkBehavior(rule("requested"), events, allCapabilities, true).status).toBe("fail");
		expect(checkBehavior(rule("started"), events, allCapabilities, false).status).toBe("insufficient");
	});
	test("every modification needs a completed predecessor and a prior approval", () => {
		const events = [event(1, "tool.started", "read", "read"), event(2, "tool.started", "write", "write"), event(3, "tool.completed", "read", "read", { outcome: "success" }), event(4, "approval.resolved", "write", "write", { approved: true })];
		const order: Rule = { id: "order", kind: "tool.order", before: { name: "read", phase: "completed" }, after: { name: "write", phase: "started" } };
		expect(checkBehavior(order, events, allCapabilities, true).status).toBe("fail");
		expect(checkBehavior({ id: "approval", kind: "tool.approval", match: { name: "write", phase: "started" } }, events, allCapabilities, true).status).toBe("fail");
		const correct = [events[2], events[3], event(5, "tool.started", "write", "write")]; expect(checkBehavior(order, correct, allCapabilities, true).status).toBe("pass");
	});
	test("parameter mismatch fails; an allowed failed attempt followed by success passes", () => {
		const events = [event(1, "tool.completed", "a", "read", { input: { path: "wrong" }, outcome: "error" }), event(2, "tool.completed", "b", "read", { input: { path: "right" }, outcome: "success" })];
		expect(checkBehavior({ id: "retry", kind: "tool.count", match: { name: "read", phase: "completed", outcome: "success" }, min: 1, max: 1 }, events, allCapabilities, true).status).toBe("pass");
		expect(checkBehavior({ id: "args", kind: "tool.parameters", match: { name: "read", phase: "completed" }, check: { pointer: "/path", op: "equals", expected: "right" } }, events, allCapabilities, true).status).toBe("fail");
	});
});

describe("isolated verifier protocol and grading", () => {
	async function setup(source: string) {
		const script = path.join(directory, "verify.ts"); await writeFile(script, source);
		const registry = path.join(directory, "verifiers.json"); await writeFile(registry, JSON.stringify([{ id: "fixture", label: "Fixture", version: "1", command: process.execPath, args: [script], files: [script], timeoutMs: 3000 }]));
		return loadVerifiers(registry);
	}
	test("scripts run on a disposable copy and never mutate archived evidence", async () => {
		await writeFile(path.join(workspace, "out.txt"), "original"); const evidence = manifest(); await snapshot(workspace, directory, "baseline", evidence, []); await snapshot(workspace, directory, "artifacts", evidence, []);
		const verifiers = await setup('await Bun.write("out.txt", "mutated"); console.log(JSON.stringify({protocolVersion:1, verdict:"pass", expected:"ok", actual:"ok", message:"verified", evidence:[]}));');
		const grade = await gradeCase({ definition: definition([{ id: "script", kind: "script", verifierId: "fixture" }, { id: "unchanged", kind: "file.unchanged", path: "out.txt" }]), result: result(), directory, evidence, events: [], verifiers });
		expect(grade.verdict).toBe("passed"); expect(await readFile(path.join(workspace, "out.txt"), "utf8")).toBe("original");
	});
	test("command exit failure differs from script crash; a hard failure remains visible", async () => {
		const verifiers = await setup("process.exit(1);"); const evidence = manifest();
		const grade = await gradeCase({ definition: definition([{ id: "command", kind: "command", verifierId: "fixture", expectedExitCode: 0 }, { id: "script", kind: "script", verifierId: "fixture" }]), result: result(), directory, evidence, events: [], verifiers });
		expect(grade.results.map(r => r.status)).toEqual(["fail", "error"]); expect(grade.verdict).toBe("failed"); expect(grade.status).toBe("error");
	});
	test("malformed verifier protocol and changed verifier versions are errors, never Agent failures", async () => {
		const verifiers = await setup('console.log("not JSON");'); const evidence = manifest();
		const def = definition([{ id: "script", kind: "script", verifierId: "fixture" }]);
		const malformed = await gradeCase({ definition: def, result: result(), directory, evidence, events: [], verifiers });
		expect(malformed.verdict).toBe("inconclusive"); expect(malformed.results[0].status).toBe("error");
		await writeFile(path.join(directory, "verify.ts"), 'console.log("changed");');
		const changed = await gradeCase({ definition: def, result: result(), directory, evidence, events: [], verifiers });
		expect(changed.results[0].message).toContain("已变更"); expect(changed.verdict).toBe("inconclusive");
	});
	test("cancellation preserves a skipped required rule and never reports success", async () => {
		const controller = new AbortController(); controller.abort();
		const grade = await gradeCase({ definition: definition([{ id: "file", kind: "file.exists", path: "out" }]), result: result(), directory, evidence: manifest(), events: [], verifiers: [], signal: controller.signal });
		expect(grade.status).toBe("cancelled"); expect(grade.verdict).toBe("inconclusive"); expect(grade.results[0].status).toBe("skipped");
	});
	test("regex watchdog terminates pathological matching and missing optional capability cannot override success", async () => {
		await writeFile(path.join(workspace, "out.txt"), "a".repeat(50000) + "!"); const evidence = manifest(); await snapshot(workspace, directory, "artifacts", evidence, []);
		const grade = await gradeCase({ definition: definition([{ id: "regex", kind: "file.text", path: "out.txt", op: "matches", expected: "(a+)+$" }]), result: result(), directory, evidence, events: [], verifiers: [], totalTimeoutMs: 100 });
		expect(grade.verdict).toBe("inconclusive"); expect(grade.results[0].status).toBe("error");
		const optional = await gradeCase({ definition: definition([{ id: "exists", kind: "file.exists", path: "out.txt" }, { id: "tool", kind: "tool.count", match: { name: "read", phase: "started" }, min: 1, required: false }]), result: result(), directory, evidence, events: [], verifiers: [] });
		expect(optional.verdict).toBe("passed"); expect(optional.results[1].status).toBe("insufficient");
	});
	test("timeouts terminate the verifier and retain partial output", async () => {
		const script = path.join(directory, "slow.ts"); await writeFile(script, 'console.log("before-timeout"); setInterval(() => {}, 1000);');
		const output = await runProcess(process.execPath, [script], { cwd: directory, env: { SystemRoot: process.env.SystemRoot ?? "" }, timeoutMs: 300 });
		expect(output.timedOut).toBe(true); expect(output.stdout).toContain("before-timeout");
	});
});

test("summary separates legacy, rule versions, errors, unknowns and cancellations", () => {
	const required: RuleResult = { id: "x", kind: "file.exists", required: true, status: "pass", message: "", evidenceRefs: [], durationMs: 0 };
	expect(verdict([])).toBe("inconclusive"); expect(verdict([required, { ...required, status: "error" }])).toBe("inconclusive");
	const base = { snapshot: { id: "c", definition: { id: "case", grading: {} } }, result: { ...result(), grading: { id: "g", version: 1 as const, ruleHash: "v1", status: "completed" as const, verdict: "passed" as const, results: [required], startedAt: "", endedAt: "", durationMs: 1, verifiers: [] } }, status: "passed" };
	const summary = gradingSummary([base, { ...base, status: "inconclusive", result: { ...base.result, execution: { status: "error" }, grading: { ...base.result.grading, verdict: "inconclusive", results: [{ ...required, status: "error" }] } } }, { ...base, status: "cancelled" }, { ...base, snapshot: { id: "old", definition: { id: "old" } } }]);
	expect(summary.groups[0].passRate).toMatchObject({ numerator: 1, denominator: 1 }); expect(summary.groups[0].coverage.rate).toBe(0.5); expect(summary.groups[0].successRatio.rate).toBe(0.5); expect(summary.cancelled).toBe(1); expect(summary.legacy.denominator).toBe(1);
});
