import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile, materialize, redact, saveEvidence, sha256 } from "./evidence.js";
import { runProcess } from "./process.js";
import type { EvidenceManifest, Rule } from "./types.js";

export type Verifier = { id: string; label: string; version: string; command: string; args: string[]; files: string[]; env: string[]; timeoutMs: number; sha256: string; fileHashes: Array<{ path: string; sha256: string }> };
export async function loadVerifiers(file = process.env.EVAL_VERIFIERS_FILE): Promise<Verifier[]> {
	if (!file) return [];
	const raw: unknown = JSON.parse(await readFile(file, "utf8"));
	if (!Array.isArray(raw)) throw new Error("EVAL_VERIFIERS_FILE 必须包含验证器数组");
	const ids = new Set<string>(); const result: Verifier[] = [];
	for (const value of raw) {
		if (value && typeof value === "object" && value.command === "{runtime}") value.command = process.execPath;
		if (!value || typeof value !== "object" || !/^[\w-]{1,80}$/.test(value.id) || ids.has(value.id) || typeof value.label !== "string" || typeof value.version !== "string" || typeof value.command !== "string" || !path.isAbsolute(value.command)) throw new Error("验证器配置无效：需要唯一 id、label、version、command 绝对路径");
		for (const key of Object.keys(value)) if (!["id", "label", "version", "command", "args", "files", "env", "timeoutMs"].includes(key)) throw new Error(`验证器未知字段：${key}`);
		for (const key of ["args", "files", "env"]) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((s: unknown) => typeof s !== "string"))) throw new Error(`验证器 ${key} 须为字符串数组`);
		const timeoutMs = value.timeoutMs ?? 60000; if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new Error("验证器 timeoutMs 须为 1–180000");
		const files = (value.files ?? []).map((p: string) => path.resolve(path.dirname(file), p));
		await access(value.command); const hashes = await Promise.all([value.command, ...files].map(async p => ({ path: p, sha256: await hashFile(p) })));
		ids.add(value.id); result.push({ ...value, args: (value.args ?? []).map((arg: string) => arg.replaceAll("{verifierDir}", path.resolve(path.dirname(file)))), files, env: value.env ?? [], timeoutMs, fileHashes: hashes, sha256: sha256(JSON.stringify({ ...value, hashes })) });
	}
	return result;
}
export const publicVerifier = (v: Verifier) => ({ id: v.id, label: v.label, version: v.version, sha256: v.sha256, timeoutMs: v.timeoutMs, dependencies: v.files.map(f => path.basename(f)) });

export async function verifyProcess(rule: Extract<Rule, { kind: "command" | "script" }>, verifier: Verifier, input: { directory: string; gradeDirectory: string; evidence: EvidenceManifest; execution: unknown; signal?: AbortSignal; timeoutMs: number; secrets: string[] }) {
	const deadline = Date.now() + input.timeoutMs;
	const checkVersion = async () => { for (const file of verifier.fileHashes) if (await hashFile(file.path) !== file.sha256) throw new Error("验证器或声明依赖已变更，请重新运行以固定新版本"); };
	await checkVersion();
	const destination = path.join(input.gradeDirectory, rule.id); const workspace = path.join(destination, "workspace"); await mkdir(workspace, { recursive: true });
	await materialize(input.directory, workspace, input.evidence);
	const context = path.join(destination, "context.json");
	await writeFile(context, JSON.stringify({ protocolVersion: 1, workspace, execution: input.execution, rule, evidence: input.evidence }));
	const env: Record<string, string> = {};
	for (const key of ["SystemRoot", "WINDIR", "PATH", "Path", "PATHEXT", "TEMP", "TMP", ...verifier.env]) if (process.env[key]) env[key] = process.env[key]!;
	env.EVAL_CONTEXT = context;
	if (deadline <= Date.now()) throw new Error("案例验证总超时（准备阶段）");
	const processResult = await runProcess(verifier.command, verifier.args.map(arg => arg.replaceAll("{workspace}", workspace).replaceAll("{context}", context)), { cwd: workspace, env, timeoutMs: Math.min(deadline - Date.now(), verifier.timeoutMs), signal: input.signal });
	const secrets = [...input.secrets, ...verifier.env.map(key => process.env[key] ?? "")];
	const stdout = redact(processResult.stdout, secrets); const stderr = redact(processResult.stderr, secrets);
	const ref = await saveEvidence(input.directory, JSON.stringify({ ...processResult, stdout, stderr }, null, 2), `${rule.id}/验证日志`, input.evidence.refs);
	try { await checkVersion(); } catch (error) { return { status: "error" as const, message: String(error), actual: null, evidenceRefs: [ref] }; }
	if (processResult.cleanupError) return { status: "error" as const, message: processResult.cleanupError, actual: null, evidenceRefs: [ref] };
	if (input.signal?.aborted) return { status: "skipped" as const, message: "验证已取消", actual: null, evidenceRefs: [ref] };
	if (processResult.timedOut) return { status: "error" as const, message: "验证器超时", actual: null, evidenceRefs: [ref] };
	if (rule.kind === "command") return { status: processResult.code === rule.expectedExitCode ? "pass" as const : "fail" as const, message: `验收命令退出码 ${processResult.code}${processResult.truncated ? "（日志预览截断）" : ""}`, actual: processResult.code, evidenceRefs: [ref] };
	if (processResult.code !== 0 || processResult.truncated) return { status: "error" as const, message: "验证脚本异常退出或结果超过大小限制", actual: processResult.code, evidenceRefs: [ref] };
	let parsed: Record<string, unknown>;
	try { parsed = JSON.parse(stdout); } catch { return { status: "error" as const, message: "验证脚本未返回有效 JSON", actual: null, evidenceRefs: [ref] }; }
	if (!parsed || parsed.protocolVersion !== 1 || !["pass", "fail"].includes(String(parsed.verdict)) || typeof parsed.message !== "string" || !("expected" in parsed) || !("actual" in parsed) || !Array.isArray(parsed.evidence) || parsed.evidence.some(id => typeof id !== "string" || !input.evidence.refs.some(r => r.id === id))) return { status: "error" as const, message: "验证脚本协议无效", actual: null, evidenceRefs: [ref] };
	if (stdout.includes("[REDACTED]")) return { status: "insufficient" as const, message: "验证结果含已脱敏字段，无法精确判定", actual: null, evidenceRefs: [ref] };
	return { status: parsed.verdict as "pass" | "fail", message: parsed.message, expected: parsed.expected, actual: parsed.actual, evidenceRefs: [ref, ...parsed.evidence as string[]] };
}
