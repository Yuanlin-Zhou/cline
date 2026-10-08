import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const ignored = new Set([".git", "node_modules", ".cline", ".eval-data"]);
export type FileRecord = { path: string; hash: string; size: number; text?: string };
export function within(root: string, target: string) {
	const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export async function inventory(root: string): Promise<FileRecord[]> {
	const files: FileRecord[] = [];
	async function walk(directory: string) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) await walk(absolute);
			else if (entry.isFile()) {
				if (files.length >= 5000) throw new Error("工作区超过 5000 个文件，请使用精简的案例 fixture");
				const stat = await lstat(absolute);
				if (stat.size > 10 * 1024 * 1024) { files.push({ path: path.relative(root, absolute), hash: `large:${stat.size}:${stat.mtimeMs}`, size: stat.size }); continue; }
				const bytes = await readFile(absolute);
				files.push({ path: path.relative(root, absolute), hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, text: bytes.length <= 128 * 1024 && !bytes.includes(0) ? bytes.toString("utf8") : undefined });
			}
		}
	}
	await walk(root); return files;
}
export async function prepareWorkspace(directory: string, source?: string): Promise<string> {
	const destination = path.join(directory, "workspace"); await mkdir(destination, { recursive: true });
	if (source) {
		const root = await realpath(path.resolve(source));
		if (within(root, path.resolve(directory)) || within(path.resolve(directory), root)) throw new Error("fixture 与运行目录不能相互包含，请选择独立的案例目录");
		if (!(await lstat(root)).isDirectory()) throw new Error("fixture 必须是目录");
		let count = 0;
		await cp(root, destination, { recursive: true, filter: async (file) => {
			if (file !== root && ignored.has(path.basename(file))) return false;
			if (++count > 10000) throw new Error("fixture 太大，请限制在 10000 个目录/文件以内");
			if ((await lstat(file)).isSymbolicLink()) throw new Error("fixture 包含符号链接，请改用普通文件以保证工作区隔离");
			return true;
		} });
	}
	await writeFile(path.join(directory, "baseline.json"), JSON.stringify(await inventory(destination)));
	return destination;
}
export async function artifacts(directory: string) {
	const root = path.join(directory, "workspace");
	const before: FileRecord[] = JSON.parse(await readFile(path.join(directory, "baseline.json"), "utf8"));
	const after = await inventory(root); const originals = new Map(before.map(f => [f.path, f])); const current = new Map(after.map(f => [f.path, f]));
	return [...new Set([...originals.keys(), ...current.keys()])].sort().map(name => {
		const a = originals.get(name); const b = current.get(name);
		return { path: name, change: !a ? "added" : !b ? "deleted" : a.hash === b.hash ? "unchanged" : "modified", size: b?.size ?? a?.size ?? 0 };
	});
}
export async function artifactText(directory: string, name: string) {
	const root = await realpath(path.join(directory, "workspace"));
	const target = path.resolve(root, name);
	if (!within(root, target)) throw new Error("文件路径无效");
	const before: FileRecord[] = JSON.parse(await readFile(path.join(directory, "baseline.json"), "utf8"));
	let after: string | undefined;
	try {
		const resolved = await realpath(target); if (!within(root, resolved)) throw new Error("不能读取工作区外的文件");
		const stat = await lstat(resolved); if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("仅预览 128 KB 以内的文本文件");
		const bytes = await readFile(resolved); if (bytes.includes(0)) throw new Error("二进制文件无法文本预览"); after = bytes.toString("utf8");
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	return { before: before.find(f => f.path === path.relative(root, target))?.text, after };
}
