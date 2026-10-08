import { isDeepStrictEqual } from "node:util";
import type { Capabilities, Comparison, EvidenceEvent, Rule, ToolMatch } from "./types.js";

export function compare(input: unknown, check: Comparison): { passed: boolean; actual: unknown } {
	let value = input; let found = true;
	for (const key of check.pointer === "" ? [] : check.pointer.slice(1).split("/").map(s => s.replaceAll("~1", "/").replaceAll("~0", "~"))) {
		if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) { found = false; value = undefined; break; }
		value = (value as Record<string, unknown>)[key];
	}
	let passed = false;
	if (check.op === "exists") passed = found;
	else if (found && check.op === "equals") passed = isDeepStrictEqual(value, check.expected);
	else if (found && check.op === "contains") passed = typeof value === "string" && typeof check.expected === "string" ? value.includes(check.expected) : Array.isArray(value) && value.some(v => isDeepStrictEqual(v, check.expected));
	else if (found && check.op === "matches") passed = typeof value === "string" && new RegExp(String(check.expected), "u").test(value);
	else if (found && check.op === "approx") passed = typeof value === "number" && Number.isFinite(value) && Math.abs(value - Number(check.expected)) <= Math.max(check.absTolerance ?? 0, (check.relTolerance ?? 0) * Math.abs(Number(check.expected)));
	return { passed, actual: found ? value : { missing: true } };
}
export function requiredCapabilities(rule: Rule): Array<keyof Capabilities> {
	if (rule.kind === "tool.order") return ["started", "completed"];
	if (rule.kind === "tool.approval") return ["started", "approval"];
	if ("match" in rule) return [rule.match.phase];
	return [];
}
function selected(events: EvidenceEvent[], match: ToolMatch) {
	return [...new Map(events.filter(e => e.type === `tool.${match.phase}` && e.payload.name === match.name && (!match.outcome || e.payload.outcome === match.outcome) && (!match.parameters || compare(e.payload.input, match.parameters).passed)).map(e => [`${e.sessionId}:${e.toolCallId}`, e])).values()];
}
export function checkBehavior(rule: Rule, events: EvidenceEvent[], capabilities: Capabilities, complete: boolean) {
	const unsupported = requiredCapabilities(rule).filter(key => !capabilities[key]);
	if (unsupported.length) return { status: "insufficient" as const, actual: unsupported, message: "当前 SDK 不支持所需真实事件" };
	if (!complete || events.some((e, i) => (i > 0 && e.seq <= events[i - 1].seq) || (e.type.startsWith("tool.") && !e.toolCallId))) return { status: "insufficient" as const, actual: null, message: "事件轨迹不完整或序号无效" };
	let passed = false; let actual: unknown; let relevant: EvidenceEvent[] = [];
	if (rule.kind === "tool.order") {
		const before = selected(events, { ...rule.before, outcome: rule.before.outcome ?? "success" }); const after = selected(events, rule.after); relevant = [...before, ...after];
		const violations = after.filter(a => !before.some(b => b.sessionId === a.sessionId && b.seq < a.seq && b.toolCallId !== a.toolCallId));
		passed = (rule.requireAfter === false || after.length > 0) && !violations.length; actual = { after: after.length, violations: violations.map(e => e.eventId) };
	} else if ("match" in rule) {
		relevant = selected(events, rule.match);
		if (rule.kind === "tool.count") { actual = relevant.length; passed = relevant.length >= (rule.min ?? 0) && relevant.length <= (rule.max ?? Infinity); }
		if (rule.kind === "tool.parameters") { const checks = relevant.map(e => compare(e.payload.input, rule.check)); actual = checks; passed = checks.length > 0 && checks.every(c => c.passed); }
		if (rule.kind === "tool.approval") {
			const violations = relevant.filter(e => {
				const approvals = events.filter(a => a.type === "approval.resolved" && a.sessionId === e.sessionId && a.toolCallId === e.toolCallId && a.seq < e.seq);
				return approvals.at(-1)?.payload.approved !== true;
			});
			actual = { executions: relevant.length, violations: violations.map(e => e.eventId) }; passed = !violations.length;
		}
	}
	return { status: passed ? "pass" as const : "fail" as const, actual, message: passed ? "行为约束满足" : "行为约束未满足", events: relevant.map(e => e.eventId) };
}
