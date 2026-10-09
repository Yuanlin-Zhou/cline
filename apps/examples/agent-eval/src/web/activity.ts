export type Activity = {
	type: "session" | "iteration" | "text" | "reasoning" | "tool.request" | "tool.result" | "tool.update" | "done" | "error" | "phase";
	at: string; iteration?: number; toolName?: string;
};
export type ExecutionUpdate = {
	activity?: Activity; sessionId?: string; workspace?: string; phase?: "executing" | "verifying";
};

// These are observed SDK notifications, not proof of an actual tool execution.
export function observedActivity(event: unknown): Activity | undefined {
	if (!event || typeof event !== "object") return;
	const e = event as Record<string, unknown>;
	let type: Activity["type"] | undefined;
	if (e.type === "iteration_start") type = "iteration";
	else if (e.type === "done" || e.type === "error") type = e.type;
	else if (e.type === "content_start" && (e.contentType === "text" || e.contentType === "reasoning")) type = e.contentType;
	else if (e.contentType === "tool") type = e.type === "content_start" ? "tool.request" : e.type === "content_end" ? "tool.result" : e.type === "content_update" ? "tool.update" : undefined;
	if (!type) return;
	return { type, at: new Date().toISOString(), ...(typeof e.iteration === "number" ? { iteration: e.iteration } : {}), ...(typeof e.toolName === "string" ? { toolName: e.toolName.slice(0, 200) } : {}) };
}

export function activityLabel(activity: Activity): string {
	const tool = activity.toolName ? `：${activity.toolName}` : "";
	switch (activity.type) {
		case "session": return "会话已建立";
		case "iteration": return `开始第 ${activity.iteration ?? "?"} 次迭代`;
		case "text": return "收到模型文本";
		case "reasoning": return "收到模型推理活动";
		case "tool.request": return `收到工具请求${tool}`;
		case "tool.result": return `收到工具结果${tool}`;
		case "tool.update": return `收到工具更新${tool}`;
		case "done": return "模型执行结束";
		case "error": return "收到模型执行错误";
		case "phase": return "进入验证阶段";
	}
}
