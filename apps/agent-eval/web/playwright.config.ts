import { defineConfig } from "@playwright/test";

const port = Number(process.env.EVAL_BROWSER_PORT ?? 3310);
export default defineConfig({
	testDir: "./checks",
	testMatch: "browser.ts",
	workers: 1,
	timeout: 90000,
	expect: { timeout: 10000 },
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		viewport: { width: 1440, height: 900 },
		headless: true,
		launchOptions: {
			...(process.env.CHROMIUM_EXECUTABLE
				? { executablePath: process.env.CHROMIUM_EXECUTABLE }
				: {}),
			args: ["--no-sandbox"],
		},
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	outputDir: "../test-results/browser",
	webServer: {
		command: "bun run build:web && bun scripts/browser-server.ts",
		cwd: "..",
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
		timeout: 60000,
	},
});
