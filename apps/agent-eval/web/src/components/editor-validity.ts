const errors = new Map<string, string>();
export function editorError(id: string, error?: string) {
	if (error) errors.set(id, error);
	else errors.delete(id);
}
export function assertValidEditors() {
	const error = errors.values().next().value;
	if (error) throw new Error(`请先修正表单错误：${error}`);
}
