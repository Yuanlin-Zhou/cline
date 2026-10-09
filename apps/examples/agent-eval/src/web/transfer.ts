import type { Module, SavedCase } from "./types.js";
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

export function planTransfer(request: TransferRequest, modules: Module[], cases: SavedCase[]): TransferPreview {
		const target = modules.find(module => module.id === request.targetModuleId);
		if (!target) throw new TransferError("目标模块不存在", 404);
		if (target.archived) throw new TransferError(`目标模块「${target.name}」已归档`);
		const names = new Set(cases.filter(c => !c.archived).filter(c => c.moduleId === target.id).map(c => c.definition.id));
		const items: TransferPreview["items"] = [];
		for (const input of request.items) {
			const source = cases.find(c => c.id === input.id);
			if (!source) throw new TransferError("源案例不存在", 404);
			const module = modules.find(module => module.id === source.moduleId);
			if (!module) throw new TransferError("源模块不存在", 404);
			if (source.archived || module.archived) throw new TransferError(`源案例「${source.definition.id}」或模块「${module.name}」已归档`);
			if (source.revision !== input.revision) throw new TransferError(`案例「${source.definition.id}」版本已变化，请重新选择并预览`);
			const unchanged = request.operation === "move" && source.moduleId === target.id;
			const base = source.definition.id;
			const sameModuleCopy = request.operation === "copy" && source.moduleId === target.id;
			const conflict = !unchanged && !sameModuleCopy && names.has(base);
			let proposed = base;
			if (sameModuleCopy || (conflict && request.conflictPolicy === "rename")) {
				let suffix = 1;
				while (names.has(`${base}-${request.operation}${suffix}`)) suffix++;
				proposed = `${base}-${request.operation}${suffix}`;
			}
			names.add(proposed);
			items.push({ id: source.id, revision: source.revision, originalDefinitionId: base, proposedDefinitionId: proposed, sourceModuleName: module.name, targetModuleName: target.name, result: unchanged ? "unchanged" : request.operation, conflict });
		}
		return { items, summary: { copied: items.filter(i => i.result === "copy").length, moved: items.filter(i => i.result === "move").length, unchanged: items.filter(i => i.result === "unchanged").length, conflicts: items.filter(i => i.conflict).length }, canApply: request.conflictPolicy === "rename" || !items.some(item => item.conflict) };
}
