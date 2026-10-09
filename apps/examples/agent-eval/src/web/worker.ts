import { readFile } from "node:fs/promises";
import { parseEvalSuite } from "../schema.js";
import { runEvalSuite } from "../runner.js";
import { observedActivity } from "./activity.js";

// One SDK process and data directory per case. Stdout is a JSONL event channel.
const suitePath = process.argv[2];
const controller = new AbortController();
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => controller.abort());
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
	const suite = parseEvalSuite(JSON.parse(await readFile(suitePath, "utf8")));
	const report = await runEvalSuite({ suite, suitePath, overrides: { stream: false }, signal: controller.signal, onText: text => emit({ type: "text", text }), onSession: sessionId => emit({ type: "session", sessionId }), onDiagnostic: event => emit({ type: "diagnostic", event }), onActivity: event => { const activity = observedActivity(event); if (activity) emit({ type: "activity", activity }); } });
	emit({ type: "result", result: report.cases[0] });
} catch (error) { emit({ type: "error", error: error instanceof Error ? error.message : String(error) }); }
finally { process.stdin.destroy(); }
