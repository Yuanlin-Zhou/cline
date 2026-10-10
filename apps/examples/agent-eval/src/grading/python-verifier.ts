import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Verifier } from "./verifiers.js";
import type { EvidenceManifest, Rule, ScriptCheck } from "./types.js";
import { hashFile, redactValue, saveEvidence } from "./evidence.js";
import { frozenValidationInput, missingInputs, prepareValidationCopy } from "./validation-context.js";
import { processEnvironment, pythonBootstrap, pythonEnvironment } from "./python-runtime.js";
import { runProcess } from "./process.js";
import { safeRelative } from "./schema.js";
import { within } from "../web/workspace.js";

export function parsePythonResult(raw: unknown, evidence: EvidenceManifest) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("verify(ctx) 必须返回 dict");
	const value = raw as Record<string, unknown>;
	if (!["pass", "fail", "insufficient"].includes(String(value.verdict)) || typeof value.message !== "string" || value.message.length > 16000) throw new Error("返回值需要 verdict（pass/fail/insufficient）和 message 字符串");
	if (Object.keys(value).some(k => !["verdict", "message", "checks", "expected", "actual"].includes(k))) throw new Error("验证返回值包含未知字段");
	if (value.checks !== undefined && (!Array.isArray(value.checks) || value.checks.length > 100)) throw new Error("checks 必须是最多100项的数组");
	const ids = new Set<string>(); const refs: string[] = [];
	for (const check of (value.checks ?? []) as ScriptCheck[]) {
		if (!check || typeof check !== "object" || !/^[a-zA-Z0-9_-]{1,80}$/.test(check.id) || ids.has(check.id) || !["pass", "fail", "insufficient"].includes(check.status) || typeof check.message !== "string" || Object.keys(check).some(k => !["id", "status", "message", "expected", "actual", "files"].includes(k))) throw new Error("checks 检查项格式无效或ID重复");
		ids.add(check.id);
		if (value.verdict === "pass" && check.status !== "pass") throw new Error("整体 pass 与检查项失败/不足矛盾");
		if (check.files !== undefined && (!Array.isArray(check.files) || check.files.some(f => typeof f !== "string" || !safeRelative(f)))) throw new Error("检查项文件引用须为合法相对路径");
		for (const file of check.files ?? []) {
			const ref = evidence.artifacts.find(f => f.path === file) ?? evidence.baseline.find(f => f.path === file);
			if (!ref) throw new Error(`检查项引用未归档的文件：${file}`); refs.push(ref.ref);
		}
	}
	return { status: value.verdict as "pass" | "fail" | "insufficient", message: value.message, checks: (value.checks ?? []) as ScriptCheck[], expected: value.expected, actual: value.actual, evidenceRefs: [...new Set(refs)] };
}
export async function verifyPythonProcess(rule: Extract<Rule, { kind: "script" }>, verifier: Verifier, input: { directory: string; gradeDirectory: string; evidence: EvidenceManifest; signal?: AbortSignal; timeoutMs: number; secrets: string[] }) {
	const deadline = Date.now() + Math.min(input.timeoutMs, verifier.timeoutMs);
	const frozen = await frozenValidationInput(input.directory, input.evidence);
	const base = { contextSha256: frozen.sha256, runtime: verifier.pythonEnvironment ? { version: verifier.pythonEnvironment.version, environmentId: verifier.pythonEnvironment.environmentId } : undefined };
	const missing = missingInputs(frozen.context, rule);
	if (missing.length) return { ...base, status: "insufficient" as const, message: `缺少必要输入或完整性不足：${missing.join("、")}`, evidenceRefs: [] };
	const environment = await pythonEnvironment();
	if (verifier.pythonEnvironment?.environmentId !== environment.environmentId) throw new Error("Python验证环境已变化，请重新创建评测");
	const checkFiles = async () => { for (const f of verifier.fileHashes) if (await hashFile(f.path) !== f.sha256) throw new Error("验证器或解释器内容已变化"); };
	await checkFiles();
	const destination = path.join(input.gradeDirectory, rule.id);
	const paths = await prepareValidationCopy(input.directory, destination, input.evidence, frozen.context);
	await writeFile(paths.context, JSON.stringify({ ...frozen.context, params: rule.params ?? {}, paths }));
	const bootstrap = path.join(destination, "python-runner.py"); const resultFile = path.join(destination, "result.json");
	await writeFile(bootstrap, pythonBootstrap);
	if (deadline <= Date.now()) throw new Error("验证准备阶段超时");
	const processResult = await runProcess(environment.command, ["-I", "-u", bootstrap, verifier.files[0], paths.context, resultFile], { cwd: paths.scratch, env: processEnvironment(), timeoutMs: deadline - Date.now(), signal: input.signal });
	const logs = redactValue(processResult, input.secrets);
	const logRef = await saveEvidence(input.directory, JSON.stringify(logs), `${rule.id}/Python验证日志`, input.evidence.refs);
	const failed = (status: "error" | "skipped", message: string) => ({ ...base, status, message, actual: processResult.code, evidenceRefs: [logRef] });
	if (input.signal?.aborted) return failed("skipped", "验证已取消");
	if (processResult.cleanupError) return failed("error", processResult.cleanupError);
	if (processResult.timedOut) return failed("error", "Python验证脚本超时");
	if (processResult.code !== 0) return failed("error", `Python脚本异常退出，请查看验证日志\n${logs.stderr.slice(-4000)}`);
	try {
		await checkFiles();
		const target = await realpath(resultFile); if (!within(await realpath(destination), target) || !(await stat(target)).isFile() || (await stat(target)).size > 1024 * 1024) throw new Error("验证结果文件越界或超过1MiB");
		const raw = JSON.parse(await readFile(target, "utf8")); const result = parsePythonResult(redactValue(raw, input.secrets), input.evidence);
		if (JSON.stringify(raw) !== JSON.stringify(redactValue(raw, input.secrets))) return { ...base, status: "insufficient" as const, message: "返回结果包含已替换的凭据，无法精确判定", evidenceRefs: [logRef] };
		const reportRef = await saveEvidence(input.directory, JSON.stringify({ ...result, ...base }), `${rule.id}/Python检查报告`, input.evidence.refs);
		return { ...base, ...result, evidenceRefs: [logRef, reportRef, ...result.evidenceRefs] };
	} catch (error) { return failed("error", `Python验证返回值无效：${error instanceof Error ? error.message : String(error)}`); }
}
