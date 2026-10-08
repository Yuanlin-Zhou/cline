import { parseToolMode } from "./schema.js";
import type { CliOverrides, ToolMode } from "./types.js";

export type CliOptions = {
	inputPath: string;
	outputPath?: string;
	overrides: CliOverrides;
};

export const HELP = `Lightweight Cline agent evaluator

Usage:
  bun run eval --input <suite.json> [options]
  bun run eval <suite.json> [options]

Options:
  -i, --input <path>          Evaluation suite JSON file
  -o, --output <path>         Also write the JSON report to a file
  -P, --provider <id>         Override defaults.providerId
  -m, --model <id>            Override defaults.modelId
      --api-key-env <name>    Read the API key from this environment variable
  -c, --cwd <path>            Override the workspace for every case
      --tools <mode>          none | read-only | full (full can modify files)
      --stream                Stream assistant text to stderr
  -h, --help                  Show this help
`;

function readValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

export function parseCliArgs(args: string[]): CliOptions | { help: true } {
	let inputPath: string | undefined;
	let outputPath: string | undefined;
	let providerId: string | undefined;
	let modelId: string | undefined;
	let apiKeyEnv: string | undefined;
	let cwd: string | undefined;
	let tools: ToolMode | undefined;
	let stream = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-h" || arg === "--help") return { help: true };
		if (arg === "--stream") {
			stream = true;
			continue;
		}
		if (arg === "-i" || arg === "--input") {
			inputPath = readValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "-o" || arg === "--output") {
			outputPath = readValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "-P" || arg === "--provider") {
			providerId = readValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "-m" || arg === "--model") {
			modelId = readValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "--api-key-env") {
			apiKeyEnv = readValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "-c" || arg === "--cwd") {
			cwd = readValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "--tools") {
			tools = parseToolMode(readValue(args, index, arg), arg);
			index += 1;
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown option: ${arg}`);
		if (inputPath) throw new Error(`unexpected positional argument: ${arg}`);
		inputPath = arg;
	}

	if (!inputPath) throw new Error("an input JSON file is required");
	return {
		inputPath,
		outputPath,
		overrides: {
			providerId,
			modelId,
			apiKeyEnv,
			cwd,
			tools,
			stream,
		},
	};
}
