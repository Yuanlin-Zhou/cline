import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultDataDirectory } from "./paths.js";

test("repository relocation keeps the actual legacy data directory; standalone releases use their own directory", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "eval-path-compat-"));
	try {
		const application = path.join(directory, "apps/agent-eval");
		const legacy = path.join(directory, "apps/examples");
		await mkdir(application, { recursive: true });
		expect(defaultDataDirectory(application)).toBe(
			path.join(application, ".eval-data"),
		);
		await mkdir(path.join(directory, "sdk/packages/sdk"), { recursive: true });
		await writeFile(
			path.join(directory, "sdk/packages/sdk/package.json"),
			"{}",
		);
		await mkdir(path.join(legacy, "agent-eval"), { recursive: true });
		await writeFile(path.join(legacy, "agent-eval/package.json"), "{}");
		expect(defaultDataDirectory(application)).toBe(
			path.join(legacy, ".eval-data"),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
