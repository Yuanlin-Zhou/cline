export type PythonEnvironment = {
	command: string;
	version: string;
	sha256: string;
	packages: Array<{ name: string; version: string }>;
	environmentId: string;
};
export type UploadedVerifier = {
	id: string;
	schemaVersion: 1;
	label: string;
	filename: string;
	extension: ".js" | ".mjs" | ".ts" | ".py";
	runtime?: "bun" | "python";
	entrypoint?: "verify";
	contractVersion?: 1 | 2;
	pythonEnvironment?: PythonEnvironment;
	content: string;
	version: string;
	sha256: string;
	timeoutMs: number;
	createdAt: string;
};
