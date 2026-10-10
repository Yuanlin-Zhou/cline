import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvalCase, EvalCaseResult } from "../types.js";
import type { RunItem } from "../web/types.js";
import type { EvidenceManifest, ValidationInputName, Rule } from "./types.js";
import { readEvidence, saveEvidence, redactValue } from "./evidence.js";
import { readSessionInput } from "./session-input.js";
import { safeRelative } from "./schema.js";

export type InputSection = { status: string; completeness: string; issues: string[] };
export type ValidationContext = {
	context_version: 2; run: { run_id?: string; item_id: string; round: number; session_id: string };
	case: { id: string; prompt: string; history: unknown[]; replay_mode: string };
	execution: InputSection & { text: string; finish_reason?: string; error?: string; duration_ms: number; iterations: number; usage: unknown };
	conversation: InputSection & { source: string; scope: string; messages: Array<{ id: string; index: number; role: string; blocks: Array<Record<string, unknown>> }> };
	diagnostics: InputSection & { tool_calls: unknown[]; capabilities: EvidenceManifest["capabilities"]; events_ref?: string };
	artifacts: InputSection & { files: Array<{ path: string; size: number; sha256: string; change: string }>; deleted: string[] };
	baseline: InputSection & { files: Array<{ path: string; size: number; sha256: string }> };
	params?: Record<string, unknown>; paths?: Record<string, string>;
};
export const CONTEXT_LABEL = "Python验证输入 v2";
const complete = (status: string, completeness = "complete", issues: string[] = []): InputSection => ({ status, completeness, issues });
function contentBlocks(value: unknown): Array<Record<string, unknown>> {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [{ type: "unknown", data: value }];
	return value.map(v => {
		if (!v || typeof v !== "object") return { type: "unknown", data: v };
		const b = v as Record<string, unknown>; const original = String(b.type ?? "unknown"); const type = ({ "tool-call": "tool_call", tool_use: "tool_call", "tool-result": "tool_result" } as Record<string, string>)[original] ?? original;
		if (["image", "file", "audio", "video"].includes(type)) return { type, note: "媒体正文不嵌入验证上下文" };
		if (type === "tool_call" || type === "tool_result") return { type, tool_name: b.toolName ?? b.name, tool_call_id: b.toolCallId ?? b.tool_use_id ?? b.id, ...(type === "tool_call" ? { input: b.input } : { output: b.output ?? b.content ?? b.result }), ...(b.error !== undefined ? { error: b.error } : {}) };
		return { type, ...(typeof b.text === "string" ? { text: b.text } : { data: b }) };
	});
}
export async function freezeValidationInput(input: { directory: string; definition: EvalCase; result: EvalCaseResult; evidence: EvidenceManifest; secrets: string[]; runId?: string; itemId?: string; round?: number; historical?: boolean }) {
	const { directory, definition, result, evidence } = input;
	const session = !input.historical && result.sessionId ? await readSessionInput(directory, result.sessionId, false, input.secrets) : { status: "missing", completeness: "missing", issues: [input.historical ? "旧执行未冻结会话，不读取可变化的会话文件；需要会话时请重新评测。" : "会话未建立"], messages: [] };
	const full = definition.replayMode === "full-task";
	const fileState = full ? complete(evidence.complete ? "ready" : "partial", evidence.complete ? "complete" : "partial", evidence.issues) : complete("not_applicable", "missing");
	const diagnostic = evidence.refs.find(r => r.label === "SDK 诊断轨迹（不证明实际执行）");
	const executionStatus = result.execution?.status ?? (result.status === "error" ? "error" : "completed");
	const ctx: ValidationContext = {
		context_version: 2, run: { run_id: input.runId, item_id: input.itemId ?? path.basename(directory), round: input.round ?? 1, session_id: result.sessionId },
		case: { id: definition.id, prompt: definition.prompt, history: definition.history ?? [], replay_mode: definition.replayMode ?? "single-turn" },
		execution: { ...complete(executionStatus), text: result.text, finish_reason: result.finishReason, error: result.error, duration_ms: result.durationMs, iterations: result.iterations, usage: result.usage },
		conversation: { status: session.status, completeness: session.completeness, issues: session.issues, source: "sdk_saved_context", scope: "main_session", messages: session.messages.map((m, index) => ({ id: `${result.sessionId}:${index}`, index, role: String(m.role ?? "unknown"), blocks: contentBlocks(m.content) })) },
		diagnostics: { ...complete(diagnostic || result.toolCalls.length ? "ready" : "missing", "unknown", ["工具通知仅供诊断，不证明实际执行或审批；事件记录可能截断。"]), tool_calls: result.toolCalls, capabilities: { ...evidence.capabilities }, events_ref: diagnostic?.id },
		artifacts: { ...fileState, files: evidence.artifacts.map(f => ({ path: f.path, size: f.size, sha256: f.sha256, change: evidence.baseline.some(b => b.path === f.path) ? evidence.baseline.some(b => b.path === f.path && b.sha256 === f.sha256) ? "unchanged" : "modified" : "added" })), deleted: evidence.baseline.filter(f => !evidence.artifacts.some(a => a.path === f.path)).map(f => f.path) },
		baseline: { ...fileState, files: evidence.baseline.map(f => ({ path: f.path, size: f.size, sha256: f.sha256 })) },
	};
	const bytes = JSON.stringify(redactValue(ctx, input.secrets));
	const ref = await saveEvidence(directory, bytes, CONTEXT_LABEL, evidence.refs);
	await writeFile(path.join(directory, "validation-input-v2.json"), bytes);
	return ref;
}
export async function frozenValidationInput(directory: string, evidence: EvidenceManifest): Promise<{ context: ValidationContext; sha256: string }> {
	const ref = evidence.refs.find(r => r.label === CONTEXT_LABEL);
	if (!ref) throw new Error("这次历史执行没有冻结的验证输入，请重新评测以生成输入；不会读取已变化的工作区");
	const bytes = await readEvidence(directory, ref, 64 * 1024 * 1024); const context = JSON.parse(bytes.toString("utf8")) as ValidationContext;
	if (context.context_version !== 2) throw new Error("验证输入版本无效");
	return { context, sha256: ref.sha256 };
}
export async function historicalEvidence(directory: string, item: RunItem) {
	if (!item.result) throw new Error("历史执行缺少结果，请重新评测");
	const evidence = structuredClone(item.result.evidence ?? { version: 1, complete: false, eventsComplete: false, capabilities: { requested: false, started: false, completed: false, approval: false }, issues: ["旧执行缺少归档文件"], baseline: [], artifacts: [], refs: [], createdAt: "", environment: { platform: "unknown", arch: "unknown", node: "unknown", graderVersion: "1" } } as EvidenceManifest);
	if (!evidence.refs.some(r => r.label === CONTEXT_LABEL)) await freezeValidationInput({ directory, definition: item.snapshot.definition, result: item.result, evidence, secrets: [], runId: item.runId, itemId: item.id, round: item.round, historical: true });
	return evidence;
}
export function missingInputs(ctx: ValidationContext, rule: Extract<Rule, { kind: "script" }>) {
	const names = [...new Set([...(rule.required_inputs ?? ["execution"]), ...(rule.require_complete ?? [])])];
	return names.filter((name: ValidationInputName) => {
		const value = ctx[name];
		const available = name === "execution" ? ["completed", "error", "cancelled"].includes(value.status) : value.status === "ready";
		return !available || rule.require_complete?.includes(name) && value.completeness !== "complete";
	});
}
export async function prepareValidationCopy(directory: string, destination: string, evidence: EvidenceManifest, ctx: ValidationContext) {
	const paths = { artifacts: path.join(destination, "artifacts"), baseline: path.join(destination, "baseline"), scratch: path.join(destination, "scratch"), context: path.join(destination, "context.json"), diagnostics: path.join(destination, "diagnostics.jsonl") };
	for (const folder of [paths.artifacts, paths.baseline, paths.scratch]) await mkdir(folder, { recursive: true });
	for (const kind of ["artifacts", "baseline"] as const) {
		if (ctx[kind].status !== "ready") continue;
		for (const file of ctx[kind].files) {
			if (!safeRelative(file.path)) throw new Error("产物路径无效");
			const f = evidence[kind].find(f => f.path === file.path && f.sha256 === file.sha256); const ref = evidence.refs.find(r => r.id === f?.ref);
			if (!ref) throw new Error("缺少归档文件引用");
			const bytes = await readEvidence(directory, ref, 100 * 1024 * 1024);
			const target = path.join(paths[kind], file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
		}
	}
	if (ctx.diagnostics.events_ref) {
		const ref = evidence.refs.find(r => r.id === ctx.diagnostics.events_ref); if (!ref) throw new Error("缺少诊断快照");
		await writeFile(paths.diagnostics, await readEvidence(directory, ref, 4 * 1024 * 1024));
	} else await writeFile(paths.diagnostics, "");
	return paths;
}
