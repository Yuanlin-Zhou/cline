import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvalServer } from "./server.js";
import { JudgeScores } from "./judge-scores.js";
import { parseJudgeConfig } from "../judge/config.js";
import { manifest } from "../grading/evidence.js";
import { freezeValidationInput } from "../grading/validation-context.js";
import type { EvalCaseResult } from "../types.js";
test("historical Judge preview is free; idempotent scoring has isolated auth, immutable source results and restart recovery", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "judge-http-"));
	let calls = 0,
		delay = 0;
	const headers: Headers[] = [];
	const model = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			calls++;
			headers.push(request.headers);
			const body = await request.json();
			if (delay) await Bun.sleep(delay);
			const text = JSON.stringify({
				status: "scored",
				score: 80,
				rationale: "结果正确",
				evidence: [{ ref: "result.final_response" }],
			});
			return new Response(
				`data: ${JSON.stringify({ id: "mock", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "mock", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const old = process.env.JUDGE_HTTP_AUTH;
	process.env.JUDGE_HTTP_AUTH = "Bearer trial-http-token";
	const app = await createEvalServer({
		directory,
		port: 0,
		execute: async (item) => ({
			id: item.snapshot.definition.id,
			status: "passed",
			sessionId: item.id,
			text: "FINAL RESULT",
			durationMs: 1,
			iterations: 1,
			usage: { inputTokens: 0, outputTokens: 0 },
			toolCalls: [],
			assertions: [],
			execution: { status: "completed" },
		}),
	});
	const origin = `http://127.0.0.1:${app.server.port}`;
	const json = (body: unknown) => ({
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	try {
		const config = parseJudgeConfig({
			enabled: true,
			referenceAnswer: "expected answer",
			targets: ["result"],
			model: {
				providerId: "openai-compatible",
				modelId: "gpt-4o-mini",
				baseUrl: `http://127.0.0.1:${model.port}/v1`,
				headersEnv: { Authorization: "JUDGE_HTTP_AUTH" },
			},
		})!;
		const actorSettings = app.store.settings();
		const saved = await fetch(`${origin}/api/judge-settings`, {
			...json(config.model),
			method: "PUT",
		});
		expect(saved.status).toBe(200);
		expect(app.store.settings()).toEqual(actorSettings);
		const caseResponse = await fetch(
			`${origin}/api/cases`,
			json({
				moduleId: app.store.activeModules()[0].id,
				defaults: actorSettings,
				definition: {
					id: "judge-case",
					prompt: "task",
					history: [],
					llmJudge: config,
				},
			}),
		);
		expect(caseResponse.status).toBe(201);
		const c = await caseResponse.json();
		const run = app.store.createRun({ caseIds: [c.id] });
		app.queue.kick();
		await app.queue.idle();
		const item = app.store.items(run.id)[0];
		const evidence = manifest();
		await freezeValidationInput({
			directory: path.join(directory, "runs", run.id, item.id),
			definition: item.snapshot.definition,
			result: item.result!,
			evidence,
			secrets: [],
		});
		item.result!.evidence = evidence;
		app.store.put("item", item.id, item);
		const original = JSON.stringify(app.store.detail(run.id));
		const base = `${origin}/api/runs/${run.id}/items/${item.id}/judge-scores`;
		const preview = await fetch(`${base}/preview`, json({ config }));
		expect(preview.status).toBe(200);
		expect((await preview.json()).input.sources.map((s: any) => s.id)).toEqual([
			"result.final_response",
		]);
		expect(calls).toBe(0);
		const body = { requestId: "same-request", config };
		const [a, b] = await Promise.all([
			fetch(base, json(body)),
			fetch(base, json(body)),
		]);
		expect(a.status).toBe(202);
		expect(b.status).toBe(202);
		const task = await a.json();
		expect((await b.json()).id).toBe(task.id);
		const wait = async (id: string) => {
			for (let i = 0; i < 100; i++) {
				const t = await (await fetch(`${base}/${id}`)).json();
				if (!["queued", "running"].includes(t.status)) return t;
				await Bun.sleep(20);
			}
			throw Error("score did not settle");
		};
		const completed = await wait(task.id);
		expect(completed.result).toMatchObject({
			status: "scored",
			score: 80,
			usage: { inputTokens: 10, outputTokens: 8 },
		});
		expect(calls).toBe(1);
		expect(headers[0].get("authorization")).toBe("Bearer trial-http-token");
		expect(
			(await (await fetch(`${base}/${task.id}?input=1`)).json()).input
				.referenceAnswer,
		).toBe("expected answer");
		expect(
			JSON.stringify(await (await fetch(`${base}/${task.id}`)).json()),
		).not.toContain("trial-http-token");
		expect((await fetch(base, json(body))).status).toBe(202);
		expect(
			(
				await fetch(
					base,
					json({ ...body, config: { ...config, referenceAnswer: "changed" } }),
				)
			).status,
		).toBe(409);
		expect(calls).toBe(1);
		expect(JSON.stringify(app.store.detail(run.id))).toBe(original);
		const report = await (await fetch(`${origin}/api/runs/${run.id}`)).json();
		expect(report.judgeSummary.scored).toBe(0);
		expect(report.summary.tokens).toBe(0);
		expect(
			await (
				await fetch(`${origin}/api/runs/${run.id}/export?format=csv`)
			).text(),
		).toContain('"judge_score"');
		delay = 2000;
		const next = await (
			await fetch(base, json({ requestId: "cancel-request", config }))
		).json();
		await fetch(`${base}/${next.id}/cancel`, json({}));
		expect((await wait(next.id)).status).toBe("cancelled");
		expect(JSON.stringify(app.store.detail(run.id))).toBe(original);
		app.store.put("judge-score", "interrupted", {
			...completed,
			id: "interrupted",
			status: "running",
		});
		const recovered = new JudgeScores(app.store);
		expect(recovered.get("interrupted", item)).toMatchObject({
			status: "error",
			error: "服务重启，试评分已中断；不会自动再次调用模型",
		});
		await recovered.close();
		const copied = app.store.duplicateCase(c.id);
		expect(copied.definition.llmJudge).toEqual(c.definition.llmJudge);
		expect(copied.id).not.toBe(c.id);
	} finally {
		await app.close();
		model.stop(true);
		if (old === undefined) delete process.env.JUDGE_HTTP_AUTH;
		else process.env.JUDGE_HTTP_AUTH = old;
		await rm(directory, { recursive: true, force: true });
	}
}, 15000);
