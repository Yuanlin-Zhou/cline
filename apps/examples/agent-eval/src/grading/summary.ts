import type { EvalCaseResult } from "../types.js";

type Item = { status: string; snapshot: { id: string; definition: { id: string; grading?: unknown } }; result?: EvalCaseResult };
const fraction = (numerator: number, denominator: number) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
export function gradingSummary(items: Item[]) {
	const settled = items.filter(i => !["queued", "running", "cancelled"].includes(i.status));
	const legacy = settled.filter(i => !i.snapshot.definition.grading);
	const groups = new Map<string, Item[]>();
	for (const item of settled.filter(i => i.snapshot.definition.grading)) {
		const key = `${item.snapshot.id}:${item.result?.grading?.ruleHash ?? JSON.stringify(item.snapshot.definition.grading)}`;
		groups.set(key, [...groups.get(key) ?? [], item]);
	}
	return {
		legacy: fraction(legacy.filter(i => i.status === "passed").length, legacy.filter(i => ["passed", "failed"].includes(i.status)).length),
		executionErrors: fraction(settled.filter(i => i.result?.execution?.status === "error" || (!i.result?.execution && i.status === "error")).length, settled.length),
		cancelled: items.filter(i => i.status === "cancelled").length,
		groups: [...groups.entries()].map(([key, entries]) => {
			const passed = entries.filter(i => i.result?.grading?.verdict === "passed").length;
			const failed = entries.filter(i => i.result?.grading?.verdict === "failed").length;
			const rules = entries.flatMap(i => i.result?.grading?.results ?? []).filter(r => r.required && r.kind.startsWith("tool."));
			const covered = entries.filter(i => { const required = i.result?.grading?.results.filter(r => r.required) ?? []; return required.length > 0 && required.every(r => r.status === "pass" || r.status === "fail"); }).length;
			return { key, name: entries[0].snapshot.definition.id, ruleHash: entries[0].result?.grading?.ruleHash, total: entries.length,
				passRate: fraction(passed, passed + failed), successRatio: fraction(passed, entries.length), coverage: fraction(covered, entries.length),
				constraints: fraction(rules.filter(r => r.status === "pass").length, rules.filter(r => r.status === "pass" || r.status === "fail").length),
				unknownConstraints: rules.filter(r => r.status !== "pass" && r.status !== "fail").length,
				inconclusive: entries.length - passed - failed, verifierErrors: entries.filter(i => i.result?.grading?.status === "error").length,
			};
		}),
	};
}
