import { pythonFields, pythonReplyTemplate, pythonArtifactTemplate, pythonConversationTemplate } from "../../grading/python-guide.js";
import { verifierTrial } from "./verifier-trial.js";
import { parseGrading, safeRelative } from "../../grading/schema.js";
import type { GradingConfig } from "../../grading/types.js";
import { replyTemplate, artifactTemplate, verifierFields, verifierProtocolHelp, verifierTimingHelp } from "../../grading/verifier-guide.js";
import { comparisons, condition, guides, readExpected, valueType } from "./grading-help.js";

type Draft = Record<string, unknown>;
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Verifier = { id: string; label: string; version: string; dependencies: string[]; source?: string; runtime?: string };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; };
const input = (value: unknown = "") => { const node = el("input", "", "form-control"); node.value = String(value); return node; };
const select = (options: [string, string][], value = "") => { const node = el("select", "", "form-control"); for (const [key, name] of options) node.append(new Option(name, key)); node.value = value; return node; };
const button = (label: string, click: () => void) => { const node = el("button", label, "btn btn-sm"); node.type = "button"; node.onclick = click; return node; };
const details = (summary: string) => { const node = el("details", "", "Grading-advanced"); node.append(el("summary", summary)); return node; };
const check = (label: string, control: HTMLInputElement) => { const node = el("label", "", "form-check"); node.append(control, document.createTextNode(label)); return node; };
const json = (value: unknown) => JSON.stringify(value, null, 2);
class FieldError extends Error { constructor(message: string, readonly control: Control) { super(message); } }
let sequence = 0;

