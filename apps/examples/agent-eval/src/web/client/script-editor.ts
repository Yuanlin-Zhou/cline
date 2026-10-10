import type { ValidationInputName, Rule } from "../../grading/types.js";
import { verifierTrial } from "./verifier-trial.js";
import { node, action, row, fold, verifierDialog, openVerifierGuide } from "./verifier-ui.js";

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Verifier = { id: string; label: string; version: string; runtime?: string; source?: string };
export function scriptEditor(rule: Record<string, unknown>, options: {
	caseId?: string; getId: () => string;
	field: (title: string, control: Control, hint?: string) => HTMLElement;
	validate: (control: Control, task: () => void) => void;
	list: () => Verifier[]; state: () => string; reload: () => Promise<void>;
	subscribe: (update: () => void) => () => void; uploaded: (v: Verifier) => void;
}) {
	const root = node("div", "", "ScriptEditor"); const selection = node("select", "", "form-control"); let current = String(rule.verifierId ?? ""); let pythonReady = false;
	const status = node("p", "", "form-hint"); status.setAttribute("role", "status");
	const summary = node("div", "", "Verifier-summary"); const runtime = node("span", "正在检查 Python 环境…", "form-hint"); const metadata = node("p", "", "form-hint");
	const advance = fold("高级设置"); const advanceSummary = advance.querySelector("summary")!;
	const params = node("textarea", "", "form-control"); params.rows = 3; params.value = JSON.stringify(rule.params ?? {}, null, 2);
	const readJson = () => { try { const value = JSON.parse(params.value || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new Error("脚本参数须为 JSON 对象，例如 {\"contains\":\"已完成\"}。"); } };
	options.validate(params, readJson);
	advance.append(options.field("脚本参数（JSON，可选）", params, '在 ctx["params"] 中读取；不使用参数时保持 {}。'));
	const inputs = [["execution", "执行结果"], ["conversation", "会话记录"], ["artifacts", "执行产物"], ["baseline", "执行前文件"], ["diagnostics", "工具诊断"]] as const;
	const wanted = new Map<ValidationInputName, HTMLInputElement>(); const complete = new Map<ValidationInputName, HTMLInputElement>();
	const requirements = fold("必要输入与完整性要求"); requirements.append(node("p", "缺少必要输入时显示证据不足。会话完整性通常未知，要求完整会话会使检查无法判定。", "form-hint"));
	for (const [key, title] of inputs) {
		const required = node("input"); required.type = "checkbox"; required.checked = ((rule.required_inputs as string[] | undefined) ?? ["execution"]).includes(key); wanted.set(key, required);
		const full = node("input"); full.type = "checkbox"; full.checked = ((rule.require_complete as string[] | undefined) ?? []).includes(key); complete.set(key, full);
		const label = node("label", "", "form-check"); label.append(required, document.createTextNode(`需要${title}`));
		const fullLabel = node("label", "", "form-check"); fullLabel.append(full, document.createTextNode("要求完整")); full.setAttribute("aria-label", `要求${title}完整`);
		requirements.append(row(label, fullLabel));
	}
	advance.append(requirements, fold("脚本版本与运行环境")); const detail = advance.lastElementChild!; detail.append(metadata);
	const read = (): Extract<Rule, { kind: "script" }> => ({ ...rule, kind: "script" as const, id: options.getId(), verifierId: selection.value, params: readJson(), required_inputs: [...wanted].filter(([, control]) => control.checked).map(([key]) => key), require_complete: [...complete].filter(([, control]) => control.checked).map(([key]) => key) });
	const configSummary = () => {
		let hasParams = true; try { hasParams = Object.keys(JSON.parse(params.value || "{}")).length > 0; } catch { /* Invalid values must remain visible as configured. */ }
		const selected = [...wanted].filter(([, n]) => n.checked).map(([key]) => key);
		const hasRequirements = selected.length !== 1 || selected[0] !== "execution" || [...complete.values()].some(n => n.checked);
		advanceSummary.textContent = `高级设置${hasParams || hasRequirements ? ` · 已配置${hasParams ? "参数" : ""}${hasParams && hasRequirements ? "、" : ""}${hasRequirements ? "输入要求" : ""}` : ""}`;
	}; advance.addEventListener("input", configSummary); configSummary();
	let trial: ReturnType<typeof verifierTrial> | undefined; let trialDialog: ReturnType<typeof verifierDialog> | undefined;
	const test = action("试验证", () => {
		if (trialDialog) return;
		try { readJson(); } catch (error) { advance.open = true; params.focus(); status.textContent = error instanceof Error ? error.message : String(error); return; }
		const session = trial ??= verifierTrial({ caseId: options.caseId, getRule: read, getScriptLabel: () => options.list().find(v => v.id === current)?.label ?? "原脚本不可用" });
		trialDialog = verifierDialog("用历史结果试验证", session.element, { wide: true, onClose: () => {
			session.suspend(); trialDialog = undefined;
			if (session.isRunning()) status.textContent = "试验证仍在后台运行，点击“试验证”查看。";
			else if (status.textContent?.startsWith("试验证仍在后台")) status.textContent = "";
		} }); session.resume();
	}, true);
	const guide = action("编写指南", () => openVerifierGuide(options.list().find(v => v.id === current)?.runtime !== "python" && !!current));
	const refresh = action("刷新列表", () => { void options.reload(); });
	const update = () => {
		const list = options.list(); const state = options.state();
		selection.replaceChildren(new Option(state === "loading" ? "正在加载脚本…" : "请选择验证脚本", ""));
		for (const v of list) selection.append(new Option(list.filter(other => other.label === v.label).length > 1 ? `${v.label} · ${v.version}` : v.label, v.id));
		if (current && !list.some(v => v.id === current)) selection.append(new Option("原脚本不可用，请重新选择", current)); selection.value = current;
		const selected = list.find(v => v.id === current); const python = selected?.runtime === "python";
		status.textContent = state === "error" ? "脚本列表加载失败，请刷新重试。原选择已保留。" : state === "loading" ? "" : current && !selected ? "所选脚本不可用，请上传或选择其他脚本。" : !list.length ? "还没有脚本，上传一个 .py 文件开始。" : !selected ? "选择已有脚本，或上传自己的 .py 文件。" : "";
		summary.replaceChildren(node("span", selected ? `${python ? "Python" : "JS/TS 或注册程序"} · ${selected.source === "uploaded" ? "用户上传" : "配置注册"}` : "", "form-hint"));
		if (!selected || python) summary.append(runtime);
		metadata.textContent = selected ? `脚本版本 ${selected.version}。${python ? runtime.title || runtime.textContent : "兼容协议，使用已配置的运行时。"}` : runtime.title || runtime.textContent;
		test.disabled = !python || !pythonReady || state !== "ready"; test.title = !selected ? "先选择 Python 脚本" : !python ? "历史试验证仅支持上传的 Python verify(ctx) 脚本" : !pythonReady ? "请先检查 Python 环境，点击刷新列表可重试" : "使用历史执行，不再次调用模型";
		guide.textContent = selected && !python ? "JS/TS 兼容指南" : "编写指南";
		root.dispatchEvent(new Event("change", { bubbles: true }));
	};
	selection.onchange = () => { current = selection.value; update(); }; const unsubscribe = options.subscribe(update); update();
	options.validate(selection, () => { if (options.state() !== "ready") throw new Error("脚本列表尚未就绪，请点击刷新列表。" ); if (!options.list().some(v => v.id === selection.value)) throw new Error("请选择脚本，或点击“上传 .py”。"); });
	const checkRuntime = async () => { try { const response = await fetch("/api/verifiers/runtime-status", { signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(); const value = await response.json(); pythonReady = value.ready === true; runtime.textContent = value.ready ? "Python 环境可用" : value.message ?? "Python 环境不可用"; runtime.classList.toggle("Verifier-warning", !value.ready); runtime.title = value.ready ? `Python ${value.version} · 环境 ${value.environmentId}` : runtime.textContent; } catch { pythonReady = false; runtime.textContent = "环境状态加载失败"; runtime.title = "请刷新列表重试"; } update(); };
	refresh.onclick = () => { void options.reload(); void checkRuntime(); }; void checkRuntime();
	const upload = action("上传 .py", () => {
		const body = node("div", "", "Verifier-upload"); const file = node("input", "", "form-control"); file.type = "file"; file.accept = ".py,.js,.mjs,.ts";
		const name = node("input", "", "form-control"); name.maxLength = 80; name.placeholder = "默认使用文件名";
		const message = node("p", "", "form-hint"); message.setAttribute("role", "status"); let busy = false;
		const submit = action("上传并选中", () => { void (async () => {
			const selected = file.files?.[0]; if (!selected || busy) return; busy = true; submit.disabled = true; file.disabled = true; name.disabled = true; message.textContent = "正在上传…";
			try {
				const content = new TextDecoder("utf-8", { fatal: true }).decode(await selected.arrayBuffer());
				const response = await fetch("/api/verifiers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: selected.name, content, ...(name.value.trim() ? { label: name.value.trim() } : {}) }), signal: AbortSignal.timeout(20000) });
				const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "上传失败");
				await options.reload(); options.uploaded(value); current = value.id; update(); selection.dispatchEvent(new Event("change", { bubbles: true }));
				status.textContent = value.syntaxStatus === "pending" ? "已选中。Python 环境未就绪，配置后才能运行。" : "已选中，保存案例后生效。"; busy = false; modal.close();
			} catch (error) { message.textContent = `上传失败：${error instanceof Error ? error.message : String(error)}。可重试，原选择未改变。`; }
			finally { busy = false; file.disabled = false; name.disabled = false; submit.disabled = !file.files?.length; }
		})(); }, true); submit.disabled = true;
		file.onchange = () => { const selected = file.files?.[0]; const valid = !!selected && /\.(py|js|mjs|ts)$/.test(selected.name) && selected.size > 0 && selected.size <= 1024 * 1024; submit.disabled = !valid; message.textContent = !selected ? "" : valid ? `${selected.name} · ${(selected.size / 1024).toFixed(1)} KiB` : "请选择非空 .py（兼容 .js/.mjs/.ts），最大 1 MiB。"; };
		body.append(options.field("选择脚本文件", file, "UTF-8 编码，单文件最大 1 MiB；也兼容 .js/.mjs/.ts。"), options.field("脚本显示名称（可选）", name), node("p", "脚本会在评测服务器执行，只上传可信代码。Python 可使用标准库和服务端已有依赖，不自动安装；文件副本不是系统沙箱。", "form-hint"), message);
		const modal = verifierDialog("上传验证脚本", body, { footer: row(action("取消", () => modal.close()), submit), canClose: () => !busy });
	});
	const selectField = options.field("验证脚本", selection); const controlRow = row(selection, upload); selectField.querySelector("label")!.after(controlRow);
	root.append(selectField, summary, status, row(test, guide, refresh), advance);
	return { element: root, read, dispose() { unsubscribe(); trialDialog?.close(); trial?.dispose(); } };
}
