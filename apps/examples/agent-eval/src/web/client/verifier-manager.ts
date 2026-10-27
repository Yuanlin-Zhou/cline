import { node, action, row, verifierDialog, downloadScript } from "./verifier-ui.js";
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Reference = { id: string; name: string; moduleId: string; moduleName: string; archived: boolean };
type Script = { id: string; label: string; filename?: string; version: string; sha256?: string; runtime?: string; source?: string; referenceCount?: number };
type Detail = Script & { content: string; token: string; references: Reference[] };
const headers = { "Content-Type": "application/json" };
let leave: (() => boolean) | undefined;
export const canLeaveVerifierManager = () => leave?.() ?? true;
function scriptInfo(script: Script, title = "详细信息") {
	const info = node("details", "", "VerifierCard-info");
	info.append(node("summary", title));
	const values = node("dl", "", "VerifierCard-metadata");
	for (const [label, value] of [
		["来源", script.source === "uploaded" ? "用户上传" : "配置注册"],
		["文件名", script.filename || "未提供"],
		[
			"运行环境",
			script.runtime === "python" ? "Python" : script.runtime || "未声明",
		],
		["版本", (script.source === "uploaded" ? script.sha256 ?? script.version : script.version) || "未声明"],
	])
		values.append(node("dt", label), node("dd", value));
	info.append(values);
	if (script.source === "uploaded" && script.runtime !== "python")
		info.append(
			node(
				"p",
				"当前管理页支持编辑 Python；此兼容脚本保持原有使用方式。",
				"form-hint",
			),
		);
	return info;
}
export function verifierManager(api: Api) {
	const root = node("section", "", "VerifierManager"), search = node("input", "", "form-control");
	search.placeholder = "搜索名称或文件名"; search.setAttribute("aria-label", "搜索验证脚本");
	const feedback = node("p", "", "flash flash-success"); feedback.hidden = true; feedback.setAttribute("role", "status");
	const list = node("div", "", "Resource-cards"), status = node("p", "", "form-hint"), error = node("p", "", "Grading-error");
	error.setAttribute("role", "alert"); status.setAttribute("role", "status");
	const registryNote = node("p", "配置注册的验证器由服务端维护，此处只读。", "form-hint");
	registryNote.hidden = true;
	let scripts: Script[] = [], loading = false;
	const refresh = action("刷新列表", () => { void load(); });
	function paint() {
		const q = search.value.toLowerCase(),
			visible = scripts.filter((s) =>
				`${s.label} ${s.filename ?? ""}`.toLowerCase().includes(q),
			);
		list.replaceChildren();
		status.textContent = `${visible.length} 个验证脚本 · 引用数包含已归档案例`;
		registryNote.hidden = !scripts.some((s) => s.source !== "uploaded");
		for (const s of visible) {
			const editable = s.source === "uploaded" && s.runtime === "python";
			const card = node("article", "", "Box Box-body VerifierCard");
			card.append(node("h2", s.label, "section-title"));
			if (s.filename)
				card.append(node("p", s.filename, "form-hint VerifierCard-filename"));
			const footer = node("div", "", "VerifierCard-footer");
			if (editable) {
				const count = s.referenceCount ?? 0;
				footer.append(
					node(
						"span",
						count ? `${count} 个案例引用` : "未引用",
						"form-hint VerifierCard-references",
					),
					row(
						action("查看 / 编辑", () => {
							void open(s.id);
						}),
						action("下载", () => {
							void download(s.id);
						}),
						action("删除", () => {
							void open(s.id, true);
						}),
					),
				);
			} else
				footer.append(
					node(
						"span",
						s.source === "uploaded" ? "兼容脚本 · 只读" : "配置注册 · 只读",
						"form-hint VerifierCard-source",
					),
					scriptInfo(s),
				);
			card.append(footer);
			list.append(card);
		}
		if (!visible.length)
			list.append(
				node("p", "暂无匹配的脚本，可上传 .py 文件开始使用。", "empty"),
			);
	}

	async function load() {
		if (loading) return; loading = true; refresh.disabled = true; error.textContent = "";
		try { scripts = (await api<{ verifiers: Script[] }>("/api/verifiers?manage=1")).verifiers; paint(); }
		catch (e) { error.textContent = `读取失败：${String(e)}`; } finally { loading = false; refresh.disabled = false; }
	}
	async function download(id: string) { try { const d = await api<Detail>(`/api/verifiers/${id}`); downloadScript(d.filename!, d.content); } catch (e) { error.textContent = String(e); } }
	async function open(id?: string, deleting = false) {
		let detail: Detail | undefined;
		try { if (id) detail = await api<Detail>(`/api/verifiers/${id}`); } catch (e) { error.textContent = String(e); return; }
		const body = node("div", "", "VerifierManager-editor"), problem = node("p", "", "Grading-error"); problem.setAttribute("role", "alert");
		const name = node("input", "", "form-control"), filename = node("input", "", "form-control"), code = node("textarea", "", "form-control");
		name.id = "manage-script-label"; filename.id = "manage-script-filename"; code.id = "manage-script-code"; code.spellcheck = false; code.rows = 16;
		name.value = detail?.label ?? ""; filename.value = detail?.filename ?? "verify.py"; code.value = detail?.content ?? "def verify(ctx):\n    return {\"verdict\": \"pass\", \"message\": \"验证通过\"}\n";
		const snapshot = () => JSON.stringify([name.value, filename.value, code.value]), baseline = snapshot();
		let busy = false, saved = false;
		const dirty = () => !deleting && !saved && baseline !== snapshot();
		const field = (title: string, control: HTMLInputElement | HTMLTextAreaElement) => { const g = node("div", "", "form-group"), label = node("label", title, "form-label"); label.htmlFor = control.id; g.append(label, control); return g; };
		const refs = node("div");
		function paintRefs() {
			refs.replaceChildren(node("p", `${detail?.references.length ?? 0} 个案例引用此脚本（含归档）。`, "form-hint"));
			const ul = node("ul", "", "Resource-list");
			for (const r of detail?.references ?? []) {
				const li = node("li", `${r.moduleName} / ${r.name}${r.archived ? "（已归档）" : ""} `);
				const edit = action(r.archived ? "恢复并编辑案例" : "编辑案例", () => { void (async () => {
					if (!canClose()) return; busy = true; edit.disabled = true;
					try { if (r.archived) { await api(`/api/modules/${r.moduleId}/unarchive`, { method: "POST", headers }); await api(`/api/cases/${r.id}/unarchive`, { method: "POST", headers }); }
						busy = false; saved = true; modal.close(); location.hash = `#/case/${r.id}?tab=grading`;
					} catch (e) { problem.textContent = String(e); } finally { busy = false; edit.disabled = false; }
				})(); }); li.append(edit); ul.append(li);
			} refs.append(ul);
		}
		paintRefs();
		if (deleting) body.append(node("p", `永久删除「${detail!.label}」？历史执行保存的脚本快照会保留。`), node("p", "仍被案例引用时不能删除。请先替换或移除这些案例中的规则，再刷新引用。", "form-hint"), refs);
		else {
			if (detail) body.append(scriptInfo(detail, "脚本信息"));
			const file = node("input", "", "form-control"); file.type = "file"; file.accept = ".py"; file.id = "manage-script-file";
			file.onchange = () => { void (async () => { const f = file.files?.[0]; if (!f || busy) return; busy = true; submit.disabled = true; problem.textContent = "";
				try { if (!f.name.endsWith(".py")) throw Error("请选择 .py 文件"); if (f.size > 1024 * 1024) throw Error("脚本不能超过 1 MiB"); code.value = new TextDecoder("utf-8", { fatal: true }).decode(await f.arrayBuffer()); filename.value = f.name; if (!name.value) name.value = f.name; }
				catch (e) { problem.textContent = `文件读取失败，请确认使用 UTF-8：${String(e)}`; } finally { busy = false; file.value = ""; submit.disabled = false; }
			})(); };
			body.append(node("p", "实现 def verify(ctx)。保存仅检查语法与入口，不执行脚本，不安装依赖。UTF-8 单文件，最多 1 MiB。", "form-hint"), field("显示名称", name), field("文件名（.py）", filename), field("选择 .py 文件替换源码（可选）", file), field("Python 源码", code), refs, node("p", "保存后，引用案例新提交的运行会使用新脚本；已提交任务和历史结果继续使用原快照。", "Verifier-warning"));
		}
		body.append(problem);
		const submit = action(deleting ? "永久删除脚本" : id ? "保存修改" : "上传脚本", () => { void (async () => {
			if (busy) return; busy = true; submit.disabled = true; submit.textContent = deleting ? "正在删除…" : "正在保存…"; problem.textContent = "";
			body.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input,textarea,button").forEach(c => { c.disabled = true; });
			try { const input = deleting ? { expectedToken: detail!.token } : { ...(id ? { expectedToken: detail!.token } : {}), label: name.value, filename: filename.value, content: code.value };
				await api(id ? `/api/verifiers/${id}` : "/api/verifiers", { method: deleting ? "DELETE" : id ? "PUT" : "POST", headers, body: JSON.stringify(input) });
				try { localStorage.setItem("eval-verifiers-changed", String(Date.now())); } catch { /* Focus refresh still works when browser storage is unavailable. */ }
				saved = true; busy = false; modal.close(); feedback.textContent = deleting ? "脚本已删除" : "脚本已保存，后续新运行使用此版本。"; feedback.hidden = false; void load();
			} catch (e) { problem.textContent = `${e instanceof Error ? e.message : String(e)}。未确认操作成功，编辑内容已保留，请核对后重试。`; }
			finally { busy = false; body.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input,textarea,button").forEach(c => { c.disabled = false; }); submit.disabled = deleting && !!detail?.references.length; submit.textContent = deleting ? "永久删除脚本" : id ? "保存修改" : "上传脚本"; }
		})(); }); submit.classList.toggle("btn-danger", deleting); submit.classList.toggle("btn-primary", !deleting); submit.disabled = deleting && !!detail?.references.length;
		const refreshRefs = action("刷新引用", () => { void (async () => { if (!id || busy) return; busy = true; refreshRefs.disabled = true;
			try { const current = await api<Detail>(`/api/verifiers/${id}`); if (current.token !== detail!.token) throw Error("脚本已被修改，请关闭并重新打开，避免覆盖他人的修改"); detail!.references = current.references; paintRefs(); submit.disabled = deleting && !!current.references.length; }
			catch (e) { problem.textContent = String(e); } finally { busy = false; refreshRefs.disabled = false; }
		})(); });
		function canClose() { return !busy && (!dirty() || window.confirm("脚本修改尚未保存，确定放弃修改吗？")); }
		const unload = (e: BeforeUnloadEvent) => { if (dirty() || busy) { e.preventDefault(); e.returnValue = ""; } };
		window.addEventListener("beforeunload", unload);
		const modal = verifierDialog(deleting ? "删除 Python 验证脚本" : id ? "编辑 Python 验证脚本" : "上传 Python 验证脚本", body, { wide: !deleting, footer: row(...(id ? [refreshRefs] : []), action("取消", () => modal.close()), submit), canClose, onClose: () => { leave = undefined; window.removeEventListener("beforeunload", unload); } });
		leave = () => { if (!canClose()) return false; saved = true; modal.close(); return true; };
	}
	search.oninput = paint;
	root.append(node("h1", "验证脚本", "page-title"), node("p", "管理验证脚本，查看案例引用。", "page-desc"), row(action("上传 Python 脚本", () => { void open(); }, true), refresh, search), error, feedback, status, registryNote, list);
	void load(); return root;
}
