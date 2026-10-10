import { verifierTrial } from "./verifier-trial.js";
import { tagEditor } from "./tag-editor.js";
import { conversationView, executionStatus, showSyncStatus, syncStatus } from "./observability.js";
import type { TransferPreview } from "../transfer.js";
import { headerEditor, readHeaderEditor } from "./header-editor.js";
import type {
	EvalAssertions,
	EvalCase,
	EvalCaseResult,
	EvalDefaults,
	EvalMessage,
	ToolMode,
} from "../../types.js";
import { caseExample, replayConfig, IMPORT_FIELDS, REPLAY_MODES, type ReplayMode } from "../../replay.js";
import type { RepeatReport } from "../repeat-report.js";
import { gradingEditor, gradingPanel, gradingMetrics } from "./grading.js";
import { gradingSummary } from "../../grading/summary.js";
import type {
	ItemStatus,
	Module,
	Run,
	RunItem,
	SavedCase,
	Summary,
} from "../types.js";

/* ----------------------------- Types ----------------------------- */

type LatestResult = {
	sessionId?: string;
	status: ItemStatus;
	runId: string;
	revision: number;
	modelId: string;
	durationMs?: number;
	endedAt?: string;
};

type StateResponse = {
	modules: Module[];
	cases: SavedCase[];
	settings: EvalDefaults;
	runs: Array<Run & { summary: Summary }>;
	latest: Record<string, LatestResult>;
};

type RunDetailResponse = Run & { items: RunItem[]; summary: Summary; repeatReport: RepeatReport };

type CaseRunItem = {
	sessionId?: string;
	round?: number;
	id: string;
	status: ItemStatus;
	revision: number;
	modelId: string;
	durationMs?: number;
	endedAt?: string;
};

type Route =
	| { page: "cases"; moduleId?: string }
	| { page: "import" }
	| { page: "case"; id: string }
	| { page: "case-new"; moduleId?: string }
	| { page: "run-new" }
	| { page: "runs" }
	| { page: "run"; id: string }
	| { page: "settings" };

/* ----------------------------- DOM helpers ----------------------------- */

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

function h(tag: string, attrs?: Attrs | null, ...children: Array<Node | string | number | false | null | undefined>): HTMLElement {
	const el = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === null || value === undefined || value === false) continue;
			if (key === "class") el.className = String(value);
			else if (key === "html") el.innerHTML = String(value);
			else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
			else el.setAttribute(key, String(value));
		}
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		el.append(typeof child === "number" ? String(child) : child);
	}
	return el;
}

const esc = (value: unknown): string =>
	String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

function val(id: string): string {
	return (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
}

function input(id: string, value: string | number | undefined, type = "text"): HTMLElement {
	return h("input", { class: "form-control", id, type, value: value === undefined || value === null ? "" : String(value) });
}

function textarea(id: string, value: string | undefined, mono = true): HTMLElement {
	return h("textarea", { class: mono ? "form-control" : "form-control normal", id, rows: 4 }, value ?? "");
}

function select(id: string, options: Array<[string, string]>, value: string): HTMLElement {
	const sel = h("select", { class: "form-control", id });
	for (const [optionValue, label] of options) {
		sel.append(h("option", { value: optionValue, selected: optionValue === value ? true : null }, label));
	}
	return sel;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
	const group = h("div", { class: "form-group" });
	group.append(h("label", { class: "form-label", for: control.id || undefined }, label), control);
	if (hint) group.append(h("div", { class: "form-hint" }, hint));
	return group;
}

// Panels stay mounted so switching views preserves drafts and control state.
function panelTabs(id: string, entries: Array<[string, HTMLElement]>): HTMLElement {
	const bar = h("div", { class: "tab-bar", role: "tablist", "aria-label": "切换视图" });
	const tabs: HTMLElement[] = [];
	const activate = (index: number) => entries.forEach(([, panel], i) => {
		panel.hidden = i !== index;
		tabs[i].classList.toggle("active", i === index);
		tabs[i].setAttribute("aria-selected", String(i === index));
		tabs[i].tabIndex = i === index ? 0 : -1;
	});
	entries.forEach(([label, panel], i) => {
		panel.id = `${id}-panel-${i}`;
		panel.setAttribute("role", "tabpanel");
		panel.setAttribute("aria-labelledby", `${id}-tab-${i}`);
		const button = h("button", { type: "button", role: "tab", id: `${id}-tab-${i}`, "aria-controls": panel.id, onclick: () => activate(i), onkeydown: (event: Event) => {
			const key = (event as KeyboardEvent).key;
			const next = key === "ArrowRight" ? (i + 1) % entries.length : key === "ArrowLeft" ? (i + entries.length - 1) % entries.length : key === "Home" ? 0 : key === "End" ? entries.length - 1 : -1;
			if (next < 0) return;
			event.preventDefault(); activate(next); tabs[next].focus();
		} }, label);
		tabs.push(button); bar.append(button);
	});
	activate(0);
	return h("div", { class: "PanelTabs" }, bar, ...entries.map(([, panel]) => panel));
}

/* ----------------------------- Formatting ----------------------------- */

const TOOL_OPTIONS: Array<[ToolMode, string]> = [
	["read-only", "read-only（只读）"],
	["full", "full（可写，需隔离工作区）"],
	["none", "none（无工具）"],
];

const FINISH_OPTIONS: Array<[string, string]> = [
	["completed", "正常完成"],
	["max_iterations", "达到最大迭代次数"],
	["aborted", "已取消"],
	["mistake_limit", "达到错误次数上限"],
	["error", "执行出错"],
];

const STATUS_META: Record<ItemStatus, { label: string; cls: string }> = {
	inconclusive: { label: "无法判定", cls: "Label--attention" },
	queued: { label: "排队中", cls: "Label--neutral" },
	running: { label: "运行中", cls: "Label--accent" },
	passed: { label: "通过", cls: "Label--success" },
	failed: { label: "断言失败", cls: "Label--danger" },
	error: { label: "执行错误", cls: "Label--attention" },
	cancelled: { label: "已取消", cls: "Label--done" },
};

const RUN_STATUS_META: Record<Run["status"], { label: string; cls: string }> = {
	queued: { label: "排队中", cls: "Label--neutral" },
	running: { label: "运行中", cls: "Label--accent" },
	completed: { label: "已完成", cls: "Label--neutral" },
	cancelled: { label: "已取消", cls: "Label--done" },
	interrupted: { label: "已中断", cls: "Label--attention" },
};

const replayLabel = (mode?: string): string => REPLAY_MODES.find((item) => item.value === mode)?.label ?? REPLAY_MODES[0]!.label;

function fmtDuration(ms?: number): string {
	if (ms === undefined || ms === null) return "—";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n?: number): string {
	return n === undefined || n === null ? "—" : n.toLocaleString();
}

function fmtCost(c?: number | null): string {
	return c === undefined || c === null ? "未提供" : `$${c.toFixed(4)}`;
}

function fmtTime(iso?: string): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString("zh-CN", { hour12: false });
}

function relTime(iso?: string): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const diff = Date.now() - d.getTime();
	const s = Math.floor(diff / 1000);
	if (s < 60) return "刚刚";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} 分钟前`;
	const hh = Math.floor(m / 60);
	if (hh < 24) return `${hh} 小时前`;
	const dd = Math.floor(hh / 24);
	if (dd < 30) return `${dd} 天前`;
	return d.toLocaleDateString("zh-CN");
}

const badge = (label: string, cls: string): HTMLElement => h("span", { class: `Label ${cls}` }, label);
const statusBadge = (status: ItemStatus): HTMLElement => badge(STATUS_META[status].label, STATUS_META[status].cls);
const runStatusBadge = (status: Run["status"]): HTMLElement => badge(RUN_STATUS_META[status].label, RUN_STATUS_META[status].cls);

function tagPills(tags?: string[]): HTMLElement[] {
	return (tags ?? []).filter(Boolean).map((tag) => badge(tag, "Label--tag"));
}

/* ----------------------------- API ----------------------------- */

const JSON_HEADERS = { "Content-Type": "application/json" };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, { ...init, signal: init?.signal ?? (!init?.method || init.method === "GET" ? AbortSignal.timeout(10000) : undefined) });
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = null;
	}
	if (!res.ok) {
		const message = data && typeof data === "object" && "error" in (data as Record<string, unknown>) ? String((data as { error: unknown }).error) : `请求失败 (${res.status})`;
		throw Object.assign(new Error(message), { status: res.status });
	}
	return data as T;
}

const getState = () => api<StateResponse>("/api/state");

/* ----------------------------- Toast / modal ----------------------------- */

function toast(message: string, kind: "success" | "error" = "success"): void {
	const root = document.getElementById("toast-root")!;
	const el = h("div", { class: `toast ${kind}` }, message);
	root.append(el);
	setTimeout(() => el.remove(), 4000);
}

function openModal(options: { title: string; body: HTMLElement; wide?: boolean; actions: (close: () => void) => HTMLElement[] }): () => void {
	const overlay = h("dialog", { class: "Modal-overlay", "aria-label": options.title }) as HTMLDialogElement;
	const modal = h("div", { class: options.wide ? "Modal Modal--wide" : "Modal" });
	function close() {
		overlay.close();
		overlay.remove();
	}
	modal.append(h("div", { class: "Modal-header" }, options.title), h("div", { class: "Modal-body" }, options.body), h("div", { class: "Modal-footer" }, ...options.actions(close)));
	overlay.append(modal);
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) close();
	});
	document.body.append(overlay);
	 overlay.addEventListener("close", () => overlay.remove());
	overlay.showModal();
	return close;
}

function openCaseTransfer(operation: "copy" | "move", sources: SavedCase[], state: StateResponse, onSuccess: (cases: SavedCase[]) => void = () => render(), hiddenCount = 0): void {
	const label = operation === "copy" ? "复制" : "移动";
	const modules = state.modules.filter(m => operation === "copy" || sources.some(c => c.moduleId !== m.id));
	if (!modules.length) { toast("请先创建其他模块作为移动目标", "error"); return; }
	const target = select("transfer-target", (operation === "move" ? [["", "请选择目标模块"] as [string, string], ...modules.map(m => [m.id, `${m.name}（${state.cases.filter(c => c.moduleId === m.id).length} 个案例）`] as [string, string])] : modules.map(m => [m.id, `${m.name}（${state.cases.filter(c => c.moduleId === m.id).length} 个案例）`] as [string, string])), operation === "move" ? "" : modules.find(m => m.id === sources[0].moduleId)?.id ?? modules[0].id) as HTMLSelectElement;
	const policy = select("transfer-policy", [["rename", "自动重命名"], ["abort", "遇到同名案例时中止"]], operation === "copy" ? "rename" : "abort") as HTMLSelectElement;
	const previewArea = h("div", { class: "TransferPreview" });
	const errorBox = h("div", { role: "alert" });
	const submit = h("button", { class: "btn btn-primary", disabled: true }, `确认${label}`) as HTMLButtonElement;
	let selected = sources;
	let preview: TransferPreview | undefined;
	let generation = 0;
	let submitting = false;
	let closed = false;
	let uncertain = false;
	const request = () => ({ operation, targetModuleId: target.value, conflictPolicy: policy.value, items: selected.map(c => ({ id: c.id, revision: c.revision })) });
	async function refreshPreview(refreshSources = false) {
		const current = ++generation;
		preview = undefined; submit.disabled = true;
		if (!target.value) { previewArea.textContent = "请选择目标模块以查看预览。"; errorBox.replaceChildren(); return; }
		previewArea.textContent = "正在预览…";
		errorBox.replaceChildren();
		try {
			if (refreshSources) {
				const latest = await api<StateResponse>("/api/state");
				if (current !== generation || closed) return;
				selected = selected.map(c => latest.cases.find(item => item.id === c.id) ?? c);
			}
			const next = await api<TransferPreview>("/api/cases/transfer/preview", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(request()) });
			if (current !== generation || closed) return;
			preview = next;
			submit.textContent = `确认${label} ${next.items.length} 个案例`;
			previewArea.replaceChildren(h("p", { class: "muted small" }, `${next.items.length} 个案例 → ${next.items[0].targetModuleName}。历史执行记录和快照保持不变。`),
				h("div", { class: "TableWrap" }, h("table", { class: "Table" },
					h("thead", {}, h("tr", {}, ...["来源模块", "原案例 ID", "目标案例 ID", "处理结果"].map(t => h("th", {}, t)))),
					h("tbody", {}, ...next.items.map(item => h("tr", {}, h("td", {}, item.sourceModuleName), h("td", {}, item.originalDefinitionId), h("td", {}, item.proposedDefinitionId), h("td", {}, item.result === "unchanged" ? "保持原样" : item.conflict && !next.canApply ? "同名冲突" : item.originalDefinitionId !== item.proposedDefinitionId ? "重命名后" + label : label)))))));
			if (!next.canApply) errorBox.append(flash("目标模块存在同名案例，请选择自动重命名或其他模块。", "warning"));
			submit.disabled = !next.canApply || submitting || uncertain;
		} catch (error) {
			if (current !== generation || closed) return;
			previewArea.replaceChildren(); errorBox.replaceChildren(flash(error instanceof Error ? error.message : String(error)));
		}
	}
	const body = h("div", { class: "CaseTransfer" }, h("p", {}, `将${label} ${sources.length} 个已保存案例。${hiddenCount ? `其中 ${hiddenCount} 个已选案例被当前筛选隐藏，仍会一并处理。` : ""}`),
		field("目标模块", target), field("同名处理", policy), previewArea, errorBox);
	const closeModal = openModal({ title: `${label}案例到模块`, body, wide: true, actions: close => [
		h("button", { class: "btn", onclick: () => { if (!submitting) { closed = true; generation++; close(); } } }, "取消"),
		h("button", { class: "btn", onclick: () => { if (!submitting && !uncertain) void refreshPreview(true); } }, "刷新预览"), submit,
	] });
	const dialog = body.closest("dialog")!;
	dialog.addEventListener("cancel", e => { if (submitting) e.preventDefault(); });
	dialog.addEventListener("close", () => { closed = true; generation++; });
	dialog.addEventListener("click", e => { if (submitting && e.target === dialog) e.stopImmediatePropagation(); }, true);
	target.onchange = policy.onchange = () => { if (!submitting && !uncertain) void refreshPreview(); };
	submit.onclick = async () => {
		if (!preview?.canApply || submitting || uncertain) return;
		submitting = true; submit.disabled = true; target.disabled = policy.disabled = true;
		try {
			const result = await api<{ cases: SavedCase[]; copied: number; moved: number; unchanged: number }>("/api/cases/transfer", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...request(), items: preview.items.map(item => ({ id: item.id, revision: item.revision, expectedDefinitionId: item.proposedDefinitionId })) }) });
			closed = true; closeModal();
			toast(`已复制 ${result.copied} 个，移动 ${result.moved} 个，保持原样 ${result.unchanged} 个`);
			onSuccess(result.cases);
			const link = h("a", { class: "toast", href: `#/cases/${target.value}` }, "查看目标模块");
			document.getElementById("toast-root")!.append(link); setTimeout(() => link.remove(), 8000);
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status === 409) { submitting = false; await refreshPreview(); errorBox.append(flash("提交前数据已变化。请刷新预览，检查最新结果后再次确认。", "warning")); }
			else {
				uncertain = !status || status === 503;
				errorBox.replaceChildren(flash(uncertain ? "网络中断，无法确认提交结果。请关闭弹窗并刷新目标模块核对，避免重复复制。" : String(error)));
				submit.disabled = true;
			}
		} finally { submitting = false; target.disabled = policy.disabled = uncertain; }
	};
	void refreshPreview();
}

