/** Preserve existing strings verbatim; only newly entered names are trimmed. */
export class TagSelection {
	private selected: string[];
	constructor(initial: string[], readonly limit?: number) { this.selected = [...initial]; }
	read() { return [...this.selected]; }
	add(input: string) {
		const name = input.trim();
		if (!name) throw new Error("请输入标签名称。");
		if (this.selected.includes(name)) throw new Error("该标签已添加。");
		if (this.limit !== undefined && this.selected.length >= this.limit) throw new Error(`最多选择 ${this.limit} 个标签，请先移除其他标签。`);
		this.selected.push(name);
		return name;
	}
	select(name: string) {
		if (this.selected.includes(name)) return;
		if (this.limit !== undefined && this.selected.length >= this.limit) throw new Error(`最多选择 ${this.limit} 个标签，请先移除其他标签。`);
		this.selected.push(name);
	}
	remove(index: number) { this.selected.splice(index, 1); }
	unselect(name: string) { this.selected = this.selected.filter(tag => tag !== name); }
}

export function tagEditor(options: { id: string; initial?: string[]; candidates?: string[]; limit?: number; loadCandidates?: () => Promise<string[]> }) {
	const state = new TagSelection(options.initial ?? [], options.limit);
	const known = new Set([...(options.candidates ?? []), ...state.read()]);
	function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
		const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
	}
	function button(text: string, action: () => void) {
		const node = el("button", "btn btn-sm", text); node.type = "button"; node.onclick = action; return node;
	}
	const root = el("div", "TagEditor"); root.id = options.id; root.setAttribute("role", "group"); root.setAttribute("aria-label", "标签");
	const chips = el("div", "TagEditor-chips");
	const message = el("div", "TagEditor-message"); message.setAttribute("aria-live", "polite");
	const status = el("div", "form-hint"); status.setAttribute("aria-live", "polite");
	const addPanel = el("div", "TagEditor-panel"); addPanel.id = `${options.id}-add`; addPanel.hidden = true;
	const choosePanel = el("div", "TagEditor-panel"); choosePanel.id = `${options.id}-choose`; choosePanel.hidden = true;
	const name = el("input", "form-control"); name.placeholder = "输入标签名称"; name.setAttribute("aria-label", "新标签名称");
	const search = el("input", "form-control"); search.type = "search"; search.placeholder = "搜索已有标签"; search.setAttribute("aria-label", "搜索已有标签");
	const choices = el("div", "TagEditor-choices");
	const add = button("＋ 新增标签", () => { switchPanel("add"); name.focus(); });
	const choose = button("选择已有标签", () => { switchPanel("choose"); search.focus(); });
	add.setAttribute("aria-controls", addPanel.id); choose.setAttribute("aria-controls", choosePanel.id);
	function switchPanel(panel?: "add" | "choose") {
		addPanel.hidden = panel !== "add"; choosePanel.hidden = panel !== "choose";
		add.setAttribute("aria-expanded", String(panel === "add")); choose.setAttribute("aria-expanded", String(panel === "choose"));
		message.textContent = "";
	}
	function changed() { renderChips(); renderChoices(); root.dispatchEvent(new Event("change", { bubbles: true })); }
	function renderChips() {
		chips.replaceChildren();
		const tags = state.read();
		if (!tags.length) chips.append(el("span", "muted small", "尚未添加标签"));
		tags.forEach((tag, index) => {
			const chip = el("span", "TagEditor-chip");
			const remove = button("×", () => {
				state.remove(index); message.textContent = ""; changed();
				const buttons = chips.querySelectorAll<HTMLButtonElement>("button");
				(buttons[Math.min(index, buttons.length - 1)] ?? add).focus();
			});
			remove.className = "TagEditor-remove"; remove.setAttribute("aria-label", `移除标签 ${tag}`);
			chip.append(el("span", "TagEditor-name", tag), remove); chips.append(chip);
		});
	}
	function renderChoices() {
		const focused = document.activeElement as HTMLInputElement | null;
		const focusTag = choices.contains(focused) ? focused?.value : undefined;
		choices.replaceChildren();
		const query = search.value.trim().toLocaleLowerCase();
		const all = [...new Set([...known, ...state.read()])].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"));
		const matches = all.filter(tag => tag.toLocaleLowerCase().includes(query));
		if (!matches.length) choices.append(el("p", "muted small", all.length ? "没有匹配的标签。" : "暂无已有标签，点击新增标签创建。"));
		for (const tag of matches) {
			const label = el("label", "TagEditor-option");
			const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.value = tag; checkbox.checked = state.read().includes(tag);
			checkbox.onchange = () => {
				try { if (checkbox.checked) state.select(tag); else state.unselect(tag); message.textContent = ""; changed(); }
				catch (error) { checkbox.checked = false; message.textContent = (error as Error).message; }
			};
			label.append(checkbox, el("span", "TagEditor-name", tag)); choices.append(label);
			if (tag === focusTag) checkbox.focus();
		}
	}
	function addName() {
		try { const tag = state.add(name.value); known.add(tag); name.value = ""; message.textContent = ""; changed(); }
		catch (error) { message.textContent = (error as Error).message; }
		name.focus();
	}
	name.onkeydown = event => {
		if (event.isComposing) return;
		if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); addName(); }
		if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); name.value = ""; switchPanel(); add.focus(); }
	};
	choosePanel.onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); switchPanel(); choose.focus(); } };
	search.oninput = renderChoices;
	addPanel.append(name, button("添加", addName), button("取消新增", () => { name.value = ""; switchPanel(); add.focus(); }));
	choosePanel.append(search, choices, button("完成选择", () => { switchPanel(); choose.focus(); }));
	const toolbar = el("div", "TagEditor-toolbar"); toolbar.append(add, choose);
	const retry = button("重试加载标签", () => { void load(); }); retry.hidden = true;
	let loading = false;
	async function load() {
		if (!options.loadCandidates || loading) return;
		loading = true; retry.hidden = true; status.textContent = "正在加载已有标签…";
		try {
			const tags = await options.loadCandidates(); for (const tag of tags) known.add(tag);
			status.textContent = ""; renderChoices();
		} catch { status.textContent = "已有标签加载失败，可重试；仍可新增标签并保存。"; retry.hidden = false; }
		finally { loading = false; }
	}
	root.append(chips, toolbar, addPanel, choosePanel, message, status, retry);
	switchPanel(); renderChips(); renderChoices(); void load();
	return { element: root, read: () => state.read() };
}
