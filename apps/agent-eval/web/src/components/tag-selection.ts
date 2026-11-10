/** Preserve existing strings verbatim; only newly entered names are trimmed. */
export class TagSelection {
	private selected: string[];
	constructor(
		initial: string[],
		readonly limit?: number,
	) {
		this.selected = [...initial];
	}
	read() {
		return [...this.selected];
	}
	add(input: string) {
		const name = input.trim();
		if (!name) throw new Error("请输入标签名称。");
		if (this.selected.includes(name)) throw new Error("该标签已添加。");
		if (this.limit !== undefined && this.selected.length >= this.limit)
			throw new Error(`最多选择 ${this.limit} 个标签，请先移除其他标签。`);
		this.selected.push(name);
		return name;
	}
	select(name: string) {
		if (this.selected.includes(name)) return;
		if (this.limit !== undefined && this.selected.length >= this.limit)
			throw new Error(`最多选择 ${this.limit} 个标签，请先移除其他标签。`);
		this.selected.push(name);
	}
	remove(index: number) {
		this.selected.splice(index, 1);
	}
	unselect(name: string) {
		this.selected = this.selected.filter((tag) => tag !== name);
	}
}
