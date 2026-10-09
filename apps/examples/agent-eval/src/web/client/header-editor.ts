import { parseHeaderConfig, type HeaderConfig } from "../../headers.js";

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

export function headerEditor(
	id: string,
	initial: HeaderConfig,
	title = "自定义模型请求头",
): HTMLElement {
	const section = document.createElement("section");
	section.id = id;
	const heading = document.createElement("div");
	heading.className = "section-title";
	heading.textContent = title;
	const hint = document.createElement("p");
	hint.className = "form-hint";
	hint.textContent =
		"Authorization 等凭据请选择环境变量，填写服务端变量名。固定值支持 {{sessionId}}、{{caseId}}、{{evaluationId}}；evaluationId 标识一次案例执行，完整任务中的模型调用复用该值。";
	const rows = document.createElement("div");
	rows.dataset.headerRows = "";
	const addRow = (entry: HeaderRow) => {
		const row = document.createElement("div");
		row.className = "form-row";
		row.dataset.headerRow = "";
		const name = document.createElement("input");
		name.className = "form-control";
		name.value = entry.name;
		name.placeholder = "x-session-id";
		name.setAttribute("aria-label", "请求头名称");
		name.dataset.headerName = "";
		const source = document.createElement("select");
		source.className = "form-control";
		source.setAttribute("aria-label", "请求头值来源");
		source.dataset.headerSource = "";
		for (const [value, label] of [
			["literal", "固定值"],
			["env", "环境变量"],
		]) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			source.append(option);
		}
		source.value = entry.source;
		const value = document.createElement("input");
		value.className = "form-control";
		value.value = entry.value;
		value.dataset.headerValue = "";
		value.setAttribute("aria-label", "请求头固定值或环境变量名");
		const updateHint = () => {
			value.placeholder =
				source.value === "env"
					? "EVAL_AUTHORIZATION（变量名）"
					: "{{sessionId}}";
		};
		source.onchange = updateHint;
		updateHint();
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "btn btn-sm";
		remove.textContent = "删除";
		remove.onclick = () => row.remove();
		row.append(name, source, value, remove);
		rows.append(row);
	};
	for (const [name, value] of Object.entries(initial.headers ?? {}))
		addRow({ name, value, source: "literal" });
	for (const [name, value] of Object.entries(initial.headersEnv ?? {}))
		addRow({ name, value, source: "env" });
	const add = document.createElement("button");
	add.type = "button";
	add.className = "btn btn-sm";
	add.textContent = "添加请求头";
	add.onclick = () => addRow({ name: "", value: "", source: "literal" });
	section.append(heading, hint, rows, add);
	return section;
}

export function readHeaderEditor(id: string): HeaderConfig {
	const section = document.getElementById(id);
	if (!section) return {};
	return headersFromRows(
		[...section.querySelectorAll<HTMLElement>("[data-header-row]")].map(
			(row) => ({
				name: row.querySelector<HTMLInputElement>("[data-header-name]")!.value,
				source: row.querySelector<HTMLSelectElement>("[data-header-source]")!
					.value as HeaderRow["source"],
				value: row.querySelector<HTMLInputElement>("[data-header-value]")!
					.value,
			}),
		),
	);
}
