import type { Comparison, GradingConfig, Rule, ToolMatch } from "./types.js";

function object(value: unknown, at: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at}: 必须是对象`);
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], at: string) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${at}.${key}: 未知字段`);
}
function string(value: unknown, at: string): asserts value is string {
	if (typeof value !== "string" || !value.length || value.length > 4096) throw new Error(`${at}: 须为 1–4096 字符的字符串`);
}
function boolean(value: unknown, at: string) { if (value !== undefined && typeof value !== "boolean") throw new Error(`${at}: 必须为布尔值`); }
function number(value: unknown, at: string, integer = false) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) throw new Error(`${at}: 必须为非负${integer ? "整数" : "数值"}`);
}
export function safeRelative(value: string) {
	return !!value && !/^[a-z]:|^[\\/]|[:\x00-\x1f]/i.test(value) && !value.split(/[\\/]/).some(part => !part || part === "." || part === "..");
}
function comparison(value: unknown, at: string): Comparison {
	const c = object(value, at); keys(c, ["pointer", "op", "expected", "absTolerance", "relTolerance"], at);
	if (typeof c.pointer !== "string" || (c.pointer !== "" && (!c.pointer.startsWith("/") || /~(?![01])/u.test(c.pointer)))) throw new Error(`${at}.pointer: 无效 JSON Pointer`);
	if (!["exists", "equals", "contains", "matches", "approx"].includes(String(c.op))) throw new Error(`${at}.op: 无效比较方式`);
	if (c.op !== "exists" && !("expected" in c)) throw new Error(`${at}.expected: 必填`);
	if (c.op === "matches") { string(c.expected, `${at}.expected`); new RegExp(c.expected, "u"); }
	if (c.op === "approx") {
		if (typeof c.expected !== "number" || !Number.isFinite(c.expected)) throw new Error(`${at}.expected: 须为有限数值`);
		if (c.absTolerance === undefined && c.relTolerance === undefined) throw new Error(`${at}: 须设置数值容差`);
	}
	for (const key of ["absTolerance", "relTolerance"]) if (c[key] !== undefined) {
		if (c.op !== "approx") throw new Error(`${at}.${key}: 仅适用于 approx`);
		number(c[key], `${at}.${key}`);
	}
	return c as Comparison;
}
function match(value: unknown, at: string): ToolMatch {
	const m = object(value, at); keys(m, ["name", "phase", "outcome", "parameters"], at); string(m.name, `${at}.name`);
	if (!["requested", "started", "completed"].includes(String(m.phase))) throw new Error(`${at}.phase: 必须指定 requested/started/completed`);
	if (m.outcome !== undefined && (m.phase !== "completed" || !["success", "error"].includes(String(m.outcome)))) throw new Error(`${at}.outcome: 仅 completed 支持 success/error`);
	if (m.parameters !== undefined) comparison(m.parameters, `${at}.parameters`);
	return m as ToolMatch;
}
export function parseGrading(value: unknown, at = "grading", replayMode = "full-task"): GradingConfig | undefined {
	if (value === undefined) return;
	const config = object(value, at); keys(config, ["version", "rules"], at);
	if (config.version !== 1) throw new Error(`${at}.version: 必须为 1`);
	if (!Array.isArray(config.rules) || !config.rules.length || config.rules.length > 100) throw new Error(`${at}.rules: 须为 1–100 条规则`);
	const ids = new Set<string>();
	for (const [index, value] of config.rules.entries()) {
		const p = `${at}.rules[${index}]`; const r = object(value, p);
		string(r.id, `${p}.id`);
		if (!/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) || ids.has(r.id) || r.id.startsWith("legacy-")) throw new Error(`${p}.id: ID 无效、重复或使用保留前缀 legacy-`);
		ids.add(r.id); boolean(r.required, `${p}.required`); if (r.label !== undefined) string(r.label, `${p}.label`);
		const fields: Record<string, string[]> = {
			"file.exists": ["path"], "file.absent": ["path"], "file.unchanged": ["path"],
			"file.text": ["path", "op", "expected"], "file.json": ["path", "pointer", "op", "expected", "absTolerance", "relTolerance"],
			command: ["verifierId", "expectedExitCode"], script: ["verifierId", "params", "required_inputs", "require_complete"],
			"tool.count": ["match", "min", "max"], "tool.parameters": ["match", "check"],
			"tool.order": ["before", "after", "requireAfter"], "tool.approval": ["match"],
		};
		if (typeof r.kind !== "string" || !Object.hasOwn(fields, r.kind)) throw new Error(`${p}.kind: 不支持的规则`);
		keys(r, ["id", "kind", "required", "label", ...fields[r.kind]], p);
		if (r.kind.startsWith("file.")) { string(r.path, `${p}.path`); if (!safeRelative(r.path)) throw new Error(`${p}.path: 必须为工作区内的相对文件路径`); }
		if (r.kind === "file.text") {
			if (!["contains", "notContains", "matches"].includes(String(r.op))) throw new Error(`${p}.op: 无效文本规则`);
			string(r.expected, `${p}.expected`); if (r.op === "matches") new RegExp(r.expected, "u");
		}
		if (r.kind === "file.json") comparison(Object.fromEntries(Object.entries(r).filter(([k]) => !["id", "kind", "required", "label", "path"].includes(k))), p);
		if (r.kind === "command" || r.kind === "script") { string(r.verifierId, `${p}.verifierId`); if (r.kind === "command") number(r.expectedExitCode, `${p}.expectedExitCode`, true); }
		if (r.kind === "script") {
			if (r.params !== undefined) { object(r.params, `${p}.params`); if (JSON.stringify(r.params).length > 65536) throw new Error(`${p}.params: 参数超过64KiB`); }
			for (const key of ["required_inputs", "require_complete"]) if (r[key] !== undefined && (!Array.isArray(r[key]) || r[key].some(v => !["execution", "conversation", "artifacts", "baseline", "diagnostics"].includes(String(v))) || new Set(r[key]).size !== r[key].length)) throw new Error(`${p}.${key}: 须为不重复的输入数据名称数组`);
		}
		if (r.kind.startsWith("tool.") && r.kind !== "tool.order") match(r.match, `${p}.match`);
		if (r.kind === "tool.approval" && (r.match as ToolMatch).phase !== "started") throw new Error(`${p}.match.phase: 审批规则须使用 started`);
		if (r.kind === "tool.parameters") comparison(r.check, `${p}.check`);
		if (r.kind === "tool.count") {
			if (r.min === undefined && r.max === undefined) throw new Error(`${p}: 须设置 min 或 max`);
			if (r.min !== undefined) number(r.min, `${p}.min`, true); if (r.max !== undefined) number(r.max, `${p}.max`, true);
			if (Number(r.min ?? 0) > Number(r.max ?? Infinity)) throw new Error(`${p}: min 不能大于 max`);
		}
		if (r.kind === "tool.order") {
			const before = match(r.before, `${p}.before`); const after = match(r.after, `${p}.after`); boolean(r.requireAfter, `${p}.requireAfter`);
			if (before.phase !== "completed" || after.phase !== "started") throw new Error(`${p}: 顺序须为 completed → started`);
		}
		if (replayMode !== "full-task" && r.required !== false && r.kind !== "script") throw new Error(`${p}: 产物及行为验收须使用 full-task 完整任务模式`);
	}
	if (!config.rules.some(r => (r as Rule).required !== false)) throw new Error(`${at}: 至少需要一条必要规则`);
	return structuredClone(config) as GradingConfig;
}