function confirmModal(title: string, message: string, confirmLabel: string, onConfirm: () => void | Promise<void>): void {
	openModal({
		title,
		body: h("div", {}, message),
		actions: (close) => [
			h("button", { class: "btn", onclick: close }, "取消"),
			h("button", { class: "btn btn-danger", onclick: async () => { close(); await onConfirm(); } }, confirmLabel),
		],
	});
}

/* ----------------------------- Router ----------------------------- */

let state: StateResponse | null = null;
let activePoll: (() => void) | undefined;
let runScope: { moduleIds: string[]; caseIds: string[]; returnTo: string } | undefined;
const caseListState = new Map<string, { search: string; replay: string; result: string; selection: Set<string> }>();

function openNewRun(caseIds: string[], moduleIds: string[]): void {
	runScope = { caseIds, moduleIds, returnTo: location.hash };
	navigate("#/run/new");
}

function parseRoute(): Route {
	const raw = location.hash.replace(/^#/, "") || "/cases";
	const [pathPart, queryPart] = raw.split("?");
	const seg = pathPart.split("/").filter(Boolean);
	const query = new URLSearchParams(queryPart ?? "");
	if (seg[0] === "cases") return { page: "cases", moduleId: seg[1] };
	if (seg[0] === "case") {
		if (seg[1] === "new") return { page: "case-new", moduleId: query.get("module") ?? undefined };
		if (seg[1]) return { page: "case", id: seg[1] };
	}
	if (seg[0] === "import") return { page: "import" };
	if (seg[0] === "run") {
		if (seg[1] === "new") return { page: "run-new" };
		if (seg[1]) return { page: "run", id: seg[1] };
	}
	if (seg[0] === "runs") return { page: "runs" };
	if (seg[0] === "settings") return { page: "settings" };
	return { page: "cases" };
}

const NAV_OF_PAGE: Record<Route["page"], string> = {
	cases: "cases",
	import: "cases",
	case: "cases",
	"case-new": "cases",
	"run-new": "runs",
	runs: "runs",
	run: "runs",
	settings: "settings",
};

function highlightNav(route: Route): void {
	const key = NAV_OF_PAGE[route.page];
	for (const link of document.querySelectorAll<HTMLAnchorElement>("#top-nav a")) {
		link.classList.toggle("active", link.dataset.nav === key);
		if (link.dataset.nav === key) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
}

function navigate(hash: string): void {
	location.hash = hash;
}

function stopPolling(): void {
	activePoll?.();
	activePoll = undefined;
}

function loading(text = "加载中…"): HTMLElement {
	return h("div", { class: "empty" }, h("div", { class: "empty-title" }, text));
}

function flash(text: string, kind: "error" | "warning" | "success" | "info" = "error"): HTMLElement {
	return h("div", { class: `flash flash-${kind}` }, text);
}

let renderEpoch = 0;
function render(): void {
	renderEpoch++;
	stopPolling();
	const route = parseRoute();
	const app = document.getElementById("app")!;
	app.replaceChildren();
	highlightNav(route);
	switch (route.page) {
		case "cases": void renderCases(app, route.moduleId); break;
		case "import": void renderImport(app); break;
		case "case": void renderCaseDetail(app, route.id); break;
		case "case-new": void renderCaseDetail(app, undefined, route.moduleId); break;
		case "run-new": void renderNewRun(app); break;
		case "runs": void renderRuns(app); break;
		case "run": void renderRunDetail(app, route.id); break;
		case "settings": void renderSettings(app); break;
	}
}

/* ----------------------------- Shared: config fields ----------------------------- */

function appendConfigFields(parent: HTMLElement, prefix: string, initial: EvalDefaults, withCwd: boolean, modelOnly = false): void {
	const grid = h("div", { class: modelOnly ? "" : "ConfigGrid" });
	let section = modelOnly ? grid : h("section", { class: "ConfigSection" }, h("div", { class: "section-title" }, "模型与连接"));
	if (!modelOnly) grid.append(section);
	parent.append(grid);
	const fg = (label: string, control: HTMLElement, hint?: string) => section.append(field(label, control, hint));
	const connection = h("section", { class: "ModelConnection" });
	if (modelOnly) connection.append(h("h3", { class: "ConfigGroup-title" }, "模型连接"));
	const modelFields = h("div", { class: "ModelFields" },
		field("Provider", input(`${prefix}-provider`, initial.providerId), "如 cline、openai-compatible、anthropic"),
		field("模型 Model", input(`${prefix}-model`, initial.modelId)),
	);
	connection.append(modelFields,
		field("密钥环境变量", input(`${prefix}-keyenv`, initial.apiKeyEnv), "从服务端环境变量读取 API Key，例如 DEEPSEEK_API_KEY"),
		field("Base URL", input(`${prefix}-baseurl`, initial.baseUrl), "自定义 OpenAI 兼容端点时填写"),
	);
	section.append(connection, headerEditor(`${prefix}-headers`, initial, modelOnly ? "默认模型请求头" : "自定义模型请求头"));
	if (modelOnly) return;
	section = h("section", { class: "ConfigSection" }, h("div", { class: "section-title" }, "执行参数"));
	grid.append(section);
	fg("工具范围", select(`${prefix}-tools`, TOOL_OPTIONS, initial.tools ?? "read-only"), "full 模式可执行命令、修改文件，务必使用隔离工作区");
	fg("最大迭代次数", input(`${prefix}-maxiter`, initial.maxIterations ?? 10, "number"));
	fg("超时（毫秒）", input(`${prefix}-timeout`, initial.timeoutMs ?? 300000, "number"));
	fg("系统提示词", textarea(`${prefix}-sysprompt`, initial.systemPrompt, false), "留空使用默认提示词");
	if (withCwd) fg("Fixture 目录", input(`${prefix}-cwd`, initial.cwd), "初始工作区目录（须为绝对路径）；留空表示使用空工作区");
}

function readConfig(prefix: string, withCwd: boolean): EvalDefaults {
	const optional = (id: string): string | undefined => {
		const v = val(id).trim();
		return v || undefined;
	};
	const defaults: EvalDefaults = {
		...readHeaderEditor(`${prefix}-headers`),
		providerId: optional(`${prefix}-provider`) ?? "cline",
		modelId: optional(`${prefix}-model`) ?? "anthropic/claude-sonnet-4.6",
		tools: (val(`${prefix}-tools`) || "read-only") as ToolMode,
		maxIterations: Math.max(1, Number(val(`${prefix}-maxiter`)) || 10),
		timeoutMs: Math.max(1000, Number(val(`${prefix}-timeout`)) || 300000),
	};
	const apiKeyEnv = optional(`${prefix}-keyenv`);
	if (apiKeyEnv) defaults.apiKeyEnv = apiKeyEnv;
	const baseUrl = optional(`${prefix}-baseurl`);
	if (baseUrl) defaults.baseUrl = baseUrl;
	const systemPrompt = optional(`${prefix}-sysprompt`);
	if (systemPrompt) defaults.systemPrompt = systemPrompt;
	if (withCwd) {
		const cwd = optional(`${prefix}-cwd`);
		if (cwd) defaults.cwd = cwd;
	}
	return defaults;
}

const splitLines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/* ----------------------------- View: cases (modules + list) ----------------------------- */

async function renderCases(app: HTMLElement, moduleId?: string): Promise<void> {
	const epoch = renderEpoch;
	app.append(loading());
	let s: StateResponse;
	try {
		s = await getState();
	} catch (error) {
		if (epoch !== renderEpoch) return;
		app.replaceChildren(h("div", {}, flash(error instanceof Error ? error.message : String(error)), h("button", { class: "btn mt-3", onclick: render }, "重试加载")));
		return;
	}
	if (epoch !== renderEpoch) return;
	state = s;
	const selected = moduleId ? s.modules.find((m) => m.id === moduleId) : undefined;
	const cases = selected ? s.cases.filter((c) => c.moduleId === selected.id) : s.cases;
	const moduleCounts = new Map<string, number>();
	for (const c of s.cases) moduleCounts.set(c.moduleId, (moduleCounts.get(c.moduleId) ?? 0) + 1);

	app.replaceChildren();
	app.append(h("div", { class: "page-head flex-between" },
		h("div", {},
			h("h1", { class: "page-title" }, selected ? selected.name : "全部案例"),
			h("p", { class: "page-desc" }, selected?.description || "跨模块查看、调试与批量评测案例"),
		),
		h("div", { class: "page-actions" },
			h("button", { class: "btn", onclick: () => navigate("#/import" + (selected ? `?module=${selected.id}` : "")) }, "导入案例"),
			h("button", { class: "btn", onclick: () => navigate("#/case/new" + (selected ? `?module=${selected.id}` : "")) }, "新建案例"),
			h("button", {
				class: "btn btn-primary",
				onclick: () => selected ? openNewRun([], [selected.id]) : navigate("#/run/new"),
			}, selected ? "评测当前模块" : "新建评测"),
		),
	));

	const layout = h("div", { class: "Layout" });
	const sidebar = h("aside", { class: "Layout-sidebar" });
	sidebar.append(h("div", { class: "module-toolbar flex-between" }, h("span", { class: "section-title" }, "模块"), h("button", { class: "btn btn-sm", onclick: () => openModuleModal() }, "＋ 新建模块")));
	const main = h("section", { class: "Layout-main" });

	const moduleList = h("div", { class: "module-list" });
	const allItem = moduleItem({ id: "", name: "全部案例", description: "跨模块搜索与筛选" }, !selected, () => navigate("#/cases"), s.cases.length);
	moduleList.append(allItem);
	for (const module of s.modules) {
		moduleList.append(moduleItem(module, selected?.id === module.id, () => navigate(`#/cases/${module.id}`), moduleCounts.get(module.id) ?? 0, {
			onEdit: () => openModuleModal(module),
			onArchive: () => confirmModal("归档模块", `确定归档模块「${module.name}」吗？其中的案例也会被归档。`, "归档", async () => {
				try {
					await api(`/api/modules/${module.id}/archive`, { method: "POST", headers: JSON_HEADERS });
					toast("模块已归档");
					navigate("#/cases");
				} catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
			}),
		}));
	}
	sidebar.append(moduleList);
	layout.append(sidebar);

	// Search box + table
	const savedList = caseListState.get(moduleId ?? "");
	const searchBox = input("case-search", savedList?.search ?? "", "text");
	searchBox.setAttribute("placeholder", "按名称、ID 或标签筛选…");
	const replayFilter = select("case-replay", [["", "全部回放方式"], ["single-turn", "单轮回放"], ["full-task", "多轮回放（完整任务）"]], "");
	const resultFilter = select("case-result", [["", "全部结果"], ["passed", "通过"], ["failed", "失败"], ["error", "执行错误"], ["inconclusive", "无法判定"], ["none", "未运行"]], "");
	(replayFilter as HTMLSelectElement).value = savedList?.replay ?? "";
	(resultFilter as HTMLSelectElement).value = savedList?.result ?? "";
	const selection = new Set([...(savedList?.selection ?? [])].filter((id) => cases.some((c) => c.id === id)));
	let visible = cases;

	const renderTable = (): void => {
		const query = val("case-search").toLowerCase();
		const replay = val("case-replay");
		const result = val("case-result");
		caseListState.set(moduleId ?? "", { search: val("case-search"), replay, result, selection });
		visible = cases.filter((c) => {
			const latest = s.latest[c.id];
			if (replay && (c.definition.replayMode ?? "single-turn") !== replay) return false;
			if (result && (result === "none" ? latest !== undefined : latest?.status !== result)) return false;
			if (!query) return true;
			const hay = [c.definition.id, c.definition.description ?? "", latest?.sessionId ?? "", ...(c.definition.tags ?? [])].join(" ").toLowerCase();
			return hay.includes(query);
		});
		tableBody.replaceChildren(...visible.map((c) => caseRow(c, selection, renderTable, s)));
		if (!visible.length) tableBody.append(h("tr", {}, h("td", { colspan: 7, class: "empty" }, "没有匹配的案例，试试调整筛选条件或导入案例。")));
		selectionInfo.textContent = selection.size ? `已选 ${selection.size} 个案例` : `${visible.length} 个案例`;
		runSelectedBtn.disabled = selection.size === 0;
		batchBar.hidden = selection.size === 0;
		batchCount.textContent = `已选 ${selection.size} 个案例`;
		selectAll.checked = visible.length > 0 && visible.every(c => selection.has(c.id));
		selectAll.indeterminate = visible.some(c => selection.has(c.id)) && !selectAll.checked;
	};

	const tableWrap = h("div", { class: "TableWrap" });
	const table = h("table", { class: "Table CaseTable" });
	const selectAll = h("input", { type: "checkbox", "aria-label": "选择当前筛选结果", onchange: (e: Event) => {
		const checked = (e.target as HTMLInputElement).checked;
		for (const c of visible) { if (checked) selection.add(c.id); else selection.delete(c.id); }
		renderTable();
	} }) as HTMLInputElement;
	table.append(h("thead", {},
		h("tr", {},
			h("th", {}, selectAll),
			h("th", {}, "案例"),
			h("th", {}, "回放方式"),
			h("th", {}, "标签"),
			h("th", { class: "num" }, "版本"),
			h("th", {}, "最近结果"),
			h("th", { class: "CaseTable-actionsCell" }, "操作"),
		),
	));
	const tableBody = h("tbody");
	table.append(tableBody);
	tableWrap.append(table);

	const selectionInfo = h("span", { class: "muted small" });
	const runSelectedBtn = h("button", { class: "btn btn-primary", onclick: () => openNewRun([...selection], []) }, "评测所选案例") as HTMLButtonElement;
	const batchCount = h("span", {});
	const transferSelected = (operation: "copy" | "move") => openCaseTransfer(operation, s.cases.filter(c => selection.has(c.id)), s, () => { selection.clear(); render(); }, [...selection].filter(id => !visible.some(c => c.id === id)).length);
	const batchBar = h("div", { class: "BatchBar", hidden: true }, batchCount, h("div", { class: "flex-center gap-2 wrap" }, h("button", { class: "btn", onclick: () => transferSelected("copy") }, "复制所选"), h("button", { class: "btn", onclick: () => transferSelected("move") }, "移动所选"), h("button", { class: "btn btn-outline", onclick: () => { selection.clear(); renderTable(); } }, "取消选择"), runSelectedBtn));

	const toolbar = h("div", { class: "flex-between mt-3 mb-2 gap-2 wrap" },
		h("div", { class: "case-filters flex-center gap-2 grow wrap" }, searchBox, replayFilter, resultFilter, selectionInfo),
	);
	searchBox.setAttribute("aria-label", "搜索案例");
	replayFilter.setAttribute("aria-label", "按回放方式筛选");
	resultFilter.setAttribute("aria-label", "按最近结果筛选");
	searchBox.addEventListener("input", renderTable);
	replayFilter.addEventListener("change", renderTable);
	resultFilter.addEventListener("change", renderTable);

	main.append(toolbar, batchBar, tableWrap);
	layout.append(main);
	app.append(layout);
	renderTable();
}

function moduleItem(module: Pick<Module, "id" | "name" | "description">, active: boolean, onClick: () => void, count?: number, actions?: { onEdit: () => void; onArchive: () => void }): HTMLElement {
	const link = h("a", {
		class: `module-item${active ? " active" : ""}`,
		href: "#",
		onclick: (e: Event) => { e.preventDefault(); onClick(); },
	},
		h("div", { class: "module-item-name" },
			h("span", {}, module.name),
			count !== undefined ? h("span", { class: "module-item-count" }, String(count)) : h("span", {}),
		),
		module.description ? h("div", { class: "module-item-desc" }, module.description) : h("span", {}),
	);
	if (!actions) return link;
	const wrapper = h("div", { class: "module-entry" });
	const actionBar = h("div", { class: "module-actions" });
	actionBar.append(
		h("button", { class: "btn btn-sm btn-icon", title: "编辑模块", onclick: (e: Event) => { e.stopPropagation(); actions.onEdit(); } }, "编辑"),
		h("button", { class: "btn btn-sm btn-icon", title: "归档模块", onclick: (e: Event) => { e.stopPropagation(); actions.onArchive(); } }, "归档"),
	);
	wrapper.append(link, actionBar);
	return wrapper;
}

function caseRow(c: SavedCase, selection: Set<string>, rerender: () => void, s: StateResponse): HTMLElement {
	const latest = s.latest[c.id];
	const tr = h("tr", { class: "clickable", onclick: () => navigate(`#/case/${c.id}`) });
	tr.append(
		h("td", {}, h("input", {
			type: "checkbox",
			checked: selection.has(c.id),
			"aria-label": `选择案例 ${c.definition.id}`,
			onclick: (e: Event) => e.stopPropagation(),
			onchange: (e: Event) => {
				const checked = (e.target as HTMLInputElement).checked;
				if (checked) selection.add(c.id);
				else selection.delete(c.id);
				rerender();
			},
		})),
		h("td", { class: "CaseTable-content" },
			h("a", { class: "case-name CaseTable-link", href: `#/case/${c.id}`, onclick: (event: Event) => event.stopPropagation() }, c.definition.id),
			c.definition.description ? h("div", { class: "muted small" }, c.definition.description) : h("span", {}),
		),
		h("td", {}, badge(replayLabel(c.definition.replayMode), c.definition.replayMode === "full-task" ? "Label--done" : "Label--accent")),
		h("td", {}, ...tagPills(c.definition.tags)),
		h("td", { class: "num" }, `v${c.revision}`),
		h("td", {},
			latest
				? h("div", { class: "flex-center gap-2 wrap" },
					statusBadge(latest.status),
					h("span", { class: "muted small mono nowrap" }, latest.modelId),
					h("span", { class: "muted small nowrap" }, relTime(latest.endedAt)),
				)
				: h("span", { class: "muted" }, "未运行"),
		),
	);
	const actions = h("td", { class: "CaseTable-actionsCell", onclick: (e: Event) => e.stopPropagation() },
		h("div", { class: "CaseTable-actions" },
			h("button", { class: "btn btn-sm", onclick: () => runCases([c.id], [], `调试 · ${c.definition.id}`) }, "运行"),
			h("button", { class: "btn btn-sm btn-danger", onclick: () => deleteCase(c, () => render()) }, "删除"),
		),
	);
	tr.append(actions);
	return tr;
}

function sessionIdLabel(sessionId?: string): HTMLElement {
	return h("div", { class: "muted small mono", style: "overflow-wrap:anywhere", title: sessionId ?? "尚无会话 ID" }, `session_id: ${sessionId || "—"}`);
}

function deleteCase(c: SavedCase, onDeleted: () => void): void {
	confirmModal("删除案例", `确定永久删除案例「${c.definition.id}」吗？删除后无法恢复；历史评测记录和已提交的执行不受影响。`, "删除", async () => {
		try {
			await api(`/api/cases/${c.id}`, { method: "DELETE", headers: JSON_HEADERS });
			for (const list of caseListState.values()) list.selection.delete(c.id);
			toast("已删除案例");
			onDeleted();
		} catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
	});
}

async function runCases(caseIds: string[], moduleIds: string[], name?: string): Promise<void> {
	try {
		const run = await api<Run>("/api/runs", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ caseIds, moduleIds, name, concurrency: 1 }),
		});
		toast("已创建评测批次");
		navigate(`#/run/${run.id}`);
	} catch (error) {
		toast(error instanceof Error ? error.message : String(error), "error");
	}
}

