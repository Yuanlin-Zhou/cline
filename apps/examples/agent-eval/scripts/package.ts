import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(projectRoot, "../../..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const releaseRoot = path.join(projectRoot, "release", stamp);
const packageRoot = path.join(releaseRoot, "package");
const vendor = path.join(packageRoot, "vendor");

async function pack(cwd: string, destination: string): Promise<void> {
	const result = Bun.spawn(
		[
			process.execPath,
			"pm",
			"pack",
			"--ignore-scripts",
			"--quiet",
			"--destination",
			destination,
		],
		{ cwd, stdout: "inherit", stderr: "inherit" },
	);
	if ((await result.exited) !== 0) throw new Error(`Packing failed: ${cwd}`);
}

await stat(path.join(projectRoot, "dist/index.js"));
await mkdir(vendor, { recursive: true });
await cp(path.join(projectRoot, "dist"), path.join(packageRoot, "dist"), {
	recursive: true,
});
await cp(
	path.join(projectRoot, "examples"),
	path.join(packageRoot, "examples"),
	{ recursive: true },
);
await cp(
	path.join(projectRoot, "README.release.md"),
	path.join(packageRoot, "README.md"),
);
await cp(path.join(repoRoot, "LICENSE"), path.join(packageRoot, "LICENSE"));

const overrides: Record<string, string> = {};
for (const name of ["shared", "llms", "agents", "core", "sdk"]) {
	const sdkRoot = path.join(repoRoot, "sdk/packages", name);
	const manifest = JSON.parse(
		await readFile(path.join(sdkRoot, "package.json"), "utf8"),
	);
	await stat(path.join(sdkRoot, "dist/index.js"));
	await pack(sdkRoot, vendor);
	overrides[manifest.name] =
		`file:vendor/cline-${name}-${manifest.version}.tgz`;
}

const examplePath = path.join(packageRoot, "examples/basic.json");
const example = JSON.parse(await readFile(examplePath, "utf8"));
example.defaults.cwd = ".";
await writeFile(examplePath, `${JSON.stringify(example, null, 2)}\n`);
await writeFile(
	path.join(packageRoot, "package.json"),
	`${JSON.stringify(
		{
			name: "cline-agent-eval",
			version: "0.0.0",
			private: true,
			type: "module",
			packageManager: "bun@1.3.13",
			engines: { node: ">=22", bun: "1.3.13" },
			workspaces: [],
			scripts: { start: "bun dist/index.js", eval: "bun dist/index.js" },
			dependencies: { "@cline/sdk": overrides["@cline/sdk"] },
			overrides,
			files: ["dist", "examples", "vendor", "README.md", "LICENSE"],
		},
		null,
		2,
	)}\n`,
);
await pack(packageRoot, releaseRoot);
console.log(`Release directory: ${releaseRoot}`);
