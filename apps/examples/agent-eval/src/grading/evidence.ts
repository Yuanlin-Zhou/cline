import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, lstat, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { safeRelative } from "./schema.js";
import type { EvidenceManifest, EvidenceRef, FileEvidence } from "./types.js";

export const CAPABILITIES = { requested: false, started: false, completed: false, approval: false };
export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export async function hashFile(file: string) {
	const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export function manifest(): EvidenceManifest {
	return { version: 1, complete: true, eventsComplete: false, capabilities: { ...CAPABILITIES }, issues: [], environment: { platform: process.platform, arch: process.arch, node: process.versions.node, bun: process.versions.bun, graderVersion: "1" }, baseline: [], artifacts: [], refs: [], createdAt: new Date().toISOString() };
}
export function redact(text: string, secrets: string[]) { for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]"); return text; }
export function redactValue<T>(value: T, secrets: string[]): T {
	if (typeof value === "string") return redact(value, secrets) as T;
	if (Array.isArray(value)) return value.map(v => redactValue(v, secrets)) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secrets), redactValue(v, secrets)])) as T;
	return value;
}
export async function saveEvidence(directory: string, data: string | Uint8Array, label: string, refs: EvidenceRef[]) {
	const id = randomUUID(); const file = `evidence/blobs/${id}`;
	await mkdir(path.join(directory, "evidence/blobs"), { recursive: true });
	await writeFile(path.join(directory, file), data);
	refs.push({ id, label, path: file, size: Buffer.byteLength(data), sha256: sha256(data) }); return id;
}
export async function readEvidence(directory: string, ref: EvidenceRef, maxBytes = 1024 * 1024) {
	if (!safeRelative(ref.path)) throw new Error("证据路径无效");
	const root = await realpath(directory); const target = await realpath(path.join(root, ref.path));
	const relative = path.relative(root, target); if (!safeRelative(relative)) throw new Error("证据路径越界");
	const stat = await lstat(target); if (!stat.isFile() || stat.size > maxBytes) throw new Error(`证据超过 ${maxBytes} 字节读取限制`);
	const bytes = await readFile(target); if (sha256(bytes) !== ref.sha256) throw new Error("证据摘要不一致，可能已修改"); return bytes;
}
// Snapshot limits are explicit. Missing evidence never becomes evidence of absence.
export async function snapshot(workspace: string, directory: string, output: "baseline" | "artifacts", evidence: EvidenceManifest, secrets: string[]) {
	const files: FileEvidence[] = []; let total = 0;
	const ignored = new Set([".git", "node_modules", ".cline", ".eval-data"]);
	async function walk(folder: string) {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			const absolute = path.join(folder, entry.name); const name = path.relative(workspace, absolute).replaceAll("\\", "/");
			if (secrets.some(secret => secret && name.includes(secret))) throw new Error("文件路径含凭据，未归档");
			if (entry.isSymbolicLink()) throw new Error(`证据包含符号链接：${name}`);
			if (ignored.has(entry.name)) continue;
			if (entry.isDirectory()) { await walk(absolute); continue; }
			if (!entry.isFile()) throw new Error(`不支持的文件类型：${name}`);
			const stat = await lstat(absolute);
			if (files.length >= 5000 || total + stat.size > 100 * 1024 * 1024) throw new Error("归档超过 5000 文件或 100 MiB 限额");
			total += stat.size;
			const bytes = await readFile(absolute);
			if (secrets.some(secret => secret && bytes.includes(Buffer.from(secret)))) throw new Error(`文件含凭据，未归档：${name}`);
			const ref = await saveEvidence(directory, bytes, `${output}/${name}`, evidence.refs);
			files.push({ path: name, sha256: sha256(bytes), size: bytes.length, ref });
		}
	}
	try { await walk(workspace); } catch (error) { evidence.complete = false; evidence.issues.push(String(error)); }
	evidence[output] = files;
}

export async function materialize(directory: string, destination: string, evidence: EvidenceManifest) {
	if (!evidence.complete) throw new Error("产物快照不完整，不能运行验收命令");
	for (const file of evidence.artifacts) {
		if (!safeRelative(file.path)) throw new Error("产物路径无效");
		const ref = evidence.refs.find(r => r.id === file.ref); if (!ref) throw new Error("缺少文件证据引用");
		const bytes = await readEvidence(directory, ref, 100 * 1024 * 1024);
		const target = path.join(destination, file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
	}
}
