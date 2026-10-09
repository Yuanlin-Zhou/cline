import { resolveHeaders } from "./headers.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runIsolated } from "./grading/run.js";
import { gradingSummary } from "./grading/summary.js";
import { ClineCore, type ToolPolicy } from "@cline/sdk";
import { evaluateAssertions } from "./assertions.js";
import { replayConfig } from "./replay.js";
import type {
	CliOverrides,
	EvalCase,
	EvalCaseResult,
	EvalReport,
	EvalSuite,
	ToolMode,
} from "./types.js";

const DEFAULT_SYSTEM_PROMPT = `You are Cline running inside an automated evaluation.
Follow the user's request and use only the tools made available to you. Return a clear final answer without asking for interactive input.`;

function resolveWorkspace(
	value: string | undefined,
	suiteDirectory: string,
): string {
	return path.resolve(suiteDirectory, value ?? ".");
}

function buildToolPolicies(mode: ToolMode): Record<string, ToolPolicy> {
	if (mode === "full") {
		return { "*": { enabled: true, autoApprove: true } };
	}
	if (mode === "none") {
		return { "*": { enabled: false, autoApprove: false } };
	}
	return {
		"*": { enabled: false, autoApprove: false },
		read_files: { enabled: true, autoApprove: true },
		search_codebase: { enabled: true, autoApprove: true },
	};
}

function resolveApiKey(apiKeyEnv: string | undefined): string | undefined {
	if (!apiKeyEnv) return undefined;
	const apiKey = process.env[apiKeyEnv];
	if (!apiKey) {
		throw new Error(`environment variable ${apiKeyEnv} is not set`);
	}
	return apiKey;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runCase(input: {
	cline: ClineCore;
	caseDefinition: EvalCase;
	suite: EvalSuite;
	overrides: CliOverrides;
	suiteDirectory: string;
	signal?: AbortSignal;
	onSession?: (sessionId: string) => void;
}): Promise<EvalCaseResult> {
	const { cline, caseDefinition, suite, overrides, suiteDirectory } = input;
	const defaults = suite.defaults;
	const sessionId = randomUUID();
	input.onSession?.(sessionId);
	const execution = replayConfig(caseDefinition, defaults, overrides.tools);
	const toolMode = execution.tools;
	const timeoutMs =
		caseDefinition.timeoutMs ?? defaults.timeoutMs ?? 5 * 60 * 1000;
	const startedAt = Date.now();
	const abort = () => { void cline.stop(sessionId).catch(() => undefined); };
	input.signal?.throwIfAborted();
	input.signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		void cline.stop(sessionId).catch(() => undefined);
	}, timeoutMs);

	try {
		const headers = resolveHeaders(defaults, caseDefinition, { sessionId, caseId: caseDefinition.id, evaluationId: randomUUID() });
		const cwd = overrides.cwd
			? path.resolve(overrides.cwd)
			: resolveWorkspace(caseDefinition.cwd ?? defaults.cwd, suiteDirectory);
		const result = await cline.start({
			prompt: caseDefinition.prompt,
			initialMessages: caseDefinition.history,
			interactive: false,
			source: "cli",
			sessionMetadata: {
				evaluationCaseId: caseDefinition.id,
			},
			config: {
				sessionId,
				providerId: overrides.providerId ?? defaults.providerId,
				modelId: overrides.modelId ?? defaults.modelId,
				apiKey: resolveApiKey(overrides.apiKeyEnv ?? defaults.apiKeyEnv),
				baseUrl: defaults.baseUrl,
				...(headers ? { headers } : {}),
				cwd,
				workspaceRoot: cwd,
				mode: toolMode === "full" ? "yolo" : "act",
				systemPrompt:
					caseDefinition.systemPrompt ??
					defaults.systemPrompt ??
					DEFAULT_SYSTEM_PROMPT,
				maxIterations: execution.maxIterations,
				enableTools: toolMode !== "none",
				enableSpawnAgent: false,
				enableAgentTeams: false,
				disableMcpSettingsTools: true,
			},
			toolPolicies: buildToolPolicies(toolMode),
		});

		if (timedOut) {
			throw new Error(`evaluation timed out after ${timeoutMs}ms`);
		}
		if (!result.result) {
			throw new Error("Cline session ended without an AgentResult");
		}
		const agentResult = result.result;
		const assertions = evaluateAssertions(
			agentResult.text,
			agentResult.finishReason,
			caseDefinition.assertions,
		);
		const passed = assertions.every((assertion) => assertion.passed);
		return {
			id: caseDefinition.id,
			description: caseDefinition.description,
			status: passed ? "passed" : "failed",
			sessionId,
			text: agentResult.text,
			finishReason: agentResult.finishReason,
			durationMs: agentResult.durationMs,
			iterations: agentResult.iterations,
			usage: agentResult.usage,
			toolCalls: agentResult.toolCalls.map((call) => ({
				name: call.name,
				input: call.input,
				output: call.output,
				error: call.error,
				durationMs: call.durationMs,
			})),
			assertions,
		};
	} catch (error) {
		return {
			id: caseDefinition.id,
			description: caseDefinition.description,
			status: "error",
			sessionId,
			text: "",
			durationMs: Date.now() - startedAt,
			iterations: 0,
			usage: { inputTokens: 0, outputTokens: 0 },
			toolCalls: [],
			assertions: [],
			error: timedOut
				? `evaluation timed out after ${timeoutMs}ms`
				: errorMessage(error),
		};
	} finally {
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", abort);
	}
}

