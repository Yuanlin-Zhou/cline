export type WorkspaceConfig =
	| { mode: "copy"; copyRoot?: string }
	| { mode: "direct" };
export function parseWorkspace(
	value: unknown,
	at = "workspace",
): WorkspaceConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error(`${at} 须为对象`);
	const v = value as Record<string, unknown>;
	if (!["copy", "direct"].includes(String(v.mode)))
		throw Error(`${at}.mode 须为 copy 或 direct`);
	if (Object.keys(v).some((k) => !["mode", "copyRoot"].includes(k)))
		throw Error(`${at} 包含未知字段`);
	if (
		v.copyRoot !== undefined &&
		(v.mode !== "copy" || typeof v.copyRoot !== "string" || !v.copyRoot.trim())
	)
		throw Error(`${at}.copyRoot 仅复制方式可填写非空目录`);
	return v.mode === "direct"
		? { mode: "direct" }
		: {
				mode: "copy",
				...(v.copyRoot !== undefined ? { copyRoot: v.copyRoot as string } : {}),
			};
}
export type WorkspaceInfo = {
	mode: "copy" | "direct";
	source?: string;
	path: string;
	directory: string;
};
