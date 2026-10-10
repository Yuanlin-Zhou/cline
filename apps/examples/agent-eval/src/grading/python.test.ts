import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseUpload, validateUploaded } from "./uploaded-verifiers.js";
import { pythonEnvironment, preparePythonUpload } from "./python-runtime.js";
import { manifest, snapshot, readEvidence } from "./evidence.js";
import { freezeValidationInput, frozenValidationInput, historicalEvidence } from "./validation-context.js";
import { materializeVerifiers, verifyProcess } from "./verifiers.js";
import { parseGrading } from "./schema.js";
import { preflight } from "./engine.js";
import { pythonReplyTemplate, pythonArtifactTemplate, pythonConversationTemplate } from "./python-guide.js";
import { createEvalServer } from "../web/server.js";
import type { EvalCaseResult } from "../types.js";
import type { VerifierTest } from "../web/verifier-tests.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "eval-python-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const execution = (): EvalCaseResult => ({ id: "python", sessionId: "python-session", text: "Done", execution: { status: "completed" }, status: "passed", durationMs: 1, iterations: 1, usage: { inputTokens: 2, outputTokens: 1 }, toolCalls: [], assertions: [] });
async function seed(text = "hello world") {
	const evidence = manifest(); const workspace = path.join(directory, "workspace"); await mkdir(workspace);
	await snapshot(workspace, directory, "baseline", evidence, []);
	await writeFile(path.join(workspace, "out.txt"), text); await snapshot(workspace, directory, "artifacts", evidence, []);
	const session = path.join(directory, "session/sessions/python-session"); await mkdir(session, { recursive: true });
	await writeFile(path.join(session, "python-session.messages.json"), JSON.stringify({ sessionId: "python-session", messages: [{ role: "user", content: "task" }, { role: "assistant", content: [{ type: "text", text: "Done" }, { type: "tool-call", toolName: "read_files", toolCallId: "call", input: { path: "out.txt", limit: 2 } }] }, { role: "tool", content: [{ type: "tool-result", toolName: "read_files", toolCallId: "call", output: { total: 12 } }] }] }));
	await freezeValidationInput({ directory, definition: { id: "python", prompt: "task", history: [], replayMode: "full-task" }, result: execution(), evidence, secrets: [] });
	return { evidence, workspace };
}
async function verify(content: string, evidence: ReturnType<typeof manifest>, options: { timeout?: number; signal?: AbortSignal; required_inputs?: string[]; params?: Record<string, unknown> } = {}) {
	const uploaded = await preparePythonUpload(parseUpload({ filename: "verify.py", content }));
	const folder = path.join(directory, `test-${crypto.randomUUID()}`); const [verifier] = await materializeVerifiers([uploaded], folder);
	const rule = parseGrading({ version: 1, rules: [{ id: "python", kind: "script", verifierId: uploaded.id, params: options.params, required_inputs: options.required_inputs }] })!.rules[0] as Extract<import("./types.js").Rule, {kind:"script"}>;
	return verifyProcess(rule, { ...verifier, timeoutMs: options.timeout ?? verifier.timeoutMs }, { directory, gradeDirectory: path.join(folder, "grading"), execution: execution(), evidence, secrets: [], timeoutMs: 10000, signal: options.signal });
}

test("Python upload metadata, syntax preflight and environment snapshots do not import user code", async () => {
	const value = parseUpload({ filename: "verify.py", content: "raise RuntimeError('must not execute at upload')\ndef verify(ctx):\n    return {'verdict':'pass','message':'ok'}\n" });
	expect(validateUploaded(value).runtime).toBe("python"); expect(value.contractVersion).toBe(2);
	const prepared = await preparePythonUpload(value); expect(prepared.pythonEnvironment?.version).toMatch(/^3\./);
	await expect(preparePythonUpload(parseUpload({ filename: "bad.py", content: "def verify(ctx)\n pass" }))).rejects.toThrow("语法");
	await expect(preparePythonUpload({ ...value, pythonEnvironment: { ...prepared.pythonEnvironment!, environmentId: "changed" } })).rejects.toThrow("不一致");
	const rule = { id: "python", prompt: "task", replayMode: "single-turn" as const, grading: { version: 1 as const, rules: [{ id: "script", kind: "script" as const, verifierId: value.id }] } };
	const [v] = await materializeVerifiers([prepared], path.join(directory, "single")); preflight(rule, [v]);
	expect(() => preflight({ ...rule, grading: { version: 1, rules: [{ ...rule.grading.rules[0], required_inputs: ["artifacts"] }] } }, [v])).toThrow("单轮");
});