function openModuleModal(module?: Module): void {
	const tagsEditor = tagEditor({ id: "m-tags", initial: module?.tags, limit: 20, loadCandidates: async () => (await api<StateResponse>("/api/state")).modules.flatMap(m => m.tags ?? []) });
	const body = h("div", {});
	body.append(
		field("名称", input("m-name", module?.name)),
		field("描述", textarea("m-desc", module?.description, false), "模块所覆盖的被测能力"),
		field("标签", tagsEditor.element, "新增或选择已有标签，保存后生效。最多 20 个。"),
	);
	openModal({
		title: module ? "编辑模块" : "新建模块",
		body,
		actions: (close) => [
			h("button", { class: "btn", onclick: close }, "取消"),
			h("button", {
				class: "btn btn-primary",
				onclick: async () => {
					try {
						const tags = tagsEditor.read();
						if (module) {
							await api(`/api/modules/${module.id}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ name: val("m-name"), description: val("m-desc"), tags }) });
						} else {
							await api("/api/modules", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: val("m-name"), description: val("m-desc"), tags }) });
						}
						close();
						toast(module ? "模块已更新" : "模块已创建");
						render();
					} catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
				},
			}, "保存"),
		],
	});
}

/* ----------------------------- View: import (3-step wizard) ----------------------------- */

async function renderImport(app: HTMLElement): Promise<void> {
	let s: StateResponse;
	try {
		s = await getState();
	} catch (error) {
		app.replaceChildren(flash(error instanceof Error ? error.message : String(error)));
		return;
	}
	state = s;

	app.replaceChildren();
	app.append(h("div", { class: "page-head" },
		h("h1", { class: "page-title" }, "导入案例"),
		h("p", { class: "page-desc" }, "上传 JSON/JSONL 或粘贴内容，校验后导入到目标模块"),
	));

	let step = 1;
	let content = "";
	const requestedModule = new URLSearchParams(location.hash.split("?")[1]).get("module");
	let moduleId = s.modules.find((m) => m.id === requestedModule)?.id ?? s.modules[0]?.id ?? "";
	const returnTo = requestedModule ? `#/cases/${requestedModule}` : "#/cases";
	let format = "json";
	let replayMode = "single-turn";
	let preview: { suite: { defaults: EvalDefaults; cases: EvalCase[] }; cases: Array<{ id: string; description?: string; replayMode?: string; duplicate: boolean }> } | null = null;
	let policy = "skip";

	const stepsEl = h("div", { class: "Steps" });
	const bodyEl = h("div", {});
	app.append(stepsEl, bodyEl);

	const renderSteps = (): void => {
		stepsEl.replaceChildren(
			stepEl(1, "选择来源与模块", step === 1 ? "active" : step > 1 ? "done" : ""),
			stepEl(2, "校验并预览", step === 2 ? "active" : step > 2 ? "done" : ""),
			stepEl(3, "确认导入", step === 3 ? "active" : ""),
		);
	};

	const stepEl = (num: number, label: string, cls: string): HTMLElement =>
		h("div", { class: `step ${cls}` }, h("span", { class: "step-num" }, num > 1 && step > num ? "✓" : String(num)), h("span", {}, label));

	const renderStep1 = (): void => {
		bodyEl.replaceChildren();
		const wrap = h("div", { class: "Box" });
		const inner = h("div", { class: "Box-body" });
		inner.append(
			field("目标模块", select("imp-module", s.modules.map((m) => [m.id, m.name]), moduleId)),
			h("div", { class: "form-row" },
				field("缺省回放方式", select("imp-replay", REPLAY_MODES.map((m) => [m.value, m.label]), replayMode), "仅用于未填写 replayMode 的案例；文件中已指定的类型保持不变。"),
				field("文件格式", select("imp-format", [["json", "JSON（对象或数组）"], ["jsonl", "JSONL（每行一个案例）"]], format)),
			),
			field("粘贴内容", textarea("imp-content", content), "或使用下方文件上传；JSON 对象需包含 cases 数组"),
			field("或上传文件", h("input", {
				class: "form-control",
				type: "file",
				accept: ".json,.jsonl,.txt",
				onchange: async (e: Event) => {
					const file = (e.target as HTMLInputElement).files?.[0];
					if (!file) return;
					(document.getElementById("imp-content") as HTMLTextAreaElement).value = await file.text();
				},
			})),
			h("div", { class: "form-hint" },
				"示例模板：",
				...REPLAY_MODES.map((m) => h("button", { class: "btn btn-sm", onclick: () => fillImportExample(m.value) }, `${m.label}示例`)),
				h("button", { class: "btn btn-sm", onclick: () => fillImportExample("single-turn", "jsonl") }, "JSONL 示例"),
			),
		);
		wrap.append(inner);
		bodyEl.append(h("div", { class: "ImportLayout" }, wrap, fieldDocs()));
		bodyEl.append(h("div", { class: "wizard-actions" },
			h("button", { class: "btn", onclick: () => navigate(returnTo) }, "取消"),
			h("button", {
				class: "btn btn-primary",
				onclick: async () => {
					moduleId = val("imp-module");
					replayMode = val("imp-replay");
					format = val("imp-format");
					content = val("imp-content");
					if (!moduleId) return toast("请选择目标模块", "error");
					if (!content.trim()) return toast("请粘贴或上传内容", "error");
					try {
						preview = await api("/api/import/preview", {
							method: "POST",
							headers: JSON_HEADERS,
							body: JSON.stringify({ moduleId, content, format, replayMode }),
						});
						step = 2;
						renderSteps();
						renderStep2();
					} catch (error) {
						bodyEl.prepend(flash(error instanceof Error ? error.message : String(error)));
					}
				},
			}, "下一步：校验"),
		));
	};

	const renderStep2 = (): void => {
		bodyEl.replaceChildren();
		if (!preview) {
			bodyEl.append(flash("校验失败，请返回上一步重试"));
			return;
		}
		const duplicateCount = preview.cases.filter((c) => c.duplicate).length;
		const wrap = h("div", { class: "Box" });
		const inner = h("div", { class: "Box-body" });
		inner.append(
			h("div", { class: "flash flash-info" }, `共解析出 ${preview.cases.length} 个有效案例${duplicateCount ? `，其中 ${duplicateCount} 个与现有案例 ID 重复` : ""}。`),
		);
		if (preview.cases.some((c) => c.replayMode !== "full-task")) inner.append(h("p", { class: "form-hint" }, "单轮案例执行时禁用工具，只生成一次响应；文件中保留的工作区和多轮迭代配置不会用于单轮执行。"));
		const tableWrap = h("div", { class: "TableWrap" });
		const table = h("table", { class: "Table" });
		table.append(h("thead", {}, h("tr", {}, h("th", {}, "案例 ID"), h("th", {}, "描述"), h("th", {}, "回放方式"), h("th", {}, "状态"))));
		const tbody = h("tbody");
		for (const c of preview.cases) {
			tbody.append(h("tr", {},
				h("td", { class: "mono" }, c.id),
				h("td", { class: "muted" }, c.description ?? "—"),
				h("td", {}, badge(replayLabel(c.replayMode), c.replayMode === "full-task" ? "Label--done" : "Label--accent")),
				h("td", {}, c.duplicate ? badge("重复", "Label--attention") : badge("新增", "Label--success")),
			));
		}
		table.append(tbody);
		tableWrap.append(table);
		inner.append(tableWrap);
		wrap.append(inner);
		bodyEl.append(wrap);
		bodyEl.append(h("div", { class: "wizard-actions" },
			h("button", { class: "btn", onclick: () => { step = 1; renderSteps(); renderStep1(); } }, "上一步"),
			h("button", { class: "btn btn-primary", onclick: () => { step = 3; renderSteps(); renderStep3(); } }, "下一步：确认导入"),
		));
	};

	const renderStep3 = (): void => {
		bodyEl.replaceChildren();
		const wrap = h("div", { class: "Box" });
		const inner = h("div", { class: "Box-body" });
		inner.append(
			field("重复案例处理", select("imp-policy", [["skip", "跳过（保留现有案例）"], ["version", "创建新版本（覆盖）"]], policy), "重复依据为「同模块内相同案例 ID」"),
		);
		const resultBox = h("div", {});
		inner.append(resultBox);
		wrap.append(inner);
		bodyEl.append(wrap);
		bodyEl.append(h("div", { class: "wizard-actions" },
			h("button", { class: "btn", onclick: () => { step = 2; renderSteps(); renderStep2(); } }, "上一步"),
			h("button", {
				class: "btn btn-primary",
				onclick: async () => {
					policy = val("imp-policy");
					try {
						const result = await api<{ created: number; updated: number; skipped: number }>("/api/import", {
							method: "POST",
							headers: JSON_HEADERS,
							body: JSON.stringify({ moduleId, content, format, replayMode, policy }),
						});
						resultBox.replaceChildren(h("div", { class: "flash flash-success" }, `导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}。`));
						toast("导入完成");
						navigate(`#/cases/${moduleId}`);
					} catch (error) {
						resultBox.replaceChildren(flash(error instanceof Error ? error.message : String(error)));
					}
				},
			}, "确认导入"),
		));
	};

	const fillImportExample = (mode: ReplayMode, fileFormat = "json"): void => {
		const fill = () => {
			const example = caseExample(mode);
			content = fileFormat === "jsonl" ? JSON.stringify(example) : JSON.stringify({ version: 1, cases: [example] }, null, 2);
			(document.getElementById("imp-content") as HTMLTextAreaElement).value = content;
			(document.getElementById("imp-format") as HTMLSelectElement).value = format = fileFormat;
			(document.getElementById("imp-replay") as HTMLSelectElement).value = replayMode = mode;
		};
		if (val("imp-content").trim()) confirmModal("替换导入内容", "填入示例将替换当前内容。", "替换", fill);
		else fill();
	};
	renderSteps();
	renderStep1();
}

function fieldDocs(): HTMLElement {
 const box = h("aside", { class: "Box field-docs" });
 box.append(h("div", { class: "Box-header" }, "字段说明"));
 const body = h("div", { class: "Box-body" });
 body.append(h("p", { class: "form-hint" }, "支持案例集对象、案例数组和 JSONL（每行一个案例），每次 1–1000 个。示例可直接导入，无需填写模型密钥。执行时仍需有效的运行配置。"));
 body.append(h("p", { class: "form-hint" }, "cwd、tools、maxIterations、timeoutMs、systemPrompt 可写在案例中或 defaults 中。单轮固定禁用工具、最多一次响应，不使用多轮工作区和迭代配置。"));
 const table = h("table", { class: "Table" }, h("thead", {}, h("tr", {}, ...["字段 / 类型", "说明", "示例"].map((label) => h("th", {}, label)))));
 table.append(h("tbody", {}, ...IMPORT_FIELDS.map(([name, type, description, example]) => h("tr", {},
  h("td", {}, h("code", {}, name), h("div", { class: "muted small" }, type)), h("td", {}, description), h("td", {}, h("code", {}, example))))));
 body.append(h("div", { class: "TableWrap" }, table));
 box.append(body);
 return box;
}

async function renderCaseDetail(app: HTMLElement, id?: string, newModuleId?: string): Promise<void> {
	const epoch = renderEpoch;
	app.append(loading());
	let s: StateResponse;
	try {
		const [snapshot, item] = await Promise.all([getState(), id ? api<SavedCase>(`/api/cases/${id}`) : Promise.resolve(undefined)]);
		s = snapshot;
		if (item) {
			s.cases = [...s.cases.filter(c => c.id !== item.id), item];
			if (!s.modules.some(m => m.id === item.moduleId)) s.modules.push(await api<Module>(`/api/modules/${item.moduleId}`));
		}
	} catch (error) {
		if (epoch !== renderEpoch) return;
		app.replaceChildren(h("div", {}, flash(error instanceof Error ? error.message : String(error)), h("button", { class: "btn mt-3", onclick: render }, "重试加载")));
		return;
	}
	if (epoch !== renderEpoch) return;
	state = s;

	const existing = id ? s.cases.find((c) => c.id === id) : undefined;
	if (id && !existing) {
		app.replaceChildren(flash("案例不存在或已删除", "warning"));
		return;
	}
	const module = existing ? s.modules.find((m) => m.id === existing.moduleId) : s.modules.find((m) => m.id === newModuleId) ?? s.modules[0];
	if (!module) {
		app.replaceChildren(flash("请先创建一个模块", "warning"));
		return;
	}
	const isNew = !existing;
	const definition: EvalCase = existing?.definition ?? {
		id: "new-case",
		replayMode: "single-turn",
		tags: [],
		description: "",
		history: [],
		prompt: "",
		assertions: { finishReason: "completed" },
	};
	const defaults: EvalDefaults = { ...(existing?.defaults ?? s.settings) };
	for (const key of ["cwd", "systemPrompt", "tools", "maxIterations", "timeoutMs"] as const) {
		if (definition[key] !== undefined) Object.assign(defaults, { [key]: definition[key] });
	}
	let replayMode: ReplayMode = definition.replayMode ?? "single-turn";

	let inlineRunId: string | undefined;

	app.replaceChildren();

	// crumbs
	const crumbs = h("div", { class: "crumbs" },
		h("a", { href: "#/cases", onclick: () => navigate("#/cases") }, "案例"),
		h("span", { class: "sep" }, "/"),
		h("a", { href: `#/cases/${module.id}`, onclick: () => navigate(`#/cases/${module.id}`) }, module.name),
		h("span", { class: "sep" }, "/"),
		h("span", { class: "muted" }, isNew ? "新建案例" : definition.id),
	);
	app.append(crumbs);

	// header
	const header = h("div", { class: "page-head flex-between wrap gap-2" },
		h("div", {},
			h("h1", { class: "page-title" }, isNew ? "新建案例" : definition.id),
			h("p", { class: "page-desc" }, isNew ? `归属模块：${module.name}` : `模块：${module.name} · 版本 v${existing?.revision ?? 0} · 更新于 ${relTime(existing?.updatedAt)}`),
			...(existing ? [sessionIdLabel(s.latest[existing.id]?.sessionId)] : []),
		),
		h("div", { class: "page-actions" },
			h("button", { class: "btn", onclick: () => navigate(`#/cases/${module.id}`) }, "返回"),
			h("button", { class: "btn", onclick: () => saveCase() }, "保存"),
			...(existing ? [h("button", { class: "btn", onclick: () => transferSaved("copy") }, "复制到…"), h("button", { class: "btn", disabled: !s.modules.some(m => m.id !== existing.moduleId), onclick: () => transferSaved("move") }, "移动到…"), h("button", { class: "btn btn-danger", onclick: () => deleteCase(existing, () => navigate(`#/cases/${module.id}`)) }, "删除")] : []),
			h("button", { class: "btn btn-primary", id: "case-run", onclick: () => runDraft(replayMode) }, `运行${replayLabel(replayMode)}`),
		),
	);
	app.append(header);
	const modeCards = h("div", { class: "replay-cards", role: "group", "aria-label": "回放方式" });
	for (const mode of REPLAY_MODES) {
		modeCards.append(h("button", { class: "replay-card", "data-mode": mode.value, onclick: () => { replayMode = mode.value; updateMode(); } },
			h("strong", {}, mode.label), h("span", { class: "form-hint" }, mode.description)));
	}
	app.append(modeCards);

	const layout = h("div", { class: "CaseLayout" });
	const left = h("section", { class: "grow" });
	const right = h("section", { class: "grow" });

	// ---- left: input form ----
	const tagsEditor = tagEditor({ id: "f-tags", initial: definition.tags, candidates: s.cases.filter(c => s.modules.some(m => m.id === c.moduleId)).flatMap(c => c.definition.tags ?? []) });
	const form = h("div", { class: "Box" });
	const formBody = h("div", { class: "Box-body" });
	formBody.append(
		h("div", { class: "section-title" }, h("span", {}, "基本信息")),
		field("案例 ID *", input("f-id", isNew ? "" : definition.id), "模块内唯一，例如 history-bun-install"),
		field("描述", input("f-desc", definition.description ?? ""), "可选，例如：验证模型遵循历史上下文"),
		field("标签", tagsEditor.element, "新增或选择已有标签，保存后生效。"),
	);

	const historyBox = h("details", { class: "Box mt-3", open: definition.history.length > 0 });
	historyBox.append(h("summary", { class: "Box-header" }, "历史消息（可选）"));
	const historyBody = h("div", { class: "Box-body" });
	historyBody.append(
		h("div", { class: "section-title" },
			h("span", {}, "历史消息"),
			...(["user", "assistant"] as const).map((role) => h("button", { class: "btn btn-sm", onclick: () => { definition.history.push({ role, content: "" }); renderHistory(); } }, role === "user" ? "＋ 用户消息" : "＋ 助手消息")),
		),
	);
	const historyRows = h("div", { id: "history-rows" });
	historyBody.append(historyRows, h("div", { class: "form-hint", id: "history-hint" }));
	historyBox.append(historyBody);

	const promptBox = h("div", { class: "Box mt-3" });
	promptBox.append(h("div", { class: "Box-header", id: "prompt-title" }), h("div", { class: "Box-body" },
		textarea("f-prompt", definition.prompt, false),
		h("div", { class: "form-hint", id: "prompt-hint" }),
		h("button", { class: "btn btn-sm mt-2", onclick: () => {
			const fill = () => {
				const sample = caseExample(replayMode);
				(document.getElementById("f-prompt") as HTMLTextAreaElement).value = sample.prompt;
				if (!val("f-id")) (document.getElementById("f-id") as HTMLInputElement).value = sample.id;
				definition.history = structuredClone(sample.history); renderHistory();
				historyBox.toggleAttribute("open", sample.history.length > 0);
				(document.getElementById("a-contains") as HTMLTextAreaElement).value = (sample.assertions?.contains ?? []).join("\n");
				for (const key of ["tools", "maxIterations", "timeoutMs"] as const) {
					const control = document.getElementById({ tools: "f-tools", maxIterations: "f-maxiter", timeoutMs: "f-timeout" }[key]) as HTMLInputElement;
					if (sample[key] !== undefined) control.value = String(sample[key]);
				}
			};
			if (val("f-prompt").trim() || definition.history.length || val("a-contains")) confirmModal("填入示例", "将替换当前输入、历史消息和包含文本规则，并填入示例执行配置。", "填入", fill);
			else fill();
		} }, "填入示例"),
	));
	form.append(formBody);

	const envBox = h("div", { class: "Box mt-3 CaseConfig-environment" });
	const envBody = h("div", { class: "Box-body" });
	envBody.append(
		h("div", { class: "section-title" }, h("span", {}, "环境与执行配置")),
		field("工作区初始目录", input("f-cwd", defaults.cwd), "多轮专用，例如 D:/eval-fixtures/demo。服务端绝对路径；留空使用空工作区，每次运行从独立副本启动。"),
		h("div", { class: "form-row" },
			field("工具范围", select("f-tools", TOOL_OPTIONS, defaults.tools ?? "read-only")),
			field("最大迭代次数", input("f-maxiter", defaults.maxIterations ?? 10, "number"), "正整数，例如 30；达到此上限后结束任务。"),
		),
	);
	envBox.append(envBody);

	const credBox = h("details", { class: "Box mt-3 CaseConfig" });
	credBox.append(h("summary", { class: "Box-header" }, h("span", {}, "模型与高级配置")));
	const credBody = h("div", { class: "Box-body" });
	credBody.append(h("p", { class: "CaseConfig-origin" }, existing ? "已载入案例保存的配置。" : "已填入当前全局运行配置，可按需修改；保存后作为案例配置。"));
	appendConfigFields(credBody, "f", defaults, false, true);
	credBody.append(headerEditor("f-case-headers", definition, "案例请求头覆盖"));
	const advancedFields = h("section", { class: "CaseConfig-advanced" },
		h("h3", { class: "ConfigGroup-title" }, "高级执行设置"),
		h("div", { class: "CaseConfig-timeout" }, field("超时（毫秒）", input("f-timeout", defaults.timeoutMs ?? 300000, "number"), "正整数，例如 300000 表示 5 分钟。")),
		field("系统提示词", textarea("f-sysprompt", defaults.systemPrompt, false), "可选，例如：请用中文回答。留空使用默认提示词。"),
	);
	credBody.append(advancedFields);
	credBox.append(credBody);

	const assertBox = h("div", { class: "Box mt-3" });
	const assertBody = h("div", { class: "Box-body" });
	assertBody.append(
		h("div", { class: "section-title" }, h("span", {}, "最终回复检查（可选）")),
		h("p", { class: "form-hint" }, "这里检查 Agent 最后发出的回复，不读取工作区文件。每行填写一项；留空就不检查。要检查交付文件，请使用下方的任务验收规则。"),
		field("回复必须包含（每行一个）", textarea("a-contains", (definition.assertions?.contains ?? []).join("\n")), "例如 bun install；最后回复必须包含所有填写项。"),
		field("回复不能包含（每行一个）", textarea("a-notContains", (definition.assertions?.notContains ?? []).join("\n")), "例如 npm install；最后回复不能包含任何填写项。"),
		field("回复需匹配正则（每行一个）", textarea("a-matches", (definition.assertions?.matches ?? []).join("\n")), "例如 Bun|bun；最后回复必须匹配所有表达式，无需填写 / 分隔符。"),
		field("结束状态（可选）", select("a-finish", [["", "不额外检查（推荐由任务验收规则判定）"], ...FINISH_OPTIONS], definition.grading ? definition.assertions?.finishReason ?? "" : definition.assertions?.finishReason ?? "completed"), "只在明确需要检查 Agent 如何结束时选择。通常保持“不额外检查”，由下方必要规则判断任务是否完成；选择“正常完成”则要求 Agent 的结束状态确实为正常完成。"),
	);
	assertBox.append(assertBody);
	const taskGrading = gradingEditor(definition.grading, { caseId: existing?.id });


	left.append(panelTabs("case-editor", [
		["输入", h("div", {}, form, historyBox, promptBox)],
		["判定规则", h("div", {}, assertBox, taskGrading.element)],
		["配置", h("div", {}, envBox, credBox)],
	]));
	credBox.setAttribute("open", "");

	// ---- right: result panel ----
	const resultPanel = h("div", { class: "Box" });
	const resultHeader = h("div", { class: "Box-header flex-between" },
		h("span", {}, "执行结果"),
		h("div", { class: "flex-center gap-2" },
			h("span", { class: "muted small", id: "inline-run-status" }, "尚未运行"),
			h("button", { class: "btn btn-sm btn-danger", id: "inline-stop", onclick: () => void stopInline(), disabled: true }, "停止"),
		),
	);
	const resultBody = h("div", { class: "Box-body" });
	resultBody.append(h("pre", { class: "output placeholder" }, "点击上方「单轮回放」或「多轮回放（完整任务）」开始调试。执行期间此处实时显示输出；结束后展示断言、工具轨迹、Token 与耗时。"));
	resultPanel.append(resultHeader, resultBody);

	const historyBox2 = h("div", { class: "Box mt-3" });
	historyBox2.append(h("div", { class: "Box-header" }, "历史记录"));
	const historyList = h("div", { class: "Box-body", id: "case-history" });
	historyList.append(h("div", { class: "muted small" }, "加载中…"));
	historyBox2.append(historyList);

	right.append(resultPanel, historyBox2);
	layout.append(left, right);
	app.append(layout);
	const updateMode = (): void => {
		const single = replayMode === "single-turn";
		taskGrading.setMode(replayMode);
		envBox.hidden = single;
		for (const card of modeCards.querySelectorAll<HTMLElement>("button")) {
			card.setAttribute("aria-pressed", String(card.dataset.mode === replayMode));
		}
		document.getElementById("case-run")!.textContent = `运行${replayLabel(replayMode)}`;
		document.getElementById("prompt-title")!.textContent = single ? "本轮问题 *" : "任务指令 *";
		document.getElementById("prompt-hint")!.textContent = `示例：${caseExample(replayMode).prompt}`;
		document.getElementById("history-hint")!.textContent = single ? "可选，为本轮问题提供上下文。例如用户：项目使用 Bun。留空则只发送本轮问题。" : "可选，作为任务初始背景；不会依次重放这些消息。";
		if (!inlineRunId) resultBody.replaceChildren(h("p", { class: "muted" }, `点击「运行${replayLabel(replayMode)}」开始调试，结果将在此显示。`));
	};
	updateMode();

	const renderHistory = (): void => {
		historyRows.replaceChildren(...definition.history.map((msg, index) => {
			const row = h("div", { class: "history-item" });
			row.append(
				h("div", { class: "role " + msg.role, },
					h("span", {}, msg.role === "user" ? "用户" : "助手"),
					h("button", { class: "btn btn-sm btn-icon", onclick: () => { definition.history.splice(index, 1); renderHistory(); } }, "×"),
				),
				textarea(`h-content-${index}`, msg.content, false),
			);
			row.querySelector("textarea")!.addEventListener("input", (event) => { msg.content = (event.target as HTMLTextAreaElement).value; });
			return row;
		}));
	};
	renderHistory();

	const readDefinitionFromForm = (validateGrading = true): EvalCase => {
		const history: EvalMessage[] = [];
		for (let index = 0; index < definition.history.length; index++) {
			const content = val(`h-content-${index}`).trim();
			if (content) history.push({ role: definition.history[index]!.role, content });
		}
		const assertions = readAssertionsFromForm();
		const result: EvalCase = {
			id: val("f-id").trim(),
			replayMode,
			tags: tagsEditor.read(),
			description: val("f-desc").trim() || undefined,
			history,
			prompt: val("f-prompt"),
			assertions,
			grading: validateGrading ? taskGrading.read(replayMode) : definition.grading,
			...readHeaderEditor("f-case-headers"),
			cwd: val("f-cwd").trim() || undefined,
			tools: val("f-tools") as ToolMode,
			maxIterations: replayMode === "single-turn" && (!Number.isInteger(Number(val("f-maxiter"))) || Number(val("f-maxiter")) <= 0) ? defaults.maxIterations ?? 10 : Number(val("f-maxiter")),
			timeoutMs: Number(val("f-timeout")),
			systemPrompt: val("f-sysprompt").trim() || undefined,
		};
		return result;
	};

	const readAssertionsFromForm = (): EvalAssertions | undefined => {
		const contains = splitLines(val("a-contains"));
		const notContains = splitLines(val("a-notContains"));
		const matches = splitLines(val("a-matches"));
		const finishReason = val("a-finish") as EvalAssertions["finishReason"];
		if (!contains.length && !notContains.length && !matches.length && (!finishReason || (finishReason === "completed" && !definition.assertions && !definition.grading))) return undefined;
		const assertions: EvalAssertions = { finishReason: finishReason || undefined };
		if (contains.length) assertions.contains = contains;
		if (notContains.length) assertions.notContains = notContains;
		if (matches.length) assertions.matches = matches;
		return assertions;
	};

	const readDefaultsFromForm = (): EvalDefaults => readConfig("f", true);
	const savedForm = JSON.stringify({ definition: readDefinitionFromForm(false), defaults: readDefaultsFromForm() });
	function transferSaved(operation: "copy" | "move") {
		if (!existing) return;
		try {
			if (JSON.stringify({ definition: readDefinitionFromForm(), defaults: readDefaultsFromForm() }) !== savedForm) { toast("有未保存的修改，请先保存案例后再复制或移动。", "error"); return; }
		} catch { toast("请先保存有效的案例配置。", "error"); return; }
		openCaseTransfer(operation, [existing], s, cases => { if (operation === "move") render(); else navigate(`#/case/${cases[0].id}`); });
	}
	const validateCaseForm = (): boolean => {
		for (const error of app.querySelectorAll(".field-error")) error.remove();
		for (const control of app.querySelectorAll("[aria-invalid]")) control.removeAttribute("aria-invalid");
		let first: HTMLElement | undefined;
		const invalid = (id: string, message: string) => {
			const control = document.getElementById(id)!;
			control.setAttribute("aria-invalid", "true");
			control.after(h("div", { class: "field-error", role: "alert" }, message));
			const details = control.closest("details");
			if (details) details.open = true;
			first ??= control;
		};
		if (!val("f-id").trim()) invalid("f-id", "请填写案例 ID，例如 history-bun-install。");
		else if (s.cases.some((c) => c.moduleId === module.id && c.id !== existing?.id && c.definition.id === val("f-id").trim())) invalid("f-id", "此模块已存在相同案例 ID，请使用其他 ID。");
		if (!val("f-prompt").trim()) invalid("f-prompt", replayMode === "single-turn" ? "请填写本轮问题。" : "请填写任务指令。");
		for (const id of replayMode === "full-task" ? ["f-maxiter", "f-timeout"] : ["f-timeout"]) {
			const value = Number(val(id));
			if (!Number.isInteger(value) || value <= 0) invalid(id, "请输入大于 0 的整数。");
		}
		for (const [index, pattern] of splitLines(val("a-matches")).entries()) {
			try { new RegExp(pattern, "u"); } catch { invalid("a-matches", `第 ${index + 1} 条正则表达式无效。`); break; }
		}
		first?.focus();
		try { taskGrading.read(replayMode); } catch (error) { toast(String(error), "error"); return false; }
		return !first;
	};

	const saveCase = async (): Promise<void> => {
		if (!validateCaseForm()) return;
		const def = readDefinitionFromForm();
		if (!def.id) return toast("案例 ID 不能为空", "error");
		if (!def.prompt.trim()) return toast("Prompt 不能为空", "error");
		const nextDefaults = readDefaultsFromForm();
		try {
			if (isNew) {
				const created = await api<SavedCase>("/api/cases", {
					method: "POST",
					headers: JSON_HEADERS,
					body: JSON.stringify({ moduleId: module.id, definition: def, defaults: nextDefaults }),
				});
				toast("案例已创建");
				navigate(`#/case/${created.id}`);
			} else {
				await api<SavedCase>(`/api/cases/${existing!.id}`, {
					method: "PUT",
					headers: JSON_HEADERS,
					body: JSON.stringify({ revision: existing!.revision, definition: def, defaults: nextDefaults }),
				});
				toast("案例已保存");
				render();
			}
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const runDraft = async (mode: "single-turn" | "full-task"): Promise<void> => {
		if (!validateCaseForm()) return;
		const def = readDefinitionFromForm();
		if (!def.id) return toast("案例 ID 不能为空", "error");
		if (!def.prompt.trim()) return toast("Prompt 不能为空", "error");
		const nextDefaults = readDefaultsFromForm();
		try {
			const run = await api<Run>("/api/runs", {
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({
					name: `调试 · ${def.id}`,
					concurrency: 1,
					replayMode: mode,
					draft: [{ moduleId: module.id, definition: def, defaults: nextDefaults }],
				}),
			});
			inlineRunId = run.id;
			startInlinePoll(run.id, mode);
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const startInlinePoll = (runId: string, mode: string): void => {
		stopPolling();
		const stopBtn = document.getElementById("inline-stop") as HTMLButtonElement;
		const statusEl = document.getElementById("inline-run-status") as HTMLElement;
		stopBtn.disabled = false;
		activePoll = pollRun(runId, (detail) => {
			const item = detail.items[0];
			if (!item) return;
			renderInlineResult(resultBody, item);
			statusEl.textContent = item.phase === "verifying" && item.status === "running" ? "验证中" : STATUS_META[item.status].label;
			if (["completed", "cancelled", "interrupted"].includes(detail.status) && !detail.items.some(i => ["queued", "running"].includes(i.status))) {
				stopBtn.disabled = true;
				activePoll = undefined;
				void loadHistory();
			}
		});
	};

	const stopInline = async (): Promise<void> => {
		if (!inlineRunId) return;
		try {
			await api(`/api/runs/${inlineRunId}/cancel`, { method: "POST", headers: JSON_HEADERS });
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const loadHistory = async (): Promise<void> => {
		if (!existing) {
			historyList.replaceChildren(h("div", { class: "muted small" }, "保存案例后此处显示历次执行记录。"));
			return;
		}
		try {
			const runs = await api<Array<Run & { items: CaseRunItem[] }>>(`/api/cases/${existing.id}/runs`);
			if (!runs.length) {
				historyList.replaceChildren(h("div", { class: "muted small" }, "暂无执行记录。"));
				return;
			}
			historyList.replaceChildren(...runs.map((run) => {
				const item = run.items[0];
				const row = h("div", { class: "flex-between gap-2", style: "padding:6px 0;border-bottom:1px solid var(--color-border-muted)" });
				row.append(
					h("div", { class: "flex-center gap-2 wrap" },
						statusBadge(item?.status ?? "queued"),
						h("span", { class: "mono" }, item?.modelId ?? "—"),
						h("span", { class: "muted small" }, `v${item?.revision ?? 0}`),
						h("span", { class: "muted small" }, fmtTime(run.createdAt)),
						...run.items.map(i => h("div", {}, h("span", { class: "muted small" }, `第 ${i.round ?? 1} 轮`), sessionIdLabel(i.sessionId))),
					),
					h("div", { class: "flex-center gap-2" },
						h("span", { class: "muted small" }, fmtDuration(item?.durationMs)),
						h("button", { class: "btn btn-sm", onclick: () => navigate(`#/run/${run.id}`) }, "查看"),
					),
				);
				return row;
			}));
		} catch {
			historyList.replaceChildren(h("div", { class: "muted small" }, "加载失败"));
		}
	};

	void loadHistory();
}

const inlineInspectors = new WeakMap<HTMLElement, { id: string; view: ReturnType<typeof createItemInspector> }>();
function renderInlineResult(container: HTMLElement, item: RunItem): void {
	const existing = inlineInspectors.get(container);
	if (existing?.id === item.id && container.contains(existing.view.element)) { existing.view.update(item); return; }
	const view = createItemInspector(item.runId, item);
	inlineInspectors.set(container, { id: item.id, view });
	container.replaceChildren(view.element);
}

function renderAssertions(container: HTMLElement, result: EvalCaseResult): void {
	if (!result.assertions.length) return;
	const box = h("div", { class: "mt-3" });
	box.append(h("div", { class: "section-title" }, "断言结果"));
	for (const assertion of result.assertions) {
		box.append(h("div", { class: "flex-center gap-2 mb-2" },
			assertion.passed ? badge("通过", "Label--success") : badge("失败", "Label--danger"),
			h("span", { class: "small" }, assertion.message),
		));
	}
	container.append(box);
}

function renderToolCalls(container: HTMLElement, toolCalls: EvalCaseResult["toolCalls"]): void {
	if (!toolCalls.length) return;
	const box = h("div", { class: "mt-3" });
	box.append(h("div", { class: "section-title" }, `工具调用（${toolCalls.length}）`));
	for (const call of toolCalls) {
		const item = h("div", { class: "tool-call" });
		item.append(
			h("div", { class: "tool-call-head" },
				h("span", {}, call.name),
				h("span", { class: "muted" }, call.error ? badge("错误", "Label--danger") : fmtDuration(call.durationMs)),
			),
			h("div", { class: "tool-call-body" },
				h("pre", {}, `${JSON.stringify(call.input, null, 2)}${call.error ? `\n\nERROR: ${call.error}` : call.output !== undefined ? `\n\n→ ${JSON.stringify(call.output, null, 2)}` : ""}`),
			),
		);
		box.append(item);
	}
	container.append(box);
}

function pollRun(runId: string, onUpdate: (detail: RunDetailResponse) => void, onDone?: () => void): () => void {
	let stopped = false;
	let handle: number | undefined;
	const tick = async (): Promise<void> => {
		if (stopped) return;
		try {
			const detail = await api<RunDetailResponse>(`/api/runs/${runId}`);
			if (stopped) return;
			onUpdate(detail);
			showSyncStatus(runId);
			if (["completed", "cancelled", "interrupted"].includes(detail.status) && !detail.items.some(i => ["queued", "running"].includes(i.status))) {
				if (onDone) onDone();
				return;
			}
		} catch (error) {
			if (!stopped) showSyncStatus(runId, error instanceof Error ? error.message : String(error));
		}
		handle = window.setTimeout(tick, 1000);
	};
	handle = window.setTimeout(tick, 200);
	return () => {
		stopped = true;
		if (handle !== undefined) clearTimeout(handle);
	};
}

/* ----------------------------- View: new run ----------------------------- */

async function renderNewRun(app: HTMLElement): Promise<void> {
	app.append(loading());
	let s: StateResponse;
	try {
		s = await getState();
	} catch (error) {
		app.replaceChildren(flash(error instanceof Error ? error.message : String(error)));
		return;
	}
	state = s;

	app.replaceChildren();
	const page = h("div", { class: "WizardPage" });
	app.append(page);
	app = page;
	app.append(h("div", { class: "page-head" },
		h("h1", { class: "page-title" }, "新建评测"),
		h("p", { class: "page-desc" }, "选择执行范围与运行配置，提交后后台执行，关闭页面不影响运行"),
	));

	const scope = runScope;
	runScope = undefined;
	const selectedModules = new Set(scope?.moduleIds ?? []);
	for (const c of s.cases) if (scope?.caseIds.includes(c.id)) selectedModules.add(c.moduleId);
	const excludedCases = new Set(scope?.caseIds.length ? s.cases.filter((c) => selectedModules.has(c.moduleId) && !scope.caseIds.includes(c.id)).map((c) => c.id) : []);

	const scopeBox = h("div", { class: "Box" });
	scopeBox.append(h("div", { class: "Box-header" }, "执行范围"));
	const scopeBody = h("div", { class: "Box-body" });
	const moduleChecks = h("div", {});
	const caseChecks = h("div", { class: "mt-3" });
	const caseCheckLabel = h("div", { class: "section-title mt-2" }, h("span", {}, "案例微调（默认全部选中）"));
	caseChecks.append(caseCheckLabel);
	const caseList = h("div", { id: "run-case-list", class: "mt-2" });
	caseChecks.append(caseList);
	scopeBody.append(moduleChecks, caseChecks);
	scopeBox.append(scopeBody);

	for (const module of s.modules) {
		const count = s.cases.filter((c) => c.moduleId === module.id).length;
		const label = h("label", { class: "form-check" },
			h("input", {
				type: "checkbox",
				checked: selectedModules.has(module.id),
				onchange: (e: Event) => {
					const checked = (e.target as HTMLInputElement).checked;
					if (checked) selectedModules.add(module.id);
					else selectedModules.delete(module.id);
					renderCaseChecks();
				},
			}),
			h("span", {}, module.name),
			h("span", { class: "muted small" }, `${count} 个案例`),
		);
		moduleChecks.append(label);
	}

	const renderCaseChecks = (): void => {
		caseList.replaceChildren();
		const cases = s.cases.filter((c) => selectedModules.has(c.moduleId));
		if (!cases.length) {
			caseList.append(h("div", { class: "muted small" }, "未选择模块"));
			return;
		}
		for (const c of cases) {
			caseList.append(h("label", { class: "form-check", style: "padding-left:8px" },
				h("input", {
					type: "checkbox",
					checked: !excludedCases.has(c.id),
					onchange: (e: Event) => {
						const checked = (e.target as HTMLInputElement).checked;
						if (checked) excludedCases.delete(c.id);
						else excludedCases.add(c.id);
						updatePreview();
					},
				}),
				h("span", { class: "mono" }, c.definition.id),
				h("span", { class: "muted small" }, replayLabel(c.definition.replayMode)),
			));
		}
	};

	const replayBox = h("div", { class: "Box mt-3" });
	replayBox.append(h("div", { class: "Box-header" }, "回放方式"));
	const replayBody = h("div", { class: "Box-body" });
	replayBody.append(field("回放方式", select("nr-replay", [["", "使用案例自身方式"], ["single-turn", "强制单轮回放"], ["full-task", "强制多轮回放（完整任务）"]], ""), "覆盖类型会应用于所有所选案例，不是按类型筛选；单轮固定禁用工具并只生成一次响应。"));
	replayBox.append(replayBody);

	const configBox = h("div", { class: "Box mt-3" });
	configBox.append(h("div", { class: "Box-header" }, "运行配置"));
	const configBody = h("div", { class: "Box-body" });
	configBody.append(
		h("label", { class: "form-check mb-2" },
			h("input", { type: "checkbox", id: "nr-use-settings", checked: true }),
			h("span", {}, "使用案例保存的配置（默认来自全局配置）"),
		),
	);
	const configFields = h("div", { id: "nr-config-fields", style: "display:none" });
	configBody.append(configFields, field("并发数", input("nr-concurrency", 1, "number"), "1–4，同一轮内多个案例并行执行"), field("重复轮数", h("input", { class: "form-control", id: "nr-repeat", type: "number", min: 1, max: 100, step: 1, value: 1 }), "1–100，含首次执行。例如填 3 表示整批执行 3 轮；每轮使用相同提示词、历史与配置，建立独立会话。与多轮对话回放无关。"));
	appendConfigFields(configFields, "nr", s.settings, false);
	configBox.append(configBody);

	const infoBox = h("div", { class: "Box mt-3" });
	infoBox.append(h("div", { class: "Box-header" }, "批次信息"));
	const infoBody = h("div", { class: "Box-body" });
	infoBody.append(
		field("批次名称", input("nr-name", `回归评测 · ${new Date().toLocaleString("zh-CN")}`)),
		field("备注 / 代码版本", input("nr-note", ""), "可选，记录本次评测对应的代码版本或说明"),
	);
	infoBox.append(infoBody);

	const preview = h("div", { class: "mt-3" });
	const updatePreview = (): void => {
		const cases = s.cases.filter((c) => selectedModules.has(c.moduleId) && !excludedCases.has(c.id));
		const perModule = new Map<string, number>();
		for (const c of cases) perModule.set(c.moduleId, (perModule.get(c.moduleId) ?? 0) + 1);
		preview.replaceChildren(h("div", { class: "flash flash-info" }, `将执行 ${cases.length} 个案例${cases.length ? "：" : ""} ${[...perModule.entries()].map(([id, count]) => `${s.modules.find((m) => m.id === id)?.name ?? id} ${count}`).join("、")}`));
	};

	const stepper = h("div", { class: "Steps", "aria-label": "新建评测步骤" });
	const review = h("section", {});
	const panels = [h("section", {}, scopeBox), h("section", {}, replayBox, configBox, infoBox), review];
	const errorBox = h("div", { role: "alert" });
	let step = 0;
	let submitting = false;
	let reviewedBody: Record<string, unknown> | undefined;
	const collect = (): Record<string, unknown> => {
		const caseIds = s.cases.filter(c => selectedModules.has(c.moduleId) && !excludedCases.has(c.id)).map(c => c.id);
		if (!caseIds.length) throw new Error("请至少选择一个案例");
		const concurrency = Number(val("nr-concurrency"));
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("并发数必须是 1–4 的整数");
		const repeatCount = Number(val("nr-repeat"));
		if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100) throw new Error("重复轮数须为 1–100 的整数");
		const body: Record<string, unknown> = { caseIds, name: val("nr-name") || undefined, note: val("nr-note") || undefined, concurrency, repeatCount };
		if (val("nr-replay")) body.replayMode = val("nr-replay");
		if (!(document.getElementById("nr-use-settings") as HTMLInputElement).checked) {
			for (const key of ["maxiter", "timeout"]) { const value = Number(val(`nr-${key}`)); if (!Number.isInteger(value) || value <= 0) throw new Error("迭代次数和超时必须是正整数"); }
			body.defaults = readConfig("nr", false);
		}
		return body;
	};
	const showReview = () => {
		reviewedBody = collect();
		const cases = s.cases.filter(c => (reviewedBody!.caseIds as string[]).includes(c.id));
		const overriding = reviewedBody.defaults as EvalDefaults | undefined;
		review.replaceChildren(h("div", { class: "ReviewSummary" }, h("strong", {}, `${cases.length} 个案例 × ${reviewedBody.repeatCount} 轮 = ${cases.length * Number(reviewedBody.repeatCount)} 次执行`), h("span", {}, `并发 ${reviewedBody.concurrency}`), h("span", {}, overriding ? "覆盖默认配置；案例执行参数优先" : "使用案例保存的配置")), h("h2", { class: "section-title" }, String(reviewedBody.name ?? "未命名评测")), h("p", { class: "muted small" }, "以下为本批次生效配置。每轮整批结束后自动开始下一轮，重复执行会相应增加耗时与模型用量。单轮回放固定禁用工具且仅生成一次响应；案例级执行参数优先于批次默认配置。"));
		const table = h("table", { class: "Table" }, h("thead", {}, h("tr", {}, ...["案例", "模型", "回放方式", "工具 / 迭代上限", "超时"].map(label => h("th", {}, label)))));
		const body = h("tbody", {});
		for (const c of cases) {
			const defaults = { ...c.defaults, ...overriding };
			const definition = { ...c.definition, replayMode: (reviewedBody.replayMode ?? c.definition.replayMode) as ReplayMode };
			const execution = replayConfig(definition, defaults);
			body.append(h("tr", {}, h("td", {}, c.definition.id), h("td", {}, defaults.modelId), h("td", {}, replayLabel(definition.replayMode)), h("td", {}, `${execution.tools} / ${execution.maxIterations}`), h("td", {}, fmtDuration(definition.timeoutMs ?? defaults.timeoutMs ?? 300000))));
		}
		table.append(body); review.append(h("div", { class: "TableWrap" }, table));
	};
	const previous = h("button", { class: "btn", onclick: () => { step--; updateStep(); } }, "上一步");
	const next = h("button", { class: "btn btn-primary", onclick: () => {
		try {
			if (!s.cases.some(c => selectedModules.has(c.moduleId) && !excludedCases.has(c.id))) throw new Error("请至少选择一个案例");
			if (step === 1) showReview();
			step++; updateStep();
		} catch (error) { errorBox.replaceChildren(flash(String(error))); }
	} }, "下一步");
	const submit = h("button", {
			class: "btn btn-primary",
			onclick: async () => {
				if (submitting || !reviewedBody) return;
				submitting = true; (submit as HTMLButtonElement).disabled = true; (previous as HTMLButtonElement).disabled = true;
				try {
					const run = await api<Run>("/api/runs", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(reviewedBody) });
					toast("评测批次已提交，后台开始执行");
					navigate(`#/run/${run.id}`);
				} catch (error) {
					toast(error instanceof Error ? error.message : String(error), "error");
				} finally {
					submitting = false; (submit as HTMLButtonElement).disabled = false; (previous as HTMLButtonElement).disabled = false;
				}
			},
		}, "确认并启动评测");
	const updateStep = () => {
		errorBox.replaceChildren();
		panels.forEach((panel, index) => { panel.hidden = index !== step; });
		stepper.replaceChildren(...["选择案例", "运行配置", "确认启动"].map((label, index) => h("div", { class: `step ${index === step ? "active" : index < step ? "done" : ""}`, "aria-current": index === step ? "step" : undefined }, h("span", { class: "step-num" }, String(index + 1)), label)));
		previous.hidden = step === 0; next.hidden = step === 2; submit.hidden = step !== 2; preview.hidden = step === 2;
	};
	app.append(stepper, ...panels, preview, errorBox, h("div", { class: "wizard-actions" }, h("button", { class: "btn", onclick: () => navigate(scope?.returnTo ?? "#/runs") }, "取消"), previous, next, submit));
	updateStep();

	const useSettings = document.getElementById("nr-use-settings") as HTMLInputElement;
	useSettings.addEventListener("change", () => {
		configFields.style.display = useSettings.checked ? "none" : "";
	});
	const updateScope = (): void => { updatePreview(); };
	for (const box of moduleChecks.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) box.addEventListener("change", updateScope);
	renderCaseChecks();
	updatePreview();
}

/* ----------------------------- View: runs list ----------------------------- */

async function renderRuns(app: HTMLElement): Promise<void> {
	app.append(loading());
	let s: StateResponse;
	try {
		s = { modules: [], cases: [], latest: {}, settings: {} as EvalDefaults, runs: await api<StateResponse["runs"]>("/api/runs") };
	} catch (error) {
		app.replaceChildren(flash(error instanceof Error ? error.message : String(error)));
		return;
	}
	state = s;

	app.replaceChildren();
	app.append(h("div", { class: "page-head flex-between" },
		h("div", {},
			h("h1", { class: "page-title" }, "评测批次"),
			h("p", { class: "page-desc" }, "后台队列执行历史与进度"),
		),
		h("div", { class: "page-actions" }, h("button", { class: "btn btn-primary", onclick: () => navigate("#/run/new") }, "新建评测")),
	));

	if (!s.runs.length) {
		app.append(h("div", { class: "empty" },
			h("div", { class: "empty-title" }, "还没有评测批次"),
			h("div", { class: "empty-desc" }, "在案例页运行单个模块，或点击「新建评测」批量运行。"),
		));
		return;
	}

	const tableWrap = h("div", { class: "TableWrap" });
	const search = input("runs-search", ""); search.setAttribute("placeholder", "搜索批次名称或备注…"); search.setAttribute("aria-label", "搜索评测批次");
	const filter = select("runs-status", [["", "全部批次"], ["active", "正在执行"], ["issues", "含失败或错误"], ["completed", "已完成"], ["cancelled", "已取消"], ["interrupted", "已中断"]], "");
	filter.setAttribute("aria-label", "按批次状态筛选");
	const count = h("span", { class: "muted small" });
	app.append(h("div", { class: "ResultFilters" }, search, filter, count));
	const table = h("table", { class: "Table" });
	table.append(h("thead", {}, h("tr", {},
		h("th", {}, "批次"),
		h("th", {}, "状态"),
		h("th", { class: "num" }, "通过 / 总数"),
		h("th", { class: "num" }, "累计执行耗时"),
		h("th", { class: "num" }, "Token"),
		h("th", { class: "num" }, "费用"),
		h("th", {}, "操作"),
	)));
	const tbody = h("tbody");
	for (const run of s.runs) {
		const summary = run.summary;
		const failed = summary.failed + summary.error + summary.inconclusive;
		const tr = h("tr", { class: "clickable", "data-run-id": run.id, onclick: () => navigate(`#/run/${run.id}`) });
		tr.append(
			h("td", {},
				h("a", { class: "case-name", href: `#/run/${run.id}` }, run.name),
				run.note ? h("div", { class: "muted small" }, run.note) : h("span", {}),
				h("div", { class: "muted small" }, `${fmtTime(run.createdAt)} · ${run.repeatCount ?? 1} 轮`),
			),
			h("td", {}, runStatusBadge(run.status), failed ? h("div", { class: "muted small mt-2" }, `${summary.failed} 验收失败 · ${summary.error} 执行错误 · ${summary.inconclusive} 无法判定`) : null),
			h("td", { class: "num" },
				h("span", { class: failed ? "Label Label--danger" : summary.passed === summary.total && summary.total > 0 ? "Label Label--success" : "Label Label--neutral", style: "font-variant-numeric:tabular-nums" }, `${summary.passed} / ${summary.total}`),
			),
			h("td", { class: "num" }, fmtDuration(summary.durationMs)),
			h("td", { class: "num" }, fmtTokens(summary.tokens)),
			h("td", { class: "num" }, fmtCost(summary.cost)),
		);
		const actions = h("td", { onclick: (e: Event) => e.stopPropagation(), class: "nowrap" });
		actions.append(h("button", { class: "btn btn-sm", onclick: () => navigate(`#/run/${run.id}`) }, "查看"));
		if (["queued", "running"].includes(run.status)) {
			actions.append(h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
				try { await api(`/api/runs/${run.id}/cancel`, { method: "POST", headers: JSON_HEADERS }); toast("已请求取消"); render(); } catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
			} }, "取消"));
		}
		if (failed + summary.cancelled > 0 && ["completed", "cancelled", "interrupted"].includes(run.status)) {
			actions.append(h("button", { class: "btn btn-sm", onclick: () => rerunFailed(run.id) }, "重跑未通过案例"));
		}
		tr.append(actions);
		tbody.append(tr);
	}
	table.append(tbody);
	tableWrap.append(table);
	app.append(tableWrap);
	const emptyRow = h("tr", { hidden: true }, h("td", { colspan: 7, class: "empty" }, "没有匹配的评测批次"));
	tbody.append(emptyRow);
	const apply = () => {
		let visible = 0;
		const query = (search as HTMLInputElement).value.toLowerCase();
		const value = (filter as HTMLSelectElement).value;
		for (const row of tbody.querySelectorAll<HTMLElement>("[data-run-id]")) {
			const run = s.runs.find(r => r.id === row.dataset.runId)!;
			const matches = (!value || (value === "active" ? ["queued", "running"].includes(run.status) : value === "issues" ? run.summary.failed + run.summary.error + run.summary.inconclusive > 0 : run.status === value)) && `${run.name} ${run.note ?? ""}`.toLowerCase().includes(query);
			row.hidden = !matches; if (matches) visible++;
		}
		count.textContent = `${visible} 个批次`; emptyRow.hidden = visible > 0;
	};
	search.addEventListener("input", apply); filter.addEventListener("change", apply); apply();
}

async function rerunFailed(runId: string): Promise<void> {
	try {
		const run = await api<Run>("/api/runs", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ parentRunId: runId, name: "未通过案例重跑", concurrency: 1 }),
		});
		toast("已创建重跑批次");
		navigate(`#/run/${run.id}`);
	} catch (error) {
		toast(error instanceof Error ? error.message : String(error), "error");
	}
}

function download(url: string): void {
	const a = document.createElement("a");
	a.href = url;
	a.rel = "noopener";
	document.body.append(a);
	a.click();
	a.remove();
}

/* ----------------------------- View: run detail ----------------------------- */

function repeatBatch(run: RunDetailResponse): void {
	const count = h("input", { class: "form-control", id: "repeat-batch-count", type: "number", min: 1, max: 100, step: 1, value: 3 }) as HTMLInputElement;
	const hint = h("p", { class: "muted small" });
	const error = h("div", { role: "alert" });
	const update = () => { hint.textContent = `${run.repeatReport.caseCount} 个案例 × ${count.value || "—"} 轮 = ${run.repeatReport.caseCount * Number(count.value)} 次执行；沿用原批次快照和并发 ${run.concurrency}，创建独立的新批次。`; };
	count.addEventListener("input", update); update();
	openModal({ title: "重复评测本批次", body: h("div", {}, field("重复轮数（含首次）", count), hint, error), actions: close => [
		h("button", { class: "btn", onclick: close }, "取消"),
		h("button", { class: "btn btn-primary", onclick: async (event: Event) => {
			const repeatCount = Number(count.value);
			if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100) { error.replaceChildren(flash("重复轮数须为 1–100 的整数")); return; }
			const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
			try {
				const created = await api<Run>("/api/runs", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ parentRunId: run.id, rerunScope: "all", repeatCount, concurrency: run.concurrency, name: `${run.name} · 重复 ${repeatCount} 轮` }) });
				close(); navigate(`#/run/${created.id}`);
			} catch (e) { error.replaceChildren(flash(String(e))); button.disabled = false; }
		} }, "启动重复评测"),
	] });
}

function renderRepeatReport(target: HTMLElement, run: RunDetailResponse): void {
	const report = run.repeatReport;
	const signature = JSON.stringify(report);
	if (target.dataset.signature === signature) return;
	target.dataset.signature = signature;
	const expanded = new Set([...target.querySelectorAll<HTMLDetailsElement>("details[open]")].map(el => el.dataset.caseId));
	const rate = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
	target.replaceChildren(
		h("h2", { class: "section-title" }, "重复多轮评测报告"),
		h("p", {}, `${report.caseCount} 个案例 × ${report.repeatCount} 轮 · 完整执行 ${report.completedRounds} 轮${report.partial ? " · 阶段性结果，样本未全部完成" : ""}`),
		h("div", { class: "ReviewSummary" }, h("strong", {}, `全轮通过 ${report.allRoundsPassedCases}/${report.caseCount}`), h("span", {}, `通过/失败波动 ${report.judgmentChangedCases} 个案例`), h("span", {}, `输出变化 ${report.outputChangedCases}/${report.comparableCases} 个可比较案例`)),
		h("p", { class: "muted small" }, report.method),
		gradingMetrics(report.grading),
		h("p", { class: "muted small" }, `${report.withoutContentAssertions} 个案例未配置内容判定规则。文本一致率 = 最常见输出次数 / 可比较输出次数；少于 2 次输出显示 —。`),
	);
	const table = h("table", { class: "Table" }, h("thead", {}, h("tr", {}, ...["轮次", "旧版通过 / 已判定", "旧版文本通过率", "验收失败", "错误 / 未判定 / 取消", "待完成", "累计耗时"].map(label => h("th", {}, label)))));
	const body = h("tbody");
	for (const r of report.rounds) body.append(h("tr", {}, ...[String(r.round), `${r.grading.legacy.numerator} / ${r.grading.legacy.denominator}`, rate(r.passRate), String(r.failed), `${r.error} / ${r.inconclusive} / ${r.cancelled}`, String(r.queued + r.running), fmtDuration(r.durationMs)].map(value => h("td", {}, value))));
	table.append(body); target.append(h("div", { class: "TableWrap" }, table), h("h3", { class: "section-title mt-3" }, "案例对比（展开查看逐轮输出与失败依据）"));
	const items = new Map(run.items.map(item => [item.id, item]));
	for (const c of [...report.cases].sort((a, b) => Number(b.judgmentChanged) - Number(a.judgmentChanged) || b.failed + b.error - a.failed - a.error || b.outputVariants - a.outputVariants)) {
		const row = h("details", { class: "Box mt-2 RepeatCase", "data-case-id": c.caseId, open: expanded.has(c.caseId) },
			h("summary", { class: "Box-header" }, `${c.moduleName} / ${c.name} · 通过 ${c.passed}/${c.passed + c.failed} · 输出 ${c.outputVariants} 种 · 一致率 ${rate(c.consistencyRate)}${c.judgmentChanged ? " · 判定波动" : ""}${c.error ? ` · 错误 ${c.error}` : ""}`),
		);
		const content = h("div", { class: "Box-body RepeatOutputs" });
		const populate = () => {
			if (content.childElementCount) return;
			for (const r of c.rounds) {
				const item = items.get(r.itemId)!;
				content.append(h("section", { class: "Box" }, h("div", { class: "Box-header flex-center gap-2" }, `第 ${r.round} 轮`, statusBadge(r.status)), h("div", { class: "Box-body" },
					...r.failedAssertions.map(message => h("p", { class: "flash flash-error" }, message)),
					r.error ? h("p", { class: "flash flash-error" }, r.error) : null,
					h("pre", { class: "RepeatOutput" }, item.result?.text ?? (r.status === "queued" ? "尚未执行" : r.status === "running" ? "执行中，实时输出见案例结果" : item.text || "无完整输出")),
				)));
			}
		};
		row.append(content); row.addEventListener("toggle", () => { if ((row as HTMLDetailsElement).open) populate(); });
		if (expanded.has(c.caseId)) populate();
		target.append(row);
	}
}

async function renderRunDetail(app: HTMLElement, runId: string): Promise<void> {
	app.append(loading());
	let detail: RunDetailResponse;
	try { detail = await api<RunDetailResponse>(`/api/runs/${runId}`); }
	catch (error) { app.replaceChildren(flash(error instanceof Error ? error.message : String(error))); return; }
	if (parseRoute().page !== "run" || location.hash !== `#/run/${runId}`) return;
	app.replaceChildren();
	const title = h("h1", { class: "page-title" }, detail.name);
	const status = h("span", {});
	const actions = h("div", { class: "page-actions" });
	const summary = h("section", { class: "RunSummary", "aria-label": "批次摘要" });
	const stats = h("section", {});
	const repeatReport = h("section", {});
	const list = h("div", { class: "RunItems", "aria-label": "案例结果" });
	const inspector = h("section", { class: "RunInspector", "aria-label": "选中案例详情" });
	const filter = select("run-result-filter", [["", "全部结果"], ["issues", "失败与错误"], ["running", "运行中"], ["queued", "排队中"], ["passed", "通过"], ["failed", "断言失败"], ["error", "执行错误"], ["inconclusive", "无法判定"], ["cancelled", "已取消"]], "");
	const moduleFilter = select("run-module-filter", [["", "全部模块"], ...[...new Set(detail.items.map(i => i.moduleName))].map(name => [name, name] as [string, string])], "");
	const roundFilter = select("run-round-filter", [["", "全部轮次"], ...Array.from({ length: detail.repeatCount ?? 1 }, (_, i) => [String(i + 1), `第 ${i + 1} 轮`] as [string, string])], "");
	roundFilter.setAttribute("aria-label", "按重复轮次筛选");
	filter.setAttribute("aria-label", "按执行结果筛选"); moduleFilter.setAttribute("aria-label", "按模块筛选");
	const search = input("run-item-search", ""); search.setAttribute("placeholder", "搜索案例 ID 或描述…"); search.setAttribute("aria-label", "搜索批次案例");
	const count = h("span", { class: "muted small" });
	const rows = new Map<string, HTMLElement>();
	let selectedId: string | undefined;
	let itemView: ReturnType<typeof createItemInspector> | undefined;
	let inspectorItem: string | undefined;
	let lastRunStatus = "";
	const applyFilters = () => {
		const query = (search as HTMLInputElement).value.toLowerCase();
		const value = (filter as HTMLSelectElement).value;
		const module = (moduleFilter as HTMLSelectElement).value;
		const round = (roundFilter as HTMLSelectElement).value;
		const visible = detail.items.filter(i => (!round || (i.round ?? 1) === Number(round)) && (!value || (value === "issues" ? ["failed", "error", "inconclusive"].includes(i.status) : i.status === value)) && (!module || i.moduleName === module) && `${i.snapshot.definition.id} ${i.snapshot.definition.description ?? ""}`.toLowerCase().includes(query));
		count.textContent = `${visible.length} / ${detail.items.length} 次执行`;
		if (!visible.some(i => i.id === selectedId)) selectedId = visible[0]?.id;
		for (const item of detail.items) {
			let row = rows.get(item.id);
			if (!row) {
				row = h("button", { class: "RunItem", type: "button", onclick: () => { selectedId = item.id; applyFilters(); } });
				rows.set(item.id, row); list.append(row);
			}
			row.hidden = !visible.some(i => i.id === item.id);
			row.setAttribute("aria-pressed", String(item.id === selectedId));
			const signature = JSON.stringify([item.status, item.phase, item.result?.durationMs]);
			if (row.dataset.signature !== signature) {
				row.dataset.signature = signature;
				row.replaceChildren(h("span", { class: "RunItem-head" }, h("span", { class: "case-name" }, item.snapshot.definition.id), item.status === "running" && item.phase === "verifying" ? badge("验证中", "Label--attention") : statusBadge(item.status)), h("span", { class: "muted small" }, `第 ${item.round ?? 1} 轮 · ${item.moduleName} · ${replayLabel(item.snapshot.definition.replayMode)} · ${fmtDuration(item.result?.durationMs)}`));
			}
		}
		const selected = detail.items.find(i => i.id === selectedId);
		if (!selected) {
			inspector.replaceChildren(h("div", { class: "empty" }, h("div", { class: "empty-title" }, "没有匹配的案例"), h("div", { class: "empty-desc" }, "调整结果、模块或搜索条件后重试。")));
			inspectorItem = undefined; return;
		}
		if (inspectorItem !== selected.id) {
			itemView = createItemInspector(runId, selected); inspector.replaceChildren(itemView.element); inspectorItem = selected.id;
		} else {
			itemView?.update(selected);
		}
	};
	const update = (run: RunDetailResponse) => {
		detail = run;
		const value = run.summary;
		const legacyMetrics = gradingSummary(run.items).legacy; const judged = legacyMetrics.denominator;
		const settled = value.passed + value.failed + value.error + value.inconclusive + value.cancelled;
		const running = ["queued", "running"].includes(run.status);
		status.replaceChildren(runStatusBadge(run.status));
		if (lastRunStatus !== run.status) {
			lastRunStatus = run.status; actions.replaceChildren();
			if (running) actions.append(h("button", { class: "btn btn-danger", onclick: async () => {
				try { await api(`/api/runs/${runId}/cancel`, { method: "POST", headers: JSON_HEADERS }); toast("已请求停止评测"); }
				catch (error) { toast(String(error), "error"); }
			} }, "停止评测"));
			else if (value.failed + value.error + value.inconclusive + value.cancelled > 0) actions.append(h("button", { class: "btn btn-primary", onclick: () => rerunFailed(runId) }, "重跑未通过案例"));
			actions.append(h("button", { class: "btn", onclick: () => download(`/api/runs/${runId}/export?format=json`) }, "导出 JSON"), h("button", { class: "btn", onclick: () => download(`/api/runs/${runId}/export?format=csv`) }, "导出 CSV"));
			actions.append(h("button", { class: "btn", onclick: () => download(`/api/runs/${runId}/export?format=markdown`) }, "导出简报"));
			if (!running) actions.append(h("button", { class: "btn", onclick: () => repeatBatch(detail) }, "重复评测本批次"));
		}
		summary.replaceChildren(
			h("div", { class: "RunSummary-primary" }, h("strong", {}, judged ? `${Math.round((gradingSummary(run.items).legacy.rate ?? 0) * 100)}%` : "—"), h("span", {}, "旧版文本通过率"), h("span", { class: "muted small" }, `${gradingSummary(run.items).legacy.numerator} / ${judged} 已判定`)),
			h("div", { class: "RunSummary-counts" }, ...(["passed", "failed", "error", "inconclusive", "cancelled", "running", "queued"] as const).map(key => h("span", { class: "flex-center gap-1" }, statusBadge(key), h("b", {}, String(value[key]))))),
			h("div", { class: "RunSummary-meta muted small" }, `已结束 ${settled} / ${value.total} · 累计执行耗时 ${fmtDuration(value.durationMs)} · Token ${fmtTokens(value.tokens)} · 费用 ${value.cost === null ? "未提供" : fmtCost(value.cost)}`),
			statusBar(value), gradingMetrics(gradingSummary(run.items)),
			h("div", { class: "muted small" }, "通过率 = 通过 /（通过 + 断言失败）；执行错误与取消单独统计。"),
		);
		const table = h("table", { class: "Table" }, h("thead", {}, h("tr", {}, ...["模块", "通过 / 总数", "旧版文本通过率", "失败 / 错误 / 未判定", "累计执行耗时"].map(label => h("th", {}, label)))));
		const body = h("tbody", {});
		for (const [name, m] of Object.entries(moduleStats(run.items))) {
			const metrics = gradingSummary(run.items.filter(i => i.moduleName === name));
			body.append(h("tr", {}, h("td", {}, name), h("td", {}, `${m.passed} / ${m.total}`), h("td", {}, metrics.legacy.rate === null ? "—" : `${Math.round(metrics.legacy.rate * 100)}% (${metrics.legacy.numerator}/${metrics.legacy.denominator})`), h("td", {}, `${m.failed} / ${metrics.executionErrors.numerator} / ${run.items.filter(i => i.moduleName === name && i.status === "inconclusive").length}`), h("td", {}, fmtDuration(m.durationMs))));
		}
		table.append(body); stats.replaceChildren(h("div", { class: "TableWrap" }, table));
		renderRepeatReport(repeatReport, run);
		applyFilters();
	};
	const results = h("section", {}, h("div", { class: "ResultFilters" }, search, filter, moduleFilter, roundFilter, count), h("div", { class: "RunWorkbench" }, list, inspector));
	app.append(h("div", { class: "crumbs" }, h("a", { href: "#/runs" }, "评测批次"), h("span", {}, "/"), h("span", {}, runId.slice(0, 8))), h("div", { class: "page-head flex-between wrap gap-3" }, h("div", {}, h("div", { class: "flex-center gap-2 wrap" }, title, status), h("p", { class: "page-desc" }, `创建于 ${fmtTime(detail.createdAt)} · ${detail.repeatCount ?? 1} 轮 · 并发 ${detail.concurrency}${detail.note ? ` · ${detail.note}` : ""}`)), actions), summary, panelTabs("run-detail", [["案例结果", results], ["多轮报告", repeatReport], ["模块统计", stats]]));
	search.addEventListener("input", applyFilters); filter.addEventListener("change", applyFilters); moduleFilter.addEventListener("change", applyFilters); roundFilter.addEventListener("change", applyFilters);
	update(detail);
	if (["queued", "running"].includes(detail.status) || detail.items.some(i => ["queued", "running"].includes(i.status))) activePoll = pollRun(runId, update);
}

function statusBar(summary: Summary): HTMLElement {
	const segments: Array<[string, number]> = [
		["seg-passed", summary.passed],
		["seg-failed", summary.failed],
		["seg-error", summary.error], ["seg-queued", summary.inconclusive],
		["seg-cancelled", summary.cancelled],
		["seg-queued", summary.queued],
		["seg-running", summary.running],
	];
	const bar = h("div", { class: "StatusBar", role: "img", "aria-label": `通过 ${summary.passed}，断言失败 ${summary.failed}，执行错误 ${summary.error}，取消 ${summary.cancelled}，运行中 ${summary.running}，排队 ${summary.queued}` });
	for (const [cls, count] of segments) {
		if (count > 0) bar.append(h("span", { class: cls, style: `width:${(count / (summary.total || 1)) * 100}%` }));
	}
	return bar;
}

function moduleStats(items: RunItem[]): Record<string, { total: number; passed: number; failed: number; error: number; cancelled: number; durationMs: number }> {
	const map: Record<string, { total: number; passed: number; failed: number; error: number; cancelled: number; durationMs: number }> = {};
	for (const item of items) {
		const entry = map[item.moduleName] ??= { total: 0, passed: 0, failed: 0, error: 0, cancelled: 0, durationMs: 0 };
		entry.total++;
		if (item.status === "passed") entry.passed++;
		else if (item.status === "failed") entry.failed++;
		else if (item.status === "error") entry.error++;
		else if (item.status === "cancelled") entry.cancelled++;
		entry.durationMs += item.result?.durationMs ?? 0;
	}
	return map;
}

function createItemInspector(runId: string, initial: RunItem) {
	let item = initial;
	let tab = "result";
	let revision = 0;
	const title = h("div", { class: "Inspector-title" });
	const meta = h("div", { class: "muted small" });
	const content = h("div", { class: "Inspector-content" });
	const tabs = h("div", { class: "tab-bar", "aria-label": "案例详情视图" });
	const progress = h("div");
	const sync = syncStatus(runId);
	const element = h("div", {}, title, meta, progress, sync, tabs, content);
	let conversation: ReturnType<typeof conversationView> | undefined;
	let trial: ReturnType<typeof verifierTrial> | undefined;
	const labels = [["result", "结果与断言"], ["conversation", "会话记录"], ["verification", "脚本试验证"], ["input", "输入快照"], ["tools", "工具诊断"], ["artifacts", "文件产物"]];
	const setHeader = () => {
		title.replaceChildren(h("span", {}, item.snapshot.definition.id), statusBadge(item.status));
		meta.replaceChildren(h("span", {}, `v${item.snapshot.revision} · ${item.snapshot.defaults.modelId} · ${replayLabel(item.snapshot.definition.replayMode)}`), sessionIdLabel(item.sessionId ?? item.result?.sessionId));
		const expanded = progress.querySelector("details")?.open;
		progress.replaceChildren(executionStatus(item));
		const details = progress.querySelector("details"); if (details && expanded) details.open = true;
	};
	const renderTab = async () => {
		const currentRevision = ++revision;
		const result = item.result;
		if (tab !== "verification") trial?.suspend();
		for (const b of tabs.querySelectorAll("button")) { b.classList.toggle("active", b.dataset.tab === tab); b.setAttribute("aria-pressed", String(b.dataset.tab === tab)); }
		content.replaceChildren();
		if (tab === "result") {
			const reason = item.error ?? result?.error ?? (item.status === "failed" ? result?.assertions.filter(a => !a.passed).map(a => a.message).join("；") || "断言未通过" : "");
			if (reason) content.append(flash(reason, item.status === "error" ? "warning" : "error"));
			if (result) renderAssertions(content, result);
			if (result) content.append(gradingPanel(result, async id => api(`/api/runs/${runId}/items/${item.id}/evidence/${id}`)));
			if (result && !["error", "cancelled"].includes(item.status)) content.append(h("div", { class: "section-title mt-3" }, "最终回复"), h("pre", { class: "output" }, result.text || "（无文本回复）"));
			if (!result || ["error", "cancelled"].includes(item.status)) {
				const preview = h("details", { class: "mt-3" }, h("summary", {}, ["queued", "running"].includes(item.status) ? "实时文本预览" : "已有输出（执行未完整结束）"), h("p", { class: "muted small" }, "这里只是文本片段；按消息查看过程请切换到会话记录。"), h("pre", { class: "output", "data-live-output": true }, item.text || result?.text || "暂无文本片段。"));
				content.append(preview);
			}
			if (result) content.append(h("div", { class: "metric-row mt-3" }, ...[["耗时", fmtDuration(result.durationMs)], ["迭代", String(result.iterations)], ["输入 Token", fmtTokens(result.usage.inputTokens)], ["输出 Token", fmtTokens(result.usage.outputTokens)], ["费用", fmtCost(result.usage.totalCost)]].map(([label, value]) => h("span", { class: "metric" }, label + " ", h("b", {}, value)))));
		} else if (tab === "conversation") {
			conversation ??= conversationView(runId, item.id); content.append(conversation.element); conversation.refresh();
		} else if (tab === "verification") {
			trial ??= verifierTrial({ runId, itemId: item.id }); content.append(trial.element); trial.resume();
		} else if (tab === "input") {
			content.append(h("div", { class: "section-title" }, "输入快照"), h("pre", { class: "code" }, JSON.stringify(item.snapshot.definition, null, 2)), h("div", { class: "section-title mt-3" }, "最终生效配置"), h("pre", { class: "code" }, JSON.stringify({ ...item.snapshot.defaults, ...Object.fromEntries(Object.entries(item.snapshot.definition).filter(([key, value]) => ["timeoutMs", "systemPrompt", "cwd"].includes(key) && value !== undefined)), ...replayConfig(item.snapshot.definition, item.snapshot.defaults), cwd: item.workspace ?? item.snapshot.definition.cwd ?? item.snapshot.defaults.cwd }, null, 2)));
		} else if (tab === "tools") {
			content.append(h("p", { class: "muted small" }, "这里展示 SDK 保存的工具诊断；请求与结果通知不证明工具实际执行。运行中的通知可在最近活动和会话记录中查看。"));
			if (!result?.toolCalls.length) content.append(h("div", { class: "empty" }, ["queued", "running"].includes(item.status) ? "执行结束后展示已记录的工具轨迹。" : "本次执行没有工具调用。"));
			else renderToolCalls(content, result.toolCalls);
		} else {
			if (item.snapshot.definition.replayMode !== "full-task") { content.append(h("div", { class: "empty" }, "单轮回放不产生工作区文件变更。")); return; }
			content.append(loading("加载文件产物…"));
			try {
				const files = await api<Array<{ path: string; change: string; size: number }>>(`/api/runs/${runId}/artifacts?item=${item.id}`);
				if (currentRevision !== revision || !element.isConnected) return;
				content.replaceChildren(h("p", { class: "muted small" }, "与初始工作区对比，可查看新增、修改和删除的文件。"));
				if (!files.length) content.append(h("div", { class: "empty" }, "无文件产物变化。"));
				const diffArea = h("div", { class: "FileDiff" });
				let fileRequest = 0;
				for (const file of files) content.append(h("div", { class: "ArtifactRow" }, h("span", { class: "mono grow" }, file.path), h("span", { class: "muted small" }, `${({ added: "新增", modified: "修改", deleted: "删除", unchanged: "未变" } as Record<string, string>)[file.change] ?? file.change} · ${file.size} B`), h("button", { class: "btn btn-sm", onclick: async () => {
					const request = ++fileRequest;
					diffArea.replaceChildren(loading());
					try {
						const diff = await api<{ before?: string; after?: string }>(`/api/runs/${runId}/artifacts?item=${item.id}&file=${encodeURIComponent(file.path)}`);
						if (currentRevision !== revision || request !== fileRequest) return;
						const makeDiff = () => h("div", { class: "DiffGrid" }, h("div", {}, h("div", { class: "section-title" }, "执行前"), h("pre", { class: "code" }, diff.before ?? "（不存在）")), h("div", {}, h("div", { class: "section-title" }, "执行后"), h("pre", { class: "code" }, diff.after ?? "（已删除）")));
						diffArea.replaceChildren(h("div", { class: "flex-between gap-2 mt-3 mb-2 wrap" }, h("span", { class: "mono" }, file.path), h("button", { class: "btn btn-sm", onclick: () => openModal({ title: file.path, body: makeDiff(), wide: true, actions: close => [h("button", { class: "btn", onclick: close }, "关闭")] }) }, "展开对比")), makeDiff());
					} catch (error) { if (request === fileRequest) diffArea.replaceChildren(flash(String(error))); }
				} }, "查看")));
				content.append(diffArea);
			} catch (error) { if (currentRevision === revision) content.replaceChildren(flash(String(error))); }
		}
	};
	for (const [key, label] of labels) tabs.append(h("button", { type: "button", "data-tab": key, onclick: () => { tab = key; void renderTab(); } }, label));
	setHeader(); void renderTab();
	return { element, update(next: RunItem) {
		const previous = item; item = next; setHeader();
		if (tab === "conversation") { conversation?.refresh(previous.status !== next.status); return; }
		// Completed results are immutable; other items in the batch may still be polling.
		if (next.result && previous.status === next.status && previous.endedAt === next.endedAt) return;
		// Streaming updates change the existing text node, preserving scroll and focus.
		if (tab === "result" && previous.status === next.status && !next.result) {
			const output = content.querySelector<HTMLElement>("[data-live-output]");
			if (output) output.textContent = next.text || "等待模型输出…";
		} else if (tab === "result" || (tab === "input" && previous.workspace !== next.workspace) || (tab === "tools" && JSON.stringify(previous.result?.toolCalls) !== JSON.stringify(next.result?.toolCalls)) || (tab === "artifacts" && previous.status !== next.status)) {
			const scroll = content.scrollTop; void renderTab(); content.scrollTop = scroll;
		}
	} };
}

function openItemModal(runId: string, item: RunItem): void {
	openModal({ title: `${item.snapshot.definition.id} · ${item.moduleName}`, wide: true, body: createItemInspector(runId, item).element, actions: close => [h("button", { class: "btn", onclick: close }, "关闭")] });
}

async function renderSettings(app: HTMLElement): Promise<void> {
	app.append(loading());
	let s: StateResponse;
	try {
		s = { modules: [], cases: [], runs: [], latest: {}, settings: await api<EvalDefaults>("/api/settings") };
	} catch (error) {
		app.replaceChildren(flash(error instanceof Error ? error.message : String(error)));
		return;
	}
	state = s;

	app.replaceChildren();
	app.append(h("div", { class: "page-head" },
		h("h1", { class: "page-title" }, "运行配置"),
		h("p", { class: "page-desc" }, "全局默认 Provider / 模型 / 工具 / 超时，新建案例与批量评测时作为默认值"),
	));

	const box = h("div", { class: "Box" });
	const body = h("div", { class: "Box-body" });
	body.append(h("p", { class: "form-hint mb-3" }, "全局配置用于新建案例。已保存的案例保留自己的配置；启动评测时可覆盖默认值，并在确认页检查最终生效参数。"));
	appendConfigFields(body, "set", s.settings, true);
	box.append(body);
	app.append(box);
	app.append(h("div", { class: "wizard-actions" },
		h("button", { class: "btn btn-primary", onclick: async () => {
			try {
				const settings = readConfig("set", true);
				await api("/api/settings", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(settings) });
				toast("配置已保存");
			} catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
		} }, "保存配置"),
	));
}

/* ----------------------------- Boot ----------------------------- */

function boot(): void {
	document.querySelector<HTMLAnchorElement>(".SkipLink")?.addEventListener("click", event => { event.preventDefault(); document.getElementById("app")?.focus(); });
	window.addEventListener("hashchange", render);
	void render();
}

boot();
