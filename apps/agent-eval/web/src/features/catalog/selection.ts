export function selectRange(
	ids: string[],
	selection: Set<string>,
	from: string,
	to: string,
	checked: boolean,
) {
	const a = ids.indexOf(from),
		b = ids.indexOf(to);
	if (a < 0 || b < 0) return;
	for (const id of ids.slice(Math.min(a, b), Math.max(a, b) + 1))
		checked ? selection.add(id) : selection.delete(id);
}