test("Python reads fixed result, structured conversation, params and artifact copies; print is separate", async () => {
	const { evidence, workspace } = await seed();
	const frozen = await frozenValidationInput(directory, evidence); expect(frozen.context.conversation.messages[1].blocks[1].input).toEqual({ path: "out.txt", limit: 2 }); expect(frozen.context.conversation.messages[2].blocks[0].output).toEqual({ total: 12 });
	await writeFile(path.join(workspace, "out.txt"), "modified after snapshot");
	const result = await verify(`from pathlib import Path\nimport os\ndef verify(ctx):\n    assert ctx['execution']['text'] == 'Done'\n    assert ctx['conversation']['messages'][2]['blocks'][0]['output']['total'] == 12\n    assert ctx['params']['expected'] == 12\n    assert 'EVAL_TEST_SECRET_NOT_FOR_VERIFIER' not in os.environ\n    file = Path(ctx['paths']['artifacts']) / 'out.txt'\n    text = file.read_text()\n    file.write_text('modified by verifier')\n    print('ordinary debug log')\n    return {'verdict': 'pass' if text == 'hello world' else 'fail', 'message': 'verified', 'checks': [{'id':'file','status':'pass','message':'snapshot read', 'actual':text, 'files':['out.txt']}]}\n`, evidence, { params: { expected: 12 }, required_inputs: ["conversation", "artifacts"] });
	expect(result.status).toBe("pass"); expect("checks" in result && result.checks?.[0].actual).toBe("hello world");
	expect(await readFile(path.join(workspace, "out.txt"), "utf8")).toBe("modified after snapshot");
	const blob = evidence.refs.find(r => r.id === evidence.artifacts[0].ref)!; expect((await readEvidence(directory, blob)).toString()).toBe("hello world");
	const logs = evidence.refs.find(r => r.label.endsWith("Python验证日志"))!; expect((await readEvidence(directory, logs)).toString()).toContain("ordinary debug log");
});

test("templates accept correct artifacts and conversation, business failure and absent data differ", async () => {
	const { evidence } = await seed();
	expect((await verify(pythonReplyTemplate, evidence, { params: { contains: "Done" } })).status).toBe("pass");
	expect((await verify(pythonArtifactTemplate, evidence)).status).toBe("pass");
	expect((await verify(pythonConversationTemplate, evidence, { params: { contains: "Done" } })).status).toBe("pass");
	expect((await verify(pythonArtifactTemplate, evidence, { params: { contains: "not present" } })).status).toBe("fail");
	const partial = structuredClone(evidence); const ref = partial.refs.find(r => r.label === "Python验证输入 v2")!;
	const raw = JSON.parse((await readEvidence(directory, ref)).toString()); raw.conversation.status = "missing";
	const { saveEvidence } = await import("./evidence.js"); const id = await saveEvidence(directory, JSON.stringify(raw), "test input", partial.refs); partial.refs = partial.refs.filter(r => r.id !== ref.id); partial.refs.find(r => r.id === id)!.label = "Python验证输入 v2";
	expect((await verify(pythonReplyTemplate, partial, { required_inputs: ["conversation"] })).status).toBe("insufficient");
});

test("Python exceptions, contradictory results, timeout and log truncation are classified correctly", async () => {
	const { evidence } = await seed();
	expect((await verify("def verify(ctx):\n    raise RuntimeError('business verifier crashed')\n", evidence)).status).toBe("error");
	expect((await verify("def verify(ctx):\n    return {'verdict':'pass','message':'x','checks':[{'id':'bad','status':'fail','message':'no'}]}\n", evidence)).status).toBe("error");
	expect((await verify("import time\ndef verify(ctx):\n    time.sleep(3)\n    return {'verdict':'pass','message':'ok'}\n", evidence, { timeout: 100 })).status).toBe("error");
	expect((await verify("def verify(ctx):\n    print('x' * 1100000)\n    return {'verdict':'pass','message':'log is not the protocol'}\n", evidence)).status).toBe("pass");
	const controller = new AbortController(); setTimeout(() => controller.abort(), 600);
	expect((await verify("import time\ndef verify(ctx):\n    time.sleep(3)\n    return {'verdict':'pass','message':'ok'}\n", evidence, { signal: controller.signal })).status).toBe("skipped");
});

