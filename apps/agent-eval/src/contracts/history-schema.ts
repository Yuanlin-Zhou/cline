const nonempty = { bsonType: "string", minLength: 1 };
export const nativeHistoryValidator = {
	bsonType: "array",
	maxItems: 500,
	items: {
		bsonType: "object",
		required: ["role"],
		additionalProperties: false,
		properties: {
			role: { enum: ["system", "developer", "user", "assistant", "tool"] },
			content: { bsonType: ["string", "null"] },
			name: nonempty,
			tool_call_id: nonempty,
			tool_calls: {
				bsonType: "array",
				minItems: 1,
				items: {
					bsonType: "object",
					required: ["id", "type", "function"],
					additionalProperties: false,
					properties: {
						id: nonempty,
						type: { enum: ["function"] },
						function: {
							bsonType: "object",
							required: ["name", "arguments"],
							additionalProperties: false,
							properties: { name: nonempty, arguments: { bsonType: "string" } },
						},
					},
				},
			},
		},
		oneOf: [
			{
				properties: {
					role: { enum: ["system", "developer", "user"] },
					content: nonempty,
				},
				required: ["content"],
				not: {
					anyOf: [{ required: ["tool_calls"] }, { required: ["tool_call_id"] }],
				},
			},
			{
				properties: { role: { enum: ["assistant"] } },
				not: { required: ["tool_call_id"] },
				anyOf: [
					{ required: ["content"], properties: { content: nonempty } },
					{ required: ["tool_calls"] },
				],
			},
			{
				properties: {
					role: { enum: ["tool"] },
					content: { bsonType: "string" },
				},
				required: ["content", "tool_call_id"],
				not: { required: ["tool_calls"] },
			},
		],
	},
};
const index = {
	bsonType: ["int", "long", "double"],
	minimum: 0,
	multipleOf: 1,
};
export const historySourceValidator = {
	bsonType: "object",
	required: ["format", "notices", "messages"],
	additionalProperties: false,
	properties: {
		format: { enum: ["cline", "openai", "type-data"] },
		sessionId: nonempty,
		notices: { bsonType: "array", items: { bsonType: "string" } },
		messages: {
			bsonType: "array",
			maxItems: 500,
			items: {
				bsonType: "object",
				required: ["index", "sourceIndex"],
				additionalProperties: false,
				properties: {
					index,
					sourceIndex: index,
					blockIndex: index,
					id: { bsonType: "string" },
				},
			},
		},
	},
};