export function gradingEditor(initial?: GradingConfig, options: { caseId?: string } = {}) {
	const element = el("section", "", "Box mt-3 Grading");
	const header = el("div", "", "Box-header"); const enabled = input(); enabled.type = "checkbox"; enabled.checked = !!initial;
	header.append(el("span", "任务结果与行为验收"), check("启用验收", enabled));
	const body = el("div", "", "Box-body");
	body.append(el("p", "上传 Python 脚本可自定义检查执行结果、会话和产物；文件内置规则仍需完整任务模式。", "form-hint Grading-intro"));
	const content = el("div"); content.hidden = !enabled.checked; enabled.onchange = () => { content.hidden = !enabled.checked; };
	const modeHint = el("p", "单轮可用 Python 验证回复与会话；检查产物请选择完整任务模式。", "form-hint");
	content.append(modeHint, el("p", "必要规则与上方已填写的最终回复检查都满足才通过。取消“必须满足”后仅供诊断；至少保留一条必要规则。", "form-hint"));
	body.append(content); element.append(header, body);
	const error = el("div", "", "Grading-error"); error.setAttribute("role", "alert"); body.append(error);
	const focus = (node: HTMLElement) => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; node.focus(); node.scrollIntoView({ block: "center" }); };
	const report = (cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); if (cause instanceof FieldError) focus(cause.control); };
	const attempt = (action: () => void) => { try { action(); error.textContent = ""; } catch (cause) { report(cause); } };
	type Editor = { node: HTMLElement; read: () => Draft; dispose: () => void };
	let editors: Editor[] = [];
	let verifiers: Verifier[] = []; let verifierState: "loading" | "ready" | "error" = "loading"; let loadTask: Promise<void> | undefined;
	const verifierUpdates = new Set<() => void>();
	const resultList = el("div"); const behaviorList = el("div"); const empty = el("p", "还没有结果规则。请选择检查目标，再按示例填写。", "Grading-empty");
	const count = el("span", "0", "Label Label--neutral");
	const refresh = () => { count.textContent = String(resultList.children.length); empty.hidden = resultList.children.length > 0; };
	const collect = () => editors.map(editor => editor.read());
	let nextId = 1;
	const addRule = (kind: string, sample?: Draft) => {
		const ids = new Set(editors.map(editor => editor.node.querySelector<HTMLInputElement>(".Grading-id")?.value));
		while (ids.has(`rule-${nextId}`)) nextId++;
		const blank = kind.startsWith("file.") ? { path: "", ...(kind === "file.text" ? { op: "contains" } : kind === "file.json" ? { pointer: "", op: "equals" } : {}) } : guides[kind].sample;
		const card = appendRule({ id: `rule-${nextId++}`, kind, required: !kind.startsWith("tool."), ...structuredClone(sample ?? blank) }, !!sample);
		const first = card.querySelector<HTMLElement>(".Grading-rule-body input, .Grading-rule-body select, .Grading-rule-body textarea"); if (first) focus(first);
	};
	const appendRule = (rule: Draft, sampled = false): HTMLElement => {
		const kind = String(rule.kind); const guide = guides[kind]; const behavior = kind.startsWith("tool.");
		const card = el("div", "", "Grading-rule"); const head = el("div", "", "Grading-rule-head"); const fields = el("div", "", "Grading-rule-body");
		const required = input(); required.type = "checkbox"; required.checked = rule.required !== false;
		const id = input(rule.id); id.classList.add("Grading-id"); const name = input(rule.label ?? "");
		const messages = new Map<Control, HTMLElement>(); const validators: Array<() => void> = [];
		const field = (label: string, control: Control, hint = "") => {
			const wrapper = el("div", "", "form-group Grading-field"); const title = el("label", label, "form-label");
			control.id = `grading-field-${++sequence}`; title.htmlFor = control.id;
			const help = el("p", hint, "form-hint"); help.id = `${control.id}-hint`;
			const issue = el("p", "", "Grading-field-error"); issue.id = `${control.id}-error`;
			control.setAttribute("aria-describedby", `${help.id} ${issue.id}`); messages.set(control, issue);
			wrapper.append(title, control, help, issue); return wrapper;
		};
		const invalid = (control: Control, message: string): never => { control.setAttribute("aria-invalid", "true"); messages.get(control)!.textContent = message; throw new FieldError(message, control); };
		const clear = () => { for (const [control, issue] of messages) { control.removeAttribute("aria-invalid"); issue.textContent = ""; } };
		const validate = (control: Control, task: () => void) => {
			const run = () => { try { task(); } catch (cause) { invalid(control, cause instanceof Error ? cause.message : String(cause)); } };
			validators.push(run); control.addEventListener("blur", event => {
				// Avoid moving the upload target between pointer-down and click. Validate on leaving the card or saving.
				if (event instanceof FocusEvent && event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
				try { run(); } catch { /* Field message is visible. */ }
			});
		};
		const meta = details("高级：规则标识与名称"); const metaRow = el("div", "", "form-row mt-3");
		metaRow.append(field("规则 ID", id, "自动生成，一般无需修改。"), field("显示名称（可选）", name)); meta.append(metaRow);
		validate(id, () => { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id.value) || id.value.startsWith("legacy-")) throw new Error("规则 ID 只能使用 1–80 个字母、数字、下划线或连字符，且不能以 legacy- 开头。"); });
		fields.append(el("p", guide.purpose, "form-hint"));
		if (sampled) fields.append(el("p", "已添加填写示例，请把路径和期望内容改成自己的任务要求。", "Grading-example-note"));
		let readParams: () => Draft = () => ({ ...rule }); let dispose = () => {};
		let dynamicExample: HTMLElement | undefined; let exampleParams = () => guide.sample;
		if (kind.startsWith("file.")) {
			const path = input(rule.path ?? ""); path.placeholder = "例如 reports/summary.json";
			fields.append(field("文件路径", path, "从工作区根目录填写，例如 reports/summary.json；不要填电脑绝对路径或 * 通配符。"));
			validate(path, () => { if (!path.value.trim()) throw new Error("请填写要检查的文件路径，例如 reports/summary.json。"); if (!safeRelative(path.value)) throw new Error("请填写工作区内相对路径，不要以 /、盘符开头或使用 ..。"); if (/[?*]/.test(path.value)) throw new Error("这里只检查一个具体文件，不支持 * 或 ? 通配符。"); });
			readParams = () => ({ ...rule, path: path.value });
			if (kind === "file.text" || kind === "file.json") {
				const isJson = kind === "file.json";
				const opNames = isJson ? ["equals", "exists", "contains", "matches", "approx"] : ["contains", "notContains", "matches"];
				const op = select(opNames.map(key => [key, comparisons[key].label]), String(rule.op ?? (isJson ? "equals" : "contains")));
				const pointer = input(rule.pointer ?? ""); pointer.placeholder = "例如 /total；留空检查整个 JSON";
				if (isJson) {
					fields.append(field("要检查的字段", pointer, '例如 {"total":12} 填 /total；嵌套字段填 /summary/total；数组首项填 /items/0。留空检查整个 JSON。'));
					const more = details("更多字段路径示例"); more.append(el("p", "首项的 name 填 /items/0/name。字段名里的 / 写 ~1，~ 写 ~0。不要填写 $.total 或 total。", "form-hint")); fields.append(more);
					validate(pointer, () => { if (pointer.value && (!pointer.value.startsWith("/") || /~(?![01])/u.test(pointer.value))) throw new Error("字段路径请以 / 开头，例如 /total 或 /items/0；~ 写 ~0，/ 写 ~1。"); });
				}
				fields.append(field("判断方式", op)); const opHelp = el("p", "", "form-hint"); fields.append(opHelp);
				const type = select([["text", "文字"], ["number", "数字"], ["boolean", "是 / 否"], ["null", "空值（null）"], ["json", "数组 / 对象"]], valueType(rule.expected));
				const typeField = field("值的类型", type, "文字直接填 Bun；数字填 12，不需要添加 JSON 引号。");
				const valueControls = new Map<string, Control>(); const valueFields = new Map<string, HTMLElement>();
				for (const key of ["text", "number", "boolean", "null", "json"]) {
					const control = key === "boolean" ? select([["true", "是（true）"], ["false", "否（false）"]], "true") : key === "text" || key === "json" ? el("textarea", "", "form-control") : input();
					if (control instanceof HTMLTextAreaElement) control.rows = key === "json" ? 4 : 2;
					if (key === "number") control.setAttribute("inputmode", "decimal");
					if (key === valueType(rule.expected) && rule.expected !== undefined) control.value = key === "json" ? json(rule.expected) : String(rule.expected);
					control.setAttribute("placeholder", key === "number" ? "例如 12 或 0.3333" : key === "json" ? '[1, 2] 或 {"name":"Bun"}' : "例如 Bun");
					valueControls.set(key, control);
					const title = { text: "期望文本", number: "期望数字", boolean: "期望值", null: "期望空值", json: "期望数组 / 对象（JSON）" }[key]!;
					valueFields.set(key, field(title, control, key === "text" ? "直接填写文字或正则表达式，无需加引号。" : key === "json" ? '数组例如 [1, 2]；对象例如 {"name":"Bun"}。' : ""));
				}
				const nullHelp = el("p", "期望值为 null，无需额外填写；字段仍必须存在。", "form-hint");
				const abs = input(rule.absTolerance ?? ""); const rel = input(rule.relTolerance ?? "");
				for (const n of [abs, rel]) n.setAttribute("inputmode", "decimal");
				const tolerances = el("div"); const relative = details("更多误差设置：相对误差"); relative.open = rule.relTolerance !== undefined;
				relative.append(field("最大相对误差", rel, "0.01 表示 1%。预期值为 0 时，相对误差不能提供非零允许偏差。"));
				tolerances.append(field("最大绝对误差", abs, "例如 0.001。至少填写一种误差，不能为负。"), relative, el("p", "两种都填时允许偏差 = max(绝对误差，相对误差 × |期望值|)。", "form-hint"));
				fields.append(typeField, ...valueFields.values(), nullHelp, tolerances);
				dynamicExample = el("div");
				const currentType = () => !isJson || op.value === "matches" ? "text" : op.value === "approx" ? "number" : type.value;
				const expected = () => readExpected(currentType(), valueControls.get(currentType())!.value);
				for (const [key, control] of valueControls) validate(control, () => {
					if (op.value === "exists" || key !== currentType()) return;
					const value = expected(); if (typeof value === "string" && !value && (!isJson || op.value === "matches")) throw new Error("请填写要检查的文本或正则表达式。");
					if (op.value === "matches") { try { new RegExp(String(value), "u"); } catch { throw new Error("正则表达式无效，请检查括号和转义；例如 ^v[0-9]+$。"); } }
				});
				for (const control of [abs, rel]) validate(control, () => { if (op.value !== "approx") return; if (!abs.value.trim() && !rel.value.trim()) throw new Error("请至少填写一种允许误差，例如绝对误差 0.001。"); if (control.value !== "" && (!control.value.trim() || !Number.isFinite(Number(control.value)) || Number(control.value) < 0)) throw new Error("允许误差须为非负数字，例如 0.001。"); });
				const sync = () => {
					const comparison = comparisons[op.value]; opHelp.textContent = comparison.help;
					typeField.hidden = !isJson || ["exists", "matches", "approx"].includes(op.value);
					for (const [key, field] of valueFields) field.hidden = op.value === "exists" || key !== currentType() || key === "null";
					nullHelp.hidden = op.value === "exists" || currentType() !== "null"; tolerances.hidden = op.value !== "approx";
					const examplePath = op.value === "approx" ? "/ratio" : op.value === "matches" ? "/version" : op.value === "contains" ? "/items" : "/total";
					dynamicExample!.replaceChildren(el("p", `填写示例：${isJson ? `summary.json；字段 ${examplePath}` : op.value === "matches" ? "version.txt" : "README.md"}；${comparison.label}${comparison.sample === undefined ? "，无需预期值" : `；预期值 ${String(comparison.sample)}`}${op.value === "approx" ? "；最大绝对误差 0.001" : ""}。`), el("p", `通过：${comparison.pass}。`), el("p", `不通过：${comparison.fail}。`));
					exampleParams = () => ({ path: isJson ? "summary.json" : op.value === "matches" ? "version.txt" : "README.md", ...(isJson ? { pointer: examplePath } : {}), op: op.value, ...(comparison.sample === undefined ? {} : { expected: comparison.sample }), ...(op.value === "approx" ? { absTolerance: 0.001 } : {}) });
				};
				op.onchange = sync; type.onchange = sync; sync();
				readParams = () => { const result: Draft = { ...rule, path: path.value, op: op.value }; delete result.expected; delete result.absTolerance; delete result.relTolerance; if (isJson) result.pointer = pointer.value; if (op.value !== "exists") result.expected = expected(); if (op.value === "approx") { if (abs.value !== "") result.absTolerance = Number(abs.value); if (rel.value !== "") result.relTolerance = Number(rel.value); } return result; };
			}
		} else if (kind === "command" || kind === "script") {
			const verifier = select([], ""); const status = el("p", "", "form-hint"); let current = String(rule.verifierId ?? "");
			const update = () => {
				verifier.replaceChildren(new Option(verifierState === "loading" ? "正在加载验证脚本…" : "请选择验证脚本", ""));
				for (const v of verifiers) verifier.append(new Option(`${v.runtime === "python" ? "Python · " : ""}${v.label} · ${v.version} · ${v.source === "uploaded" ? "用户上传" : "配置注册"}`, v.id));
				if (current && !verifiers.some(v => v.id === current)) verifier.append(new Option(`${current}（未注册）`, current)); verifier.value = current;
				status.textContent = verifierState === "loading" ? "正在读取服务端注册列表…" : verifierState === "error" ? "列表加载失败，请重试；已填写内容会保留。" : current && !verifiers.some(v => v.id === current) ? "此程序不可用，请上传脚本或选择其他程序。" : !verifiers.length ? "还没有验证脚本，可直接上传，或选择文件 / JSON 检查。" : "选择已有程序，或直接上传验证脚本；无需填写服务端命令或路径。";
			};
			verifier.onchange = () => { current = verifier.value; update(); }; verifierUpdates.add(update); dispose = () => { verifierUpdates.delete(update); }; update();
			fields.append(field("验收程序 / 验证脚本", verifier), status, button("重新加载列表", () => { void loadVerifiers(); }));
			if (kind === "script") {
				const file = input(); file.type = "file"; file.accept = ".py,.js,.mjs,.ts";
				const label = input(); label.maxLength = 80; label.placeholder = "可选，默认使用文件名";
				const uploadStatus = el("p", "", "form-hint"); uploadStatus.setAttribute("role", "status");
				file.onchange = () => { const selected = file.files?.[0]; uploadStatus.textContent = selected ? `${selected.name} · ${selected.size} 字节` : ""; };
				const upload = button("上传验证脚本", () => { void (async () => {
					const selected = file.files?.[0];
					if (!selected) { uploadStatus.textContent = "请先选择 .py 脚本（也兼容 .js/.mjs/.ts）。"; file.focus(); return; }
					if (!/\.(py|js|mjs|ts)$/.test(selected.name) || selected.size > 1024 * 1024 || !selected.size) { uploadStatus.textContent = "请选择非空的 .py/.js/.mjs/.ts 单文件脚本，不超过 1 MiB。"; return; }
					upload.disabled = true; uploadStatus.textContent = "正在上传…";
					try {
						const content = new TextDecoder("utf-8", { fatal: true }).decode(await selected.arrayBuffer());
						const response = await fetch("/api/verifiers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: selected.name, content, ...(label.value.trim() ? { label: label.value.trim() } : {}) }) });
						const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "上传失败");
						await loadVerifiers();
						if (!verifiers.some(v => v.id === value.id)) verifiers.push(value);
						verifierState = "ready"; current = value.id;
						for (const refreshVerifier of verifierUpdates) refreshVerifier();
						verifier.dispatchEvent(new Event("change", { bubbles: true }));
						uploadStatus.textContent = value.syntaxStatus === "pending" ? "上传成功，已选中；Python环境未就绪，需配置后才能运行。" : "上传成功，已选中此脚本，可立即保存案例并运行，无需重启。";
					} catch (cause) { uploadStatus.textContent = `上传失败，原规则已保留，可重试：${cause instanceof Error ? cause.message : String(cause)}`; }
					finally { upload.disabled = false; }
				})(); });
				fields.append(field("选择脚本文件", file, "推荐 UTF-8 .py；兼容 .js/.mjs/.ts，单文件不超过 1 MiB。Python使用标准库或服务端已有依赖，不自动安装。"), field("脚本显示名称（可选）", label), upload, uploadStatus,
					el("p", "脚本会在运行评测器的机器上执行。只上传自己编写或信任的脚本；工作区副本不是操作系统沙箱。", "form-hint"));
				const runtimeHint = el("p", "正在检查Python环境…", "form-hint"); fields.append(runtimeHint);
				void fetch("/api/verifiers/runtime-status").then(r => r.json()).then(value => { runtimeHint.textContent = value.ready ? `Python ${value.version} 已就绪 · 环境 ${value.environmentId.slice(0, 12)}` : value.message; }).catch(() => { runtimeHint.textContent = "Python环境状态读取失败，可重新加载页面。"; });
				const pythonHelp = details("Python verify(ctx)：格式、输入字段与示例"); pythonHelp.open = true;
				pythonHelp.append(el("p", "实现 def verify(ctx)，返回 verdict、message，可选 checks。print 自动记录为日志；无需输出JSON协议。通过：pass；业务失败：fail；数据不足：insufficient。"));
				const pythonTable = el("table");
				for (const [key, meaning] of pythonFields) { const row = el("tr"); row.append(el("th", key), el("td", meaning)); pythonTable.append(row); } pythonHelp.append(pythonTable);
				for (const [filename, template] of [["verify-reply.py", pythonReplyTemplate], ["verify-artifacts.py", pythonArtifactTemplate], ["verify-conversation.py", pythonConversationTemplate]]) {
					pythonHelp.append(button(`下载 ${filename}`, () => { const url = URL.createObjectURL(new Blob([template], { type: "text/plain;charset=utf-8" })); const link = el("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
				}
				pythonHelp.append(el("pre", pythonReplyTemplate, "code")); fields.append(pythonHelp);
				const help = details("兼容JS/TS：脚本格式与执行结果字段"); help.classList.add("Grading-script-guide");
				help.append(el("p", verifierProtocolHelp), el("p", verifierTimingHelp));
				const table = el("table"); const tbody = el("tbody");
				for (const [key, meaning] of verifierFields) { const row = el("tr"); row.append(el("th", key), el("td", meaning)); tbody.append(row); } table.append(tbody); help.append(table);
				for (const [filename, template, title] of [["verify-reply.mjs", replyTemplate, "读取最终回复并验证"], ["verify-artifact.mjs", artifactTemplate, "读取 summary.json 并验证 total=12"]]) {
					help.append(el("h4", title), el("pre", template, "code"), button(`下载 ${filename}`, () => {
						const url = URL.createObjectURL(new Blob([template], { type: "text/javascript;charset=utf-8" })); const link = el("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
					}));
				}
				fields.append(help);
			}
			validate(verifier, () => { if (verifierState !== "ready") throw new Error("请等待验收程序列表加载，或点击“重新加载列表”。"); if (!verifiers.some(v => v.id === verifier.value)) throw new Error("请选择可用程序，或先上传验证脚本。"); });
			const exit = input(rule.expectedExitCode ?? 0); if (kind === "command") { fields.append(field("期望退出码", exit, "通常填 0；实际退出码 0 通过，1 不通过。")); validate(exit, () => { if (!/^\d+$/.test(exit.value) || !Number.isSafeInteger(Number(exit.value))) throw new Error("退出码请填写非负整数，通常为 0。"); }); }
			if (kind === "script") {
				const params = el("textarea", "", "form-control"); params.rows = 3; params.value = json(rule.params ?? {});
				fields.append(field("脚本参数（JSON，可选）", params, '在 ctx["params"] 读取，例如 {"contains":"hello world"}。'));
				const readJson = () => { try { const v = JSON.parse(params.value || "{}"); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(); return v; } catch { throw new Error("脚本参数须为JSON对象"); } };
				validate(params, readJson);
				const inputs: Array<[string, string]> = [["execution", "执行结果"], ["conversation", "会话记录"], ["artifacts", "执行产物"], ["baseline", "执行前文件"], ["diagnostics", "工具诊断"]];
				const selected = new Map<string, HTMLInputElement>(); const full = new Map<string, HTMLInputElement>(); const inputHelp = details("必要输入与完整性要求");
				inputHelp.append(el("p", "不可用的必要输入会返回证据不足。SDK会话完整性通常未知，勾选完整性要求可能无法判定。"));
				for (const [key, title] of inputs) {
					const wanted = input(); wanted.type = "checkbox"; wanted.checked = ((rule.required_inputs as string[] | undefined) ?? ["execution"]).includes(key); selected.set(key, wanted);
					const complete = input(); complete.type = "checkbox"; complete.checked = ((rule.require_complete as string[] | undefined) ?? []).includes(key); full.set(key, complete);
					const row = el("div", "", "flex-center gap-3"); row.append(check(`需要${title}`, wanted), check(`要求${title}完整`, complete)); inputHelp.append(row);
				}
				fields.append(inputHelp);
				readParams = () => ({ ...rule, verifierId: verifier.value, params: readJson(), required_inputs: [...selected].filter(([, control]) => control.checked).map(([key]) => key), require_complete: [...full].filter(([, control]) => control.checked).map(([key]) => key) });
				const trial = verifierTrial({ caseId: options.caseId, getRule: () => ({ ...readParams(), id: id.value, kind: "script" }) as Extract<import("../../grading/types.js").Rule, {kind:"script"}> }); fields.append(trial.element);
				const previousDispose = dispose; dispose = () => { previousDispose(); trial.dispose(); };
			} else readParams = () => ({ ...rule, verifierId: verifier.value, expectedExitCode: Number(exit.value) });
		} else {
			const params = el("textarea", "", "form-control"); params.rows = 5; params.value = json(Object.fromEntries(Object.entries(rule).filter(([key]) => !["id", "kind", "required", "label"].includes(key))));
			fields.append(field("行为参数（JSON，高级）", params, "工具名需与真实工具一致；phase 可填 requested、started 或 completed。当前示例不能证明真实行为已通过。"));
			validate(params, () => { try { const p = JSON.parse(params.value); if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(); parseGrading({ version: 1, rules: [{ ...p, id: "check", kind, required: true }] }); } catch { throw new Error("行为参数格式不正确，请参考下方完整示例；参数必须是 JSON 对象。"); } });
			readParams = () => JSON.parse(params.value);
		}
		const example = details("查看填写示例与通过 / 失败对照"); example.classList.add("Grading-example");
		example.append(dynamicExample ?? el("p", guide.example)); if (behavior) example.append(el("pre", json(guide.sample), "code"));
		if (kind.startsWith("file.") || behavior) example.append(button("添加此示例规则", () => addRule(kind, exampleParams())));
		else example.append(el("p", "请先选择实际已注册的程序；示例不会虚构验证器。", "form-hint"));
		const preview = el("p", "", "Grading-preview");
		const read = () => { clear(); for (const task of validators) task(); const value: Draft = { ...readParams(), id: id.value, kind, required: required.checked }; delete value.label; if (name.value) value.label = name.value; return value; };
		const updatePreview = (showErrors: boolean) => { try { const value = read(); preview.textContent = `通过条件：${condition(value)}${required.checked ? "" : "（仅供诊断，不影响任务通过）"}`; } catch (cause) { preview.textContent = `待补充：${cause instanceof Error ? cause.message : String(cause)}`; if (!showErrors) clear(); } };
		card.addEventListener("input", () => updatePreview(false)); card.addEventListener("change", () => updatePreview(false)); card.addEventListener("focusout", event => { if (event instanceof FocusEvent && event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return; updatePreview(true); });
		const editor: Editor = { node: card, read, dispose };
		const remove = button("移除", () => { editor.dispose(); editors = editors.filter(item => item !== editor); card.remove(); refresh(); }); remove.classList.add("btn-danger"); remove.setAttribute("aria-label", `移除规则：${guide.title}`);
		head.append(el("strong", guide.title), check("必须满足才算通过", required), remove);
		fields.append(example, preview, meta); card.append(head, fields); editors.push(editor); (behavior ? behaviorList : resultList).append(card); refresh(); updatePreview(false); return card;
	};
	const chooser = (behavior: boolean) => {
		const wrapper = el("div", "", "Grading-chooser"); const title = el("label", behavior ? "行为检查类型" : "你想检查什么？", "form-label");
		const choice = select(Object.entries(guides).filter(([key]) => key.startsWith("tool.") === behavior).map(([key, guide]) => [key, guide.title]), behavior ? "tool.count" : "file.exists");
		choice.id = `grading-choice-${++sequence}`; title.htmlFor = choice.id;
		const toolbar = el("div", "", "Grading-toolbar"); const add = button("＋ 添加规则", () => addRule(choice.value)); add.classList.add("btn-primary"); toolbar.append(choice, add);
		const purpose = el("p", "", "form-hint"); const sample = el("p", "", "form-hint"); const use = button("添加此示例规则", () => addRule(choice.value, guides[choice.value].sample));
		const sync = () => { purpose.textContent = guides[choice.value].purpose; sample.textContent = guides[choice.value].example; use.hidden = ["command", "script"].includes(choice.value); };
		choice.onchange = sync; sync(); wrapper.append(title, toolbar, purpose, sample, use); return wrapper;
	};
	const title = el("div", "", "section-title"); title.append(el("span", "结果规则"), count); content.append(chooser(false), title, empty, resultList);
	const behavior = details("行为检查（当前不可判分）"); behavior.open = !!initial?.rules.some(rule => rule.kind.startsWith("tool.")); behavior.append(el("p", "当前无法验证真实工具行为。可选规则只显示证据不足；必要行为规则会阻止运行。", "form-hint"), chooser(true), behaviorList); content.append(behavior);
	const advanced = details("高级：整体 JSON 编辑"); advanced.classList.add("Grading-json"); const raw = el("textarea", "", "form-control mt-3"); raw.rows = 8; raw.setAttribute("aria-label", "完整判分规则 JSON");
	const rawError = el("div", "", "Grading-error"); rawError.setAttribute("role", "alert");
	const load = () => { raw.value = json({ version: 1, rules: collect() }); }; advanced.addEventListener("toggle", () => { if (advanced.open && !raw.value) attempt(load); });
	const actions = el("div", "", "flex gap-2 wrap mt-2"); actions.append(button("载入当前规则", () => attempt(load)), button("应用 JSON", () => {
		try { const config = parseGrading(JSON.parse(raw.value))!; for (const editor of editors) editor.dispose(); editors = []; resultList.replaceChildren(); behaviorList.replaceChildren(); for (const rule of config.rules) appendRule(rule as unknown as Draft); rawError.textContent = ""; error.textContent = ""; }
		catch (cause) { rawError.textContent = `未应用，原规则已保留。请检查 JSON 语法和规则字段。详细信息：${cause instanceof Error ? cause.message : String(cause)}`; raw.focus(); }
	})); advanced.append(raw, rawError, actions); content.append(advanced);
	for (const rule of initial?.rules ?? []) appendRule(rule as unknown as Draft); refresh();
	function loadVerifiers(): Promise<void> {
		if (loadTask) return loadTask;
		verifierState = "loading"; for (const update of verifierUpdates) update();
		loadTask = (async () => {
			try { const response = await fetch("/api/verifiers"); if (!response.ok) throw new Error(); const data = await response.json(); if (!Array.isArray(data.verifiers)) throw new Error(); verifiers = data.verifiers; verifierState = "ready"; }
			catch { verifierState = "error"; }
			finally { loadTask = undefined; for (const update of verifierUpdates) update(); }
		})(); return loadTask;
	}
	void loadVerifiers();
	return { element, setMode: (mode: string) => { modeHint.hidden = mode === "full-task"; }, read: (mode: string) => {
		if (!enabled.checked) return undefined;
		try {

			const rules = collect(); if (mode !== "full-task" && rules.some(r => r.kind !== "script" || verifiers.find(v => v.id === r.verifierId)?.runtime !== "python" || [...(r.required_inputs as string[] ?? []), ...(r.require_complete as string[] ?? [])].some(v => ["artifacts", "baseline"].includes(v)))) throw new Error("单轮只支持Python回复/会话验证；产物检查请选择完整任务模式。"); if (!rules.length) throw new Error("请先添加一条结果规则，或关闭“启用验收”。");
			if (!rules.some(rule => rule.required !== false)) throw new Error("请至少为一条规则勾选“必须满足才算通过”。");
			const ids = new Set<unknown>(); for (const [index, rule] of rules.entries()) { if (ids.has(rule.id)) throw new FieldError(`第 ${index + 1} 条规则 ID 重复，请在高级设置中修改。`, editors[index].node.querySelector<HTMLInputElement>(".Grading-id")!); ids.add(rule.id); if (String(rule.kind).startsWith("tool.") && rule.required !== false) throw new Error(`${guides[String(rule.kind)].title}当前无法验证真实行为，请取消“必须满足”或移除此规则。`); }
			const config = parseGrading({ version: 1, rules }, "grading", mode); error.textContent = ""; return config;
		} catch (cause) { report(cause); throw cause; }
	} };
}
