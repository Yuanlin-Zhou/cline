import {
	convertHistoryDocument,
	readHistoryDocument,
	type HistoryDocument,
	type NativeHistoryMessage,
	type HistorySource,
} from "../../function-call-history.js";
import { historyImportExamples } from "../../history-import-examples.js";
import { node, action, row, fold, verifierDialog } from "./verifier-ui.js";

function messageCards(messages: NativeHistoryMessage[]) {
	const list = node("div", "", "HistoryImport-cards");
	messages.forEach((m, i) => {
		const card = fold(
			`${i + 1}. ${m.role}${m.tool_calls?.length ? ` · ${m.tool_calls.length} 个工具调用` : ""}${m.tool_call_id ? ` · ${m.tool_call_id}` : ""}`,
		);
		const summary = node(
			"p",
			typeof m.content === "string"
				? m.content.slice(0, 180)
				: (m.tool_calls?.map((c) => c.function.name).join("、") ?? ""),
			"form-hint",
		);
		const detail = node("pre", JSON.stringify(m, null, 2), "code");
		card.append(summary, detail);
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
				const provenance = fold("来源索引与转换说明");
				provenance.append(
					node("pre", JSON.stringify(converted.source, null, 2), "code"),
				);
				preview.append(messageCards(messages), provenance);
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
			saved.append(
				node(
					"p",
					`已导入 ${history.length} 条原生历史 · ${source?.format ?? "标准消息"}${source?.sessionId ? ` · 来源会话 ${source.sessionId}` : ""}`,
					"form-hint",
				),
			);
			if (history.some((m) => ["system", "developer"].includes(m.role)))
				saved.append(
					node(
						"p",
						"本案例使用导入的系统指令，配置中的系统提示词不叠加。",
						"form-hint",
					),
				);
			const provenance = fold("来源索引与转换说明");
			provenance.append(
				node("pre", JSON.stringify(source ?? {}, null, 2), "code"),
			);
			saved.append(messageCards(history), provenance);
		}
		modeHint.textContent =
			mode !== "function-call" && history !== undefined
				? "原生历史已保留，仅用于单轮函数调用；当前模式不会使用这些内容。"
				: "支持 Cline 原生记录和标准 function call JSON；导入前可预览调用链并选择本轮输入。";
		modeHint.hidden = mode !== "function-call" && history === undefined;
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
