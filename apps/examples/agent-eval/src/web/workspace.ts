import type { WorkspaceConfig, WorkspaceInfo } from "../workspace-config.js";
import { readEvidence } from "../grading/evidence.js";
import type { EvidenceManifest } from "../grading/types.js";
import { createHash, randomUUID } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

const ignored = new Set([".git", "node_modules", ".cline", ".eval-data"]);
export type FileRecord = {
	path: string;
	hash: string;
	size: number;
	text?: string;
};
export function within(root: string, target: string) {
	const relative = path.relative(root, target);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}
export async function inventory(root: string): Promise<FileRecord[]> {
	const files: FileRecord[] = [];
	async function walk(directory: string) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) await walk(absolute);
			else if (entry.isFile()) {
				if (files.length >= 5000)
					throw new Error("工作区超过 5000 个文件，请使用精简的案例 fixture");
				const stat = await lstat(absolute);
				if (stat.size > 10 * 1024 * 1024) {
					files.push({
						path: path.relative(root, absolute),
						hash: `large:${stat.size}:${stat.mtimeMs}`,
						size: stat.size,
					});
					continue;
				}
				const bytes = await readFile(absolute);
				files.push({
					path: path.relative(root, absolute),
					hash: createHash("sha256").update(bytes).digest("hex"),
					size: bytes.length,
					text:
						bytes.length <= 128 * 1024 && !bytes.includes(0)
							? bytes.toString("utf8")
							: undefined,
				});
			}
		}
	}
	await walk(root);
	return files;
}
export async function prepareWorkspace(
	directory: string,
	source?: string,
	destination = path.join(directory, "workspace"),
): Promise<string> {
	const root = source ? await realpath(path.resolve(source)) : undefined;
	const candidate = await prospective(path.resolve(destination));
	const data = await prospective(path.resolve(directory));
	if (
		root &&
		(within(root, data) ||
			within(data, root) ||
			within(root, candidate) ||
			within(candidate, root))
	)
		throw new Error(
			"fixture、运行目录与副本目录不能相互包含，请选择独立的案例目录",
		);
	if (root && !(await lstat(root)).isDirectory())
		throw new Error("fixture 必须是目录");
	await mkdir(destination, { recursive: true });
	if (root) {
		let count = 0;
		await cp(root, destination, {
			recursive: true,
			filter: async (file) => {
				if (file !== root && ignored.has(path.basename(file))) return false;
				if (++count > 10000)
					throw new Error("fixture 太大，请限制在 10000 个目录/文件以内");
				if ((await lstat(file)).isSymbolicLink())
					throw new Error(
						"fixture 包含符号链接，请改用普通文件以保证工作区隔离",
					);
				return true;
			},
		});
	}
	await writeFile(
		path.join(directory, "baseline.json"),
		JSON.stringify(await inventory(destination)),
	);
	return destination;
}
export async function artifacts(directory: string) {
	const root = path.join(directory, "workspace");
	const before: FileRecord[] = JSON.parse(
		await readFile(path.join(directory, "baseline.json"), "utf8"),
	);
	const after = await inventory(root);
	const originals = new Map(before.map((f) => [f.path, f]));
	const current = new Map(after.map((f) => [f.path, f]));
	return [...new Set([...originals.keys(), ...current.keys()])]
		.sort()
		.map((name) => {
			const a = originals.get(name);
			const b = current.get(name);
			return {
				path: name,
				change: !a
					? "added"
					: !b
						? "deleted"
						: a.hash === b.hash
							? "unchanged"
							: "modified",
				size: b?.size ?? a?.size ?? 0,
			};
		});
}
export async function artifactText(directory: string, name: string) {
	const root = await realpath(path.join(directory, "workspace"));
	const target = path.resolve(root, name);
	if (!within(root, target)) throw new Error("文件路径无效");
	const before: FileRecord[] = JSON.parse(
		await readFile(path.join(directory, "baseline.json"), "utf8"),
	);
	let after: string | undefined;
	try {
		const resolved = await realpath(target);
		if (!within(root, resolved)) throw new Error("不能读取工作区外的文件");
		const stat = await lstat(resolved);
		if (!stat.isFile() || stat.size > 128 * 1024)
			throw new Error("仅预览 128 KB 以内的文本文件");
		const bytes = await readFile(resolved);
		if (bytes.includes(0)) throw new Error("二进制文件无法文本预览");
		after = bytes.toString("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return {
		before: before.find((f) => f.path === path.relative(root, target))?.text,
		after,
	};
}

export async function directWorkspace(
	source: string | undefined,
	directory: string,
) {
	if (!source) throw Error("直接执行必须填写执行目录 cwd");
	let root: string;
	try {
		root = await realpath(path.resolve(source));
	} catch {
		throw Error(`执行目录不存在或无法访问：${source}`);
	}
	if (!(await lstat(root)).isDirectory())
		throw Error("执行目录必须是已存在的目录");
	const data = await prospective(path.resolve(directory));
	if (within(root, data) || within(data, root))
		throw Error(
			"执行目录与运行数据目录不能相互包含，请将 EVAL_DATA_DIR 放在工作区外",
		);
	return root;
}
async function prospective(file: string): Promise<string> {
	try {
		return await realpath(file);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		const parent = path.dirname(file);
		if (parent === file) throw e;
		return path.join(await prospective(parent), path.basename(file));
	}
}
export async function prepareExecutionWorkspace(
	directory: string,
	source: string | undefined,
	config: WorkspaceConfig = { mode: "copy" },
): Promise<WorkspaceInfo> {
	let target: string;
	if (config.mode === "direct") {
		target = await directWorkspace(source, directory);
		await writeFile(
			path.join(directory, "baseline.json"),
			JSON.stringify(await inventory(target)),
		);
	} else if (config.copyRoot) {
		const root = await prospective(path.resolve(config.copyRoot));
		const from = source ? await realpath(path.resolve(source)) : undefined;
		const data = await prospective(path.resolve(directory));
		target = path.join(
			root,
			`${path.basename(path.dirname(directory))}-${path.basename(directory)}-${randomUUID()}`,
		);
		if (from && (within(from, target) || within(target, from)))
			throw Error("副本目录与初始工作区不能相互包含");
		if (within(target, data) || within(data, target))
			throw Error("副本目录与本次运行数据目录不能相互包含");
		await mkdir(root, { recursive: true });
		await mkdir(target);
		await prepareWorkspace(directory, source, target);
	} else target = await prepareWorkspace(directory, source);
	const info: WorkspaceInfo = {
		mode: config.mode,
		source: source ? await realpath(path.resolve(source)) : undefined,
		path: target,
		directory: path.resolve(directory),
	};
	await writeFile(
		path.join(directory, "workspace.json"),
		JSON.stringify(info, null, 2),
	);
	return info;
}
export async function archivedArtifacts(
	directory: string,
	evidence: EvidenceManifest,
) {
	const before = new Map(evidence.baseline.map((f) => [f.path, f]));
	const after = new Map(evidence.artifacts.map((f) => [f.path, f]));
	return [...new Set([...before.keys(), ...after.keys()])]
		.sort()
		.map((name) => {
			const a = before.get(name),
				b = after.get(name);
			return {
				path: name,
				change: !a
					? "added"
					: !b
						? "deleted"
						: a.sha256 === b.sha256
							? "unchanged"
							: "modified",
				size: b?.size ?? a?.size ?? 0,
			};
		});
}
export async function archivedArtifactText(
	directory: string,
	evidence: EvidenceManifest,
	name: string,
) {
	if (
		!name ||
		name.includes("\\") ||
		path.isAbsolute(name) ||
		name.split("/").some((p) => !p || p === ".." || p === ".")
	)
		throw Error("文件路径无效");
	const get = async (kind: "baseline" | "artifacts") => {
		const file = evidence[kind].find((f) => f.path === name);
		if (!file) return undefined;
		if (file.size > 128 * 1024) throw Error("仅预览 128 KB 以内的文本文件");
		const ref = evidence.refs.find((r) => r.id === file.ref);
		if (!ref) throw Error("归档文件引用缺失");
		const bytes = await readEvidence(directory, ref, 128 * 1024);
		if (bytes.includes(0)) throw Error("二进制文件无法文本预览");
		return bytes.toString("utf8");
	};
	return { before: await get("baseline"), after: await get("artifacts") };
}
