export type Comparison = { pointer: string; op: "exists" | "equals" | "contains" | "matches" | "approx"; expected?: unknown; absTolerance?: number; relTolerance?: number };
export type ToolMatch = { name: string; phase: "requested" | "started" | "completed"; outcome?: "success" | "error"; parameters?: Comparison };
type Base = { id: string; label?: string; required?: boolean };
export type Rule = Base & (
	| { kind: "file.exists" | "file.absent" | "file.unchanged"; path: string }
	| { kind: "file.text"; path: string; op: "contains" | "notContains" | "matches"; expected: string }
	| ({ kind: "file.json"; path: string } & Comparison)
	| { kind: "command"; verifierId: string; expectedExitCode: number }
	| { kind: "script"; verifierId: string }
	| { kind: "tool.count"; match: ToolMatch; min?: number; max?: number }
	| { kind: "tool.parameters"; match: ToolMatch; check: Comparison }
	| { kind: "tool.order"; before: ToolMatch; after: ToolMatch; requireAfter?: boolean }
	| { kind: "tool.approval"; match: ToolMatch }
);
export type GradingConfig = { version: 1; rules: Rule[] };
export type EvidenceEvent = {
	schemaVersion: 1; eventId: string; itemId: string; sessionId: string; seq: number; timestamp: string;
	type: "session.started" | "session.ended" | "execution.error" | "tool.requested" | "tool.started" | "tool.completed" | "approval.requested" | "approval.resolved" | "user.replied";
	toolCallId?: string; parentEventId?: string;
	payload: { name?: string; input?: unknown; output?: unknown; error?: string; outcome?: "success" | "error"; approved?: boolean; executionStarted?: boolean; [key: string]: unknown };
};
export type Capabilities = { requested: boolean; started: boolean; completed: boolean; approval: boolean };
export type RuleResult = {
	id: string; kind: string; label?: string; required: boolean;
	status: "pass" | "fail" | "error" | "insufficient" | "skipped";
	expected?: unknown; actual?: unknown; message: string; evidenceRefs: string[]; durationMs: number;
};
export type EvidenceRef = { id: string; label: string; path: string; sha256: string; size: number };
export type FileEvidence = { path: string; sha256: string; size: number; ref: string };
export type EvidenceManifest = {
	version: 1; complete: boolean; eventsComplete: boolean; capabilities: Capabilities; issues: string[];
	environment: { platform: string; arch: string; node: string; bun?: string; graderVersion: string };
	baseline: FileEvidence[]; artifacts: FileEvidence[]; refs: EvidenceRef[]; createdAt: string;
};
export type Grade = {
	id: string; version: 1; ruleHash: string; status: "completed" | "error" | "cancelled";
	verdict: "passed" | "failed" | "inconclusive"; results: RuleResult[];
	startedAt: string; endedAt: string; durationMs: number;
	verifiers: Array<{ id: string; version: string; sha256: string }>;
};
