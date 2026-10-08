import { parseGrading } from "./grading/schema.js";
import type {
	EvalAssertions,
	EvalCase,
	EvalDefaults,
	EvalMessage,
	EvalSuite,
	ToolMode,
} from "./types.js";

const DEFAULT_PROVIDER_ID = "cline";
const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.6";
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TOOL_MODE: ToolMode = "read-only";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value;
}

function readPositiveInteger(
	value: unknown,
	path: string,
	fallback?: number,
): number | undefined {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error(`${path} must be a positive integer`);
	}
	return value as number;
}

export function parseToolMode(value: unknown, path: string): ToolMode {
	if (value === "none" || value === "read-only" || value === "full") {
		return value;
	}
	throw new Error(`${path} must be one of: none, read-only, full`);
}

function parseStringArray(value: unknown, path: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new Error(`${path} must be an array of non-empty strings`);
	}
	return value;
}

function parseAssertions(
	value: unknown,
	path: string,
): EvalAssertions | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${path} must be an object`);

	const finishReason = readOptionalString(
		value.finishReason,
		`${path}.finishReason`,
	);
	const validFinishReasons = new Set([
		"completed",
		"max_iterations",
		"aborted",
		"mistake_limit",
		"error",
	]);
	if (finishReason && !validFinishReasons.has(finishReason)) {
		throw new Error(`${path}.finishReason is invalid`);
	}

	const matches = parseStringArray(value.matches, `${path}.matches`);
	for (const [index, pattern] of (matches ?? []).entries()) {
		try {
			new RegExp(pattern, "u");
		} catch {
			throw new Error(
				`${path}.matches[${index}] is not a valid regular expression`,
			);
		}
	}

	return {
		contains: parseStringArray(value.contains, `${path}.contains`),
		notContains: parseStringArray(value.notContains, `${path}.notContains`),
		matches,
		finishReason: finishReason as EvalAssertions["finishReason"],
	};
}

function parseMessage(value: unknown, path: string): EvalMessage {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	if (value.role !== "user" && value.role !== "assistant") {
		throw new Error(`${path}.role must be user or assistant`);
	}
	if (typeof value.content !== "string" || value.content.length === 0) {
		throw new Error(`${path}.content must be a non-empty string`);
	}
	return { role: value.role, content: value.content };
}

function parseDefaults(value: unknown): EvalDefaults {
	if (value !== undefined && !isRecord(value)) {
		throw new Error("defaults must be an object");
	}
	const defaults = value ?? {};
	return {
		providerId:
			readOptionalString(defaults.providerId, "defaults.providerId") ??
			DEFAULT_PROVIDER_ID,
		modelId:
			readOptionalString(defaults.modelId, "defaults.modelId") ??
			DEFAULT_MODEL_ID,
		apiKeyEnv: readOptionalString(defaults.apiKeyEnv, "defaults.apiKeyEnv"),
		baseUrl: readOptionalString(defaults.baseUrl, "defaults.baseUrl"),
		cwd: readOptionalString(defaults.cwd, "defaults.cwd"),
		systemPrompt: readOptionalString(
			defaults.systemPrompt,
			"defaults.systemPrompt",
		),
		maxIterations: readPositiveInteger(
			defaults.maxIterations,
			"defaults.maxIterations",
			DEFAULT_MAX_ITERATIONS,
		),
		timeoutMs: readPositiveInteger(
			defaults.timeoutMs,
			"defaults.timeoutMs",
			DEFAULT_TIMEOUT_MS,
		),
		tools:
			defaults.tools === undefined
				? DEFAULT_TOOL_MODE
				: parseToolMode(defaults.tools, "defaults.tools"),
	};
}

function parseCase(value: unknown, index: number): EvalCase {
	const path = `cases[${index}]`;
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const id = readOptionalString(value.id, `${path}.id`);
	const prompt = readOptionalString(value.prompt, `${path}.prompt`);
	if (!id || !prompt)
		throw new Error(`${path}.id and ${path}.prompt are required`);
	if (value.history !== undefined && !Array.isArray(value.history)) {
		throw new Error(`${path}.history must be an array`);
	}
	if (value.replayMode !== undefined && value.replayMode !== "single-turn" && value.replayMode !== "full-task") {
		throw new Error(`${path}.replayMode must be single-turn or full-task`);
	}

	return {
		id,
		replayMode: value.replayMode as EvalCase["replayMode"],
		tags: parseStringArray(value.tags, `${path}.tags`),
		description: readOptionalString(value.description, `${path}.description`),
		history: (value.history ?? []).map((message, messageIndex) =>
			parseMessage(message, `${path}.history[${messageIndex}]`),
		),
		prompt,
		cwd: readOptionalString(value.cwd, `${path}.cwd`),
		systemPrompt: readOptionalString(
			value.systemPrompt,
			`${path}.systemPrompt`,
		),
		maxIterations: readPositiveInteger(
			value.maxIterations,
			`${path}.maxIterations`,
		),
		timeoutMs: readPositiveInteger(value.timeoutMs, `${path}.timeoutMs`),
		tools:
			value.tools === undefined
				? undefined
				: parseToolMode(value.tools, `${path}.tools`),
		assertions: parseAssertions(value.assertions, `${path}.assertions`),
		grading: parseGrading(value.grading, `${path}.grading`, String(value.replayMode ?? "single-turn")),
	};
}

export function parseEvalSuite(value: unknown): EvalSuite {
	if (!isRecord(value))
		throw new Error("evaluation file must contain an object");
	if (value.version !== undefined && value.version !== 1) {
		throw new Error("version must be 1");
	}
	if (!Array.isArray(value.cases) || value.cases.length === 0) {
		throw new Error("cases must be a non-empty array");
	}

	const cases = value.cases.map(parseCase);
	const ids = new Set<string>();
	for (const item of cases) {
		if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
		ids.add(item.id);
	}

	return { version: 1, defaults: parseDefaults(value.defaults), cases };
}
