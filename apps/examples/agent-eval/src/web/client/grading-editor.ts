import { verifierDialog, row as actionRow } from "./verifier-ui.js";
import { scriptEditor } from "./script-editor.js";
import { parseGrading, safeRelative } from "../../grading/schema.js";
import type { GradingConfig } from "../../grading/types.js";
import { comparisons, condition, guides, readExpected, valueType, ruleTitle } from "./grading-help.js";

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

export function gradingEditor(initial?: GradingConfig, options: { caseId?: string; onModeChange?: () => void } = {}) {
	const element = el("section", "", "Box mt-3 Grading");
	const header = el("div", "", "Box-header"); const enabled = input(); enabled.type = "checkbox"; enabled.checked = !!initial;
	header.append(el("span", "文件与脚本检查"), check("启用文件与脚本检查", enabled));
	const body = el("div", "", "Box-body");
	const disabledHint = el("p", "当前页保留已填写内容；保存后不执行这些文件与脚本检查。最终回复检查仍有效。", "form-hint");
	const content = el("div"); content.hidden = !enabled.checked; disabledHint.hidden = enabled.checked;
	enabled.onchange = () => { content.hidden = !enabled.checked; disabledHint.hidden = enabled.checked; };
	body.append(disabledHint, content); element.append(header, body); element.hidden = !initial;
	let currentMode = "single-turn"; const modeUpdates = new Set<() => void>();
	const error = el("div", "", "Grading-error"); error.setAttribute("role", "alert"); body.prepend(error);
	const focus = (node: HTMLElement) => { const panel = node.closest('[role="tabpanel"]'); if (panel?.id) document.querySelector<HTMLButtonElement>(`[aria-controls="${panel.id}"]`)?.click(); for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; node.focus(); node.scrollIntoView({ block: "center" }); };
	const report = (cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); if (cause instanceof FieldError) { if (!cause.control.hasAttribute("aria-invalid")) { cause.control.setAttribute("aria-invalid", "true"); const issue = document.getElementById(`${cause.control.id}-error`); if (issue) issue.textContent = cause.message; } focus(cause.control); } };
	const attempt = (action: () => void) => { try { action(); error.textContent = ""; } catch (cause) { report(cause); } };
	type Editor = { node: HTMLElement; read: (validateFields?: boolean) => Draft; dispose: () => void; modeIssue: () => string; anchor: () => Control; requiredControl: HTMLInputElement };
	let editors: Editor[] = [];
	let verifiers: Verifier[] = []; let verifierState: "loading" | "ready" | "error" = "loading"; let loadTask: Promise<void> | undefined;
	const verifierUpdates = new Set<() => void>();
	const resultList = el("div"); const behaviorList = el("div"); const empty = el("p", "还没有文件或脚本检查。可从上方添加，或取消启用文件与脚本检查。", "Grading-empty");
	const count = el("span", "0", "Label Label--neutral");
	const refresh = () => { count.textContent = String(resultList.children.length); empty.hidden = resultList.children.length > 0; };
	const collect = (validateFields = true) => {
		const values: Draft[] = []; const issues: unknown[] = [];
		for (const editor of editors) { try { values.push(editor.read(validateFields)); } catch (issue) { issues.push(issue); } }
		if (issues.length) { const first = issues[0]; const message = `有 ${issues.length} 条检查需要修正：${first instanceof Error ? first.message : String(first)}`; if (first instanceof FieldError) throw new FieldError(message, first.control); throw new Error(message); }
		return values;
	};
	let nextId = 1;
	const addRule = (kind: string, sample?: Draft) => {
		enabled.checked = true; content.hidden = false; disabledHint.hidden = true; element.hidden = false;
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
			validators.push(() => { try { task(); } catch (cause) { invalid(control, cause instanceof Error ? cause.message : String(cause)); } });
		};
		const meta = details("高级：规则标识与名称"); const metaRow = el("div", "", "form-row mt-3");
		metaRow.append(field("规则 ID", id, "自动生成，一般无需修改。"), field("显示名称（可选）", name)); meta.append(metaRow);
		validate(id, () => { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id.value) || id.value.startsWith("legacy-")) throw new Error("规则 ID 只能使用 1–80 个字母、数字、下划线或连字符，且不能以 legacy- 开头。"); });
		fields.append(el("p", guide.purpose, "form-hint"));
		if (sampled) fields.append(el("p", "已添加填写示例，请把路径和期望内容改成自己的任务要求。", "Grading-example-note"));
		let readParams: () => Draft = () => ({ ...rule }); let dispose = () => {};
		let dynamicExample: HTMLElement | undefined; let exampleParams = () => guide.sample;
		if (kind.startsWith("file.")) {
			const path = input(rule.path ?? ""); path.placeholder = `例如 ${String(guide.sample.path ?? "out.txt")}`;
			fields.append(field("文件路径", path, "相对于任务工作区的文件路径；不支持目录、绝对路径或通配符。"));
			validate(path, () => { if (!path.value.trim()) throw new Error("请填写要检查的文件路径，例如 reports/summary.json。"); if (!safeRelative(path.value)) throw new Error("请填写工作区内相对路径，不要以 /、盘符开头或使用 ..。"); if (/[?*]/.test(path.value)) throw new Error("这里只检查一个具体文件，不支持 * 或 ? 通配符。"); });
			readParams = () => ({ ...rule, path: path.value });
			if (kind === "file.text" || kind === "file.json") {
				const isJson = kind === "file.json";
				const opNames = isJson ? ["equals", "exists", "contains", "matches", "approx"] : ["contains", "notContains", "matches"];
				const op = select(opNames.map(key => [key, comparisons[key].label]), String(rule.op ?? (isJson ? "equals" : "contains")));
				const pointer = input(rule.pointer ?? ""); pointer.placeholder = "例如 /total；留空检查整个 JSON";
				if (isJson) {
					fields.append(field("要检查的字段", pointer, '例如 {"total":12} 填 /total；留空检查整个 JSON。复杂路径见下方示例。'));
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
					const comparison = comparisons[op.value]; opHelp.textContent = isJson ? comparison.help : op.value === "contains" ? "文件内容必须包含这段文字，区分大小写。" : op.value === "notContains" ? "文件内容不能出现这段文字；缺少文件仍不通过。" : "直接填写正则表达式，不加 / 分隔符；用于 UTF-8 文件。";
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
		} else if (kind === "script") {
			const script = scriptEditor(rule, { caseId: options.caseId, getId: () => id.value, field, validate,
				list: () => verifiers, state: () => verifierState, reload: loadVerifiers,
				subscribe: update => { verifierUpdates.add(update); return () => { verifierUpdates.delete(update); }; },
				uploaded: value => { if (!verifiers.some(v => v.id === value.id)) verifiers.push({ ...value, dependencies: [] }); verifierState = "ready"; for (const update of verifierUpdates) update(); },
			});
			fields.append(script.element); readParams = script.read; dispose = script.dispose;
		} else if (kind === "command") {
			const verifier = select([], ""); const status = el("p", "", "form-hint"); let current = String(rule.verifierId ?? "");
			const update = () => {
				verifier.replaceChildren(new Option(verifierState === "loading" ? "正在加载验收程序…" : "请选择验收程序", ""));
				for (const v of verifiers.filter(v => v.source !== "uploaded" || v.id === current)) verifier.append(new Option(`${v.runtime === "python" ? "Python · " : ""}${v.label} · ${v.version} · ${v.source === "uploaded" ? "用户上传" : "配置注册"}`, v.id));
				if (current && !verifiers.some(v => v.id === current)) verifier.append(new Option(`${current}（未注册）`, current)); verifier.value = current;
				status.textContent = verifierState === "loading" ? "正在加载维护者配置的程序…" : verifierState === "error" ? "列表加载失败，请重试，原选择已保留。" : current && !verifiers.some(v => v.id === current) ? "原程序不可用，请选择其他程序或联系维护者。" : !verifiers.some(v => v.source !== "uploaded") ? "暂无维护者配置的程序。可用上方的文件检查或上传 Python 脚本。" : "选择维护者配置的验收程序，不需要填写命令或服务器路径。";
			};
			verifier.onchange = () => { current = verifier.value; update(); }; verifierUpdates.add(update); dispose = () => { verifierUpdates.delete(update); }; update();
			fields.append(field("已配置的验收程序", verifier), status, button("重新加载列表", () => { void loadVerifiers(); }));
			validate(verifier, () => { if (verifierState !== "ready") throw new Error("请等待验收程序列表加载，或点击“重新加载列表”。"); if (!verifiers.some(v => v.id === verifier.value)) throw new Error("请选择可用的注册程序；也可移除此项并添加 Python 脚本检查。"); });
			const exit = input(rule.expectedExitCode ?? 0); fields.append(field("期望退出码", exit, "通常填 0；实际退出码 0 通过，1 不通过。"));
			validate(exit, () => { if (!/^\d+$/.test(exit.value) || !Number.isSafeInteger(Number(exit.value))) throw new Error("退出码请填写非负整数，通常为 0。"); });
			readParams = () => ({ ...rule, verifierId: verifier.value, expectedExitCode: Number(exit.value) });
		} else {
			const params = el("textarea", "", "form-control"); params.rows = 5; params.value = json(Object.fromEntries(Object.entries(rule).filter(([key]) => !["id", "kind", "required", "label"].includes(key))));
			fields.append(field("行为参数（JSON，高级）", params, "工具名需与真实工具一致；phase 可填 requested、started 或 completed。当前示例不能证明真实行为已通过。"));
			validate(params, () => { try { const p = JSON.parse(params.value); if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(); parseGrading({ version: 1, rules: [{ ...p, id: "check", kind, required: true }] }); } catch { throw new Error("行为参数格式不正确，请参考下方完整示例；参数必须是 JSON 对象。"); } });
			readParams = () => JSON.parse(params.value);
		}
		const example = details("查看填写示例与通过 / 失败对照"); example.classList.add("Grading-example");
		example.append(dynamicExample ?? el("p", guide.example)); if (behavior) example.append(el("pre", json(guide.sample), "code"));
		if (kind.startsWith("file.") || behavior) example.append(button("插入新示例检查", () => addRule(kind, exampleParams())));
		else example.append(el("p", "请先选择实际已注册的程序；示例不会虚构验证器。", "form-hint"));
		const preview = el("p", "", "Grading-preview"); const caption = el("strong", guide.title);
		const requiredIssue = el("p", "", "Grading-field-error"); required.id = `grading-field-${++sequence}`; requiredIssue.id = `${required.id}-error`; required.setAttribute("aria-describedby", requiredIssue.id); messages.set(required, requiredIssue);
		const read = (validateFields = true) => {
			if (validateFields) { clear(); let first: unknown; for (const task of validators) { try { task(); } catch (cause) { first ??= cause; } } if (first) throw first; }
			const value: Draft = { ...readParams(), id: id.value, kind, required: required.checked }; delete value.label; if (name.value) value.label = name.value; return value;
		};
		const modeIssue = () => {
			if (behavior) return required.checked ? "当前不能验证真实工具行为。请取消“影响通过”，仅作为参考诊断。" : "";
			if (currentMode === "full-task") return "";
			if (kind !== "script") return "这项检查需要完整任务模式。切换模式后可继续使用，配置不会被删除。";
			try { const value = read(false); if (!value.verifierId) return ""; if (verifiers.find(v => v.id === value.verifierId)?.runtime !== "python") return "单轮仅支持 Python 回复或会话脚本；当前脚本需要完整任务模式。";
				if ([...(value.required_inputs as string[] ?? []), ...(value.require_complete as string[] ?? [])].some(v => ["artifacts", "baseline"].includes(v))) return "脚本要求读取文件，需要完整任务模式。";
			} catch { /* The corresponding field is validated on save. */ } return "";
		};
		const warning = el("div", "", "Grading-mode-warning"); const updateMode = () => {
			const issue = modeIssue(); warning.replaceChildren(); warning.hidden = !issue;
			if (issue) { warning.append(el("p", issue)); if (!behavior && options.onModeChange) warning.append(button("切换为完整任务", options.onModeChange)); }
		}; modeUpdates.add(updateMode);
		const updatePreview = () => { try { const value = read(false); caption.textContent = ruleTitle(value, verifiers.find(v => v.id === value.verifierId)?.label); preview.textContent = kind.startsWith("file.") && !value.path ? "填写文件路径和检查要求，保存后即可生效。" : `通过条件：${condition(value)}${required.checked ? "" : "（仅作参考，不影响通过）"}`; } catch { preview.textContent = "补充检查要求后，这里会显示通过条件。"; } updateMode(); };
		card.addEventListener("input", () => { clear(); updatePreview(); }); card.addEventListener("change", () => { clear(); updatePreview(); });
		const originalDispose = dispose; dispose = () => { modeUpdates.delete(updateMode); originalDispose(); };
		const anchor = () => card.querySelector<Control>(".Grading-rule-body input:not(.Grading-id), .Grading-rule-body select, .Grading-rule-body textarea") ?? required;
		const editor: Editor = { node: card, read, dispose, modeIssue, anchor, requiredControl: required };
		const remove = button("移除", () => { editor.dispose(); editors = editors.filter(item => item !== editor); card.remove(); refresh(); }); remove.classList.add("btn-danger"); remove.setAttribute("aria-label", `移除检查：${guide.title}`);
		head.append(caption, check("影响通过", required), remove);
		const roleHint = el("span", required.checked ? "必要检查" : "仅作参考", "Label Label--neutral"); head.append(roleHint); required.addEventListener("change", () => { roleHint.textContent = required.checked ? "必要检查" : "仅作参考"; });
		fields.prepend(warning); if (kind !== "script") fields.append(example); fields.append(preview, requiredIssue, meta); card.append(head, fields); editors.push(editor); (behavior ? behaviorList : resultList).append(card); refresh(); updatePreview(); return card;
	};
	const title = el("div", "", "section-title"); title.append(el("span", "已有文件与脚本检查"), count); content.append(title, empty, resultList);
	const advanced = el("div", "", "Grading-settings");
	const registered = details("维护者配置的验收程序"); registered.append(el("p", "高级能力：需要维护者预先配置程序。普通业务检查可直接使用文件规则或上传 Python。", "form-hint"), button("添加注册程序检查", () => addRule("command"))); advanced.append(registered);
	const behavior = details("工具行为诊断（暂不支持判分）");
	behavior.append(el("p", "当前无法验证真实工具执行或审批行为，只能作参考。已有配置保留，不会自动转换为通过条件。", "form-hint"));
	const existingDiagnostics = details("查看已有诊断配置"); existingDiagnostics.append(behaviorList);
	const diagnosticChoice = select(Object.entries(guides).filter(([key]) => key.startsWith("tool.")).map(([key, guide]) => [key, guide.title]), "tool.count"); diagnosticChoice.setAttribute("aria-label", "行为诊断类型");
	const diagnosticAdd = details("新增高级诊断配置"); diagnosticAdd.append(actionRow(diagnosticChoice, button("添加参考诊断", () => { addRule(diagnosticChoice.value); existingDiagnostics.open = true; }))); behavior.append(existingDiagnostics, diagnosticAdd); advanced.append(behavior);
	const whole = details("整体 JSON 编辑（高级）"); whole.classList.add("Grading-json"); const raw = el("textarea", "", "form-control mt-3"); raw.rows = 8; raw.setAttribute("aria-label", "完整判分规则 JSON");
	const rawError = el("div", "", "Grading-error"); rawError.setAttribute("role", "alert"); const rawStatus = el("p", "", "form-hint"); rawStatus.setAttribute("role", "status");
	const load = () => { raw.value = json({ version: 1, rules: collect(false) }); rawStatus.textContent = "已载入当前表单；编辑后需应用，再保存案例。"; }; whole.addEventListener("toggle", () => { if (whole.open && !raw.value) attempt(load); });
	raw.oninput = () => { rawStatus.textContent = "JSON 有待应用的修改；当前表单尚未改变。"; };
	const apply = () => {
		let config: GradingConfig; try { config = parseGrading(JSON.parse(raw.value))!; if (!config) throw new Error("请填写包含 version 和 rules 的规则对象。"); } catch (cause) { rawError.textContent = `未应用，原检查已保留：${cause instanceof Error ? cause.message : String(cause)}`; raw.focus(); return; }
		const confirmation = el("div"); confirmation.append(el("p", `将用 JSON 中的 ${config.rules.length} 条规则替换现有文件、脚本与诊断检查。最终回复检查不受影响。`), el("p", "应用后仍需保存案例。", "form-hint"));
		const modal = verifierDialog("应用 JSON 检查", confirmation, { footer: actionRow(button("取消", () => modal.close()), button("替换并应用", () => {
			for (const editor of editors) editor.dispose(); editors = []; resultList.replaceChildren(); behaviorList.replaceChildren();
			for (const rule of config.rules) appendRule(rule as unknown as Draft); element.hidden = false; enabled.checked = true; content.hidden = false; disabledHint.hidden = true;
			rawError.textContent = ""; error.textContent = ""; rawStatus.textContent = "已应用到表单，请保存案例。"; refresh(); modal.close();
		})) });
	};
	whole.append(el("p", "只编辑文件、脚本和诊断规则。应用会替换当前表单，最终回复检查单独保存。", "form-hint"), raw, rawError, rawStatus, actionRow(button("重新载入表单", () => attempt(load)), button("应用 JSON", apply))); advanced.append(whole);
	for (const rule of initial?.rules ?? []) appendRule(rule as unknown as Draft); refresh();
	const openFiles = () => {
		const chooser = el("div", "", "Grading-file-chooser"); const notice = el("p", "", "form-hint"); const choice = select(Object.entries(guides).filter(([key]) => key.startsWith("file.")).map(([key, guide]) => [key, guide.title]), "file.exists"); choice.setAttribute("aria-label", "文件检查类型");
		const purpose = el("p", guides[choice.value].purpose, "form-hint"); choice.onchange = () => { purpose.textContent = guides[choice.value].purpose; };
		let pendingKind: string | undefined;
		const submit = button("添加检查", () => { if (currentMode !== "full-task") return; pendingKind = choice.value; modal.close(); }); submit.classList.add("btn-primary");
		const switchMode = button("切换为完整任务", () => { options.onModeChange?.(); sync(); });
		const sync = () => { const single = currentMode !== "full-task"; notice.textContent = single ? "文件产物检查需要完整任务模式，切换后可选择检查类型。已有配置不会被清除。" : "选择一项文件检查，添加后填写文件路径和业务要求。"; choice.disabled = single; submit.disabled = single; switchMode.hidden = !single; }; sync(); chooser.append(notice, choice, purpose, actionRow(switchMode));
		const modal = verifierDialog("添加文件检查", chooser, { footer: actionRow(button("取消", () => modal.close()), submit), onClose: () => { if (pendingKind) addRule(pendingKind); } });
	};
	function loadVerifiers(): Promise<void> {
		if (loadTask) return loadTask;
		verifierState = "loading"; for (const update of verifierUpdates) update();
		loadTask = (async () => {
			try { const response = await fetch("/api/verifiers"); if (!response.ok) throw new Error(); const data = await response.json(); if (!Array.isArray(data.verifiers)) throw new Error(); verifiers = data.verifiers; verifierState = "ready"; }
			catch { verifierState = "error"; }
			finally { loadTask = undefined; for (const update of verifierUpdates) update(); for (const update of modeUpdates) update(); }
		})(); return loadTask;
	}
	void loadVerifiers();
	return { element, advanced, openFiles, addScript: () => addRule("script"), setMode: (mode: string) => { currentMode = mode; for (const update of modeUpdates) update(); }, read: (mode: string) => {
		if (!enabled.checked) return undefined;
		try {

			const rules = collect();
			const conflict = editors.find(editor => editor.modeIssue() && (editor.read(false).required !== false || editor.read(false).kind === "script")); if (conflict) { error.textContent = conflict.modeIssue(); focus(conflict.anchor()); throw new Error(conflict.modeIssue()); }
			if (!rules.length) throw new Error("请添加文件或脚本检查，或取消启用文件与脚本检查。");
			if (!rules.some(rule => rule.required !== false)) throw new FieldError("至少一项文件或脚本检查需要勾选“影响通过”。", editors[0].requiredControl);
			const ids = new Set<unknown>(); for (const [index, rule] of rules.entries()) { if (ids.has(rule.id)) throw new FieldError(`第 ${index + 1} 条检查的 ID 重复，请在规则详情中修改。`, editors[index].node.querySelector<HTMLInputElement>(".Grading-id")!); ids.add(rule.id); }

			const config = parseGrading({ version: 1, rules }, "grading", mode); error.textContent = ""; return config;
		} catch (cause) { report(cause); throw cause; }
	} };
}
