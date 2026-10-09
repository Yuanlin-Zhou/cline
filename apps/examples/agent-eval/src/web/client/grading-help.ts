export type ValueType = "text" | "number" | "boolean" | "null" | "json";
export function valueType(value: unknown): ValueType {
	return value === null ? "null" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "object" ? "json" : "text";
}
export function readExpected(type: string, text: string): unknown {
	if (type === "text") return text;
	if (type === "null") return null;
	if (type === "boolean") { if (!["true", "false"].includes(text)) throw new Error("请选择是（true）或否（false）。"); return text === "true"; }
	if (type === "number") {
		if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text.trim()) || !Number.isFinite(Number(text))) throw new Error("请填写数字，例如 12 或 0.3333，不要加引号。");
		return Number(text);
	}
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error('请填写合法的数组或对象，例如 [1, 2] 或 {"name":"Bun"}。'); }
	if (value === null || typeof value !== "object") throw new Error("这里仅填写数组或对象；普通文字、数字请切换值的类型。");
	return value;
}

type Guide = { title: string; purpose: string; sample: Record<string, unknown>; example: string };
export const guides: Record<string, Guide> = {
	"file.exists": { title: "生成了指定文件", purpose: "确认交付文件存在；存在不代表内容正确，可再添加内容或 JSON 检查。", sample: { path: "reports/summary.json" }, example: "文件路径：reports/summary.json。通过：运行结束时该普通文件存在；不通过：文件不存在。目录不算文件。" },
	"file.absent": { title: "没有留下指定文件", purpose: "禁止临时文件或额外产物；只检查填写的这个路径。", sample: { path: "debug.log" }, example: "文件路径：debug.log。通过：运行结束时没有该文件；不通过：留下了 debug.log。" },
	"file.unchanged": { title: "原有文件没有被修改", purpose: "保护配置或输入文件。请先在初始工作区准备该文件，再检查运行前后内容是否一致。", sample: { path: "config.json" }, example: "文件路径：config.json。通过：运行前后都存在，内容完全一致；不通过：被修改、删除或运行后才新增。" },
	"file.text": { title: "文件内容符合要求", purpose: "检查 UTF-8 文件内容，区分大小写，不自动去除空白；文件缺失也不通过。要检查 Agent 最终回复，请使用上方文本断言。", sample: { path: "README.md", op: "contains", expected: "Bun" }, example: "文件路径：README.md；判断方式：包含；期望文本：Bun。通过：使用 Bun 安装；不通过：使用 npm 安装。" },
	"file.json": { title: "JSON 中的数据符合要求", purpose: "检查 JSON 文件里的字段、统计值或数组成员。数字 12 与文字“12”是不同的值。", sample: { path: "summary.json", pointer: "/total", op: "equals", expected: 12 }, example: '文件路径：summary.json；要检查的字段：/total；判断方式：等于；值的类型：数字；预期值：12。通过：{"total":12}；不通过：{"total":"12"} 或 {"total":10}。' },
	command: { title: "运行已配置的验收程序（高级）", purpose: "运行维护者注册的验收程序，并检查退出码。这里不能填写 shell 命令或脚本路径。", sample: { verifierId: "", expectedExitCode: 0 }, example: "从列表选择真实的验收程序，期望退出码填 0（通常表示正常结束）。通过：退出码为 0；不通过：退出码为 1；超时属于验证错误。" },
	script: { title: "使用验证脚本（可上传）", purpose: "适合内置规则无法表达的业务检查，可自行上传脚本返回判定结果，无需管理员注册或重启。", sample: { verifierId: "" }, example: "从列表选择已有验证脚本，或上传 .js / .mjs / .ts 文件。通过：脚本正常返回约定格式且 verdict=pass；不通过：verdict=fail。脚本异常或格式错误属于验证错误，退出码 0 本身不代表通过。" },
	"tool.count": { title: "工具调用次数", purpose: "按工具名和阶段检查次数，例如至少调用一次 read_files。当前无法验证真实行为，仅可作为诊断配置。", sample: { match: { name: "read_files", phase: "started" }, min: 1 }, example: "min 为最少次数，max 为最多次数；max: 0 表示禁止调用。当前执行只会显示证据不足。" },
	"tool.parameters": { title: "工具参数", purpose: "检查匹配调用的参数值。当前无法验证真实行为，仅可作为诊断配置。", sample: { match: { name: "read_files", phase: "started" }, check: { pointer: "/path", op: "equals", expected: "input.json" } }, example: "示例要求 read_files 的 path 参数等于 input.json。当前执行只会显示证据不足。" },
	"tool.order": { title: "工具先后顺序", purpose: "要求前一个工具成功完成后，再开始后一个工具。当前无法验证真实行为。", sample: { before: { name: "read_files", phase: "completed" }, after: { name: "apply_patch", phase: "started" } }, example: "示例要求先成功读取文件，再开始修改。当前执行只会显示证据不足。" },
	"tool.approval": { title: "批准后执行", purpose: "检查工具执行前是否收到批准。当前无法验证真实审批事件。", sample: { match: { name: "apply_patch", phase: "started" } }, example: "示例检查 apply_patch 开始执行前已获批准。当前执行只会显示证据不足。" },
};

