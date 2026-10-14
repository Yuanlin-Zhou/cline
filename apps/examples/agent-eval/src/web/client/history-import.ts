import {
	convertHistoryDocument,
	readHistoryDocument,
	type HistoryDocument,
	type NativeHistoryMessage,
	type HistorySource,
} from "../../function-call-history.js";
import { historyImportExamples } from "../../history-import-examples.js";
import { node, action, row, verifierDialog } from "./verifier-ui.js";

const roleLabels = {
	system: "系统指令",
	developer: "开发者指令",
	user: "用户",
	assistant: "助手",
	tool: "工具返回",
};
const formatLabels = {
	cline: "Cline 原生记录",
	openai: "标准 messages",
	"type-data": "type/data 记录",
};

function viewJson(title: string, value: unknown) {
	const body = node("div");
	body.append(node("pre", JSON.stringify(value, null, 2), "code"));
	return verifierDialog(title, body, { wide: true });
}
function sourceButton(source?: HistorySource) {
	return action("查看来源与转换说明", () =>
		viewJson("历史来源与转换说明", source ?? {}),
	);
}
function readableText(text: string) {
	const body = node("div", "", "HistoryMessage-text");
	const content = node(
		"p",
		text.length > 600 ? text.slice(0, 600) + "…" : text,
	);
	body.append(content);
	if (text.length > 600) {
		let expanded = false;
		const button = action("展开全文", () => {
			expanded = !expanded;
			content.textContent = expanded ? text : text.slice(0, 600) + "…";
			button.textContent = expanded ? "收起全文" : "展开全文";
			button.setAttribute("aria-expanded", String(expanded));
		});
		button.setAttribute("aria-expanded", "false");
		content.id = `history-text-${crypto.randomUUID()}`;
		button.setAttribute("aria-controls", content.id);
		body.append(button);
	}
	return body;
}
function messageCards(messages: NativeHistoryMessage[]) {
	const list = node("div", "", "HistoryImport-cards");
	const toolNames = new Map(
		messages.flatMap((m) =>
			(m.tool_calls ?? []).map((c) => [c.id, c.function.name] as const),
		),
	);
	messages.forEach((m, i) => {
		const card = node(
			"article",
			"",
			`HistoryMessage HistoryMessage--${m.role}`,
		);
		const heading = node("div", "", "HistoryMessage-heading");
		heading.append(
			node("span", String(i + 1), "HistoryMessage-number"),
			node("strong", roleLabels[m.role]),
		);
		if (m.tool_calls?.length)
			heading.append(
				node(
					"span",
					`调用 ${m.tool_calls.length} 个工具`,
					"HistoryMessage-tag",
				),
			);
		heading.append(
			action("查看 JSON", () =>
				viewJson(`第 ${i + 1} 条 · ${roleLabels[m.role]} · 原始消息 JSON`, m),
			),
		);
		card.append(heading);
		if (m.tool_call_id) {
			const tool = node("div", "", "HistoryMessage-tool-ref");
			tool.append(
				node("code", toolNames.get(m.tool_call_id) ?? "工具"),
				node("span", `调用 ID：${m.tool_call_id}`),
			);
			card.append(tool);
		}
		if (typeof m.content === "string" && m.content.length)
			card.append(readableText(m.content));
		for (const call of m.tool_calls ?? []) {
			const tool = node("section", "", "HistoryMessage-call"),
				head = node("div", "", "HistoryMessage-call-head");
			const params = node("pre", "", "code");
			params.hidden = true;
			params.id = `history-params-${crypto.randomUUID()}`;
			const button = action("查看参数", () => {
				params.hidden = !params.hidden;
				button.textContent = params.hidden ? "查看参数" : "收起参数";
				button.setAttribute("aria-expanded", String(!params.hidden));
				if (!params.hidden && !params.textContent) {
					try {
						params.textContent = JSON.stringify(
							JSON.parse(call.function.arguments),
							null,
							2,
						);
					} catch {
						params.textContent = call.function.arguments;
					}
				}
			});
			button.setAttribute("aria-expanded", "false");
			button.setAttribute("aria-controls", params.id);
			head.append(node("code", call.function.name), button);
			tool.append(
				head,
				node("p", `调用 ID：${call.id}`, "HistoryMessage-call-id"),
				params,
			);
			card.append(tool);
		}
		list.append(card);
	});
	return list;
}

