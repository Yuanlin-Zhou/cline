export type HeaderConfig = {
	headers?: Record<string, string>;
	headersEnv?: Record<string, string>;
};

const managed = new Set([
	"host",
	"content-length",
	"connection",
	"transfer-encoding",
	"content-type",
	"trailer",
	"upgrade",
	"keep-alive",
	"te",
]);
const credentials = new Set([
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"api-key",
]);
const templates = new Set(["sessionId", "caseId", "evaluationId"]);

function validateName(name: string, path: string): string {
	if (
		!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
		managed.has(name.toLowerCase())
	)
		throw new Error(`${path}: invalid or managed HTTP header name`);
	return name.toLowerCase();
}

function validateValue(name: string, value: string, path: string): void {
	if (/[\r\n\0]/.test(value))
		throw new Error(`${path}: invalid HTTP header value`);
	try {
		new Headers({ [name]: value });
	} catch {
		throw new Error(`${path}: invalid HTTP header value`);
	}
}

export function parseHeaderConfig(
	value: HeaderConfig | Record<string, unknown>,
	path: string,
): HeaderConfig {
	const result: HeaderConfig = {};
	const names = new Set<string>();
	for (const field of ["headers", "headersEnv"] as const) {
		const raw = value[field];
		if (raw === undefined) continue;
		if (
			!raw ||
			typeof raw !== "object" ||
			Array.isArray(raw) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(raw))
		)
			throw new Error(`${path}.${field} must be an object`);
		const entries: Array<[string, string]> = [];
		for (const [name, entry] of Object.entries(raw)) {
			const location = `${path}.${field}.${name}`;
			const normalized = validateName(name, location);
			if (names.has(normalized))
				throw new Error(
					`${location}: duplicate header or both literal and environment sources`,
				);
			names.add(normalized);
			if (typeof entry !== "string")
				throw new Error(`${location} must be a string`);
			if (field === "headersEnv") {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry))
					throw new Error(
						`${location} must reference an environment variable name`,
					);
			} else {
				if (credentials.has(normalized))
					throw new Error(`${location}: use headersEnv for credential headers`);
				validateValue(normalized, entry, location);
				validateTemplates(entry, location);
			}
			entries.push([normalized, entry]);
		}
		result[field] = Object.fromEntries(entries);
	}
	return result;
}

function validateTemplates(value: string, path: string): void {
	const remaining = value.replace(
		/\{\{(sessionId|caseId|evaluationId)\}\}/g,
		"",
	);
	if (remaining.includes("{{") || remaining.includes("}}"))
		throw new Error(`${path}: unknown or malformed header template`);
}

function mergedEntries(
	defaults: HeaderConfig,
	definition: HeaderConfig,
): Map<string, { env: boolean; value: string }> {
	const entries = new Map<string, { env: boolean; value: string }>();
	for (const [index, layer] of [defaults, definition].entries()) {
		const parsed = parseHeaderConfig(layer, index ? "case" : "defaults");
		for (const [name, value] of Object.entries(parsed.headers ?? {}))
			entries.set(name, { env: false, value });
		for (const [name, value] of Object.entries(parsed.headersEnv ?? {}))
			entries.set(name, { env: true, value });
	}
	return entries;
}

export function resolveHeaders(
	defaults: HeaderConfig,
	definition: HeaderConfig,
	context: { sessionId: string; caseId: string; evaluationId: string },
	env: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
	const resolved: Array<[string, string]> = [];
	for (const [name, entry] of mergedEntries(defaults, definition)) {
		let value: string;
		if (entry.env) {
			const supplied = env[entry.value];
			if (!supplied)
				throw new Error(
					`header ${name}: environment variable ${entry.value} is not set or empty`,
				);
			value = supplied;
		} else {
			value = entry.value.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
				templates.has(key) ? context[key as keyof typeof context] : "",
			);
		}
		validateValue(name, value, `header ${name}`);
		resolved.push([name, value]);
	}
	return resolved.length ? Object.fromEntries(resolved) : undefined;
}
