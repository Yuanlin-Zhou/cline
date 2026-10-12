import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
	prepareExecutionWorkspace,
	directWorkspace,
	archivedArtifactText,
} from "./web/workspace.js";
import { workspaceLease } from "./web/workspace-lease.js";
import { parseEvalSuite } from "./schema.js";
import { manifest, snapshot } from "./grading/evidence.js";
import { caseToDocument, caseFromDocument } from "./web/mongo-schema.js";
import { createEvalServer } from "./web/server.js";
import { runProcess } from "./grading/process.js";

test("configuration and Mongo contract preserve whole-case overrides and reject invalid settings", () => {
	const suite = parseEvalSuite({
		defaults: { workspace: { mode: "copy", copyRoot: "/copies" } },
		cases: [
			{
				id: "x",
				prompt: "task",
				replayMode: "full-task",
				cwd: "/work",
				workspace: { mode: "direct" },
			},
		],
	});
	expect(suite.defaults.workspace).toEqual({
		mode: "copy",
		copyRoot: "/copies",
	});
	expect(suite.cases[0].workspace).toEqual({ mode: "direct" });
	for (const workspace of [
		{ mode: "unknown" },
		{ mode: "direct", copyRoot: "/x" },
		{ mode: "copy", copyRoot: "" },
		{ mode: "copy", unknown: true },
	])
		expect(() =>
			parseEvalSuite({ cases: [{ id: "x", prompt: "x", workspace }] }),
		).toThrow();
	const saved = {
		id: "x",
		moduleId: "m",
		revision: 1,
		updatedAt: new Date().toISOString(),
		definition: suite.cases[0],
		defaults: suite.defaults,
	};
	expect(caseFromDocument(caseToDocument(saved)).definition.workspace).toEqual({
		mode: "direct",
	});
});

