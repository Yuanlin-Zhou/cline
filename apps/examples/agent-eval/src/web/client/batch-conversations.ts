import {
	BATCH_BYTE_LIMIT,
	BATCH_FILE_LIMIT,
	conversationCaseIds,
	type ConversationFile,
	type BatchConversationPreview,
	type BatchConversationRequest,
} from "../../batch-conversations.js";
import { HISTORY_BYTES } from "../../function-call-history.js";
import { functionCallEditor } from "./function-call-editor.js";
import { FUNCTION_CALL_TOOLS } from "../../function-call-config.js";
import { historyMessageCards } from "./history-import.js";
import { node, action, row, verifierDialog } from "./verifier-ui.js";
import type { EvalDefaults } from "../../types.js";

type Result = { created: number; updated: number; skipped: number };
type LocalFile = ConversationFile & { localError?: string; size: number };
export function batchConversationImport(input: {
	modules: Array<{ id: string; name: string }>;
	settings: EvalDefaults;
	initialModule: string;
	api: <T>(path: string, init?: RequestInit) => Promise<T>;
	onDone: (module: string, result: Result) => void;
}) {
	const element = node("section", "", "BatchHistory");
	const config = node("div", "", "Box Box-body"),
		files: LocalFile[] = [];
	let preview: BatchConversationPreview | undefined,
		busy = false;
	const module = node("select", "", "form-control");
	module.id = "batch-module";
	input.modules.forEach((m) => module.append(new Option(m.name, m.id)));
	module.value = input.initialModule;
	const continuation = node("input", "", "form-control");
	continuation.id = "batch-continuation";
	continuation.value = "继续";
	const policy = node("select", "", "form-control");
	policy.id = "batch-policy";
	policy.append(
		new Option("跳过，保留现有案例", "skip"),
		new Option("创建新版本，覆盖案例内容", "version"),
	);
	const verifier = node("select", "", "form-control");
	verifier.id = "batch-verifier";
	verifier.append(new Option("暂不绑定（导入后配置）", ""));
	const verifierNote = node("p", "", "form-hint");
	const thought = node("input");
	thought.type = "checkbox";
	const thoughtLabel = node("label", "", "form-check");
	thoughtLabel.append(
		thought,
		document.createTextNode("仅导入文本和工具轨迹，不发送思考内容"),
	);
	const toolEditor = functionCallEditor({
		tools: [...FUNCTION_CALL_TOOLS],
		toolChoice: "auto",
	});
	toolEditor.element.hidden = true;
	toolEditor.element.id = "batch-tool-editor";
	const toolButton = action("调整本轮工具", () => {
		toolEditor.element.hidden = !toolEditor.element.hidden;
		toolButton.setAttribute(
			"aria-expanded",
			String(!toolEditor.element.hidden),
		);
	});
	toolButton.setAttribute("aria-expanded", "false");
	toolButton.setAttribute("aria-controls", toolEditor.element.id);
	const chooser = node("input", "", "form-control");
	chooser.type = "file";
	chooser.multiple = true;
	chooser.accept = ".json,application/json";
	chooser.id = "batch-files";
	const status = node(
		"p",
		"请选择 JSON 文件，每个文件生成一个单轮函数调用案例。",
		"form-hint",
	);
	status.setAttribute("role", "status");
	const error = node("p", "", "Grading-error");
	error.setAttribute("role", "alert");
	const warning = node("div"),
		table = node("div", "", "BatchHistory-files"),
		confirm = node("section", "", "Box Box-body mt-3");
	confirm.hidden = true;
	const heading = node("strong"),
		confirmNote = node("p", "", "form-hint");
	const submit = action(
		"确认导入",
		() => {
			void commit();
		},
		true,
	);
	confirm.append(heading, confirmNote, submit);
	const field = (label: string, control: HTMLElement, hint = "") => {
		const group = node("div", "", "form-group"),
			title = node("label", label, "form-label");
		if (control.id) title.htmlFor = control.id;
		group.append(title, control);
		if (hint) group.append(node("p", hint, "form-hint"));
		return group;
	};
	const grid = node("div", "", "BatchHistory-grid");
	grid.append(
		field("目标模块", module),
		field("同名案例处理", policy),
		field(
			"追加的本轮输入",
			continuation,
			"仅当末尾不是普通用户消息时使用；不截断任何历史。",
		),
		field(
			"统一绑定 Python 验证器（可选）",
			verifier,
			"同一验证器应用于全部案例，工具类型不同可分批导入。",
		),
	);
	const validate = action(
		"校验并预览",
		() => {
			void inspect();
		},
		true,
	);
	function invalidate() {
		preview = undefined;
		confirm.hidden = true;
		warning.replaceChildren();
		for (const cell of table.querySelectorAll(".BatchHistory-state"))
			cell.textContent = "待校验";
		for (const b of table.querySelectorAll<HTMLButtonElement>(
			".BatchHistory-view",
		))
			b.disabled = true;
		status.textContent = files.length
			? `${files.length} 个文件，设置已更新，请校验并预览。`
			: "请选择 JSON 文件，每个文件生成一个单轮函数调用案例。";
	}
	function setBusy(value: boolean) {
		busy = value;
		for (const c of element.querySelectorAll<
			HTMLInputElement | HTMLSelectElement | HTMLButtonElement
		>("input,select,button"))
			c.disabled = value;
		if (!value) {
			submit.disabled = !preview || preview.rows.some((r) => !!r.error);
			for (const [i, button] of [
				...table.querySelectorAll<HTMLButtonElement>(".BatchHistory-view"),
			].entries())
				button.disabled = !preview?.rows[i]?.definition;
		}
	}
	function request(): BatchConversationRequest {
		if (files.some((f) => f.localError))
			throw Error("请先移除或重新选择读取失败的文件。");
		let fc;
		try {
			fc = toolEditor.read();
		} catch (e) {
			toolEditor.element.hidden = false;
			toolButton.setAttribute("aria-expanded", "true");
			toolEditor.element.querySelector("input")?.focus();
			throw e;
		}
		return {
			moduleId: module.value,
			files: files.map(
				({ filename, content, caseId, continuation, systemSource }) => ({
					filename,
					content,
					caseId,
					...(continuation ? { continuation } : {}),
					...(systemSource ? { systemSource } : {}),
				}),
			),
			options: {
				tools: fc.tools,
				toolChoice: fc.toolChoice,
				continuation: continuation.value,
				ignoreThinking: thought.checked,
				...(verifier.value ? { verifierId: verifier.value } : {}),
			},
			defaults: structuredClone(input.settings),
			policy: policy.value as "skip" | "version",
		};
	}
	async function post<T>(path: string, body: BatchConversationRequest) {
		const content = JSON.stringify(body);
		if (new TextEncoder().encode(content).length > BATCH_BYTE_LIMIT)
			throw Error("提交内容超过 20 MiB，请减少文件数量");
		return input.api<T>(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: content,
		});
	}
	function renderRows() {
		table.replaceChildren();
		files.forEach((f, index) => {
			const result = preview?.rows[index],
				card = node("article", "", "BatchHistory-file");
			const title = node("div", "", "BatchHistory-file-head");
			title.append(
				node("strong", `${index + 1}. ${f.filename}`),
				action("移除", () => {
					files.splice(index, 1);
					invalidate();
					renderRows();
				}),
			);
			card.append(title);
			const id = node("input", "", "form-control");
			id.value = f.caseId ?? "";
			id.id = `batch-case-${index}`;
			id.oninput = () => {
				f.caseId = id.value;
				invalidate();
			};
			const override = node("input", "", "form-control");
			override.value = f.continuation ?? "";
			override.id = `batch-prompt-${index}`;
			override.placeholder = "留空使用统一续接文案";
			override.oninput = () => {
				f.continuation = override.value;
				invalidate();
			};
			const system = node("select", "", "form-control");
			system.id = `batch-system-${index}`;
			system.append(
				new Option("自动识别（冲突时报错）", ""),
				new Option("使用顶层 system_prompt", "file"),
				new Option("使用消息内系统指令", "messages"),
			);
			system.value = f.systemSource ?? "";
			system.onchange = () => {
				f.systemSource =
					(system.value as ConversationFile["systemSource"]) || undefined;
				invalidate();
			};
			const edits = node("div", "", "BatchHistory-grid");
			edits.append(
				field("案例 ID", id),
				field("本文件续接文案（可选）", override),
			);
			const state = node(
				"p",
				f.localError ??
					result?.error ??
					(result?.definition
						? `${result.appended ? "追加本轮用户消息" : "使用实际末条用户消息"} · ${result.originalCount} 条原始记录 · 保留 ${result.definition.functionCall?.history?.length ?? 0} 条历史${result.duplicate ? ` · 同名，将${policy.value === "skip" ? "跳过" : "创建新版本"}` : " · 新建"}`
						: "待校验"),
				"BatchHistory-state form-hint",
			);
			if (f.localError || result?.error)
				state.classList.add("BatchHistory-error");
			const view = action("查看对话与本轮输入", () => {
				const r = preview?.rows[index];
				if (!r?.definition) return;
				const body = node("div");
				body.append(
					node(
						"strong",
						r.appended
							? "本轮输入（自动追加）"
							: "本轮输入（实际末条用户消息）",
					),
					node("pre", r.definition.prompt, "code"),
				);
				r.source?.notices.forEach((n) =>
					body.append(node("p", n, "form-hint")),
				);
				body.append(
					historyMessageCards(r.definition.functionCall?.history ?? []),
				);
				verifierDialog(f.filename, body, { wide: true });
			});
			view.classList.add("BatchHistory-view");
			view.disabled = !result?.definition;
			card.append(edits, state);
			if (result?.definition)
				card.append(
					node(
						"p",
						`本轮输入：${result.definition.prompt.slice(0, 160)}`,
						"form-hint",
					),
				);
			if (result?.error?.includes("选择指令来源") || f.systemSource)
				card.append(field("系统指令来源", system));
			card.append(view);
			table.append(card);
		});
	}
	async function inspect() {
		if (busy) return;
		error.textContent = "";
		try {
			const body = request();
			setBusy(true);
			preview = await post<BatchConversationPreview>(
				"/api/import/conversations/preview",
				body,
			);
			renderRows();
			const bad = preview.rows.filter((r) => r.error).length,
				duplicates = preview.rows.filter((r) => r.duplicate && !r.error).length;
			status.textContent = `${files.length} 个文件 · ${files.length - bad} 个通过 · ${bad} 个错误 · ${duplicates} 个同名`;
			warning.replaceChildren(
				...preview.warnings.map((w) => node("p", w, "form-hint")),
			);
			confirm.hidden = !!bad;
			heading.textContent = `导入到「${module.selectedOptions[0]?.textContent ?? ""}」`;
			confirmNote.textContent = `将处理 ${files.length} 个案例，${duplicates} 个同名案例将${policy.value === "skip" ? "跳过" : "创建新版本并覆盖内容"}。不会请求模型或执行历史工具。`;
			submit.textContent = `确认导入 ${files.length} 个案例`;
			if (bad)
				error.textContent =
					"存在错误文件，尚未写入。请修正设置或明确移除错误文件，再重新校验。";
		} catch (e) {
			invalidate();
			error.textContent = e instanceof Error ? e.message : String(e);
		} finally {
			setBusy(false);
		}
	}
	async function commit() {
		if (busy || !preview || preview.rows.some((r) => r.error)) return;
		error.textContent = "";
		try {
			const body = request();
			setBusy(true);
			const result = await post<Result>("/api/import/conversations", body);
			input.onDone(module.value, result);
		} catch (e) {
			invalidate();
			const message = e instanceof Error ? e.message : String(e);
			error.textContent = `未确认导入成功：${message}。如连接中断，请先查看目标模块的案例，再决定是否重新导入。`;
		} finally {
			setBusy(false);
		}
	}
	chooser.onchange = async () => {
		if (busy) return;
		const added = Array.from(chooser.files ?? []);
		if (!added.length) return;
		error.textContent = "";
		try {
			if (files.length + added.length > BATCH_FILE_LIMIT)
				throw Error("每批最多 100 个文件");
			if (
				files.reduce((n, f) => n + f.size, 0) +
					added.reduce((n, f) => n + f.size, 0) >
				BATCH_BYTE_LIMIT
			)
				throw Error("文件合计超过 20 MiB，请减少数量");
			setBusy(true);
			const ids = conversationCaseIds([
				...files.map((f) => `${f.caseId}.json`),
				...added.map((f) => f.name),
			]).slice(files.length);
			for (const [index, file] of added.entries()) {
				const entry: LocalFile = {
					filename: file.name,
					caseId: ids[index],
					content: "",
					size: file.size,
				};
				try {
					if (file.size > HISTORY_BYTES) throw Error("文件超过 1 MiB 限制");
					entry.content = new TextDecoder("utf-8", { fatal: true }).decode(
						await file.arrayBuffer(),
					);
				} catch (e) {
					entry.localError =
						e instanceof TypeError
							? "文件不是有效 UTF-8，请另存为 UTF-8 后重新选择"
							: e instanceof Error
								? e.message
								: String(e);
				}
				files.push(entry);
			}
			invalidate();
			renderRows();
		} catch (e) {
			error.textContent = e instanceof Error ? e.message : String(e);
		} finally {
			chooser.value = "";
			setBusy(false);
		}
	};
	for (const control of [module, policy, verifier, thought])
		control.onchange = invalidate;
	continuation.oninput = invalidate;
	toolEditor.element.addEventListener("change", invalidate);
	async function loadVerifiers() {
		try {
			const list = await input.api<{
				verifiers: Array<{
					id: string;
					label: string;
					runtime?: string;
					source?: string;
				}>;
			}>("/api/verifiers");
			const current = verifier.value;
			verifier.replaceChildren(new Option("暂不绑定（导入后配置）", ""));
			for (const v of list.verifiers.filter(
				(v) => v.runtime === "python" && v.source === "uploaded",
			))
				verifier.append(new Option(v.label, v.id));
			verifier.value = current;
			if (verifier.value !== current) invalidate();
			verifierNote.textContent = "";
		} catch {
			verifierNote.textContent = "验证器列表读取失败，可刷新重试或不绑定导入。";
		}
	}
	config.append(
		node("strong", "1. 选择文件与公共设置"),
		node(
			"p",
			"一份 JSON 生成一个案例。保留完整历史；末尾为用户消息则直接使用，否则追加“继续”。未完成的工具调用需先补齐结果。",
			"form-hint",
		),
		grid,
		thoughtLabel,
		row(
			node("span", "默认公布六工具，自动选择调用。", "form-hint"),
			toolButton,
		),
		toolEditor.element,
		row(
			action("刷新验证器", () => {
				void loadVerifiers();
			}),
		),
		verifierNote,
		node(
			"p",
			`模型配置快照：${input.settings.providerId} / ${input.settings.modelId}`,
			"form-hint",
		),
	);
	element.append(
		config,
		field(
			"2. 选择历史对话 JSON 文件（可多选）",
			chooser,
			"最多 100 个文件，单文件 1 MiB，合计 20 MiB；仅接受 UTF-8 JSON。",
		),
		status,
		table,
		row(validate),
		error,
		warning,
		confirm,
	);
	void loadVerifiers();
	return { element, isBusy: () => busy };
}
