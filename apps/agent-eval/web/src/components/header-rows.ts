import {
	parseHeaderConfig,
	type HeaderConfig,
} from "../../../src/contracts/headers.js";

export type HeaderRow = {
	name: string;
	source: "literal" | "env";
	value: string;
};

export function headersFromRows(rows: HeaderRow[]): HeaderConfig {
	const headers: Array<[string, string]> = [];
	const headersEnv: Array<[string, string]> = [];
	const names = new Set<string>();
	for (const row of rows) {
		const name = row.name.trim();
		if (names.has(name.toLowerCase()))
			throw new Error(`请求头 ${name} 重复（名称不区分大小写）`);
		names.add(name.toLowerCase());
		(row.source === "env" ? headersEnv : headers).push([name, row.value]);
	}
	return parseHeaderConfig(
		{
			...(headers.length ? { headers: Object.fromEntries(headers) } : {}),
			...(headersEnv.length
				? { headersEnv: Object.fromEntries(headersEnv) }
				: {}),
		},
		"请求头",
	);
}
