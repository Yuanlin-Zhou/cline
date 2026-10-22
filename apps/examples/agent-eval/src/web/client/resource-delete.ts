import { node, action, row, verifierDialog } from "./verifier-ui.js";
import type { SavedCase, Module } from "../types.js";
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
const json = { "Content-Type": "application/json" };
const preserved = "永久删除后无法恢复。历史评测、已提交任务的快照和归档产物会保留。";
export function deleteCasesDialog(cases: SavedCase[], modules: Module[], hiddenCount: number, api: Api, done: () => void) {
	const body = node("div"), error = node("p", "", "Grading-error"); error.setAttribute("role", "alert");
	body.append(node("p", `将删除所选的 ${cases.length} 个案例。${preserved}`));
	if (hiddenCount) body.append(node("p", `注意：其中 ${hiddenCount} 个案例不在当前筛选结果中，仍包含在本次删除内。`, "Verifier-warning"));
	const list = node("ul", "", "Resource-list");
	for (const c of cases) list.append(node("li", `${modules.find(m => m.id === c.moduleId)?.name ?? "未知模块"} / ${c.definition.description || c.definition.id}`));
	let busy = false;
	const submit = action(`永久删除 ${cases.length} 个案例`, () => { void (async () => {
		busy = true; submit.disabled = true; submit.textContent = "正在删除…"; error.textContent = "";
		try { await api("/api/cases/delete-batch", { method: "POST", headers: json, body: JSON.stringify({ items: cases.map(c => ({ id: c.id, revision: c.revision })) }) }); busy = false; modal.close(); done(); }
		catch (e) { error.textContent = `${e instanceof Error ? e.message : String(e)}。未确认删除成功，请刷新核对后重试。`; }
		finally { busy = false; submit.disabled = false; submit.textContent = `永久删除 ${cases.length} 个案例`; }
	})(); }); submit.classList.add("btn-danger");
	body.append(list, error);
	const modal = verifierDialog("批量删除案例", body, { footer: row(action("取消", () => modal.close()), submit), canClose: () => !busy });
}
export function deleteModuleDialog(id: string, api: Api, done: () => void) {
	type Preview = { module: Module; count: number; token: string; items: Array<{ name: string; archived: boolean }> };
	const body = node("div"), summary = node("p", "正在读取模块及全部案例…"), list = node("ul", "", "Resource-list"), error = node("p", "", "Grading-error");
	error.setAttribute("role", "alert");
	const confirm = node("input", "", "form-control"); confirm.id = "delete-module-name"; confirm.autocomplete = "off";
	const label = node("label", "输入完整模块名称确认", "form-label"); label.htmlFor = confirm.id;
	let preview: Preview | undefined, busy = false, closed = false;
	const submit = action("永久删除模块及全部案例", () => { void (async () => {
		if (!preview || busy) return;
		busy = true; submit.disabled = true; submit.textContent = "正在删除…"; error.textContent = "";
		try { await api(`/api/modules/${id}`, { method: "DELETE", headers: json, body: JSON.stringify({ name: confirm.value, expectedToken: preview.token }) }); busy = false; modal.close(); done(); }
		catch (e) { error.textContent = `${e instanceof Error ? e.message : String(e)}。未确认删除成功，请刷新清单核对。`; preview = undefined; }
		finally { busy = false; submit.disabled = !preview || confirm.value !== preview.module.name; submit.textContent = "永久删除模块及全部案例"; }
	})(); }); submit.classList.add("btn-danger"); submit.disabled = true;
	const refresh = action("刷新清单", () => { void load(); });
	async function load() {
		if (busy) return; busy = true; submit.disabled = true; refresh.disabled = true; preview = undefined;
		try {
			const value = await api<Preview>(`/api/modules/${id}/delete-preview`, { method: "POST", headers: json });
			if (closed) return; preview = value; confirm.value = ""; error.textContent = "";
			summary.textContent = `将永久删除模块「${value.module.name}」及全部 ${value.count} 个案例（含已归档案例）。${preserved}`;
			list.replaceChildren(...value.items.map(c => node("li", `${c.name}${c.archived ? "（已归档）" : ""}`)));
		} catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
		finally { busy = false; refresh.disabled = false; }
	}
	confirm.oninput = () => { submit.disabled = busy || !preview || confirm.value !== preview.module.name; };
	body.append(summary, list, label, confirm, error);
	const modal = verifierDialog("删除模块", body, { footer: row(refresh, action("取消", () => modal.close()), submit), canClose: () => !busy || !preview, onClose: () => { closed = true; } });
	void load();
}

export function archivedModulesDialog(api: Api, done: () => void) {
	const body = node("div"), status = node("p", "正在读取已归档模块…"); body.append(status);
	const modal = verifierDialog("已归档模块", body);
	void (async () => {
		try {
			const modules = (await api<Module[]>("/api/modules?includeArchived=1")).filter(m => m.archived);
			status.textContent = modules.length ? "删除包含模块下全部案例，历史执行仍保留。" : "没有已归档模块。";
			for (const module of modules) body.append(row(node("strong", module.name), action("删除模块", () => { modal.close(); deleteModuleDialog(module.id, api, done); })));
		} catch (e) { status.textContent = String(e); }
	})();
}
