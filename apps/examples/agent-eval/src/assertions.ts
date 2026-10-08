import type { AssertionResult, EvalAssertions } from "./types.js";

export function evaluateAssertions(
	text: string,
	finishReason: string | undefined,
	assertions: EvalAssertions | undefined,
): AssertionResult[] {
	const results: AssertionResult[] = [];
	const expectedFinishReason = assertions?.finishReason ?? "completed";
	results.push({
		passed: finishReason === expectedFinishReason,
		message: `finishReason is ${expectedFinishReason}`,
	});

	for (const expected of assertions?.contains ?? []) {
		results.push({
			passed: text.includes(expected),
			message: `output contains ${JSON.stringify(expected)}`,
		});
	}
	for (const forbidden of assertions?.notContains ?? []) {
		results.push({
			passed: !text.includes(forbidden),
			message: `output does not contain ${JSON.stringify(forbidden)}`,
		});
	}
	for (const pattern of assertions?.matches ?? []) {
		results.push({
			passed: new RegExp(pattern, "u").test(text),
			message: `output matches /${pattern}/u`,
		});
	}
	return results;
}