test("default/custom copies isolate changes, direct preserves real files, and snapshots never follow later changes", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workspace-policy-"));
	try {
		const source = path.join(root, "source");
		await mkdir(source);
		await writeFile(path.join(source, "a.txt"), "before");
		const dirs = ["default", "custom1", "custom2", "direct"].map((n) =>
			path.join(root, "runs", n),
		);
		for (const d of dirs) await mkdir(d, { recursive: true });
		const standard = await prepareExecutionWorkspace(dirs[0], source);
		expect(standard.path).toBe(path.join(dirs[0], "workspace"));
		const copyRoot = path.join(root, "copies");
		const first = await prepareExecutionWorkspace(dirs[1], source, {
			mode: "copy",
			copyRoot,
		});
		const second = await prepareExecutionWorkspace(dirs[2], source, {
			mode: "copy",
			copyRoot,
		});
		expect(first.path).not.toBe(second.path);
		expect(first.path.startsWith(copyRoot)).toBe(true);
		await writeFile(path.join(first.path, "a.txt"), "copy-change");
		expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("before");
		expect(await readFile(path.join(second.path, "a.txt"), "utf8")).toBe(
			"before",
		);
		const direct = await prepareExecutionWorkspace(dirs[3], source, {
			mode: "direct",
		});
		expect(direct.path).toBe(source);
		const evidence = manifest();
		await snapshot(source, dirs[3], "baseline", evidence, []);
		await writeFile(path.join(source, "a.txt"), "after");
		await snapshot(source, dirs[3], "artifacts", evidence, []);
		await writeFile(path.join(source, "a.txt"), "later");
		expect(await archivedArtifactText(dirs[3], evidence, "a.txt")).toEqual({
			before: "before",
			after: "after",
		});
		await expect(directWorkspace(undefined, dirs[3])).rejects.toThrow("cwd");
		await expect(directWorkspace(root, dirs[3])).rejects.toThrow("相互包含");
		await expect(
			prepareExecutionWorkspace(dirs[0], source, {
				mode: "copy",
				copyRoot: path.join(source, "nested"),
			}),
		).rejects.toThrow("相互包含");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("same or nested direct directories wait, disjoint directories proceed, aborted waits release", async () => {
	const release = await workspaceLease("/tmp/lease-a");
	let entered = false;
	const pending = workspaceLease("/tmp/lease-a/child").then((r) => {
		entered = true;
		return r;
	});
	const different = await workspaceLease("/tmp/lease-b");
	expect(entered).toBe(false);
	different();
	const controller = new AbortController();
	const cancelled = workspaceLease("/tmp/lease-a", controller.signal);
	controller.abort();
	await expect(cancelled).rejects.toThrow();
	release();
	const done = await pending;
	expect(entered).toBe(true);
	done();
	const again = await workspaceLease("/tmp/lease-a");
	again();
});

test("Web direct editor mutates real directory, custom copy leaves source intact, artifacts remain frozen, and CLI does not recurse", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workspace-native-"));
	const old = process.env.EVAL_WORKSPACE_KEY;
	process.env.EVAL_WORKSPACE_KEY = "mock";
	let calls = 0;
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			calls++;
			const body = await request.json();
			const toolsDone = body.messages.some((m: any) => m.role === "tool");
			let target = JSON.stringify(body.messages).match(
				/TARGET:([^\s"\\]+)/,
			)?.[1];
			if (!target) throw Error("missing target");
			if (target === "a.txt") {
				const item = app.store
					.list<any>("item")
					.find(
						(i) =>
							i.status === "running" && i.snapshot.definition.id === "copy",
					);
				if (!item?.workspace) throw Error("copy workspace missing");
				target = path.join(item.workspace, "a.txt");
			}
			const done = toolsDone || !body.tools?.length;
			const delta = done
				? { content: "Done" }
				: {
						tool_calls: [
							{
								index: 0,
								id: "call-editor",
								type: "function",
								function: {
									name: "editor",
									arguments: JSON.stringify({
										path: target,
										new_text: "updated\n",
										old_text: "original\n",
									}),
								},
							},
						],
					};
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const app = await createEvalServer({
		storage: "sqlite",
		directory: path.join(root, "data"),
		port: 0,
	});
	const base = `http://127.0.0.1:${app.server.port}`;
	const post = (route: string, value: unknown) =>
		fetch(base + route, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(value),
		});
	try {
		const source = path.join(root, "source");
		await mkdir(source);
		await writeFile(path.join(source, "a.txt"), "original\n");
		const defaults = {
			providerId: "openai-compatible",
			modelId: "gpt-4o-mini",
			apiKeyEnv: "EVAL_WORKSPACE_KEY",
			baseUrl: `http://127.0.0.1:${mock.port}/v1`,
			tools: "full" as const,
			timeoutMs: 15000,
			maxIterations: 3,
		};
		// The prompt uses an absolute path for direct execution; copies use a model that targets the effective cwd supplied in system context below.
		const direct = app.store.createCase(
			app.store.activeModules()[0].id,
			defaults,
			{
				id: "direct",
				prompt: `Use editor once to change original to updated in TARGET:${path.join(source, "a.txt")}`,
				history: [],
				replayMode: "full-task",
				cwd: source,
				workspace: { mode: "direct" },
				grading: {
					version: 1,
					rules: [
						{
							id: "content",
							kind: "file.text",
							path: "a.txt",
							op: "contains",
							expected: "updated",
						},
					],
				},
			},
		);
		const response = await post("/api/runs", { caseIds: [direct.id] });
		expect(response.status).toBe(202);
		const run = await response.json();
		await app.queue.idle();
		const item = app.store.items(run.id)[0];
		expect(item.status).toBe("passed");
		expect(item.workspace).toBe(source);
		expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe(
			"updated\n",
		);
		const uri = `/api/runs/${run.id}/artifacts?item=${item.id}`;
		expect((await (await fetch(base + uri + "&file=a.txt")).json()).after).toBe(
			"updated\n",
		);
		await writeFile(path.join(source, "a.txt"), "changed by human\n");
		expect((await (await fetch(base + uri + "&file=a.txt")).json()).after).toBe(
			"updated\n",
		);
		// The mock emits the editor absolute path in the effective copied workspace, not the source.
		await writeFile(path.join(source, "a.txt"), "original\n");
		const copy = app.store.createCase(
			app.store.activeModules()[0].id,
			defaults,
			{
				id: "copy",
				prompt: "TARGET:a.txt",
				history: [],
				replayMode: "full-task",
				cwd: source,
				workspace: { mode: "copy", copyRoot: path.join(root, "copies") },
				grading: {
					version: 1,
					rules: [
						{
							id: "content",
							kind: "file.text",
							path: "a.txt",
							op: "contains",
							expected: "updated",
						},
					],
				},
			},
		);
		const copyRun = await (
			await post("/api/runs", { caseIds: [copy.id] })
		).json();
		await app.queue.idle();
		const copied = app.store.items(copyRun.id)[0];
		expect(copied.workspace!.startsWith(path.join(root, "copies"))).toBe(true);
		expect(copied.status).toBe("passed");
		expect(
			(
				await (
					await fetch(
						base +
							`/api/runs/${copyRun.id}/artifacts?item=${copied.id}&file=a.txt`,
					)
				).json()
			).before,
		).toBe("original\n");
		expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe(
			"original\n",
		);
		const cliSuite = path.join(root, "cli.json");
		await writeFile(
			cliSuite,
			JSON.stringify({
				defaults: { ...defaults, tools: "none" },
				cases: [
					{
						id: "cli-copy",
						prompt: `TARGET:${path.join(source, "a.txt")}`,
						history: [],
						replayMode: "full-task",
						cwd: source,
						workspace: {
							mode: "copy",
							copyRoot: path.join(root, "cli-copies"),
						},
					},
				],
			}),
		);
		const output = path.join(root, "cli-out.json");
		const before = calls;
		const cli = await runProcess(
			process.execPath,
			[path.resolve(import.meta.dir, "index.ts"), cliSuite, "--output", output],
			{
				cwd: root,
				env: { ...process.env, EVAL_DATA_DIR: path.join(root, "cli-data") },
				timeoutMs: 30000,
			},
		);
		if (cli.code !== 0)
			throw Error(
				JSON.stringify({
					code: cli.code,
					stderr: cli.stderr,
					stdout: cli.stdout,
				}),
			);
		expect(cli.code).toBe(0);
		expect(cli.timedOut).toBe(false);
		const report = JSON.parse(await readFile(output, "utf8"));
		expect(
			report.cases[0].workspaceInfo.path.startsWith(
				path.join(root, "cli-copies"),
			),
		).toBe(true);
		expect(calls - before).toBe(1);
	} finally {
		await app.close();
		mock.stop(true);
		await rm(root, { recursive: true, force: true });
		if (old === undefined) delete process.env.EVAL_WORKSPACE_KEY;
		else process.env.EVAL_WORKSPACE_KEY = old;
	}
}, 90000);

test("direct repeated rounds use updated baselines; cancelling after a write retains it and releases the directory", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workspace-repeat-"));
	const source = path.join(root, "source");
	await mkdir(source);
	const target = path.join(source, "counter.txt");
	await writeFile(target, "0\n");
	const old = process.env.EVAL_WORKSPACE_REPEAT_KEY;
	process.env.EVAL_WORKSPACE_REPEAT_KEY = "mock";
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = await request.json();
			const done =
				body.messages.some((m: any) => m.role === "tool") ||
				!body.tools?.length;
			if (done && JSON.stringify(body.messages).includes("slow-after-write"))
				await Bun.sleep(1500);
			const before = await readFile(target, "utf8");
			const delta = done
				? { content: "Done" }
				: {
						tool_calls: [
							{
								index: 0,
								id: "counter-edit",
								type: "function",
								function: {
									name: "editor",
									arguments: JSON.stringify({
										path: target,
										old_text: before,
										new_text: `${Number(before.trim()) + 1}\n`,
									}),
								},
							},
						],
					};
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const app = await createEvalServer({
		storage: "sqlite",
		directory: path.join(root, "data"),
		port: 0,
	});
	const base = `http://127.0.0.1:${app.server.port}`;
	const post = (value: unknown) =>
		fetch(base + "/api/runs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(value),
		});
	try {
		const defaults = {
			providerId: "openai-compatible",
			modelId: "gpt-4o-mini",
			apiKeyEnv: "EVAL_WORKSPACE_REPEAT_KEY",
			baseUrl: `http://127.0.0.1:${mock.port}/v1`,
			tools: "full" as const,
			timeoutMs: 15000,
			maxIterations: 3,
		};
		const module = app.store.activeModules()[0];
		const definition = {
			id: "repeat-direct",
			replayMode: "full-task" as const,
			prompt: "increment counter",
			history: [],
			cwd: source,
			workspace: { mode: "direct" as const },
		};
		const c = app.store.createCase(module.id, defaults, definition);
		const run = await (await post({ caseIds: [c.id], repeatCount: 2 })).json();
		await app.queue.idle();
		const items = app.store.items(run.id);
		expect(items.map((i) => i.status)).toEqual(["passed", "passed"]);
		expect(await readFile(target, "utf8")).toBe("2\n");
		for (const [i, item] of items.entries()) {
			const data = await (
				await fetch(
					base +
						`/api/runs/${run.id}/artifacts?item=${item.id}&file=counter.txt`,
				)
			).json();
			expect(data).toEqual({ before: `${i}\n`, after: `${i + 1}\n` });
		}
		const cancelCase = app.store.createCase(module.id, defaults, {
			...definition,
			id: "cancel-direct",
			prompt: "slow-after-write increment",
		});
		const cancelled = await (await post({ caseIds: [cancelCase.id] })).json();
		for (let n = 0; n < 300; n++) {
			if ((await readFile(target, "utf8")) === "3\n") break;
			await Bun.sleep(20);
		}
		expect(await readFile(target, "utf8")).toBe("3\n");
		app.queue.cancel(cancelled.id);
		await app.queue.idle();
		expect(app.store.items(cancelled.id)[0].status).toBe("cancelled");
		expect(await readFile(target, "utf8")).toBe("3\n");
		const after = app.store.createCase(
			module.id,
			{ ...defaults, tools: "none" },
			{ ...definition, id: "after-cancel" },
		);
		const next = await (await post({ caseIds: [after.id] })).json();
		await app.queue.idle();
		expect(app.store.items(next.id)[0].status).toBe("passed");
		expect(await readFile(target, "utf8")).toBe("3\n");
	} finally {
		await app.close();
		mock.stop(true);
		await rm(root, { recursive: true, force: true });
		if (old === undefined) delete process.env.EVAL_WORKSPACE_REPEAT_KEY;
		else process.env.EVAL_WORKSPACE_REPEAT_KEY = old;
	}
}, 90000);
