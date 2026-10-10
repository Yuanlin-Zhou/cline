import { spawn } from "node:child_process";

export async function killTree(pid: number) {
	if (process.platform === "win32") {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			const timer = setTimeout(() => { child.kill(); reject(new Error("进程树清理超时")); }, 5000);
			child.on("error", error => { clearTimeout(timer); reject(error); });
			child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`进程树清理失败 (taskkill ${code})`)); });
		});
	} else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
}
export async function runProcess(command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; stdin?: string }) {
	options.signal?.throwIfAborted();
	return new Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; cleanupError?: string }>((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		if (options.stdin !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(options.stdin); }
		let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let truncated = false; let timedOut = false; let killing: Promise<void> | undefined;
		let cleanupError: string | undefined;
		const stop = () => { if (child.pid) killing ??= killTree(child.pid).catch(error => {
			cleanupError = String(error); child.kill("SIGKILL");
			// Do not wait forever on pipes inherited by a descendant when OS cleanup failed.
			child.stdout!.destroy(); child.stderr!.destroy();
		}); };
		const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
		options.signal?.addEventListener("abort", stop, { once: true });
		if (options.signal?.aborted) stop();
		const take = (previous: Buffer, data: Buffer) => { if (previous.length + data.length > 1024 * 1024) truncated = true; return Buffer.concat([previous, data.subarray(0, Math.max(0, 1024 * 1024 - previous.length))]); };
		child.stdout!.on("data", b => { stdout = take(stdout, b); }); child.stderr!.on("data", b => { stderr = take(stderr, b); });
		const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", stop); };
		child.on("error", error => { cleanup(); reject(error); });
		child.on("close", async code => { cleanup(); await killing; resolve({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated, timedOut, cleanupError }); });
	});
}
