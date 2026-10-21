import { test, expect } from "bun:test";
import os from "node:os";
import {
	pythonEnvironment,
	pythonSourceCheck,
	processEnvironment,
} from "./python-runtime.js";
import { runProcess } from "./process.js";

test("UTF-8 source checks survive Windows-style GBK stdin without executing source", async () => {
	const environment = await pythonEnvironment();
	const source =
		'raise RuntimeError("must not execute")\ndef verify(ctx):\n    """验证器：返回结果 ✅"""\n    return {"verdict":"pass","message":"中文结果 ✅"}\n';
	const run = (code: string, stdin = source) =>
		runProcess(
			environment.command,
			["-I", "-c", `import sys;sys.stdin.reconfigure(encoding="gbk");${code}`],
			{ cwd: os.tmpdir(), env: processEnvironment(), timeoutMs: 5000, stdin },
		);
	const old = await run("import ast;ast.parse(sys.stdin.read())");
	expect(old.code).not.toBe(0);
	expect(old.stderr).toMatch(/UnicodeDecodeError|SyntaxError/);
	const checked = await run(pythonSourceCheck);
	expect(checked.code).toBe(0);
	expect((await run(pythonSourceCheck, "\uFEFF" + source)).code).toBe(0);
	expect(
		(await run(pythonSourceCheck, "def verify(ctx)\n    pass")).code,
	).not.toBe(0);
	expect(
		(await run(pythonSourceCheck, "def different(ctx):\n    pass")).code,
	).not.toBe(0);
});
