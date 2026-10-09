import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase, EvalDefaults, EvalCaseResult } from "../types.js";
import { prepareWorkspace } from "../web/workspace.js";
import { gradeCase, preflight } from "./engine.js";
import { resolveVerifiers, materializeVerifiers } from "./verifiers.js";
import { loadCliVerifierSnapshots } from "./verifier-source.js";
import type { UploadedVerifier } from "./uploaded-verifiers.js";
import { manifest, redact, redactValue, saveEvidence, snapshot } from "./evidence.js";
import { killTree } from "./process.js";
import type { EvidenceEvent } from "./types.js";

export async function runIsolated(input: { definition: EvalCase; defaults: EvalDefaults; directory: string; verifierSnapshots?: UploadedVerifier[]; itemId?: string; signal?: AbortSignal; onText?: (text: string) => void; onWorkspace?: (workspace: string) => void; onPhase?: (phase: "executing" | "verifying") => void }): Promise<EvalCaseResult> {
	const { definition, defaults, directory, signal } = input; const started = Date.now();
	await mkdir(directory, { recursive: true });
	const snapshots = input.verifierSnapshots ?? await loadCliVerifierSnapshots(definition, path.resolve(directory, "../../.."));
	const resolved = await resolveVerifiers(definition, undefined, snapshots);
	const verifiers = [...resolved.configured, ...await materializeVerifiers(resolved.uploaded, directory)];
	preflight(definition, verifiers);
	const source = definition.replayMode === "full-task" ? definition.cwd ?? defaults.cwd : undefined;
	if (source && verifiers.some(v => v.files.some(file => { const relative = path.relative(path.resolve(source), file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }))) throw new Error("正式验收脚本不能位于 Agent fixture 内，请将验证器移到独立目录");
	const secrets = [defaults.apiKeyEnv ? process.env[defaults.apiKeyEnv] ?? "" : "", ...verifiers.flatMap(v => v.env.map(k => process.env[k] ?? ""))];
	if (definition.grading && secrets.some(secret => secret && JSON.stringify(definition.grading).includes(secret))) throw new Error("判分规则不得包含凭据值，请使用非敏感验收条件");
	if (definition.grading) await writeFile(path.join(directory, "case.json"), JSON.stringify(redactValue({ definition, defaults }, secrets), null, 2));
	const evidence = manifest(); const events: EvidenceEvent[] = []; let seq = 0; let sessionId = ""; let persisted = Promise.resolve();
	await mkdir(path.join(directory, "evidence"), { recursive: true });
	const emit = (type: EvidenceEvent["type"], payload: EvidenceEvent["payload"] = {}) => {
		const event: EvidenceEvent = { schemaVersion: 1, eventId: randomUUID(), itemId: input.itemId ?? path.basename(directory), sessionId, seq: ++seq, timestamp: new Date().toISOString(), type, payload };
		events.push(event); persisted = persisted.then(() => appendFile(path.join(directory, "evidence/events.jsonl"), redact(JSON.stringify(event), secrets) + "\n"));
	};
	const workspace = await prepareWorkspace(directory, source);
	input.onWorkspace?.(workspace);
	if (definition.grading) await snapshot(workspace, directory, "baseline", evidence, secrets);
	signal?.throwIfAborted(); input.onPhase?.("executing");
	// Only the parent owns grading. The worker receives the ordinary execution input.
	const suite = { version: 1, defaults: { ...defaults, cwd: workspace }, cases: [{ ...definition, grading: undefined, assertions: definition.grading ? undefined : definition.assertions, cwd: workspace }] };
	const suitePath = path.join(directory, "suite.json"); await writeFile(suitePath, JSON.stringify(suite));
	const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../web/worker.ts" : "../web/worker.js", import.meta.url));
	const child = spawn(process.execPath, [worker, suitePath], { cwd: workspace, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLINE_DATA_DIR: path.join(directory, "session"), CLINE_SANDBOX: "1", CLINE_SANDBOX_DATA_DIR: path.join(directory, "session"), CLINE_LOG_ENABLED: "0" } });
	const exited = new Promise<void>((resolve, reject) => { child.on("close", () => resolve()); child.on("error", reject); });
	let killTimer: ReturnType<typeof setTimeout> | undefined; let killing: Promise<void> | undefined;
	const kill = () => { if (child.pid) killing ??= killTree(child.pid).catch(error => { evidence.issues.push(String(error)); evidence.complete = false; child.kill("SIGKILL"); }); };
	const cancel = () => { try { child.stdin.write("cancel\n"); } catch {} killTimer = setTimeout(kill, 3000); };
	child.stdin.on("error", () => {});
	signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
	let result: EvalCaseResult | undefined; let failure = ""; let stderr = ""; let text = ""; let timedOut = false; let diagnostics = ""; let diagnosticComplete = true;
	const timeout = setTimeout(() => { timedOut = true; failure = "执行超时（包含启动与清理）"; kill(); }, (definition.timeoutMs ?? defaults.timeoutMs ?? 300000) + 30000);
	try {
		const readOutput = async () => {
			let buffer = ""; const decoder = new TextDecoder();
			for await (const bytes of child.stdout) {
				buffer += decoder.decode(bytes, { stream: true });
				if (buffer.length > 8 * 1024 * 1024) { failure = "worker 消息超过 8 MiB 限制"; kill(); break; }
				let index: number;
				while ((index = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
					let event; try { event = redactValue(JSON.parse(line), secrets); } catch { diagnosticComplete = false; continue; }
					if (event.type === "session") { sessionId = event.sessionId; emit("session.started"); }
					if (event.type === "text") { text = (text + String(event.text)).slice(-2000000); input.onText?.(String(event.text)); }
					if (event.type === "result") result = event.result;
					if (event.type === "error") failure = event.error;
					if (event.type === "diagnostic") {
						const entry = JSON.stringify(event.event) + "\n";
						if (diagnostics.length + entry.length <= 4 * 1024 * 1024) { diagnostics += entry; persisted = persisted.then(() => appendFile(path.join(directory, "evidence/diagnostics.jsonl"), entry)); } else diagnosticComplete = false;
					}
				}
			}
			if (buffer.trim()) diagnosticComplete = false;
		};
		const readErrors = async () => { const decoder = new TextDecoder(); for await (const bytes of child.stderr) stderr = (stderr + redact(decoder.decode(bytes), secrets)).slice(-8000); };
		await Promise.all([readOutput(), readErrors(), exited]); await killing;
	} catch (error) { failure = String(error); kill(); await killing;
	} finally { clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener("abort", cancel); }
	if (!result || failure) result = { id: definition.id, sessionId, status: "error", text, durationMs: Date.now() - started, iterations: 0, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], assertions: [], error: failure || stderr || `执行进程退出 (${child.exitCode})` };
	if (!definition.grading) { signal?.throwIfAborted(); return result; }
	if (!result.text && text) result.text = redact(text, secrets);
	result.assertions = [];
	result.execution = { status: signal?.aborted ? "cancelled" : result.status === "error" ? "error" : "completed", reason: timedOut || result.error?.includes("evaluation timed out") ? "task_timeout" : result.error };
	if (result.execution.status === "error") emit("execution.error", { error: result.error });
	emit("session.ended", { status: result.execution.status }); await persisted;
	evidence.eventsComplete = result.execution.status === "completed" && diagnosticComplete;
	if (!diagnosticComplete) evidence.issues.push("诊断轨迹已截断或消息无效");
	await saveEvidence(directory, await readFile(path.join(directory, "evidence/events.jsonl")), "事件轨迹", evidence.refs);
	if (diagnostics) await saveEvidence(directory, diagnostics, "SDK 诊断轨迹（不证明实际执行）", evidence.refs);
	await saveEvidence(directory, JSON.stringify(result, null, 2), "执行结果", evidence.refs);
	await snapshot(workspace, directory, "artifacts", evidence, secrets);
	await saveEvidence(directory, JSON.stringify(evidence, null, 2), "文件清单", evidence.refs);
	input.onPhase?.("verifying");
	result.grading = await gradeCase({ definition, result, directory, evidence, events, verifiers, signal, secrets });
	result.evidence = evidence; result.status = result.grading.verdict;
	await writeFile(path.join(directory, "execution.json"), JSON.stringify(result, null, 2));
	await writeFile(path.join(directory, "evidence/manifest.json"), JSON.stringify(evidence, null, 2));
	return result;
}