test("real SDK single/full task runs feed Python and history trials never request a model or alter grades", async () => {
	const old = process.env.EVAL_PYTHON_TEST_KEY; process.env.EVAL_PYTHON_TEST_KEY = "mock-only-key";
	let calls = 0;
	const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } }); } });
	const fixture = path.join(directory, "fixture"); await mkdir(fixture); await writeFile(path.join(fixture, "out.txt"), "hello world");
	const app = await createEvalServer({ storage: "sqlite", directory: path.join(directory, "data"), port: 0 }); const base = `http://127.0.0.1:${app.server.port}`;
	const post = (url: string, value: unknown) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
	const upload = async (content: string) => { const response = await post("/api/verifiers", { filename: "verify.py", content }); expect(response.status).toBe(201); return await response.json() as {id:string}; };
	try {
		const reply = await upload(pythonReplyTemplate); const artifacts = await upload(pythonArtifactTemplate);
		const defaults = { providerId: "openai-compatible", modelId: "gpt-4o-mini", apiKeyEnv: "EVAL_PYTHON_TEST_KEY", baseUrl: `http://127.0.0.1:${mock.port}/v1`, tools: "none", cwd: fixture, timeoutMs: 10000 };
		for (const mode of ["single-turn", "full-task"] as const) {
			const saved = app.store.createCase(app.store.activeModules()[0].id, defaults, { id: mode, prompt: "task", history: [], replayMode: mode, grading: { version: 1, rules: [{ id: "py", kind: "script", verifierId: mode === "single-turn" ? reply.id : artifacts.id, params: { contains: mode === "single-turn" ? "Done" : "hello world" }, required_inputs: mode === "single-turn" ? ["execution", "conversation"] : ["artifacts"] }] } });
			const response = await post("/api/runs", { caseIds: [saved.id] }); expect(response.status).toBe(202); const run = await response.json() as {id:string}; await app.queue.idle();
			const item = app.store.items(run.id)[0]; expect(item.status).toBe("passed"); expect(item.result?.grading?.results[0].checks?.length).toBeGreaterThan(0); expect(item.verifierSnapshots?.[0].pythonEnvironment?.environmentId).toBeTruthy();
			const original = JSON.stringify(item); const callCount = calls;
			const prefix = `/api/runs/${run.id}/items/${item.id}`;
			expect((await fetch(base + prefix + "/validation-input")).status).toBe(200);
			const trialResponse = await post(prefix + "/verifier-tests", { verifierId: reply.id, params: { contains: "Done" } }); expect(trialResponse.status).toBe(202); const trial = await trialResponse.json() as VerifierTest;
			let task: VerifierTest = trial;
			for (let n = 0; n < 100; n++) { task = await (await fetch(base + prefix + `/verifier-tests/${trial.id}`)).json() as VerifierTest; if (!["queued", "running"].includes(task.status)) break; await Bun.sleep(20); }
			expect(task.status).toBe("completed"); expect(task.result?.status).toBe("pass"); expect(calls).toBe(callCount); expect(JSON.stringify(app.store.items(run.id)[0])).toBe(original);
		}
		const broken = await post("/api/verifiers", { filename: "bad.py", content: "def verify(ctx)\n pass" }); expect(broken.status).toBe(400);
	} finally { await app.close(); mock.stop(true); if (old === undefined) delete process.env.EVAL_PYTHON_TEST_KEY; else process.env.EVAL_PYTHON_TEST_KEY = old; }
}, 30000);


test("missing Python is explicit and old history never reads mutable conversation", async () => {
    const old = process.env.EVAL_PYTHON_EXECUTABLE;
    try {
        process.env.EVAL_PYTHON_EXECUTABLE = path.join(directory, "missing-python");
        await expect(pythonEnvironment(true)).rejects.toThrow("Python 3.10+");
    } finally {
        if (old === undefined) delete process.env.EVAL_PYTHON_EXECUTABLE; else process.env.EVAL_PYTHON_EXECUTABLE = old;
        await pythonEnvironment(true);
    }
    await seed();
    const item = { id: "old", runId: "run", round: 1, result: execution(), snapshot: { definition: { id: "python", prompt: "task", replayMode: "single-turn" } } } as import("../web/types.js").RunItem;
    const original = JSON.stringify(item);
    const evidence = await historicalEvidence(directory, item);
    const { context } = await frozenValidationInput(directory, evidence);
    expect(context.execution.text).toBe("Done");
    expect(context.conversation.status).toBe("missing");
    expect(context.conversation.messages).toEqual([]);
    expect(JSON.stringify(item)).toBe(original);
});
