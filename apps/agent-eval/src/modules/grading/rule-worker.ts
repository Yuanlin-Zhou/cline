import { parentPort } from "node:worker_threads";
import { evaluateAssertions } from "./assertions.js";
import { checkRule } from "./check.js";

parentPort!.on("message", async (input) => {
	try {
		const result = input.legacy
			? evaluateAssertions(input.text, input.finishReason, input.assertions)
			: await checkRule(input.rule, input);
		parentPort!.postMessage({ result });
	} catch (error) {
		parentPort!.postMessage({ error: String(error) });
	}
});
