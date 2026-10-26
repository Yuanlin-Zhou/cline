const text = { bsonType: "string" };
const headers = { bsonType: "object", additionalProperties: text };
export const judgeConfigValidator = {
	bsonType: "object",
	additionalProperties: false,
	properties: {
		enabled: { bsonType: "bool" },
		referenceAnswer: { ...text, maxLength: 65536 },
		rubric: { ...text, maxLength: 16384 },
		targets: {
			bsonType: "array",
			maxItems: 2,
			uniqueItems: true,
			items: { enum: ["result", "trajectory"] },
		},
		model: {
			bsonType: "object",
			additionalProperties: false,
			properties: {
				providerId: text,
				modelId: text,
				baseUrl: text,
				apiKeyEnv: text,
				headers,
				headersEnv: headers,
			},
		},
		affectsOutcome: { bsonType: "bool" },
		passScore: {
			bsonType: ["int", "long", "double"],
			minimum: 0,
			maximum: 100,
		},
		timeoutMs: {
			bsonType: ["int", "long", "double"],
			minimum: 1000,
			maximum: 300000,
		},
		maxInputBytes: {
			bsonType: ["int", "long", "double"],
			minimum: 1024,
			maximum: 1048576,
		},
		resultFiles: {
			bsonType: "array",
			maxItems: 20,
			uniqueItems: true,
			items: text,
		},
	},
};