export async function runEvalSuite(input: {
	suite: EvalSuite;
	suitePath: string;
	overrides: CliOverrides;
	onCaseStart?: (caseDefinition: EvalCase) => void;
	onCaseComplete?: (result: EvalCaseResult) => void;
	onText?: (text: string) => void;
	onSession?: (sessionId: string) => void;
	onDiagnostic?: (event: unknown) => void;
	signal?: AbortSignal;
}): Promise<EvalReport> {
	const { suite, suitePath, overrides, onCaseStart, onCaseComplete } = input;
	const startedAt = new Date();
	const suiteDirectory = path.dirname(suitePath);
	resolveApiKey(overrides.apiKeyEnv ?? suite.defaults.apiKeyEnv);
	const cline = await ClineCore.create({
		clientName: "agent-eval",
		backendMode: "local",
		capabilities: {
			requestToolApproval: async (request) => ({
				approved: false,
				reason: `evaluation policy denied ${request.toolName}`,
			}),
		},
	});
	const unsubscribe = cline.subscribe((event) => {
		if (event.type === "agent_event" && "contentType" in event.payload.event && event.payload.event.contentType === "tool") input.onDiagnostic?.(event);
		if (
			event.type === "agent_event" &&
			event.payload.event.type === "content_start" &&
			event.payload.event.contentType === "text" &&
			event.payload.event.text
		) {
			if (overrides.stream) process.stderr.write(event.payload.event.text);
			input.onText?.(event.payload.event.text);
		}
	});

	const results: EvalCaseResult[] = [];
	const gradingRunId = randomUUID();
	try {
		for (const caseDefinition of suite.cases) {
			input.signal?.throwIfAborted();
			onCaseStart?.(caseDefinition);
			const result = caseDefinition.grading ? await runIsolated({
				definition: { ...caseDefinition, ...(overrides.tools ? { tools: overrides.tools } : {}), cwd: overrides.cwd ? path.resolve(overrides.cwd) : caseDefinition.cwd ?? suite.defaults.cwd ? resolveWorkspace(caseDefinition.cwd ?? suite.defaults.cwd, suiteDirectory) : undefined },
				defaults: { ...suite.defaults, ...(overrides.providerId ? { providerId: overrides.providerId } : {}), ...(overrides.modelId ? { modelId: overrides.modelId } : {}), ...(overrides.apiKeyEnv ? { apiKeyEnv: overrides.apiKeyEnv } : {}), ...(overrides.tools ? { tools: overrides.tools } : {}) },
				directory: path.join(path.resolve(process.env.EVAL_DATA_DIR ?? path.join(suiteDirectory, ".eval-data")), "runs", gradingRunId, randomUUID()), signal: input.signal,
				onText: text => { if (overrides.stream) process.stderr.write(text); input.onText?.(text); }, onWorkspace: workspace => process.stderr.write(`[workspace] ${workspace}\n`),
			}) : await runCase({
				cline,
				caseDefinition,
				suite,
				overrides,
				suiteDirectory,
				signal: input.signal,
				onSession: input.onSession,
			});
			results.push(result);
			onCaseComplete?.(result);
		}
	} finally {
		unsubscribe();
		await cline.dispose("evaluation finished");
	}

	const endedAt = new Date();
	const totalCost = results.reduce(
		(sum, result) => sum + (result.usage.totalCost ?? 0),
		0,
	);
	return {
		version: 1,
		startedAt: startedAt.toISOString(),
		endedAt: endedAt.toISOString(),
		providerId: overrides.providerId ?? suite.defaults.providerId,
		modelId: overrides.modelId ?? suite.defaults.modelId,
		summary: {
			total: results.length,
			passed: results.filter((result) => result.status === "passed").length,
			failed: results.filter((result) => suite.cases.some(c => c.grading) ? result.status === "failed" : result.status !== "passed").length,
			inconclusive: results.filter(result => result.status === "inconclusive").length,
			executionErrors: results.filter(result => result.execution?.status === "error" || result.status === "error").length,
			grading: gradingSummary(results.map((result, index) => ({ status: result.status, result, snapshot: { id: suite.cases[index].id, definition: suite.cases[index] } }))),
			durationMs: endedAt.getTime() - startedAt.getTime(),
			inputTokens: results.reduce(
				(sum, result) => sum + result.usage.inputTokens,
				0,
			),
			outputTokens: results.reduce(
				(sum, result) => sum + result.usage.outputTokens,
				0,
			),
			...(totalCost > 0 ? { totalCost } : {}),
		},
		cases: results,
	};
}
