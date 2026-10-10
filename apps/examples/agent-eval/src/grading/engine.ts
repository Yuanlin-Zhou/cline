import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { EvalCase, EvalCaseResult, AssertionResult } from "../types.js";
import { CAPABILITIES, sha256 } from "./evidence.js";
import { requiredCapabilities } from "./behavior.js";
import { verifyProcess, type Verifier } from "./verifiers.js";
import type { Grade, EvidenceEvent, EvidenceManifest, RuleResult } from "./types.js";

export function preflight(definition: EvalCase, verifiers: Verifier[]) {
	for (const rule of definition.grading?.rules ?? []) {
		if (rule.required !== false && requiredCapabilities(rule).some(key => !CAPABILITIES[key])) throw new Error(`grading.${rule.id}: 当前 SDK 不支持此行为规则所需的真实事件；请移除必要规则或设为可选诊断`);
		if ("verifierId" in rule && !verifiers.some(v => v.id === rule.verifierId)) throw new Error(`grading.${rule.id}: 验证器 ${rule.verifierId} 未注册`);
		if (definition.replayMode !== "full-task" && rule.kind === "script") {
			if (verifiers.find(v => v.id === rule.verifierId)?.runtime !== "python") throw new Error(`grading.${rule.id}: 单轮回放只支持 Python verify(ctx) 验证脚本`);
			if ([...(rule.required_inputs ?? []), ...(rule.require_complete ?? [])].some(v => v === "artifacts" || v === "baseline")) throw new Error(`grading.${rule.id}: 单轮回放不产生工作区产物，请选择完整任务模式`);
		}
	}
}

function builtin<T>(input: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error("验证已取消")); return; }
		const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./rule-worker.ts" : "./rule-worker.js", import.meta.url));
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); worker.terminate(); };
		const cancel = () => { cleanup(); reject(new Error("验证已取消")); };
		const timer = setTimeout(() => { cleanup(); reject(new Error("内置验证超时")); }, Math.max(1, timeoutMs));
		signal?.addEventListener("abort", cancel, { once: true });
		worker.on("message", data => { cleanup(); if (data.error) reject(new Error(data.error)); else resolve(data.result); });
		worker.on("error", e => { cleanup(); reject(e instanceof Error ? e : new Error(String(e))); });
		worker.postMessage(input);
	});
}
export function verdict(results: RuleResult[]): Grade["verdict"] {
	const required = results.filter(r => r.required);
	return required.some(r => r.status === "fail") ? "failed" : required.length > 0 && required.every(r => r.status === "pass") ? "passed" : "inconclusive";
}
export async function gradeCase(input: { definition: EvalCase; result: EvalCaseResult; directory: string; evidence: EvidenceManifest; events: EvidenceEvent[]; verifiers: Verifier[]; signal?: AbortSignal; secrets?: string[]; totalTimeoutMs?: number }): Promise<Grade> {
	const started = Date.now(); const deadline = started + (input.totalTimeoutMs ?? 180000); const id = randomUUID(); const gradeDirectory = path.join(input.directory, "grading", id);
	await mkdir(gradeDirectory, { recursive: true });
	const rules = input.definition.grading!; const ruleHash = sha256(JSON.stringify({ rules, assertions: input.definition.assertions, verifiers: input.verifiers.map(v => ({ id: v.id, sha256: v.sha256, environmentId: v.pythonEnvironment?.environmentId })) }));
	await writeFile(path.join(gradeDirectory, "rules.json"), JSON.stringify({ ...rules, assertions: input.definition.assertions, ruleHash }, null, 2));
	const results: RuleResult[] = [];
	for (const rule of rules.rules) {
		const start = Date.now();
		const base: RuleResult = { id: rule.id, label: rule.label, kind: rule.kind, required: rule.required !== false, status: "error", expected: rule, message: "", evidenceRefs: [], durationMs: 0 };
		try {
			if (input.signal?.aborted) { results.push({ ...base, status: "skipped", message: "验证已取消" }); continue; }
			if (deadline <= start) throw new Error("案例验证总超时");
			if ("verifierId" in rule) {
				const verifier = input.verifiers.find(v => v.id === rule.verifierId); if (!verifier) throw new Error("验证器未注册");
				results.push({ ...base, ...await verifyProcess(rule, verifier, { ...input, gradeDirectory, execution: input.result, timeoutMs: deadline - start, secrets: input.secrets ?? [] }), durationMs: Date.now() - start });
			} else results.push({ ...base, ...await builtin<Partial<RuleResult>>({ rule, directory: input.directory, evidence: input.evidence, events: input.events }, Math.min(60000, deadline - start), input.signal), durationMs: Date.now() - start });
		} catch (error) { results.push({ ...base, status: input.signal?.aborted ? "skipped" : "error", message: String(error), durationMs: Date.now() - start }); }
	}
	if (input.definition.assertions) {
		try {
			if (input.result.text.includes("[REDACTED]")) {
				results.push({ id: "legacy-redacted", kind: "text.legacy", required: true, status: "insufficient", message: "文本含脱敏内容，不能精确判定文本断言", evidenceRefs: [], durationMs: 0 });
			} else {
				if (Date.now() >= deadline) throw new Error("案例验证总超时");
				const assertions = await builtin<AssertionResult[]>({ legacy: true, text: input.result.text, finishReason: input.result.finishReason, assertions: input.definition.assertions }, deadline - Date.now(), input.signal);
				input.result.assertions = assertions;
				results.push(...assertions.map((a, i): RuleResult => ({ id: `legacy-${i}`, kind: "text.legacy", required: true, status: a.passed ? "pass" : "fail", message: a.message, expected: a.message, actual: i === 0 ? input.result.finishReason : input.result.text, evidenceRefs: input.evidence.refs.filter(r => r.label === "执行结果").map(r => r.id), durationMs: 0 })));
			}
		} catch (error) { results.push({ id: "legacy-error", kind: "text.legacy", required: true, status: "error", message: String(error), evidenceRefs: [], durationMs: 0 }); }
	}
	if (input.result.execution?.reason === "task_timeout") results.push({ id: "task-budget", kind: "budget", required: true, status: "fail", expected: "任务在预算内结束", actual: "任务超时", message: "超出案例任务时间预算", evidenceRefs: [], durationMs: 0 });
	for (const result of results) for (const key of ["expected", "actual"] as const) {
		const text = JSON.stringify(result[key]); if (text && text.length > 8000) result[key] = { preview: text.slice(0, 8000), truncated: true, note: "完整内容见证据或规则快照" };
	}
	const grade: Grade = { id, version: 1, ruleHash, status: input.signal?.aborted ? "cancelled" : results.some(r => r.status === "error") ? "error" : "completed", verdict: verdict(results), results, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - started, verifiers: input.verifiers.map(v => ({ id: v.id, version: v.version, sha256: v.sha256 })) };
	await writeFile(path.join(gradeDirectory, "result.json"), JSON.stringify(grade, null, 2)); return grade;
}
