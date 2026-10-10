import type { VerifierTest } from "../verifier-tests.js";
import type { Rule } from "../../grading/types.js";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => { const node = document.createElement(tag); node.textContent = text; node.className = cls; return node; };
async function request<T>(url: string, body?: unknown): Promise<T> {
	const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
	const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `请求失败(${response.status})`); return data as T;
}
export function verifierTrial(options: { caseId?: string; runId?: string; itemId?: string; getRule?: () => Extract<Rule, { kind: "script" }> }) {
	const root = el("section", "", "VerifierTrial Box Box-body mt-3");
	root.append(el("h4", "用历史结果试验证"), el("p", "使用这次历史执行的固定输入，不调用模型、不覆盖原评测结论。新编辑的案例内容不在历史输入内。", "form-hint"));
	const history = el("select", "", "form-control"); history.setAttribute("aria-label", "选择历史执行");
	const scripts = el("select", "", "form-control"); scripts.setAttribute("aria-label", "选择试验证Python脚本");
	const params = el("textarea", "", "form-control"); params.value = "{}"; params.rows = 3; params.setAttribute("aria-label", "试验证参数JSON");
	let choices: Array<{ runId: string; itemId: string }> = []; let testId: string | undefined; let endpoint = ""; let polling = false; let timer: ReturnType<typeof setTimeout> | undefined;
	const status = el("p", "", "form-hint"); status.setAttribute("role", "status"); const result = el("div");
	const button = (text: string, click: () => void) => { const b = el("button", text, "btn btn-sm"); b.type = "button"; b.onclick = click; return b; };
	async function loadHistory() {
		try {
			if (options.runId && options.itemId) choices = [{ runId: options.runId, itemId: options.itemId }];
			else if (options.caseId) {
				const runs = await request<Array<{ id: string; name: string; items: Array<{ id: string; status: string; revision: number; round?: number }> }>>(`/api/cases/${options.caseId}/runs`);
				history.replaceChildren(); choices = [];
				for (const run of runs) for (const item of run.items) if (!["queued", "running"].includes(item.status)) { history.append(new Option(`${run.name} · v${item.revision} · 第${item.round ?? 1}轮 · ${item.status}`, String(choices.length))); choices.push({ runId: run.id, itemId: item.id }); }
			} else { status.textContent = "保存案例后，可以选择历史执行试验证。"; return; }
			if (!choices.length) status.textContent = "还没有已结束的执行，请先进行一次评测。";
		} catch (error) { status.textContent = String(error); }
	}
	async function loadScripts() {
		const data = await request<{ verifiers: Array<{ id: string; label: string; runtime?: string }> }>("/api/verifiers"); scripts.replaceChildren(new Option("请选择Python脚本", ""));
		for (const v of data.verifiers) if (v.runtime === "python") scripts.append(new Option(v.label, v.id));
	}
	const target = () => { const choice = choices[options.itemId ? 0 : Number(history.value)]; if (!choice) throw new Error("请选择已结束的历史执行"); return `/api/runs/${choice.runId}/items/${choice.itemId}`; };
	const cancel = button("停止试验证", () => { if (testId) void request(`${endpoint}/verifier-tests/${testId}/cancel`, {}).catch(error => { status.textContent = String(error); }); }); cancel.disabled = true;
	const run = button("开始试验证", () => { void (async () => {
		try {
			endpoint = target(); const rule: Extract<Rule, { kind: "script" }> = options.getRule?.() ?? { kind: "script", id: "python-test", verifierId: scripts.value, params: JSON.parse(params.value) };
			if (!rule.verifierId) throw new Error("请选择Python脚本");
			run.disabled = true; status.textContent = "正在准备试验证…";
			const task = await request<VerifierTest>(`${endpoint}/verifier-tests`, { verifierId: rule.verifierId, params: rule.params, required_inputs: rule.required_inputs, require_complete: rule.require_complete });
			testId = task.id; cancel.disabled = false; polling = true; await poll();
		} catch (error) { status.textContent = `试验证失败：${error instanceof Error ? error.message : String(error)}`; run.disabled = false; cancel.disabled = true; }
	})(); });
	async function poll() {
		if (!polling || !root.isConnected) { polling = false; return; }
		try {
			const task = await request<VerifierTest>(`${endpoint}/verifier-tests/${testId}`);
			const labels = { queued: "排队中", running: "试验证中", completed: "试验证已结束", error: "试验证错误", cancelled: "试验证已取消" };
			status.textContent = `${labels[task.status]}${task.result ? ` · ${task.result.status} · ${task.result.message}` : task.error ? ` · ${task.error}` : ""}`;
			if (!["queued", "running"].includes(task.status)) {
				polling = false; run.disabled = false; cancel.disabled = true; result.replaceChildren();
				for (const check of task.result?.checks ?? []) result.append(el("p", `${check.id} · ${check.status} · ${check.message}`), el("pre", JSON.stringify({ expected: check.expected, actual: check.actual }, null, 2), "code"));
				if (task.result?.runtime) result.append(el("p", `Python ${task.result.runtime.version} · 环境 ${task.result.runtime.environmentId.slice(0, 12)} · 输入 ${task.result.contextSha256?.slice(0, 12)}`, "muted small"));
				for (const ref of task.result?.evidenceRefs ?? []) result.append(button(task.evidence.refs.find(r => r.id === ref)?.label ?? "查看验证证据", () => { void request<{ text: string }>(`${endpoint}/verifier-tests/${testId}/evidence/${ref}`).then(value => { result.append(el("pre", value.text, "code")); }).catch(error => { status.textContent = String(error); }); }));
				return;
			}
		} catch (error) { status.textContent = `试验证状态同步失败，正在重试：${String(error)}`; }
		timer = setTimeout(() => void poll(), 500);
	}
	const preview = button("查看实际输入", () => { void (async () => { try {
		const url = target(); const value = await request<{ text: string; truncated: boolean; sha256: string }>(`${url}/validation-input`);
		result.replaceChildren(el("p", `输入摘要 ${value.sha256}${value.truncated ? "（预览截断，下载可查看完整输入）" : ""}`, "muted small"), el("pre", value.text, "code"));
		const download = el("a", "下载输入JSON", "btn btn-sm"); download.href = `${url}/validation-input?download=1`; download.download = "validation-input.json"; result.append(download);
	} catch (error) { status.textContent = String(error); } })(); });
	if (!options.itemId) root.append(history, button("刷新历史执行", () => void loadHistory()));
	if (!options.getRule) { root.append(scripts, params); void loadScripts().catch(error => { status.textContent = String(error); }); }
	root.append(preview, run, cancel, status, result); void loadHistory();
	return { element: root, dispose() { polling = false; clearTimeout(timer); } };
}
