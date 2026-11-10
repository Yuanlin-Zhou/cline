export type FunctionCallResponse = {
	schema_version: 1;
	protocol: "openai-chat-completions";
	completeness: "complete" | "partial";
	request_tools: Array<{
		type: string;
		function: { name: string; description?: string; parameters: unknown };
	}>;
	tool_choice: unknown;
	raw_response: string;
	http_status: number;
};
