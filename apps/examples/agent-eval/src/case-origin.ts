export type BadCase = { observedOutput: string; outputFormat?: "text" | "json"; reason?: string };
export type ImportSource = { platform: string; taskId: string; turnId: string; url?: string };
const object = (value: unknown, path: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${path} 须为对象`);
	return value as Record<string, unknown>;
};
function text(value: unknown, path: string, limit: number, bytes = false): string {
	if (typeof value !== "string" || !value.trim() || (bytes ? new TextEncoder().encode(value).length : [...value].length) > limit) throw Error(`${path} 须为非空文本，长度不能超过 ${limit}${bytes ? " 字节" : " 字符"}`);
	return value;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string) {
	if (Object.keys(value).some(key => !allowed.includes(key))) throw Error(`${path} 包含未知字段`);
}
export function parseBadCase(value: unknown): BadCase | undefined {
	if (value === undefined) return;
	const v = object(value, "badCase"); keys(v, ["observedOutput", "outputFormat", "reason"], "badCase");
	const observedOutput = text(v.observedOutput, "badCase.observedOutput", 1048576, true);
	const outputFormat = v.outputFormat ?? "text";
	if (outputFormat !== "text" && outputFormat !== "json") throw Error("badCase.outputFormat 须为 text 或 json");
	if (outputFormat === "json") { try { JSON.parse(observedOutput); } catch { throw Error("badCase.observedOutput 不是有效 JSON"); } }
	return { observedOutput, outputFormat, ...(v.reason !== undefined ? { reason: text(v.reason, "badCase.reason", 16384, true) } : {}) };
}
export function parseImportSource(value: unknown): ImportSource | undefined {
	if (value === undefined) return;
	const v = object(value, "importSource"); keys(v, ["platform", "taskId", "turnId", "url"], "importSource");
	const result: ImportSource = { platform: text(v.platform, "importSource.platform", 256), taskId: text(v.taskId, "importSource.taskId", 256), turnId: text(v.turnId, "importSource.turnId", 256) };
	if (v.url !== undefined) {
		result.url = text(v.url, "importSource.url", 2048);
		try { if (!/^https?:\/\//i.test(result.url) || !["http:", "https:"].includes(new URL(result.url).protocol)) throw Error(); } catch { throw Error("importSource.url 须为 http/https 地址"); }
	}
	return result;
}
