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
export function rangeSelection(
	root: HTMLElement,
	ids: () => string[],
	selection: Set<string>,
	update: () => void,
) {
	let anchor: string | undefined,
		start: string | undefined,
		pointer: number | undefined;
	let checked = false,
		dragging = false,
		suppress = false,
		y0 = 0,
		x = 0,
		y = 0,
		frame = 0,
		signature = "";
	const box = (target: EventTarget | null) =>
		target instanceof Element
			? target.closest<HTMLInputElement>("input[data-selection-id]")
			: null;
	const sync = () => {
		for (const el of root.querySelectorAll<HTMLInputElement>(
			"input[data-selection-id]",
		))
			el.checked = selection.has(el.dataset.selectionId!);
		update();
	};
	const stop = () => {
		if (pointer !== undefined && root.hasPointerCapture(pointer))
			root.releasePointerCapture(pointer);
		pointer = undefined;
		start = undefined;
		dragging = false;
		cancelAnimationFrame(frame);
		root.classList.remove("selecting-cases");
	};
	const order = () => {
		const list = ids(),
			next = JSON.stringify(list);
		if (next !== signature) {
			anchor = undefined;
			stop();
			signature = next;
		}
		return list;
	};
	const hit = () => {
		const row = document
			.elementFromPoint(x, y)
			?.closest("[data-selection-row]");
		const el = row?.querySelector<HTMLInputElement>("input[data-selection-id]");
		if (start && el && root.contains(el)) {
			selectRange(ids(), selection, start, el.dataset.selectionId!, checked);
			sync();
		}
	};
	const scroll = () => {
		if (!dragging) return;
		let area: HTMLElement | null = root;
		while (
			area &&
			!(
				area.scrollHeight > area.clientHeight &&
				/(auto|scroll)/.test(getComputedStyle(area).overflowY)
			)
		)
			area = area.parentElement;
		const rect = area?.getBoundingClientRect();
		const delta =
			y < (rect?.top ?? 0) + 40
				? -14
				: y > (rect?.bottom ?? innerHeight) - 40
					? 14
					: 0;
		if (delta) {
			area ? area.scrollBy(0, delta) : window.scrollBy(0, delta);
			hit();
		}
		frame = requestAnimationFrame(scroll);
	};
	root.addEventListener("pointerdown", (e) => {
		if (e.pointerType !== "mouse" || e.button !== 0) return;
		const el = box(e.target);
		if (!el) return;
		order();
		start = el.dataset.selectionId;
		pointer = e.pointerId;
		checked = !selection.has(start!);
		y0 = e.clientY;
		x = e.clientX;
		y = e.clientY;
	});
	root.addEventListener("pointermove", (e) => {
		if (pointer !== e.pointerId || !start) return;
		x = e.clientX;
		y = e.clientY;
		if (!dragging && Math.abs(y - y0) > 4) {
			dragging = true;
			root.setPointerCapture(e.pointerId);
			root.classList.add("selecting-cases");
			anchor = start;
			checked ? selection.add(start) : selection.delete(start);
			sync();
			scroll();
		}
		if (dragging) {
			e.preventDefault();
			hit();
		}
	});
	root.addEventListener("pointerup", (e) => {
		if (pointer === e.pointerId) {
			if (dragging) {
				suppress = true;
				setTimeout(() => {
					suppress = false;
				}, 0);
			}
			stop();
		}
	});
	root.addEventListener(
		"click",
		(e) => {
			if (suppress) {
				e.preventDefault();
				e.stopImmediatePropagation();
				return;
			}
			const el = box(e.target);
			if (!el) return;
			const list = order(),
				id = el.dataset.selectionId!;
			if (e.shiftKey && anchor && list.includes(anchor)) {
				e.preventDefault();
				e.stopImmediatePropagation();
				selectRange(list, selection, anchor, id, !selection.has(id));
				sync();
				setTimeout(sync, 0);
			} else anchor = id;
		},
		true,
	);
	root.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			stop();
			return;
		}
		const el = box(e.target);
		if (e.key === " " && e.shiftKey && el) {
			const list = order();
			if (anchor) {
				e.preventDefault();
				selectRange(
					list,
					selection,
					anchor,
					el.dataset.selectionId!,
					!selection.has(el.dataset.selectionId!),
				);
				sync();
			}
		}
	});
	root.addEventListener("pointercancel", stop);
	window.addEventListener("blur", stop);
	const observer = new MutationObserver(() => {
		if (!root.isConnected) {
			stop();
			window.removeEventListener("blur", stop);
			observer.disconnect();
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	return {
		reset: () => {
			stop();
			anchor = undefined;
		},
		sync,
	};
}
