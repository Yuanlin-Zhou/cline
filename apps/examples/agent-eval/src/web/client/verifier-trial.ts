import type { VerifierTest } from "../verifier-tests.js";
import type { Rule } from "../../grading/types.js";
import { node, action, row, fold, tabs } from "./verifier-ui.js";

async function request<T>(url: string, body?: unknown): Promise<T> {
	const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
	const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `请求失败(${response.status})`); return data as T;
}
const statuses: Record<string, string> = { pass: "通过", passed: "通过", fail: "失败", failed: "失败", error: "验证错误", insufficient: "证据不足", skipped: "未验证", cancelled: "已取消", interrupted: "已中断", queued: "排队中", running: "执行中" };
export function verifierTrial(options: { caseId?: string; runId?: string; itemId?: string; getRule?: () => Extract<Rule, { kind: "script" }>; getScriptLabel?: () => string }) {
	const root = node("section", "", "VerifierTrial");
	root.append(node("p", "使用历史执行的固定输入，不调用模型，不修改原结论。当前编辑的任务内容不在历史输入内。", "form-hint"), node("p", "关闭面板不会停止任务，可重新打开查看；如需终止，请点击停止试验证。", "form-hint"));
	const history = node("select", "", "form-control"); history.setAttribute("aria-label", "选择历史执行");
	const scripts = node("select", "", "form-control"); scripts.setAttribute("aria-label", "选择试验证Python脚本");
	const params = node("textarea", "", "form-control"); params.value = "{}"; params.rows = 3; params.setAttribute("aria-label", "试验证参数JSON");
	const selectedScript = node("p", "", "form-hint");
	let choices: Array<{ runId: string; itemId: string; label: string }> = []; let testId: string | undefined; let endpoint = ""; let active = false; let disposed = false; let suspended = false; let polling = false; let timer: ReturnType<typeof setTimeout> | undefined;
	let taskTarget = ""; let taskScript = ""; let taskParams: unknown = {}; let hasResult = false; let loadingHistory = false; let loadedScripts = false; let inputGeneration = 0; let inputTarget = "";
	const status = node("p", "", "VerifierTrial-status"); status.setAttribute("role", "status");
	const result = node("section"); result.append(node("p", "选择历史执行，点击“开始试验证”，即可检查脚本并查看逐项结果。", "Verifier-empty"));
	const inputPanel = node("section"); const inputPreview = node("div");
	const logPanel = node("section"); const logActions = row(); const logPreview = node("pre", "试验证后可查看运行日志。", "code Verifier-code"); logPanel.append(logActions, logPreview);
	const logCache = new Map<string, string>(); let logGeneration = 0;
	const resultTarget = node("p", "", "form-hint");
	const panels = tabs([["验证结果", result], ["输入数据", inputPanel], ["运行日志", logPanel]], i => { if (i === 1) void loadInput(); });
	const targetChoice = () => choices[options.itemId ? 0 : Number(history.value)];
	const target = () => { const choice = targetChoice(); if (!choice) throw new Error("请选择已结束的历史执行"); return `/api/runs/${choice.runId}/items/${choice.itemId}`; };
	function currentRule(): Extract<Rule, { kind: "script" }> {
		if (options.getRule) return options.getRule();
		let value: Record<string, unknown>; try { value = JSON.parse(params.value || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); } catch { params.focus(); throw new Error("试验证参数必须是 JSON 对象，例如 {}。"); }
		return { kind: "script", id: "python-test", verifierId: scripts.value, params: value };
	}
	const cancel = action("停止试验证", () => { if (!testId || !active) return; cancel.disabled = true; status.textContent = "正在停止试验证…"; void request(`${endpoint}/verifier-tests/${testId}/cancel`, {}).catch(error => { status.textContent = `停止失败：${String(error)}，可重试。`; cancel.disabled = false; }); }); cancel.classList.add("btn-danger");
	const run = action("开始试验证", () => { void (async () => {
		if (active) return;
		try {
			const rule = currentRule(); if (!rule.verifierId) throw new Error("请选择 Python 脚本");
			endpoint = target(); taskTarget = targetChoice()!.label; taskScript = options.getRule ? options.getScriptLabel?.() ?? "当前规则的脚本与参数" : scripts.selectedOptions[0]?.textContent ?? rule.verifierId;
			taskParams = structuredClone(rule.params ?? {}); active = true; hasResult = false; testId = undefined; updateControls(); logCache.clear(); logGeneration++; logActions.replaceChildren(); logPreview.textContent = "试验证进行中，结束后可查看日志。";
			result.replaceChildren(node("p", "正在准备脚本和验证输入…", "Verifier-empty")); resultTarget.textContent = `${taskTarget} · ${taskScript}`; status.textContent = "正在准备试验证…"; panels.select(0);
			const task = await request<VerifierTest>(`${endpoint}/verifier-tests`, { verifierId: rule.verifierId, params: rule.params, required_inputs: rule.required_inputs, require_complete: rule.require_complete });
			testId = task.id; updateControls(); await poll();
		} catch (error) { active = false; updateControls(); status.textContent = `试验证未启动：${error instanceof Error ? error.message : String(error)}`; result.replaceChildren(node("p", "请按提示修改后重试。", "Verifier-empty")); }
	})(); }, true);
	const refresh = action("刷新历史", () => { void loadHistory(); });
	const refreshScripts = action("刷新脚本", () => { if (!active) void loadScripts(); });
	const preview = action("加载输入", () => { void loadInput(true); });
	inputPanel.append(node("p", "这份 JSON 是历史执行的固定数据。当前脚本参数和临时文件路径会在验证时另行注入。", "form-hint"), row(preview), inputPreview);
	function updateControls() {
		const available = !!targetChoice(); let scriptAvailable = !!scripts.value;
		if (options.getRule) scriptAvailable = true;
		refreshScripts.disabled = active; history.disabled = active || loadingHistory || !available; scripts.disabled = active; params.disabled = active; refresh.disabled = active || loadingHistory;
		run.disabled = active || loadingHistory || !available || !scriptAvailable; run.hidden = active; cancel.hidden = !active; cancel.disabled = !testId || !active;
		preview.disabled = !available || loadingHistory;
	}
	function targetChanged() { inputGeneration++; inputTarget = ""; inputPreview.replaceChildren(); if (!active) { resultTarget.textContent = hasResult ? `上次试验证：${taskTarget} · ${taskScript}。修改选择后需重新试验证。` : ""; status.textContent = ""; } updateControls(); }
	history.onchange = targetChanged; scripts.onchange = targetChanged; params.oninput = targetChanged;
	async function loadHistory() {
		if (loadingHistory) return;
		loadingHistory = true; updateControls(); const previous = targetChoice();
		try {
			if (options.runId && options.itemId) choices = [{ runId: options.runId, itemId: options.itemId, label: "当前历史执行" }];
			else if (options.caseId) {
				const runs = await request<Array<{ id: string; name: string; items: Array<{ id: string; status: string; revision: number; round?: number }> }>>(`/api/cases/${options.caseId}/runs`);
				choices = []; for (const run of runs) for (const item of run.items) if (!["queued", "running"].includes(item.status)) choices.push({ runId: run.id, itemId: item.id, label: `${run.name} · 案例 v${item.revision} · 第 ${item.round ?? 1} 轮 · ${statuses[item.status] ?? item.status}` });
				history.replaceChildren(...choices.map((choice, i) => new Option(choice.label, String(i))));
				const index = choices.findIndex(c => c.runId === previous?.runId && c.itemId === previous?.itemId); history.value = String(Math.max(0, index));
			} else { choices = []; status.textContent = "先保存案例并完成一次评测，再用历史结果试验证。"; return; }
			if (!choices.length) status.textContent = "暂无已结束的历史执行。先在案例列表运行一次已保存的案例，再刷新历史。";
			else if (!hasResult && !active) status.textContent = "";
		} catch (error) { status.textContent = `历史加载失败：${String(error)}，可点击刷新历史重试。`; }
		finally { loadingHistory = false; updateControls(); }
	}
	async function loadScripts() {
		try { const data = await request<{ verifiers: Array<{ id: string; label: string; runtime?: string }> }>("/api/verifiers"); scripts.replaceChildren(new Option("请选择 Python 脚本", "")); for (const v of data.verifiers) if (v.runtime === "python") scripts.append(new Option(v.label, v.id)); loadedScripts = true; updateControls(); }
		catch (error) { status.textContent = `脚本列表加载失败：${String(error)}。请点击刷新脚本。`; }
	}
	async function loadInput(force = false) {
		let url: string; try { url = target(); } catch { inputPreview.replaceChildren(node("p", "请先选择历史执行。", "Verifier-empty")); return; }
		if (!force && inputTarget === url) return; const generation = ++inputGeneration; inputTarget = url;
		inputPreview.replaceChildren(node("p", "正在加载固定输入…", "form-hint")); preview.disabled = true;
		try {
			const value = await request<{ text: string; truncated: boolean; sha256: string }>(`${url}/validation-input`);
			if (generation !== inputGeneration || disposed) return;
			const download = node("a", "下载输入 JSON", "btn btn-sm"); download.href = `${url}/validation-input?download=1`; download.download = "validation-input.json";
			const detail = fold("输入摘要"); detail.append(node("p", value.sha256, "form-hint"));
			inputPreview.replaceChildren(row(download), node("pre", value.text, "code Verifier-code"), detail);
			if (value.truncated) inputPreview.prepend(node("p", "预览已截断，下载 JSON 可查看完整输入。", "Verifier-warning"));
		} catch (error) { if (generation === inputGeneration) { inputTarget = ""; inputPreview.replaceChildren(node("p", `输入加载失败：${String(error)}，请重试。`, "Verifier-warning")); } }
		finally { if (generation === inputGeneration) updateControls(); }
	}
	async function poll() {
		if (!testId || !active || disposed || suspended || !root.isConnected || polling) return;
		polling = true;
		try {
			const task = await request<VerifierTest>(`${endpoint}/verifier-tests/${testId}`); if (disposed) return;
			status.textContent = ["queued", "running"].includes(task.status) ? "试验证进行中…" : task.status === "completed" ? `试验证已结束 · ${statuses[task.result?.status ?? ""] ?? "未知"}` : task.status === "cancelled" ? "试验证已取消" : "试验证错误";
			if (!["queued", "running"].includes(task.status)) {
				active = false; hasResult = true; updateControls(); result.replaceChildren();
				const tone = task.result?.status === "pass" ? "success" : task.result?.status === "fail" || task.status === "error" || task.result?.status === "error" ? "danger" : "attention";
				result.append(node("span", statuses[task.result?.status ?? task.status] ?? "已结束", `Label Label--${tone}`), node("p", task.result?.message ?? task.error ?? "试验证已结束"));
				for (const check of task.result?.checks ?? []) { const detail = fold(`${statuses[check.status]} · ${check.message}`); if (check.expected !== undefined) detail.append(node("strong", "预期"), node("pre", JSON.stringify(check.expected, null, 2), "code")); if (check.actual !== undefined) detail.append(node("strong", "实际"), node("pre", JSON.stringify(check.actual, null, 2), "code")); if (check.files?.length) detail.append(node("p", `相关文件：${check.files.join("、")}`, "form-hint")); result.append(detail); }
				const detail = fold("执行详情"); detail.append(node("p", `${taskTarget} · ${taskScript}`, "form-hint"), node("strong", "本次提交的参数"), node("pre", JSON.stringify(taskParams, null, 2), "code")); if (task.result?.runtime) detail.append(node("p", `Python ${task.result.runtime.version} · 环境 ${task.result.runtime.environmentId} · 输入 ${task.result.contextSha256 ?? "未知"}`, "form-hint")); result.append(detail);
				logActions.replaceChildren(); logCache.clear(); logGeneration++; logPreview.textContent = "点击日志或证据查看详情。";
				for (const ref of task.result?.evidenceRefs ?? []) { const label = task.evidence.refs.find(r => r.id === ref)?.label ?? "验证证据"; const text = label.endsWith("Python验证日志") ? "运行日志" : label.endsWith("Python检查报告") ? "检查报告" : label; const url = `${endpoint}/verifier-tests/${testId}/evidence/${ref}`; logActions.append(action(text, () => { void (async () => { const generation = ++logGeneration; logPreview.textContent = "正在加载…"; try { const value = logCache.get(url) ?? (await request<{ text: string }>(url)).text; logCache.set(url, value); if (generation === logGeneration && !disposed) logPreview.textContent = value; } catch (error) { if (generation === logGeneration) logPreview.textContent = `加载失败：${String(error)}，点击按钮重试。`; } })(); })); }
				if (!task.result?.evidenceRefs?.length) logPreview.textContent = "这次试验证没有运行日志；脚本可能未执行。"; return;
			}
		} catch (error) { if (!disposed) status.textContent = `状态同步失败，正在重试：${String(error)}`; }
		finally { polling = false; }
		if (active && !disposed && !suspended) timer = setTimeout(() => void poll(), 750);
	}
	if (!options.itemId) { const label = node("label", "选择历史执行", "form-label"); history.id = `trial-history-${crypto.randomUUID()}`; label.htmlFor = history.id; root.append(label, row(history, refresh)); }
	if (!options.getRule) { const label = node("label", "Python 脚本", "form-label"); scripts.id = `trial-script-${crypto.randomUUID()}`; label.htmlFor = scripts.id; root.append(label, row(scripts, refreshScripts)); const advanced = fold("脚本参数（可选）"); advanced.append(params, node("p", 'JSON 对象，例如 {"contains":"已完成"}。', "form-hint")); root.append(advanced); } else root.append(selectedScript);
	root.append(row(run, cancel), status, resultTarget, panels.element); updateControls(); void loadHistory(); if (!options.getRule) void loadScripts();
	return { element: root, isRunning: () => active,
		resume() { suspended = false; if (options.getRule) selectedScript.textContent = `验证脚本：${options.getScriptLabel?.() ?? "当前规则的 Python 脚本"}。使用当前填写的参数。`; else if (!loadedScripts) void loadScripts(); if (hasResult) resultTarget.textContent = `上次试验证：${taskTarget} · ${taskScript}。结果对应当时提交的参数，修改后需重新试验证。`; updateControls(); if (active) void poll(); else void loadHistory(); },
		suspend() { suspended = true; clearTimeout(timer); if (active) status.textContent = "试验证仍在后台运行，重新打开可查看结果。"; },
		dispose() { disposed = true; suspended = true; clearTimeout(timer); inputGeneration++; logGeneration++; },
	};
}
