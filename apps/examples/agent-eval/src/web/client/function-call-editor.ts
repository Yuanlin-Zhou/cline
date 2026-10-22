import {
	FUNCTION_CALL_TOOLS,
	parseFunctionCall,
	type FunctionCallConfig,
} from "../../function-call-config.js";
import { node, row } from "./verifier-ui.js";
export function functionCallEditor(initial?: FunctionCallConfig) {
	const config = parseFunctionCall(initial);
	const element = node("section", "", "Box Box-body mt-3");
	element.append(
		node("strong", "本轮公布哪些工具？"),
		node(
			"p",
			"本轮只请求一次模型，响应可以包含多条工具调用；不实际执行工具。需要配置 OpenAI-compatible 服务。",
			"form-hint",
		),
	);
	const labels: Record<string, string> = {
		read_files: "读取文件",
		search_codebase: "搜索代码",
		run_commands: "执行命令",
		fetch_web_content: "获取网页内容",
		editor: "编辑文件",
		skills: "调用技能",
	};
	const inputs = FUNCTION_CALL_TOOLS.map((name) => {
		const input = node("input");
		input.type = "checkbox";
		input.checked = config.tools.includes(name);
		input.value = name;
		const label = node("label", "", "form-check");
		label.append(input, document.createTextNode(`${name} · ${labels[name]}`));
		element.append(label);
		return input;
	});
	const choice = node("select", "", "form-control");
	choice.id = "fc-tool-choice";
	const label = node("label", "调用选择方式", "form-label");
	label.htmlFor = choice.id;
	let current: string = config.toolChoice ?? "auto";
	const sync = () => {
		choice.replaceChildren(
			new Option("自动选择（评测模型选择能力）", "auto"),
			new Option("必须调用任意所选工具", "required"),
		);
		for (const control of inputs.filter((c) => c.checked))
			choice.append(new Option(`强制调用 ${control.value}`, control.value));
		if (!Array.from(choice.options).some((o) => o.value === current))
			current = "auto";
		choice.value = current;
	};
	inputs.forEach((input) => (input.onchange = sync));
	choice.onchange = () => {
		current = choice.value;
	};
	sync();
	const error = node("p", "", "Grading-error");
	error.setAttribute("role", "alert");
	element.append(
		row(label),
		choice,
		node(
			"p",
			"要指定一个工具，可只勾选它，再选择“必须调用任意所选工具”；也可强制指定工具（服务需支持）。强制选择不代表自动选对工具。",
			"form-hint",
		),
		node("p", '允许同一工具调用一次或多次：使用新版六工具 Python 验证器，参数填 {"min_count":1,"allowed_tools":["editor"]}，工具名按需替换。每条调用都会检查，最多 15 条；旧脚本需重新上传并选择新版本。', "form-hint"),
		error,
	);
	return {
		element,
		setHistory(
			history: FunctionCallConfig["history"],
			source?: FunctionCallConfig["historySource"],
		) {
			config.history = history;
			config.historySource = source;
		},
		read() {
			try {
				const result = parseFunctionCall({
					...(config.history !== undefined ? { history: config.history } : {}),
					...(config.historySource
						? { historySource: config.historySource }
						: {}),
					tools: inputs.filter((i) => i.checked).map((i) => i.value),
					toolChoice: choice.value,
				});
				error.textContent = "";
				return result;
			} catch (cause) {
				error.textContent =
					cause instanceof Error ? cause.message : String(cause);
				const panel = element.closest('[role="tabpanel"]');
				if (panel?.id)
					document
						.querySelector<HTMLButtonElement>(`[aria-controls="${panel.id}"]`)
						?.click();
				inputs[0].focus();
				throw cause;
			}
		},
	};
}
