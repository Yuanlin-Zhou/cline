import path from "node:path";
export function validateWorkspacePaths(
	definition: import("../../contracts/evaluation.js").EvalCase,
	defaults: import("../../contracts/evaluation.js").EvalDefaults,
) {
	const paths: Array<[string, string | undefined]> = [
		["工作区目录", definition.cwd],
		["默认工作区目录", defaults.cwd],
		[
			"副本保存根目录",
			definition.workspace?.mode === "copy"
				? definition.workspace.copyRoot
				: undefined,
		],
		[
			"默认副本保存根目录",
			defaults.workspace?.mode === "copy"
				? defaults.workspace.copyRoot
				: undefined,
		],
	];
	for (const [name, value] of paths)
		if (value && !path.isAbsolute(value))
			throw Error(`${name}须为服务端绝对路径`);
	if (
		definition.replayMode === "full-task" &&
		(definition.workspace ?? defaults.workspace)?.mode === "direct" &&
		!(definition.cwd ?? defaults.cwd)
	)
		throw Error("直接执行必须填写执行目录 cwd");
}
