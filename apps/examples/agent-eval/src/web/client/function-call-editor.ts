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
			"只让模型生成调用格式，不执行文件、命令、网页或技能操作。需要在配置中选择 OpenAI-compatible 并填写服务地址。",
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
			"强制选择用于参数格式测试，不能据此声称模型自动选对了工具。验证器还会检查实际工具名与调用数。",
			"form-hint",
		),
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
