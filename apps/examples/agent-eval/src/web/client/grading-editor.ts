import { parseGrading, safeRelative } from "../../grading/schema.js";
import type { GradingConfig } from "../../grading/types.js";
import { comparisons, condition, guides, readExpected, valueType } from "./grading-help.js";

type Draft = Record<string, unknown>;
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Verifier = { id: string; label: string; version: string; dependencies: string[] };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; };
const input = (value: unknown = "") => { const node = el("input", "", "form-control"); node.value = String(value); return node; };
const select = (options: [string, string][], value = "") => { const node = el("select", "", "form-control"); for (const [key, name] of options) node.append(new Option(name, key)); node.value = value; return node; };
const button = (label: string, click: () => void) => { const node = el("button", label, "btn btn-sm"); node.type = "button"; node.onclick = click; return node; };
const details = (summary: string) => { const node = el("details", "", "Grading-advanced"); node.append(el("summary", summary)); return node; };
const check = (label: string, control: HTMLInputElement) => { const node = el("label", "", "form-check"); node.append(control, document.createTextNode(label)); return node; };
const json = (value: unknown) => JSON.stringify(value, null, 2);
class FieldError extends Error { constructor(message: string, readonly control: Control) { super(message); } }
let sequence = 0;

export function gradingEditor(initial?: GradingConfig) {
	const element = el("section", "", "Box mt-3 Grading");
	const header = el("div", "", "Box-header"); const enabled = input(); enabled.type = "checkbox"; enabled.checked = !!initial;
	header.append(el("span", "任务结果与行为验收"), check("启用验收", enabled));
	const body = el("div", "", "Box-body");
	body.append(el("p", "检查 Agent 运行结束后的工作区文件。只回复“已完成”不代表通过；要检查最终回复，请使用上方“最终回复检查”。", "form-hint Grading-intro"));
	const content = el("div"); content.hidden = !enabled.checked; enabled.onchange = () => { content.hidden = !enabled.checked; };
	const modeHint = el("p", "文件验收需要完整任务模式，请在上方“回放方式”选择完整任务。", "form-hint");
	content.append(modeHint, el("p", "必要规则与上方已填写的最终回复检查都满足才通过。取消“必须满足”后仅供诊断；至少保留一条必要规则。", "form-hint"));
	body.append(content); element.append(header, body);
	const error = el("div", "", "Grading-error"); error.setAttribute("role", "alert"); body.append(error);
	const focus = (node: HTMLElement) => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; node.focus(); node.scrollIntoView({ block: "center" }); };
	const report = (cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); if (cause instanceof FieldError) focus(cause.control); };
	const attempt = (action: () => void) => { try { action(); error.textContent = ""; } catch (cause) { report(cause); } };
	type Editor = { node: HTMLElement; read: () => Draft; dispose: () => void };
	let editors: Editor[] = [];
	let verifiers: Verifier[] = []; let verifierState: "loading" | "ready" | "error" = "loading"; let loading = false;
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
			validators.push(run); control.addEventListener("blur", () => { try { run(); } catch { /* Field message is visible. */ } });
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
				verifier.replaceChildren(new Option(verifierState === "loading" ? "正在加载验收程序…" : "请选择已注册的验收程序", ""));
				for (const v of verifiers) verifier.append(new Option(`${v.label} · ${v.version}`, v.id));
				if (current && !verifiers.some(v => v.id === current)) verifier.append(new Option(`${current}（未注册）`, current)); verifier.value = current;
				status.textContent = verifierState === "loading" ? "正在读取服务端注册列表…" : verifierState === "error" ? "列表加载失败，请重试；已填写内容会保留。" : current && !verifiers.some(v => v.id === current) ? "此程序未注册，请联系维护者或选择其他程序。" : !verifiers.length ? "当前没有可用程序，请联系维护者注册，或选择文件 / JSON 检查。" : "请选择维护者已注册的程序，无需填写命令或脚本路径。";
			};
			verifier.onchange = () => { current = verifier.value; update(); }; verifierUpdates.add(update); dispose = () => { verifierUpdates.delete(update); }; update();
			fields.append(field("已配置的验收程序", verifier), status, button("重新加载列表", () => { void loadVerifiers(); }));
			validate(verifier, () => { if (verifierState !== "ready") throw new Error("请等待验收程序列表加载，或点击“重新加载列表”。"); if (!verifiers.some(v => v.id === verifier.value)) throw new Error("请选择已注册的验收程序；列表为空时请联系维护者，或改用文件 / JSON 检查。"); });
			const exit = input(rule.expectedExitCode ?? 0); if (kind === "command") { fields.append(field("期望退出码", exit, "通常填 0；实际退出码 0 通过，1 不通过。")); validate(exit, () => { if (!/^\d+$/.test(exit.value) || !Number.isSafeInteger(Number(exit.value))) throw new Error("退出码请填写非负整数，通常为 0。"); }); }
			readParams = () => ({ ...rule, verifierId: verifier.value, ...(kind === "command" ? { expectedExitCode: Number(exit.value) } : {}) });
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
		card.addEventListener("input", () => updatePreview(false)); card.addEventListener("change", () => updatePreview(false)); card.addEventListener("focusout", () => updatePreview(true));
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
	async function loadVerifiers() { if (loading) return; loading = true; verifierState = "loading"; for (const update of verifierUpdates) update(); try { const response = await fetch("/api/verifiers"); if (!response.ok) throw new Error(); const data = await response.json(); if (!Array.isArray(data.verifiers)) throw new Error(); verifiers = data.verifiers; verifierState = "ready"; } catch { verifierState = "error"; } finally { loading = false; for (const update of verifierUpdates) update(); } }
	void loadVerifiers();
	return { element, setMode: (mode: string) => { modeHint.hidden = mode === "full-task"; }, read: (mode: string) => {
		if (!enabled.checked) return undefined;
		try {
			if (mode !== "full-task") throw new Error("文件验收需要完整任务模式。请在上方“回放方式”选择完整任务。");
			const rules = collect(); if (!rules.length) throw new Error("请先添加一条结果规则，或关闭“启用验收”。");
			if (!rules.some(rule => rule.required !== false)) throw new Error("请至少为一条规则勾选“必须满足才算通过”。");
			const ids = new Set<unknown>(); for (const [index, rule] of rules.entries()) { if (ids.has(rule.id)) throw new FieldError(`第 ${index + 1} 条规则 ID 重复，请在高级设置中修改。`, editors[index].node.querySelector<HTMLInputElement>(".Grading-id")!); ids.add(rule.id); if (String(rule.kind).startsWith("tool.") && rule.required !== false) throw new Error(`${guides[String(rule.kind)].title}当前无法验证真实行为，请取消“必须满足”或移除此规则。`); }
			const config = parseGrading({ version: 1, rules }, "grading", mode); error.textContent = ""; return config;
		} catch (cause) { report(cause); throw cause; }
	} };
}
