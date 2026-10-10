import type { EvalAssertions } from "../../types.js";
import { node, action, row, fold } from "./verifier-ui.js";

export function replyEditor(options: {
	initial?: EvalAssertions;
	finish: string;
	finishOptions: Array<[string, string]>;
	omitDefaultFinish: boolean;
}) {
	const root = node("section", "", "Box Box-body ReplyEditor");
	const finishSettings = fold("结束状态检查");
	const finish = node("select", "", "form-control");
	finish.id = "a-finish";
	for (const [value, label] of [["", "不额外指定"], ...options.finishOptions])
		finish.append(new Option(label, value));
	finish.value = options.finish;
	const finishLabel = node("label", "结束状态（可选）", "form-label");
	finishLabel.htmlFor = finish.id;
	finishSettings.append(
		finishLabel,
		finish,
		node(
			"p",
			"未启用文件或脚本验收时，系统默认检查正常结束。这里可以指定其他状态；正常结束本身不能证明业务任务完成。",
			"form-hint",
		),
	);
	const error = node("p", "", "Grading-error");
	error.setAttribute("role", "alert");
	const controls = new Map<string, HTMLTextAreaElement>();
	const wrappers = new Map<string, HTMLElement>();
	const buttons = new Map<string, HTMLButtonElement>();
	const types = [
		[
			"contains",
			"回复必须包含（每行一个）",
			"例如 已完成；最后回复必须包含所有填写项。",
			"添加包含检查",
		],
		[
			"notContains",
			"回复不能包含（每行一个）",
			"例如 抱歉；最后回复不能包含任何填写项。",
			"添加不包含检查",
		],
		[
			"matches",
			"回复需匹配正则（每行一个）",
			"例如 Bun|bun；所有表达式都须匹配，不加 / 分隔符。",
			"添加正则检查",
		],
	] as const;
	const title = node("div", "", "Grading-rule-head");
	title.append(
		node("strong", "最终回复检查"),
		node("span", "影响通过", "Label Label--neutral"),
	);
	root.append(
		title,
		node(
			"p",
			"检查 Agent 最后发出的回复。每行一项，所有填写项都须满足；留空的项目不执行内容检查。",
			"form-hint",
		),
	);
	const actions = row();
	const lines = (key: string) =>
		controls
			.get(key)!
			.value.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
	function reveal(key: string, focus = true) {
		root.hidden = false;
		const panel = root.closest('[role="tabpanel"]');
		if (panel?.id)
			document
				.querySelector<HTMLButtonElement>(`[aria-controls="${panel.id}"]`)
				?.click();
		wrappers.get(key)!.hidden = false;
		buttons.get(key)!.hidden = true;
		if (focus) controls.get(key)!.focus();
	}
	for (const [key, label, hint, addText] of types) {
		const input = node("textarea", "", "form-control");
		input.id = `a-${key}`;
		input.rows = 2;
		input.value = (options.initial?.[key] ?? []).join("\n");
		controls.set(key, input);
		const field = node("div", "", "form-group");
		const caption = node("label", label, "form-label");
		caption.htmlFor = input.id;
		const help = node("p", hint, "form-hint");
		help.id = `${input.id}-hint`;
		input.setAttribute("aria-describedby", help.id);
		const issue = node("p", "", "Grading-field-error");
		issue.id = `${input.id}-error`;
		input.setAttribute("aria-describedby", `${help.id} ${issue.id}`);
		const remove = action("移除这项检查", () => {
			input.value = "";
			input.removeAttribute("aria-invalid");
			issue.textContent = "";
			field.hidden = true;
			buttons.get(key)!.hidden = false;
			root.hidden = ![...wrappers.values()].some((n) => !n.hidden);
		});
		field.append(row(caption, remove), input, help, issue);
		wrappers.set(key, field);
		root.append(field);
		const add = action(addText, () => reveal(key));
		buttons.set(key, add);
		actions.append(add);
		input.oninput = () => {
			error.textContent = "";
			issue.textContent = "";
			input.removeAttribute("aria-invalid");
		};
	}
	root.append(actions, error);
	function refresh() {
		for (const [key, field] of wrappers) {
			field.hidden = !controls.get(key)!.value.trim();
			buttons.get(key)!.hidden = !field.hidden;
		}
		root.hidden = ![...wrappers.values()].some((n) => !n.hidden);
	}
	refresh();
	return {
		element: root,
		finishSettings,
		refresh,
		open() {
			root.hidden = false;
			if (![...wrappers.values()].some((n) => !n.hidden)) reveal("contains");
			else
				[...controls.entries()]
					.find(([key]) => !wrappers.get(key)!.hidden)?.[1]
					.focus();
			root.scrollIntoView({ block: "nearest" });
		},
		read(): EvalAssertions | undefined {
			const expressions = lines("matches");
			for (const [index, expression] of expressions.entries()) {
				try {
					new RegExp(expression, "u");
				} catch {
					const control = controls.get("matches")!;
					const message = `第 ${index + 1} 行正则表达式无效，请检查括号与转义。`;
					reveal("matches");
					control.setAttribute("aria-invalid", "true");
					root.querySelector(`#${control.id}-error`)!.textContent = message;
					error.textContent = "请修正最终回复检查中的正则表达式后再保存。";
					throw new Error(message);
				}
			}
			const contains = lines("contains");
			const notContains = lines("notContains");
			const finishReason = finish.value as EvalAssertions["finishReason"];
			if (
				!contains.length &&
				!notContains.length &&
				!expressions.length &&
				(!finishReason ||
					(finishReason === "completed" && options.omitDefaultFinish))
			)
				return undefined;
			return {
				finishReason: finishReason || undefined,
				...(contains.length ? { contains } : {}),
				...(notContains.length ? { notContains } : {}),
				...(expressions.length ? { matches: expressions } : {}),
			};
		},
	};
}
