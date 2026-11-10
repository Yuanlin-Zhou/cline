import { ClineCore } from "@cline/sdk";

export type EvaluationRuntime = ClineCore;
/** Keep SDK initialization and its evaluation-specific approval policy together. */
export function createEvaluationRuntime() {
	return ClineCore.create({
		clientName: "agent-eval",
		backendMode: "local",
		capabilities: {
			requestToolApproval: async (request) => ({
				approved: false,
				reason: `evaluation policy denied ${request.toolName}`,
			}),
		},
	});
}
