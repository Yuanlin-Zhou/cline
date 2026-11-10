import { access } from "node:fs/promises";
import path from "node:path";
import type { RunDetail } from "../../contracts/catalog.js";
import {
	archivedArtifacts,
	archivedArtifactText,
	artifacts,
	artifactText,
} from "../execution/workspace.js";

/** Preserve archive lookup for both current workspaces and pre-archive runs. */
export async function runArtifacts(
	root: string,
	run: RunDetail,
	itemId: string | null,
	file: string | null,
) {
	const item = run.items.find((i) => i.id === itemId);
	if (!item?.workspace) throw Error("运行工作区尚未建立");
	const directory = path.join(root, "runs", run.id, item.id);
	let modern = !!item.result?.workspaceInfo;
	try {
		await access(path.join(directory, "workspace.json"));
		modern = true;
	} catch {}
	if (modern) {
		if (!item.result?.evidence) throw Error("运行尚未结束，产物归档后可查看");
		if (!item.result.evidence.complete)
			throw Error("产物归档不完整，不能可靠展示文件差异，请查看归档提示。");
		return file !== null
			? archivedArtifactText(directory, item.result.evidence, file)
			: archivedArtifacts(directory, item.result.evidence);
	}
	const legacy = path.dirname(item.workspace);
	return file !== null ? artifactText(legacy, file) : artifacts(legacy);
}
