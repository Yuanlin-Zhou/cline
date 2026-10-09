import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { observedActivity } from "./activity.js";
import { readConversation } from "./conversation.js";
import { EvalQueue } from "./queue.js";
import { createEvalServer } from "./server.js";
import { EvalStore } from "./store.js";
import type { RunItem } from "./types.js";

let directory: string; let store: EvalStore;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "eval-observe-")); store = new EvalStore(directory); });
afterEach(async () => { store.db.close(); await rm(directory, { recursive: true, force: true }); });
function seed() {
	const c = store.createCase(store.activeModules()[0].id, store.settings(), { id: "observe", prompt: "hello" });
	const run = store.createRun({ caseIds: [c.id] }); const item = store.items(run.id)[0]; return { run, item };
}
const itemDirectory = (item: RunItem) => path.join(directory, "runs", item.runId, item.id);
async function save(item: RunItem, payload: unknown) {
	item.sessionId = "session-one";
	const folder = path.join(itemDirectory(item), "session", "sessions", item.sessionId);
	await mkdir(folder, { recursive: true }); const file = path.join(folder, `${item.sessionId}.messages.json`);
	await writeFile(file, typeof payload === "string" ? payload : JSON.stringify(payload)); return file;
}

test("SDK activity observes tool notifications without forwarding input or reasoning content", () => {
	expect(observedActivity({ type: "content_start", contentType: "tool", toolName: "read_files", input: "private" })).toMatchObject({ type: "tool.request", toolName: "read_files" });
	expect(JSON.stringify(observedActivity({ type: "content_start", contentType: "reasoning", reasoning: "private" }))).not.toContain("private");
	expect(observedActivity({ type: "content_end", contentType: "tool" })?.type).toBe("tool.result");
	expect(observedActivity({ type: "iteration_start", iteration: 2 })?.iteration).toBe(2);
	expect(observedActivity({ type: "usage" })).toBeUndefined();
});

test("bursty text is merged, phase is immediate, and terminal partial output survives failure", async () => {
	const { run, item } = seed(); let writes = 0;
	const original = store.put.bind(store); store.put = (kind, id, value) => { if (kind === "item") writes++; original(kind, id, value); };
	const queue = new EvalQueue(store, async (i, onText, _signal, onUpdate) => {
		onUpdate?.({ sessionId: "live-session", phase: "executing" });
		for (let n = 0; n < 500; n++) onText("x");
		onUpdate?.({ activity: { type: "tool.request", at: new Date().toISOString(), toolName: "read_files" } });
		onUpdate?.({ phase: "verifying", activity: { type: "phase", at: new Date().toISOString() } });
		expect(store.require<RunItem>("item", i.id).phase).toBe("verifying");
		throw new Error("provider failed");
	});
	queue.kick(); await queue.idle();
	const current = store.items(run.id)[0];
	expect(current).toMatchObject({ status: "error", sessionId: "live-session", text: "x".repeat(500), error: "provider failed", phase: "verifying" });
	expect(current.lastActivityAt).toBeTruthy(); expect(current.activities?.map(a => a.type)).toEqual(["tool.request", "phase"]);
	expect(writes).toBeLessThan(10); const atEnd = writes; await Bun.sleep(300); expect(writes).toBe(atEnd);
	expect(current.id).toBe(item.id);
});

test("periodic flush makes text available before a long execution ends and cancellation keeps it", async () => {
	const { run } = seed(); let released!: () => void;
	const queue = new EvalQueue(store, async (_item, onText, signal) => {
		onText("partial reply"); await new Promise<void>(resolve => { released = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); }); throw new Error("cancelled");
	});
	queue.kick(); await Bun.sleep(280);
	expect(store.items(run.id)[0]).toMatchObject({ status: "running", text: "partial reply" });
	queue.cancel(run.id); released(); await queue.idle(); expect(store.items(run.id)[0]).toMatchObject({ status: "cancelled", text: "partial reply" });
});

