import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvalServer } from "../src/api/server.js";

// Isolated browser acceptance service. All provider traffic remains on loopback.
const port = Number(process.env.EVAL_BROWSER_PORT ?? 3310);
const directory = await mkdtemp(path.join(os.tmpdir(), "agent-eval-browser-"));
process.env.EVAL_BROWSER_KEY = "local-mock-not-a-real-key";
const requests: unknown[] = [];
const model = Bun.serve({
	hostname: "127.0.0.1",
	port: port + 1,
	async fetch(request) {
		if (new URL(request.url).pathname === "/requests")
			return Response.json(requests);
		const body = (await request.json()) as Record<string, any>;
		requests.push(body);
		const content =
			body.model === "ui-judge"
				? JSON.stringify({
						status: "scored",
						score: 90,
						rationale: "符合参考答案",
						evidence: [{ ref: "result.final_response" }],
					})
				: "Use Bun. 已完成验证。";
		if (body.stream) {
			const chunks = [
				{
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content },
							finish_reason: null,
						},
					],
				},
				{
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
				},
			];
			return new Response(
				chunks
					.map(
						(c) =>
							`data: ${JSON.stringify({ id: "ui-mock", object: "chat.completion.chunk", model: body.model, ...c })}\n\n`,
					)
					.join("") + "data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		const message = body.tools?.length
			? {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_ui",
							type: "function",
							function: {
								name: "read_files",
								arguments: '{"paths":["README.md"]}',
							},
						},
					],
				}
			: { role: "assistant", content };
		return Response.json({
			id: "ui-mock",
			choices: [
				{
					index: 0,
					message,
					finish_reason: body.tools?.length ? "tool_calls" : "stop",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
		});
	},
});
const app = await createEvalServer({ directory, port, storage: "sqlite" });
console.log(`Browser acceptance → http://127.0.0.1:${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		void app.close().then(async () => {
			model.stop(true);
			await rm(directory, { recursive: true, force: true });
			process.exit(0);
		});
	});
