import { ClineCore } from "@cline/sdk";

export type EvaluationRuntime = ClineCore;
/** Keep SDK initialization and its evaluation-specific approval policy together. */
export function createEvaluationRuntime() {
	return ClineCore.create({
		clientName: "agent-eval",
		backendMode: "local",
		capabilities: {
			requestToolApproval: async (request) => ({
				approved: request.policy.enabled !== false,
				reason:
					request.policy.enabled === false
						? `evaluation policy denied ${request.toolName}`
						: "evaluation automatically approved enabled tool",
			}),
		},
	});
}