test("conversation paginates persisted messages, preserves tools, omits metadata and replaces existing secrets", async () => {
	const { item } = seed();
	await save(item, { sessionId: "session-one", system_prompt: "hidden system", origin: { path: "/private/path" }, messages: [
		{ role: "user", content: 'hello secret"key' },
		{ role: "assistant", content: [{ type: "text", text: "reply" }, { type: "tool-call", toolName: "read_files", toolCallId: "call-one", input: { path: "file.txt" } }] },
		{ role: "tool", content: [{ type: "tool-result", toolName: "read_files", toolCallId: "call-one", output: { type: "text", value: "file contents" } }] },
	] });
	const first = await readConversation(itemDirectory(item), item, { limit: 2, secrets: ['secret"key'] });
	expect(first).toMatchObject({ status: "ready", total: 3, nextOffset: 2 }); expect(first.messages[0].blocks[0].text).toBe("hello [REDACTED]");
	expect(first.messages[1].blocks[1]).toMatchObject({ type: "tool-call", toolName: "read_files", toolCallId: "call-one" });
	expect(JSON.stringify(first)).not.toContain("hidden system"); expect(JSON.stringify(first)).not.toContain("/private/path");
	const second = await readConversation(itemDirectory(item), item, { offset: 2 }); expect(second.messages[0].id).toBe("session-one:2"); expect(second.nextOffset).toBeUndefined();
	expect((await readConversation(itemDirectory(item), item, { download: true })).messages).toHaveLength(3);
});

test("missing, concurrent write, invalid format, mismatched session and traversal are explicit", async () => {
	const { item } = seed(); item.status = "running";
	expect((await readConversation(itemDirectory(item), item)).status).toBe("pending");
	await save(item, '{"messages":'); expect((await readConversation(itemDirectory(item), item)).status).toBe("pending");
	item.status = "error"; expect((await readConversation(itemDirectory(item), item)).status).toBe("unavailable");
	await save(item, { messages: "unexpected" }); expect((await readConversation(itemDirectory(item), item)).status).toBe("unavailable");
	await save(item, { sessionId: "other-session", messages: [] }); expect((await readConversation(itemDirectory(item), item)).notice).toContain("不匹配");
	item.sessionId = "../../outside"; expect((await readConversation(itemDirectory(item), item)).status).toBe("unavailable");
});

test("oversized files and cross-run symlinks cannot be read", async () => {
	const { item } = seed(); const file = await save(item, { messages: [] });
	await writeFile(file, " ".repeat(32 * 1024 * 1024 + 1)); expect((await readConversation(itemDirectory(item), item)).notice).toContain("32 MiB");
	const other = path.join(directory, "outside.json"); await writeFile(other, '{"messages":[]}'); await rm(file); await symlink(other, file);
	expect((await readConversation(itemDirectory(item), item)).notice).toContain("越界");
});

test("conversation HTTP checks ownership, pagination and download, with final-session fallback for old items", async () => {
	const { run, item } = seed(); await save(item, { messages: [{ role: "assistant", content: "saved reply" }] }); item.status = "passed";
	item.result = { id: "observe", status: "passed", sessionId: item.sessionId!, text: "saved reply", durationMs: 1, iterations: 1, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], assertions: [] }; delete item.sessionId;
	store.put("item", item.id, item); run.status = "completed"; store.put("run", run.id, run);
	const app = await createEvalServer({ directory, storage: "sqlite", port: 0 });
	const base = `http://127.0.0.1:${app.server.port}/api/runs/${run.id}/items`;
	try {
		const response = await fetch(`${base}/${item.id}/conversation`); expect(response.status).toBe(200); expect((await response.json() as { messages: unknown[] }).messages).toHaveLength(1);
		expect((await fetch(`${base}/other-item/conversation`)).status).toBe(404);
		for (const query of ["offset=-1", "limit=101", "offset=1.5"]) expect((await fetch(`${base}/${item.id}/conversation?${query}`)).status).toBe(400);
		const download = await fetch(`${base}/${item.id}/conversation?download=1`); expect(download.headers.get("content-disposition")).toContain("attachment"); expect(await download.text()).toContain("saved reply");
	} finally { await app.close(); }
});