export function historyImportEditor(
	initial: { history?: NativeHistoryMessage[]; historySource?: HistorySource },
	onChange: (value: {
		history?: NativeHistoryMessage[];
		historySource?: HistorySource;
		prompt?: string;
	}) => void,
	existingCount: () => number,
) {
	let history = initial.history,
		source = initial.historySource,
		mode = "function-call";
	const element = node("section", "", "HistoryImport"),
		buttons = row(),
		saved = node("div"),
		modeHint = node("p", "", "form-hint");
	const open = () => {
		const body = node("div", "", "HistoryImport-panel"),
			raw = node("textarea", "", "form-control HistoryImport-json");
		raw.id = "history-import-json";
		raw.rows = 10;
		const label = node("label", "粘贴对话 JSON", "form-label");
		label.htmlFor = raw.id;
		const status = node("p", "", "form-hint");
		status.setAttribute("role", "status");
		const error = node("p", "", "Grading-error");
		error.setAttribute("role", "alert");
		const samples = node("select", "", "form-control");
		samples.setAttribute("aria-label", "选择历史导入示例");
		historyImportExamples.forEach((x, i) =>
			samples.append(new Option(x.label, String(i))),
		);
		const scope = node("select", "", "form-control");
		scope.id = "history-import-scope";
		const scopeLabel = node("label", "哪些内容作为本轮输入？", "form-label");
		scopeLabel.htmlFor = scope.id;
		const thought = node("input");
		thought.type = "checkbox";
		const thoughtLabel = node("label", "", "form-check");
		thoughtLabel.append(
			thought,
			document.createTextNode("仅导入文本和工具轨迹，不发送思考块"),
		);
		thoughtLabel.hidden = true;
		const system = node("select", "", "form-control");
		system.setAttribute("aria-label", "选择系统指令来源");
		system.append(
			new Option("请选择系统指令来源", ""),
			new Option("使用文件顶层 system_prompt", "file"),
			new Option("使用消息内的 system/developer", "messages"),
		);
		system.hidden = true;
		const preview = node("div"),
			selection = node("section", "", "HistoryImport-selection");
		selection.hidden = true;
		selection.append(scopeLabel, scope, thoughtLabel, system);
		let doc: HistoryDocument | undefined,
			converted: ReturnType<typeof convertHistoryDocument> | undefined;
		const apply = action(
			"导入到案例",
			() => {
				if (!converted) return;
				history = converted.history;
				source = converted.source;
				onChange({
					history,
					historySource: source,
					...(converted.prompt !== undefined
						? { prompt: converted.prompt }
						: {}),
				});
				render();
				dialog.close();
			},
			true,
		);
		apply.disabled = true;
		const update = () => {
			converted = undefined;
			apply.disabled = true;
			preview.replaceChildren();
			error.textContent = "";
			if (!doc) return;
			try {
				converted = convertHistoryDocument(doc, {
					...(scope.value !== "history"
						? { currentIndex: Number(scope.value) }
						: {}),
					ignoreThinking: thought.checked,
					...(system.value
						? { systemSource: system.value as "file" | "messages" }
						: {}),
				});
				const messages = converted.history,
					calls = messages.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0),
					results = messages.filter((m) => m.role === "tool").length;
				status.textContent = `识别为 ${doc.format} · 原记录 ${doc.messages.length} 条 → 历史 ${messages.length} 条 · 调用 ${calls} 个 / 结果 ${results} 条`;
				preview.append(
					node(
						"p",
						`将替换当前 ${history?.length ?? existingCount()} 条历史；${converted.prompt !== undefined ? "替换本轮输入" : "保留本轮输入"}。导入仅更新草稿，保存案例后生效。`,
						"form-hint",
					),
				);
				if (messages.some((m) => ["system", "developer"].includes(m.role)))
					preview.append(
						node(
							"p",
							"使用导入的系统指令，不叠加配置中的系统提示词。",
							"form-hint",
						),
					);
				if (converted.prompt !== undefined)
					preview.append(
						node("strong", "本轮输入"),
						node("pre", converted.prompt, "code"),
					);
				converted.source.notices.forEach((n) =>
					preview.append(node("p", n, "form-hint")),
				);
				preview.append(
					messageCards(messages),
					row(sourceButton(converted.source)),
				);
				apply.disabled = false;
			} catch (e) {
				status.textContent = `识别为 ${doc.format}，尚未导入。`;
				error.textContent = `原草稿已保留：${e instanceof Error ? e.message : String(e)}`;
			}
		};
		const parse = action(
			"解析并预览",
			() => {
				converted = undefined;
				apply.disabled = true;
				error.textContent = "";
				preview.replaceChildren();
				try {
					doc = readHistoryDocument(raw.value);
					selection.hidden = false;
					thought.checked = false;
					thoughtLabel.hidden = !doc.hasThinking;
					system.value = "";
					system.hidden = !(doc.systemPrompt?.trim() && doc.hasInstructions);
					scope.replaceChildren(
						new Option("仅导入历史，保留本轮输入", "history"),
					);
					doc.candidates.forEach((c) =>
						scope.append(
							new Option(
								`${c.index === doc!.messages.length - 1 ? "最后一条用户消息" : "第 " + (c.index + 1) + " 条用户消息"}作为本轮输入：${c.text.slice(0, 45)}`,
								String(c.index),
							),
						),
					);
					update();
				} catch (e) {
					doc = undefined;
					selection.hidden = true;
					status.textContent = "";
					error.textContent = `原草稿已保留：${e instanceof Error ? e.message : String(e)}`;
					raw.focus();
				}
			},
			true,
		);
		raw.oninput = () => {
			doc = undefined;
			converted = undefined;
			apply.disabled = true;
			selection.hidden = true;
			preview.replaceChildren();
			error.textContent = "";
			status.textContent = "内容已改变，请重新解析预览。";
		};
		scope.onchange = update;
		thought.onchange = update;
		system.onchange = update;
		body.append(
			node(
				"p",
				"直接粘贴 Cline 原生 messages 文件或标准 function call 对话。只导入上下文，不执行历史工具。",
				"form-hint",
			),
			row(
				samples,
				action("填入示例", () => {
					raw.value = historyImportExamples[Number(samples.value)].value;
					raw.oninput?.(new Event("input"));
				}),
			),
			label,
			raw,
			row(parse),
			status,
			selection,
			error,
			preview,
		);
		const dialog = verifierDialog("导入历史对话", body, {
			wide: true,
			footer: row(
				action("取消", () => dialog.close()),
				apply,
			),
		});
		const onNavigation = () => dialog.close();
		window.addEventListener("hashchange", onNavigation);
		dialog.dialog.addEventListener(
			"close",
			() => window.removeEventListener("hashchange", onNavigation),
			{ once: true },
		);
		raw.focus();
	};
	buttons.append(
		action("粘贴 JSON 导入", open, true),
		action("清空原生历史", () => {
			history = undefined;
			source = undefined;
			onChange({});
			render();
		}),
	);
	function render() {
		buttons.hidden = mode !== "function-call";
		buttons.lastElementChild!.toggleAttribute("hidden", history === undefined);
		saved.replaceChildren();
		saved.hidden = mode !== "function-call" || history === undefined;
		if (history !== undefined) {
			const overview = node("div", "", "HistoryImport-overview");
			overview.append(
				node("strong", `${history.length} 条历史消息`),
				node(
					"span",
					source ? formatLabels[source.format] : "标准消息",
					"form-hint",
				),
			);
			if (history.some((m) => ["system", "developer"].includes(m.role))) {
				const instruction = node(
					"span",
					"使用导入的系统指令",
					"HistoryMessage-tag",
				);
				instruction.title = "配置中的系统提示词不重复叠加。";
				overview.append(instruction);
			}
			saved.append(overview, messageCards(history));
			if (source) saved.append(row(sourceButton(source)));
		}
		modeHint.textContent =
			mode !== "function-call" && history !== undefined
				? "原生历史已保留，仅用于单轮函数调用；当前模式不会使用这些内容。"
				: "支持 Cline 原生记录和标准 function call JSON；导入前可预览调用链并选择本轮输入。";
		modeHint.hidden =
			mode === "function-call" ? history !== undefined : history === undefined;
	}
	element.append(buttons, modeHint, saved);
	render();
	return {
		element,
		read: () => ({ history, historySource: source }),
		setMode(value: string) {
			mode = value;
			render();
		},
		reset() {
			history = undefined;
			source = undefined;
			render();
		},
	};
}
