import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the real packaged SDK against a local mock endpoint, without API keys
// or provider requests. All generated session state stays in a temporary folder.
const packageRoot = process.argv[2];
if (!packageRoot)
	throw new Error("Pass the extracted release package directory");
const stateRoot = await mkdtemp(
	path.join(os.tmpdir(), "cline-eval-runtime-smoke-"),
);
process.env.CLINE_DATA_DIR = stateRoot;
process.env.CLINE_SANDBOX = "1";
process.env.CLINE_SANDBOX_DATA_DIR = stateRoot;
process.env.CLINE_LOG_ENABLED = "0";
process.env.CLINE_EVAL_SMOKE_KEY = "local-mock-not-a-real-key";

const requests: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		requests.push(await request.text());
		const chunks = [
			{
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "Use Bun" },
						finish_reason: null,
					},
				],
			},
			{
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
			},
		]
			.map(
				(chunk) =>
					`data: ${JSON.stringify({ id: "local-smoke", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", ...chunk })}\n\n`,
			)
			.join("");
		return new Response(`${chunks}data: [DONE]\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	},
});

try {
	const { runEvalSuite } = await import(
		pathToFileURL(path.join(packageRoot, "dist/runner.js")).href
	);
	const report = await runEvalSuite({
		suite: {
			version: 1,
			defaults: {
				providerId: "openai-compatible",
				modelId: "gpt-4o-mini",
				apiKeyEnv: "CLINE_EVAL_SMOKE_KEY",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				cwd: stateRoot,
				tools: "none",
				maxIterations: 2,
				timeoutMs: 10000,
			},
			cases: [
				{
					id: "local-smoke",
					history: [
						{ role: "user", content: "Use Bun in this project" },
						{ role: "assistant", content: "Understood" },
					],
					prompt: "Which package manager?",
					assertions: { contains: ["Bun"] },
				},
			],
		},
		suitePath: path.join(stateRoot, "suite.json"),
		overrides: { stream: false },
	});
	if (report.summary.passed !== 1) throw new Error(JSON.stringify(report));
	if (
		!requests.some(
			(body) =>
				body.includes("Use Bun in this project") &&
				body.includes("Which package manager?"),
		)
	) {
		throw new Error(
			"The provider request did not contain the seeded history and current prompt",
		);
	}
	console.log(
		JSON.stringify({
			passed: true,
			requests: requests.length,
			text: report.cases[0].text,
			stateRoot,
		}),
	);
} finally {
	server.stop(true);
}
