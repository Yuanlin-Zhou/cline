import { createHash, randomUUID } from "node:crypto";
import type { UploadedVerifier } from "../../contracts/verifiers.js";
import { CatalogError } from "../catalog/repository.js";

export const SCRIPT_LIMIT = 1024 * 1024;
export type { UploadedVerifier } from "../../contracts/verifiers.js";
export interface VerifierRepository {
	list(): Promise<UploadedVerifier[]>;
	get(id: string): Promise<UploadedVerifier | undefined>;
	create(input: unknown): Promise<UploadedVerifier>;
	update(
		id: string,
		expectedToken: string,
		input: unknown,
	): Promise<UploadedVerifier>;
	delete(id: string, expectedToken: string): Promise<void>;
}
export const contentHash = (content: string) =>
	createHash("sha256").update(content).digest("hex");
export function parseUpload(input: unknown): UploadedVerifier {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new CatalogError("缺少验证脚本");
	const v = input as Record<string, unknown>;
	if (Object.keys(v).some((k) => !["filename", "content", "label"].includes(k)))
		throw new CatalogError("上传脚本包含未知字段");
	if (
		typeof v.filename !== "string" ||
		!v.filename.trim() ||
		v.filename.length > 160 ||
		/[\\/\x00-\x1f]/.test(v.filename)
	)
		throw new CatalogError("文件名须为 1–160 个字符，不能包含路径");
	const extension = v.filename.slice(v.filename.lastIndexOf("."));
	if (![".js", ".mjs", ".ts", ".py"].includes(extension))
		throw new CatalogError("支持 .py、.js、.mjs、.ts 单文件脚本");
	if (
		typeof v.content !== "string" ||
		!v.content.trim() ||
		v.content.includes("\0") ||
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
			v.content,
		)
	)
		throw new CatalogError("脚本须为非空 UTF-8 文本");
	if (Buffer.byteLength(v.content) > SCRIPT_LIMIT)
		throw new CatalogError("脚本不能超过 1 MiB", 413);
	if (
		v.label !== undefined &&
		(typeof v.label !== "string" || !v.label.trim() || v.label.length > 80)
	)
		throw new CatalogError("显示名称须为 1–80 个字符");
	const hash = contentHash(v.content);
	return {
		id: `uploaded-${randomUUID()}`,
		schemaVersion: 1,
		label: (v.label as string | undefined)?.trim() ?? v.filename.slice(0, 80),
		filename: v.filename,
		extension: extension as UploadedVerifier["extension"],
		content: v.content,
		version: hash,
		sha256: hash,
		timeoutMs: 60000,
		createdAt: new Date().toISOString(),
		...(extension === ".py"
			? {
					runtime: "python" as const,
					entrypoint: "verify" as const,
					contractVersion: 2 as const,
				}
			: {}),
	};
}
export function validateUploaded(value: UploadedVerifier): UploadedVerifier {
	try {
		const parsed = parseUpload({
			filename: value.filename,
			content: value.content,
			label: value.label,
		});
		if (
			!/^uploaded-[0-9a-f-]{36}$/.test(value.id) ||
			value.schemaVersion !== 1 ||
			value.extension !== parsed.extension ||
			value.sha256 !== parsed.sha256 ||
			value.version !== parsed.version ||
			value.timeoutMs !== 60000 ||
			!Number.isFinite(Date.parse(value.createdAt))
		)
			throw new Error();
		if (
			value.extension === ".py"
				? value.runtime !== "python" ||
					value.entrypoint !== "verify" ||
					value.contractVersion !== 2
				: (value.runtime !== undefined && value.runtime !== "bun") ||
					(value.contractVersion !== undefined && value.contractVersion !== 1)
		)
			throw new Error();
		return value;
	} catch {
		throw new CatalogError("上传脚本文档或内容摘要无效", 422);
	}
}
export const verifierToken = (v: UploadedVerifier) =>
	contentHash(
		JSON.stringify([
			v.id,
			v.createdAt,
			v.label,
			v.filename,
			v.content,
			v.version,
			v.pythonEnvironment,
		]),
	);
export function editable(
	v: UploadedVerifier | undefined,
	expected: string,
): UploadedVerifier {
	if (!v) throw new CatalogError("验证脚本不存在或已删除", 404);
	if (v.extension !== ".py")
		throw new CatalogError("仅支持管理用户上传的 Python 脚本", 403);
	if (typeof expected !== "string" || verifierToken(v) !== expected)
		throw new CatalogError("脚本已被其他页面修改，请重新打开后重试", 409);
	return v;
}
export function replacement(previous: UploadedVerifier, input: unknown) {
	const next = parseUpload(input);
	if (next.extension !== ".py") throw new CatalogError("文件须为 .py 脚本");
	return { ...next, id: previous.id, createdAt: previous.createdAt };
}
export const publicUploaded = (v: UploadedVerifier) => ({
	id: v.id,
	label: v.label,
	version: v.version.slice(0, 12),
	sha256: v.sha256,
	timeoutMs: v.timeoutMs,
	dependencies: [v.filename],
	source: "uploaded",
	runtime: v.runtime ?? "bun",
	contractVersion: v.contractVersion ?? 1,
	filename: v.filename,
	createdAt: v.createdAt,
});
