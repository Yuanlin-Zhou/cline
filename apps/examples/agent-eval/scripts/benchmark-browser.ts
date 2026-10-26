/** Read-only UI timing against an explicitly supplied local fixture server. No eval submission. */
import { writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import path from "node:path";
const args = process.argv.slice(2),
	arg = (name: string, fallback = "") =>
		args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1) ??
		fallback;
const origin = arg("--url"),
	module = arg("--playwright", "playwright"),
	samples = Number(arg("--samples", "30"));
if (!origin || !Number.isInteger(samples) || samples < 1)
	throw Error(
		"Specify --url=http://127.0.0.1:PORT --samples=30 [--playwright=/path/to/playwright/index.mjs] [--chromium=/path/to/chromium]",
	);
const { chromium } = await import(module);
const browser = await chromium.launch({
	...(arg("--chromium") ? { executablePath: arg("--chromium") } : {}),
	headless: true,
	args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
	cdp = await page.context().newCDPSession(page),
	results: any[] = [];
const runs = (await (await fetch(origin + "/api/runs")).json()) as any[],
	run = runs.find(
		(r) =>
			r.status === "completed" &&
			r.summary.failed +
				r.summary.error +
				r.summary.inconclusive +
				r.summary.cancelled >
				0,
	);
if (!run)
	throw Error(
		"Fixture needs a completed batch with retryable failures; this script never creates runs",
	);
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(String(e)));
const percentile = (values: number[], p: number) =>
	[...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
await page.addInitScript(() => {
	(window as any).benchmarkTasks = [];
	new PerformanceObserver((list) => {
		for (const task of list.getEntries())
			(window as any).benchmarkTasks.push({
				start: task.startTime,
				duration: task.duration,
			});
	}).observe({ type: "longtask", buffered: true });
});
try {
	await page.goto(origin + "/#/settings");
	await page.locator("#global-judge-provider").waitFor({state:"attached"});
	for (const rate of [1, 4]) {
		await cdp.send("Emulation.setCPUThrottlingRate", { rate });
		for (const [label, hash, ready] of [
			["cases", "#/cases", ".CaseTable tbody tr"],
			["batch", `#/run/${run.id}`, ".Inspector-title"],
			["new-run", "#/run/new", ".Steps"],
			["retry-preview", `#/run/${run.id}`, ".Inspector-title"],
		]) {
			const values: number[] = [],
				tasks: number[] = [];
			for (let i = 0; i < samples + 1; i++) {
				await page.evaluate(() => {
					location.hash = "#/settings";
				});
				await page.locator("#global-judge-provider").waitFor({state:"attached"});
				const start = performance.now();
				await page.evaluate((hash: string) => {
					(window as any).benchmarkTasks = [];
					location.hash = hash;
				}, hash);
				await page.locator(ready).first().waitFor();
				if (label === "retry-preview") {
					const before = performance.now();
					await page
						.getByRole("button", { name: "重试未通过案例", exact: true })
						.click();
					await page.getByRole("button", { name: /^重试 \d+ 次执行/ }).waitFor();
					if (i) values.push(performance.now() - before);
					await page.getByRole("button", { name: "取消", exact: true }).click();
				} else {
					await page.evaluate(
						() =>
							new Promise((resolve) =>
								requestAnimationFrame(() => requestAnimationFrame(resolve)),
							),
					);
					if (i) values.push(performance.now() - start);
				}
				if (i)
					tasks.push(
						...(await page.evaluate(() =>
							(window as any).benchmarkTasks.map((t: any) => t.duration),
						)),
					);
			}
			const result = {
				label,
				cpuThrottling: rate,
				samples,
				p50Ms: percentile(values, 0.5),
				p95Ms: percentile(values, 0.95),
				maxLongTaskMs: tasks.length ? Math.max(...tasks) : 0,
			};
			results.push(result);
			console.log(JSON.stringify(result));
		}
	}
	if (errors.length) throw Error(errors.join("\n"));
	await writeFile(
		path.resolve(arg("--output", "browser-performance-results.json")),
		JSON.stringify(
			{
				url: origin,
				browser: browser.version(),
				cpu: cpus()[0]?.model,
				memoryBytes: totalmem(),
				runId: run.id,
				results,
			},
			null,
			2,
		),
	);
} finally {
	await browser.close();
}
