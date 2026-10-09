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
	section.className = "HeaderEditor";
	const toolbar = document.createElement("div");
	toolbar.className = "HeaderEditor-toolbar";
	const heading = document.createElement("h3");
	heading.className = "HeaderEditor-title";
	heading.textContent = title;
	const add = document.createElement("button");
	add.type = "button";
	add.className = "btn btn-sm HeaderEditor-add";
	add.textContent = "＋ 添加请求头";
	toolbar.append(heading, add);
	const hint = document.createElement("p");
	hint.className = "HeaderEditor-description";
	hint.textContent =
		id === "f-case-headers"
			? "同名请求头覆盖上方默认值；留空继承。"
			: "为模型请求添加固定值或环境变量引用。";
	const rows = document.createElement("div");
	rows.className = "HeaderEditor-rows";
	rows.dataset.headerRows = "";
	const empty = document.createElement("div");
	empty.className = "HeaderEditor-empty";
	const emptyTitle = document.createElement("span");
	emptyTitle.textContent = "暂无自定义请求头";
	const emptyHint = document.createElement("span");
	emptyHint.textContent = "点击上方「添加请求头」开始配置";
	empty.append(emptyTitle, emptyHint);
	const help = document.createElement("div");
	help.className = "HeaderEditor-help";
	const envHint = document.createElement("p");
	envHint.textContent =
		"Authorization 等凭据请选择环境变量，填写服务端变量名。";
	const templateHint = document.createElement("p");
	templateHint.append("固定值模板：");
	for (const template of ["{{sessionId}}", "{{caseId}}", "{{evaluationId}}"]) {
		const code = document.createElement("code");
		code.textContent = template;
		templateHint.append(code, " ");
	}
	const executionHint = document.createElement("p");
	executionHint.textContent =
		"evaluationId 标识一次案例执行，完整任务中的模型调用复用该值。";
	help.append(envHint, templateHint, executionHint);
	const refresh = () => {
		empty.hidden = rows.children.length > 0;
		rows.hidden = !rows.children.length;
	};
	let sequence = 0;
	const addRow = (entry: HeaderRow): HTMLInputElement => {
		const row = document.createElement("div");
		row.className = "HeaderRow";
		row.dataset.headerRow = "";
		const rowId = `${id}-row-${++sequence}`;
		const field = (
			labelText: string,
			control: HTMLInputElement | HTMLSelectElement,
			key: string,
		) => {
			const wrapper = document.createElement("div");
			wrapper.className = `HeaderRow-field HeaderRow-${key}`;
			const label = document.createElement("label");
			label.className = "HeaderRow-label";
			control.id = `${rowId}-${key}`;
			label.htmlFor = control.id;
			label.textContent = labelText;
			wrapper.append(label, control);
			return { wrapper, label };
		};
		const name = document.createElement("input");
		name.className = "form-control HeaderRow-mono";
		name.value = entry.name;
		name.placeholder = "例如 x-session-id";
		name.setAttribute("aria-label", "请求头名称");
		name.dataset.headerName = "";
		name.spellcheck = false;
		const nameField = field("请求头名称", name, "name");
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
		const sourceField = field("值来源", source, "source");
		const value = document.createElement("input");
		value.className = "form-control HeaderRow-mono";
		value.value = entry.value;
		value.dataset.headerValue = "";
		value.spellcheck = false;
		const valueField = field("请求头值", value, "value");
		const updateHint = () => {
			const env = source.value === "env";
			value.placeholder = env
				? "例如 EVAL_AUTHORIZATION"
				: "例如 {{sessionId}}";
			valueField.label.textContent = env ? "环境变量名" : "请求头值";
			value.setAttribute("aria-label", valueField.label.textContent);
		};
		source.onchange = updateHint;
		updateHint();
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "HeaderRow-remove";
		remove.textContent = "×";
		remove.setAttribute("aria-label", "删除此请求头");
		remove.title = "删除此请求头";
		remove.onclick = () => {
			const next = row.nextElementSibling ?? row.previousElementSibling;
			row.remove();
			refresh();
			const target =
				next?.querySelector<HTMLInputElement>("[data-header-name]") ?? add;
			target.focus();
		};
		row.append(
			nameField.wrapper,
			sourceField.wrapper,
			valueField.wrapper,
			remove,
		);
		rows.append(row);
		refresh();
		return name;
	};
	for (const [name, value] of Object.entries(initial.headers ?? {}))
		addRow({ name, value, source: "literal" });
	for (const [name, value] of Object.entries(initial.headersEnv ?? {}))
		addRow({ name, value, source: "env" });
	add.onclick = () =>
		addRow({ name: "", value: "", source: "literal" }).focus();
	refresh();
	section.append(toolbar, hint, rows, empty, help);
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
