export class TransferError extends Error {
	constructor(message: string, readonly status = 409) { super(message); }
}
export type TransferRequest = {
	operation: "copy" | "move";
	targetModuleId: string;
	conflictPolicy: "rename" | "abort";
	items: Array<{ id: string; revision: number; expectedDefinitionId?: string }>;
};
export type TransferPreview = {
	canApply: boolean;
	summary: { copied: number; moved: number; unchanged: number; conflicts: number };
	items: Array<{ id: string; revision: number; originalDefinitionId: string; proposedDefinitionId: string; sourceModuleName: string; targetModuleName: string; result: "copy" | "move" | "unchanged"; conflict: boolean }>;
};
export function parseTransfer(input: unknown, apply = false): TransferRequest {
	const b = input as TransferRequest;
	if (!b || !["copy", "move"].includes(b.operation) || !["rename", "abort"].includes(b.conflictPolicy) || typeof b.targetModuleId !== "string" || !b.targetModuleId || !Array.isArray(b.items) || !b.items.length || b.items.length > 1000) throw new TransferError("请选择有效操作、目标模块和 1–1000 个案例", 400);
	const seen = new Set<string>();
	for (const item of b.items) {
		if (!item || typeof item.id !== "string" || !item.id || !Number.isInteger(item.revision) || item.revision < 1 || (apply && (typeof item.expectedDefinitionId !== "string" || !item.expectedDefinitionId))) throw new TransferError("案例参数无效", 400);
		if (seen.has(item.id)) throw new TransferError("不能重复选择案例", 400);
		seen.add(item.id);
	}
	return b;
}
