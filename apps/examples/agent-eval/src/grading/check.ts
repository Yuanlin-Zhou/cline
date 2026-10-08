import { readEvidence } from "./evidence.js";
import { checkBehavior, compare } from "./behavior.js";
import type { Rule, EvidenceManifest, EvidenceEvent } from "./types.js";

export async function checkRule(rule: Rule, input: { directory: string; evidence: EvidenceManifest; events: EvidenceEvent[] }) {
	const evidenceRefs: string[] = input.evidence.refs.filter(r => r.label === "文件清单").map(r => r.id);
	if (rule.kind.startsWith("tool.")) {
		const result = checkBehavior(rule, input.events, input.evidence.capabilities, input.evidence.eventsComplete);
		return { ...result, evidenceRefs: input.evidence.refs.filter(r => r.label === "事件轨迹").map(r => r.id) };
	}
	if (!("path" in rule)) throw new Error("非内置规则");
	const name = rule.path.replaceAll("\\", "/"); const file = input.evidence.artifacts.find(f => f.path === name); const before = input.evidence.baseline.find(f => f.path === name);
	if (file) evidenceRefs.push(file.ref); if (before) evidenceRefs.push(before.ref);
	if (!input.evidence.complete) return { status: "insufficient" as const, message: "文件快照不完整", actual: input.evidence.issues, evidenceRefs };
	let passed = false; let actual: unknown = { exists: Boolean(file) };
	if (rule.kind === "file.exists") passed = Boolean(file);
	if (rule.kind === "file.absent") passed = !file;
	if (rule.kind === "file.unchanged") { passed = !!file && !!before && file.sha256 === before.sha256; actual = { before: before?.sha256, after: file?.sha256 }; }
	if (file) {
		const ref = input.evidence.refs.find(r => r.id === file.ref); if (!ref) throw new Error("文件证据引用缺失");
		// Integrity is checked even for exists/unchanged assertions.
		const bytes = await readEvidence(input.directory, ref, rule.kind === "file.text" || rule.kind === "file.json" ? 1024 * 1024 : 100 * 1024 * 1024);
		if (rule.kind === "file.text" || rule.kind === "file.json") {
			let text: string;
			try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { status: "fail" as const, message: "文件不是有效 UTF-8", actual: null, evidenceRefs }; }
			if (rule.kind === "file.text") { passed = rule.op === "contains" ? text.includes(rule.expected) : rule.op === "notContains" ? !text.includes(rule.expected) : new RegExp(rule.expected, "u").test(text); actual = text.slice(0, 4000) + (text.length > 4000 ? "…（预览截断，判分使用完整文本）" : ""); }
			else {
				let value: unknown; try { value = JSON.parse(text); } catch { return { status: "fail" as const, message: "文件不是有效 JSON", actual: null, evidenceRefs }; }
				({ passed, actual } = compare(value, rule));
			}
		}
	}
	return { status: passed ? "pass" as const : "fail" as const, actual, message: passed ? "结果验收满足" : "结果验收未满足", evidenceRefs };
}
