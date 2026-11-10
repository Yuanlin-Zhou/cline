import { expect, test } from "bun:test";
import { selectRange } from "../../../web/src/features/catalog/selection.js";
test("visible ordered ranges select or clear both directions while preserving hidden selection", () => {
	const selection = new Set(["hidden", "c"]),
		order = ["d", "a", "c", "b"];
	selectRange(order, selection, "b", "a", true);
	expect([...selection].sort()).toEqual(["hidden", "a", "b", "c"].sort());
	selectRange(order, selection, "a", "c", false);
	expect([...selection].sort()).toEqual(["hidden", "b"].sort());
	selectRange(order, selection, "removed", "d", true);
	expect([...selection].sort()).toEqual(["hidden", "b"].sort());
});
