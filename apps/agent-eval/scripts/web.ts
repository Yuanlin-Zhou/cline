import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/web/index.html", import.meta.url);
async function changed(directory: URL, since: number): Promise<boolean> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = new URL(
			entry.name + (entry.isDirectory() ? "/" : ""),
			directory,
		);
		if (
			entry.isDirectory()
				? await changed(file, since)
				: (await stat(file)).mtimeMs > since
		)
			return true;
	}
	return false;
}
const needsBuild =
	!existsSync(output) ||
	(await changed(
		new URL("../web/src/", import.meta.url),
		(
			await stat(output)
		).mtimeMs,
	)) ||
	(await changed(
		new URL("../src/", import.meta.url),
		(
			await stat(output)
		).mtimeMs,
	)) ||
	(await stat(new URL("../web/vite.config.ts", import.meta.url))).mtimeMs >
		(await stat(output)).mtimeMs ||
	(await stat(new URL("../web/index.html", import.meta.url))).mtimeMs >
		(await stat(output)).mtimeMs;
if (needsBuild) {
	const build = Bun.spawn([process.execPath, "run", "build:web"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await build.exited) !== 0) process.exit(1);
}
const { createEvalServer } = await import("../src/api/server.js");
const app = await createEvalServer();
console.log(
	`Agent Eval → http://127.0.0.1:${app.server.port}\nData: ${app.store.directory}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		void app.close().then(() => process.exit(0));
	});
