import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [
		{
			name: "browser-runtime-boundary",
			enforce: "pre",
			resolveId(source) {
				if (/^(node:|bun:|@cline\/(sdk|core|agents|llms)(\/|$))/.test(source))
					throw new Error(`浏览器代码不能导入服务端运行模块：${source}`);
				return null;
			},
		},
		react(),
	],
	build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: true },
	server: {
		host: "127.0.0.1",
		port: 5173,
		proxy: {
			"/api": {
				target: process.env.EVAL_API_ORIGIN ?? "http://127.0.0.1:3130",
				changeOrigin: true,
				configure(proxy) {
					proxy.on("proxyReq", (outgoing, incoming) => {
						const origin = incoming.headers.origin;
						// Translate only the development page's own origin. Cross-site requests
						// retain their origin and are rejected by the backend's existing checks.
						if (
							origin &&
							origin === `http://${incoming.headers.host}` &&
							/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)
						) {
							outgoing.setHeader(
								"origin",
								process.env.EVAL_API_ORIGIN ?? "http://127.0.0.1:3130",
							);
						}
					});
				},
			},
		},
	},
});
