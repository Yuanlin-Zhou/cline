import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvalServer } from "./server.js";
import { historyImportExamples } from "../history-import-examples.js";
import { runFunctionCall } from "../function-call.js";
import { readJsonBody } from "./json-body.js";

test("batch APIs validate all files before writing, preserve continuations and import atomically", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "batch-import-")),
		requests: any[] = [];
	const model = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			requests.push(await req.json());
			return Response.json({
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_now",
									type: "function",
									function: {
										name: "editor",
										arguments:
											'{"path":"/not-executed/demo.py","new_text":"world"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			});
		},
	});
	const app = await createEvalServer({ directory, port: 0, storage: "sqlite" });
	const base = `http://127.0.0.1:${app.server.port}`;
	const post = (route: string, body: any) =>
		fetch(base + route, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		const uploaded = await (
			await post("/api/verifiers", {
				filename: "verify.py",
				content:
					'def verify(ctx):\n    return {"verdict":"pass","message":"ok"}\n',
			})
		).json();
		const module = app.store.activeModules()[0];
		const raws = historyImportExamples.map((e) => JSON.parse(e.value));
		raws[1].messages.push({ role: "assistant", content: "EXISTING_ANSWER" });
		raws[2].messages.pop();
		const body: any = {
			moduleId: module.id,
			files: raws.map((v, i) => ({
				filename: `file-${i}.json`,
				content: JSON.stringify(v),
			})),
			options: {
				tools: ["editor"],
				continuation: "继续",
				verifierId: uploaded.id,
			},
			defaults: {
				providerId: "openai-compatible",
				modelId: "snapshot",
				baseUrl: `http://127.0.0.1:${model.port}/v1`,
				systemPrompt: "DEFAULT_NOT_DUPLICATED",
			},
			policy: "skip",
		};
		const bad = {
			...body,
			files: [...body.files, { filename: "invalid.json", content: "invalid" }],
		};
		const preview = await (
			await post("/api/import/conversations/preview", bad)
		).json();
		expect(preview.rows[3].error).toContain("invalid.json");
		expect(app.store.activeCases()).toHaveLength(0);
		expect(requests).toHaveLength(0);
		expect((await post("/api/import/conversations", bad)).status).toBe(422);
		expect(app.store.activeCases()).toHaveLength(0);
		const good = await (
			await post("/api/import/conversations/preview", body)
		).json();
		expect(good.rows.map((r: any) => r.appended)).toEqual([false, true, true]);
		expect(
			await (await post("/api/import/conversations", body)).json(),
		).toEqual({ created: 3, updated: 0, skipped: 0 });
		const cases = app.store.activeCases();
		for (const [i, c] of cases.entries()) {
			expect(c.definition).toEqual(good.rows[i].definition);
			expect(c.defaults.modelId).toBe("snapshot");
			expect(c.definition.grading?.rules[0]).toMatchObject({
				verifierId: uploaded.id,
			});
			const result = await runFunctionCall({
				definition: c.definition,
				defaults: c.defaults,
			});
			expect(result.toolCalls[0].output).toEqual({ not_executed: true });
			expect(requests[i].messages).toEqual([
				...c.definition.functionCall!.history!,
				{ role: "user", content: c.definition.prompt },
			]);
		}
		expect(requests[1].messages.at(-2).content).toBe("EXISTING_ANSWER");
		expect(requests[2].messages.at(-2).role).toBe("tool");
		expect(requests[0].messages.at(-1).content).toContain("world");
		expect(
			await (await post("/api/import/conversations", body)).json(),
		).toEqual({ created: 0, updated: 0, skipped: 3 });
		const frozen = app.store.createRun({
			caseIds: [cases[1].id],
			repeatCount: 1,
		});
		app.store.db.exec(
			`CREATE TRIGGER reject_batch BEFORE UPDATE ON records WHEN NEW.kind='case' AND json_extract(NEW.data,'$.definition.id')='file-1' BEGIN SELECT RAISE(ABORT,'injected'); END;`,
		);
		expect(
			(await post("/api/import/conversations", { ...body, policy: "version" }))
				.status,
		).toBe(400);
		expect(app.store.activeCases().every((c) => c.revision === 1)).toBe(true);
		app.store.db.exec("DROP TRIGGER reject_batch");
		expect(
			await (
				await post("/api/import/conversations", {
					...body,
					policy: "version",
					options: { ...body.options, continuation: "新版继续" },
				})
			).json(),
		).toEqual({ created: 0, updated: 3, skipped: 0 });
		expect(app.store.items(frozen.id)[0].snapshot.definition.prompt).toBe(
			"继续",
		);
		const js = await (
			await post("/api/verifiers", {
				filename: "verify.ts",
				content: "console.log('unused')",
			})
		).json();
		expect(
			(
				await post("/api/import/conversations", {
					...body,
					options: { ...body.options, verifierId: js.id },
				})
			).status,
		).toBe(422);
		app.store.archiveModule(module.id);
		expect((await post("/api/import/conversations", body)).status).toBe(404);
	} finally {
		await app.close();
		model.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("batch endpoints accept up to their limit while legacy APIs keep 8 MiB", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "batch-limits-"));
	const app = await createEvalServer({ directory, port: 0, storage: "sqlite" });
	try {
		const data = JSON.stringify({ junk: "x".repeat(8 * 1024 * 1024 + 1) });
		const send = (route: string) =>
			fetch(`http://127.0.0.1:${app.server.port}${route}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: data,
			});
		expect((await send("/api/modules")).status).toBe(413);
		expect((await send("/api/import/conversations/preview")).status).toBe(400);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("JSON byte limits count actual stream bytes and cancel oversized bodies", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode('{"long":"1234567890"}'));
		},
		cancel() {
			cancelled = true;
		},
	});
	await expect(
		readJsonBody(
			new Request("http://localhost", {
				method: "POST",
				body,
				duplex: "half",
			} as RequestInit),
			10,
		),
	).rejects.toThrow("请求体超过");
	expect(cancelled).toBe(true);
	expect(
		await readJsonBody(
			new Request("http://localhost", { method: "POST", body: '{"ok":true}' }),
			100,
		),
	).toEqual({ ok: true });
});
