import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HELP, parseCliArgs } from "./cli.js";
import { parseEvalSuite } from "./schema.js";

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	if ("help" in options) {
		process.stdout.write(HELP);
		return;
	}

	const inputPath = path.resolve(options.inputPath);
	const suite = parseEvalSuite(JSON.parse(await readFile(inputPath, "utf8")));
	const { runEvalSuite } = await import("./runner.js");
	const report = await runEvalSuite({
		suite,
		suitePath: inputPath,
		overrides: options.overrides,
		onCaseStart: (caseDefinition) => {
			process.stderr.write(`[run] ${caseDefinition.id}\n`);
		},
		onCaseComplete: (result) => {
			process.stderr.write(
				`[${result.status}] ${result.id} (${result.durationMs}ms)\n`,
			);
		},
	});
	const json = `${JSON.stringify(report, null, 2)}\n`;

	if (options.outputPath) {
		const outputPath = path.resolve(options.outputPath);
		await mkdir(path.dirname(outputPath), { recursive: true });
		await writeFile(outputPath, json, "utf8");
		process.stderr.write(`[report] ${outputPath}\n`);
	}
	process.stdout.write(json);
	if (report.cases.some(c => c.grading)) {
		process.exitCode = report.cases.some(c => c.status === "failed") ? 1 : report.cases.some(c => c.status !== "passed" || c.execution?.status === "error" || c.grading?.status === "error") ? 2 : 0;
	} else if (report.summary.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`agent-eval: ${message}\n\n${HELP}`);
	process.exitCode = 2;
});
