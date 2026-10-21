import { CatalogError } from "./catalog.js";
/** Preserve the existing 8 MiB API limit while allowing bounded batch uploads. */
export async function readJsonBody(
	request: Request,
	limit = 8 * 1024 * 1024,
): Promise<any> {
	const reader = request.body?.getReader();
	if (!reader) throw new CatalogError("缺少 JSON 请求体");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel();
				throw new CatalogError(
					`请求体超过 ${limit / 1024 / 1024} MiB 限制`,
					413,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}