export const comparisons: Record<string, { label: string; help: string; sample: unknown; pass: string; fail: string }> = {
	equals: { label: "等于", help: "值和类型都必须相同。数组顺序必须相同，对象按完整值比较。", sample: 12, pass: '数字 12', fail: '文字“12”或数字 10' },
	exists: { label: "字段存在", help: "只检查字段是否存在，无需预期值；null、0、false 也算存在。", sample: undefined, pass: '{"total":null} 中的 /total', fail: '{} 中的 /total' },
	contains: { label: "包含", help: "字符串检查子串；数组检查一个完整成员，不检查数组子集或对象的部分字段。", sample: "Bun", pass: '“使用 Bun 安装”或数组 ["Bun","Node"]', fail: '“使用 npm 安装”或数组 ["bun"]' },
	notContains: { label: "不包含", help: "文本不能出现指定内容；区分大小写。文件缺失也不通过。", sample: "npm", pass: "使用 Bun 安装", fail: "使用 npm 安装" },
	matches: { label: "正则匹配", help: "直接填表达式，不加 / 包裹或标志位。默认区分大小写，^ 和 $ 表示整段匹配；JSON 字段必须是文字。", sample: "^v[0-9]+$", pass: "v12", fail: "version12" },
	approx: { label: "数值近似", help: "用于小数误差。至少填一种允许误差；两种都填时，取允许偏差较大的那个。", sample: 0.3333, pass: "0.3334（绝对误差设为 0.001）", fail: "0.34（绝对误差设为 0.001）" },
};

export function condition(rule: Record<string, unknown>): string {
	const path = String(rule.path ?? "");
	if (rule.kind === "file.exists") return `${path} 在运行结束时存在（仅检查普通文件）。`;
	if (rule.kind === "file.absent") return `${path} 在运行结束时不存在。`;
	if (rule.kind === "file.unchanged") return `${path} 在运行前后均存在，且内容完全一致。`;
	if (rule.kind === "command") return `所选验收程序的退出码等于 ${rule.expectedExitCode}。`;
	if (rule.kind === "script") return "所选脚本正常返回有效的判定结果，且 verdict 为 pass。";
	if (String(rule.kind).startsWith("tool.")) return "当前无法验证真实行为；可选规则显示证据不足，必要规则会阻止运行。";
	const target = rule.kind === "file.json" ? `${path} 能解析为 JSON，且${rule.pointer ? `字段 ${rule.pointer}` : "整个 JSON"}` : `${path} 是 UTF-8 文件，且其内容`;
	if (rule.op === "exists") return `${target} 存在（值可以为 null）。`;
	if (rule.op === "approx") return `${target} 是数字，与 ${rule.expected} 的偏差不超过 ${Math.max(Number(rule.absTolerance ?? 0), Number(rule.relTolerance ?? 0) * Math.abs(Number(rule.expected)))}。`;
	const type = rule.kind === "file.json" ? ({ text: "文字", number: "数字", boolean: "布尔值", null: "空值", json: "数组/对象" }[valueType(rule.expected)]) : "";
	return `${target} ${comparisons[String(rule.op)]?.label ?? rule.op} ${type ? `${type} ` : ""}${JSON.stringify(rule.expected)}。`;
}
