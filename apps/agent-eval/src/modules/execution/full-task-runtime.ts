import { buildClineSystemPrompt } from "@cline/shared";
import {
	buildWorkspaceMetadata,
	readCompactionStrategyGlobally,
} from "@cline/core";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
	EvalCase,
	EvalDefaults,
	FullTaskRuntime,
} from "../../contracts/evaluation.js";
export const LEGACY_PROMPT = `You are Cline running inside an automated evaluation.
Follow the user's request and use only the tools made available to you. Return a clear final answer without asking for interactive input.`;
export function resolveFullTaskRuntime(
	definition: EvalCase,
	defaults: EvalDefaults,
	historical = false,
): Required<FullTaskRuntime> {
	const d = defaults.fullTaskRuntime,
		c = definition.fullTaskRuntime;
	const promptPreset =
		c?.promptPreset ??
		d?.promptPreset ??
		(historical ? "legacy-eval" : "plugin-act");
	return {
		promptPreset,
		compaction: {
			enabled:
				c?.compaction?.enabled ??
				d?.compaction?.enabled ??
				promptPreset === "plugin-act",
			strategy:
				c?.compaction?.strategy ??
				d?.compaction?.strategy ??
				readCompactionStrategyGlobally(),
		},
	};
}
export async function resolveFullTaskPrompt(
	definition: EvalCase,
	defaults: EvalDefaults,
	cwd: string,
	providerId: string,
) {
	const explicit = definition.systemPrompt ?? defaults.systemPrompt;
	const profile = resolveFullTaskRuntime(definition, defaults);
	const prompt =
		explicit ??
		(profile.promptPreset === "legacy-eval"
			? LEGACY_PROMPT
			: buildClineSystemPrompt({
					ide: "Terminal Shell",
					workspaceRoot: cwd,
					workspaceName: path.basename(cwd),
					metadata: await buildWorkspaceMetadata(cwd),
					mode: "act",
					providerId,
					platform: process.platform,
					planModeSwitchTool: false,
				}));
	return {
		prompt,
		source: explicit ? "custom" : profile.promptPreset,
		hash: createHash("sha256").update(prompt).digest("hex"),
		profile,
	};
}
