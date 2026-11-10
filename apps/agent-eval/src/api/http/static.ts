import path from "node:path";
import { fileURLToPath } from "node:url";

export const webDirectory = fileURLToPath(
	new URL("../../../dist/web/", import.meta.url),
);
export async function staticResponse(
	request: Request,
	url: URL,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed", { status: 405 });
	const relative =
		url.pathname === "/"
			? "index.html"
			: decodeURIComponent(url.pathname).replace(/^\/+/, "");
	const target = path.resolve(webDirectory, relative);
	if (!target.startsWith(path.resolve(webDirectory) + path.sep))
		return new Response("Not found", { status: 404 });
	const file = Bun.file(target);
	if (!(await file.exists())) {
		return new Response(
			relative === "index.html"
				? "前端资源不存在，请运行 bun run build:web 后启动。"
				: "Not found",
			{ status: relative === "index.html" ? 503 : 404 },
		);
	}
	const headers = {
		"Content-Type": file.type,
		"Cache-Control": relative.startsWith("assets/")
			? "public, max-age=31536000, immutable"
			: "no-store",
		"Content-Security-Policy":
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
		"X-Content-Type-Options": "nosniff",
	};
	return new Response(request.method === "HEAD" ? null : file, { headers });
}
