import { realpath } from "node:fs/promises";
import os from "node:os";
import { hashFile, sha256 } from "./evidence.js";
import { runProcess } from "./process.js";

export type PythonEnvironment = { command: string; version: string; sha256: string; packages: Array<{ name: string; version: string }>; environmentId: string };
export function processEnvironment(extra: string[] = []) {
	const env: Record<string, string> = {};
	for (const key of ["SystemRoot", "WINDIR", "PATH", "Path", "PATHEXT", "TEMP", "TMP", ...extra]) if (process.env[key]) env[key] = process.env[key]!;
	return env;
}
let cached: { key: string; at: number; value: Promise<PythonEnvironment> } | undefined;
export async function pythonEnvironment(force = false): Promise<PythonEnvironment> {
	const key = `${process.env.EVAL_PYTHON_EXECUTABLE ?? ""}\n${process.env.PATH ?? ""}`;
	if (!force && cached?.key === key && Date.now() - cached.at < 5000) return cached.value;
	const value = (async () => {
		const commands = process.env.EVAL_PYTHON_EXECUTABLE ? [process.env.EVAL_PYTHON_EXECUTABLE] : ["python3", "python"];
		for (const command of commands) {
			try {
				const probe = await runProcess(command, ["-I", "-c", 'import sys,json,importlib.metadata as m; print(json.dumps({"command":sys.executable,"version":".".join(map(str,sys.version_info[:3])),"packages":sorted([{"name":d.metadata.get("Name", ""),"version":d.version} for d in m.distributions()], key=lambda x:(x["name"],x["version"]))}))'], { cwd: os.tmpdir(), env: processEnvironment(), timeoutMs: 10000 });
				if (probe.code !== 0 || probe.truncated || probe.timedOut) throw new Error();
				const data = JSON.parse(probe.stdout) as Pick<PythonEnvironment, "command" | "version" | "packages">;
				const [major, minor] = data.version.split(".").map(Number); if (major < 3 || major === 3 && minor < 10) throw new Error();
				const fingerprint = await hashFile(await realpath(data.command));
				return { ...data, sha256: fingerprint, environmentId: sha256(JSON.stringify({ version: data.version, sha256: fingerprint, packages: data.packages })) };
			} catch { /* Try the next default interpreter, never fall back from explicit configuration. */ }
		}
		throw new Error("Python 3.10+ 不可用，请配置 EVAL_PYTHON_EXECUTABLE 后重试");
	})();
	cached = { key, at: Date.now(), value }; return value;
}
export async function pythonRuntimeStatus() {
	try { const env = await pythonEnvironment(); return { ready: true, version: env.version, environmentId: env.environmentId }; }
	catch (error) { return { ready: false, message: error instanceof Error ? error.message : String(error) }; }
}
export async function validatePythonSource(content: string, env: PythonEnvironment) {
	const result = await runProcess(env.command, ["-I", "-c", 'import ast,sys; tree=ast.parse(sys.stdin.read(),filename="verify.py"); assert any(isinstance(n,ast.FunctionDef) and n.name=="verify" for n in tree.body), "需要定义 def verify(ctx)"'], { cwd: os.tmpdir(), env: processEnvironment(), timeoutMs: 5000, stdin: content });
	if (result.code !== 0 || result.timedOut) throw new Error(`Python 脚本语法或入口无效：${result.stderr.slice(-4000)}`);
}
export async function preparePythonUpload<T extends { extension: string; content: string; pythonEnvironment?: PythonEnvironment }>(value: T): Promise<T> {
	if (value.extension !== ".py") return value;
	const environment = await pythonEnvironment();
	if (value.pythonEnvironment && value.pythonEnvironment.environmentId !== environment.environmentId) throw new Error("Python 验证环境与运行快照不一致，请使用新上传版本创建评测");
	await validatePythonSource(value.content, environment);
	return { ...value, pythonEnvironment: environment };
}

// Kept in TypeScript so the Python bootstrap is included in compiled/release distributions.
export const pythonBootstrap = String.raw`import contextlib, json, runpy, sys, traceback
script, context_file, result_file = sys.argv[1:]
try:
    with open(context_file, encoding="utf-8") as f:
        ctx = json.load(f)
    with contextlib.redirect_stdout(sys.stderr):
        module = runpy.run_path(script, run_name="agent_eval_verifier")
        verify = module.get("verify")
        if not callable(verify):
            raise TypeError("需要定义 def verify(ctx)")
        result = verify(ctx)
        if not isinstance(result, dict):
            raise TypeError("verify(ctx) 必须返回 dict")
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > 1024 * 1024:
            raise ValueError("验证返回结果不能超过 1 MiB")
    with open(result_file, "x", encoding="utf-8") as f:
        f.write(encoded)
except BaseException:
    traceback.print_exc()
    sys.exit(1)
`;
