import { type APIRequestContext, expect, test } from "@playwright/test";

const port = Number(process.env.EVAL_BROWSER_PORT ?? 3310);
const defaults = {
	providerId: "openai-compatible",
	modelId: "ui-test",
	baseUrl: `http://127.0.0.1:${port + 1}/v1`,
	apiKeyEnv: "EVAL_BROWSER_KEY",
	tools: "none",
	maxIterations: 3,
	timeoutMs: 30000,
};
async function send(
	request: APIRequestContext,
	url: string,
	data: unknown,
	method = "POST",
) {
	const response = await request.fetch(url, { method, data });
	expect(response.ok(), await response.text()).toBeTruthy();
	return response.json();
}
async function seed(request: APIRequestContext, name: string) {
	await send(request, "/api/settings", defaults, "PUT");
	const module = await send(request, "/api/modules", {
		name,
		tags: ["含,逗号的标签"],
	});
	const item = await send(request, "/api/cases", {
		moduleId: module.id,
		defaults,
		definition: {
			id: `${name}-案例`,
			prompt: "Use Bun",
			history: [],
			replayMode: "single-turn",
			tags: ["含,逗号的标签"],
			assertions: { contains: ["Bun"] },
		},
	});
	return { module, item };
}

test("React drafts, native history conversion, JSON errors and real function-call execution", async ({
	page,
	request,
}, testInfo) => {
	const { module, item } = await seed(request, "组件迁移验收");
	const errors: string[] = [],
		requests: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("request", (r) => requests.push(r.url()));
	await page.goto(`/#/case/${item.id}`);
	await expect(
		page.getByRole("heading", { name: item.definition.id, exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/cases/${item.id}`)).json()).revision,
		)
		.toBe(2);
	expect(
		(await (await request.get(`/api/cases/${item.id}`)).json()).definition.tags,
	).toEqual(["含,逗号的标签"]);
	await page
		.getByRole("button", { name: "单轮函数调用", exact: false })
		.first()
		.click();
	await page.getByText("粘贴 JSON 导入历史", { exact: true }).click();
	await page.getByLabel("原始对话 JSON", { exact: true }).fill(
		JSON.stringify({
			messages: [
				{ role: "system", content: "instructions" },
				{ role: "user", content: "old question" },
				{ role: "assistant", content: "old context" },
				{ role: "user", content: "CURRENT_INPUT" },
			],
		}),
	);
	await page.getByRole("button", { name: "解析预览", exact: true }).click();
	await page.getByRole("button", { name: "导入到草稿", exact: true }).click();
	await expect(page.getByLabel("本轮输入", { exact: true })).toHaveValue(
		"CURRENT_INPUT",
	);
	await page.getByRole("tab", { name: "配置", exact: true }).click();
	await page.getByRole("tab", { name: "输入", exact: true }).click();
	await expect(page.getByLabel("本轮输入", { exact: true })).toHaveValue(
		"CURRENT_INPUT",
	);
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/cases/${item.id}`)).json()).definition
					.replayMode,
		)
		.toBe("function-call");
	const saved = await (await request.get(`/api/cases/${item.id}`)).json();
	expect(saved.definition.functionCall.history).toHaveLength(3);
	await page
		.getByLabel("原生 Function Call 历史", { exact: true })
		.fill("{invalid");
	await page.getByRole("tab", { name: "配置", exact: true }).click();
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "请先修正表单错误" }),
	).toHaveCount(1);
	expect(
		(await (await request.get(`/api/cases/${item.id}`)).json()).revision,
	).toBe(saved.revision);
	await page.getByRole("tab", { name: "输入", exact: true }).click();
	await page
		.getByLabel("原生 Function Call 历史", { exact: true })
		.fill(JSON.stringify(saved.definition.functionCall.history));
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await page.setViewportSize({ width: 1280, height: 900 });
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("case-desktop-1280.png"),
		fullPage: true,
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page
		.getByRole("button", { name: "运行单轮函数调用", exact: true })
		.click();
	await page.getByRole("link", { name: "查看评测", exact: true }).click();
	await expect(page.getByText("已完成", { exact: true })).toBeVisible({
		timeout: 60000,
	});
	await expect(
		page.getByRole("region", { name: "案例结果列表", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("原始函数调用响应", { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "查看详情", exact: true })
		.first()
		.click();
	await expect(
		page.getByText("原始函数调用响应", { exact: true }),
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("result-desktop.png"),
		fullPage: true,
	});
	expect(requests.some((url) => url.includes("/api/state"))).toBe(false);
	expect(errors).toEqual([]);
});

test("import preview, copy configuration, conflict handling and uploaded verifier editing", async ({
	page,
	request,
}) => {
	const { module, item } = await seed(request, "资源交互验收");
	const target = await send(request, "/api/modules", { name: "复制目标模块" });
	await page.goto(`/#/cases/${module.id}`);
	await page
		.getByRole("checkbox", { name: `选择 ${item.definition.id}`, exact: true })
		.check();
	await page.getByRole("button", { name: "复制所选", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("目标模块", { exact: true }).click();
	await page.getByRole("option", { name: "复制目标模块", exact: true }).click();
	await dialog.getByRole("button", { name: "预览", exact: true }).click();
	await dialog.getByRole("button", { name: "确认复制", exact: true }).click();
	await expect(dialog).toBeHidden();
	const copied = (
		await (await request.get(`/api/cases?moduleId=${target.id}`)).json()
	).cases;
	expect(copied).toHaveLength(1);
	const full = await (await request.get(`/api/cases/${copied[0].id}`)).json();
	expect(full.defaults).toEqual(item.defaults);
	await page.getByRole("link", { name: "导入案例", exact: true }).click();
	await page.getByLabel("粘贴案例集内容", { exact: true }).fill("{bad");
	await page.getByRole("button", { name: "预览并校验", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(1);
	await page.getByLabel("粘贴案例集内容", { exact: true }).fill(
		JSON.stringify({
			cases: [{ id: "导入验收案例", prompt: "Use Bun", history: [] }],
		}),
	);
	await page.getByRole("button", { name: "预览并校验", exact: true }).click();
	await page.getByRole("button", { name: "确认导入", exact: true }).click();
	await expect(
		page.getByRole("link", { name: "导入验收案例", exact: true }),
	).toBeVisible();
	await page.goto(`/#/case/${item.id}`);
	await page
		.getByLabel("本轮输入", { exact: true })
		.fill("local unsaved input");
	await send(
		request,
		`/api/cases/${item.id}`,
		{
			revision: item.revision,
			defaults: item.defaults,
			definition: { ...item.definition, prompt: "remote saved input" },
		},
		"PUT",
	);
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "案例已被其他页面修改" }),
	).toHaveCount(1);
	await expect(page.getByLabel("本轮输入", { exact: true })).toHaveValue(
		"local unsaved input",
	);
	page.on("dialog", (d) => d.accept());
	await page.getByRole("link", { name: "验证脚本", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByRole("button", { name: "上传 .py", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByLabel("脚本名称", { exact: true })
		.fill("浏览器验证器");
	await page.getByRole("button", { name: "上传脚本", exact: true }).click();
	await page.getByRole("button", { name: "浏览器验证器", exact: true }).click();
	await expect(page.getByLabel("Python 源码", { exact: true })).toHaveValue(
		/def verify\(ctx\)/,
	);
});

test("failed list requests retry cleanly without duplicate alerts", async ({
	page,
	request,
}) => {
	const { module, item } = await seed(request, "失败恢复验收");
	let fail = true;
	await page.route(`**/api/cases?moduleId=${module.id}`, (route) =>
		fail
			? route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ error: "模拟服务不可用" }),
				})
			: route.continue(),
	);
	await page.goto(`/#/cases/${module.id}`);
	await expect(
		page.getByRole("alert").filter({ hasText: "模拟服务不可用" }),
	).toHaveCount(1);
	fail = false;
	await page.getByRole("button", { name: "重试加载", exact: true }).click();
	await expect(
		page.getByRole("link", { name: item.definition.id, exact: true }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("run wizard, in-run retry and historical verifier/Judge trials retain their execution identities", async ({
	page,
	request,
}) => {
	const { module, item } = await seed(request, "执行和验收交互");
	await page.goto(`/#/cases/${module.id}`);
	await page
		.getByRole("checkbox", { name: `选择 ${item.definition.id}`, exact: true })
		.check();
	await page.getByRole("button", { name: "评测所选案例", exact: true }).click();
	await page.getByRole("button", { name: "下一步", exact: true }).click();
	await page.getByRole("button", { name: "下一步", exact: true }).click();
	await page.getByRole("button", { name: "开始评测", exact: true }).click();
	await expect(page.getByText("已完成", { exact: true })).toBeVisible({
		timeout: 60000,
	});
	const _runId = page.url().split("/run/")[1];
	const _script = await send(request, "/api/verifiers", {
		filename: "browser_trial.py",
		label: "历史验收脚本",
		content:
			'def verify(ctx):\n    print("browser trial log")\n    return {"verdict":"pass","message":"browser verified"}\n',
	});
	await page
		.getByRole("button", { name: "查看详情", exact: true })
		.first()
		.click();
	await page.getByRole("tab", { name: "试验证 / 试评分", exact: true }).click();
	const before = (
		await (await request.get(`http://127.0.0.1:${port + 1}/requests`)).json()
	).length;
	await page.getByLabel("Python 验证脚本", { exact: true }).click();
	await page.getByRole("option", { name: "历史验收脚本", exact: true }).click();
	await page.getByRole("button", { name: "开始试验证", exact: true }).click();
	await expect(
		page.getByText("状态：completed", { exact: true }),
	).toBeVisible();
	await expect(page.getByText(/browser verified/).first()).toBeVisible();
	expect(
		(await (await request.get(`http://127.0.0.1:${port + 1}/requests`)).json())
			.length,
	).toBe(before);
	await page.getByRole("button", { name: /关闭|Close/, exact: true }).click();
	await page
		.getByRole("button", { name: "查看详情", exact: true })
		.first()
		.click();
	await page.getByRole("tab", { name: "试验证 / 试评分", exact: true }).click();
	await expect(
		page.getByText("状态：completed", { exact: true }),
	).toBeVisible();
	await page.getByLabel("参考答案", { exact: true }).fill("Use Bun");
	await page
		.getByRole("checkbox", { name: "独立配置评审模型", exact: true })
		.check();
	await page.getByLabel("Judge 模型", { exact: true }).fill("ui-judge");
	await page
		.getByLabel("Judge Base URL", { exact: true })
		.fill(`http://127.0.0.1:${port + 1}/v1`);
	await page
		.getByLabel("Judge 密钥环境变量名", { exact: true })
		.fill("EVAL_BROWSER_KEY");
	await page.getByRole("button", { name: "预览评分输入", exact: true }).click();
	await page.getByRole("button", { name: "确认试评分", exact: true }).click();
	await expect(
		page.getByText("试评分状态：completed", { exact: true }),
	).toBeVisible({ timeout: 30000 });
	await expect(page.getByText(/符合参考答案/).first()).toBeVisible();
	await page.getByRole("button", { name: /关闭|Close/, exact: true }).click();
	const failed = await send(request, "/api/cases", {
		moduleId: module.id,
		defaults,
		definition: {
			...item.definition,
			id: "需要重试的案例",
			assertions: { contains: ["UNREACHABLE_EXPECTATION"] },
		},
	});
	const failureRun = await send(request, "/api/runs", { caseIds: [failed.id] });
	await page.goto(`/#/run/${failureRun.id}`);
	await expect(page.getByText("已完成", { exact: true })).toBeVisible({
		timeout: 60000,
	});
	await page
		.getByRole("button", { name: "重试未通过案例", exact: true })
		.click();
	await page.getByRole("button", { name: "确认重试", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(page.getByText("已完成", { exact: true })).toBeVisible({
		timeout: 60000,
	});
	expect(page.url()).toContain(failureRun.id);
	const detail = await (await request.get(`/api/runs/${failureRun.id}`)).json();
	expect(detail.items).toHaveLength(2);
	expect(detail.items[1].rootItemId).toBe(detail.items[0].id);
	expect(detail.items[1].snapshot).toEqual(detail.items[0].snapshot);
});

test("stable selections survive filtering, dragging and module archive/restore", async ({
	page,
	request,
}) => {
	const { module, item } = await seed(request, "稳定选择验收");
	const extra = [];
	for (const name of ["中间案例", "末尾案例"])
		extra.push(
			await send(request, "/api/cases", {
				moduleId: module.id,
				defaults,
				definition: { ...item.definition, id: name },
			}),
		);
	await page.goto(`/#/cases/${module.id}`);
	const boxes = () => page.getByRole("checkbox", { name: /^选择 / });
	await expect(boxes()).toHaveCount(3);
	await boxes().nth(0).click();
	await boxes()
		.nth(2)
		.click({ modifiers: ["Shift"] });
	await expect(
		page.getByText("已选 3 个（隐藏 0 个）", { exact: true }),
	).toBeVisible();
	await page.getByLabel("搜索案例", { exact: true }).fill("中间案例");
	await expect(
		page.getByText("已选 3 个（隐藏 2 个）", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "反选筛选结果", exact: true }).click();
	await expect(
		page.getByText("已选 2 个（隐藏 2 个）", { exact: true }),
	).toBeVisible();
	await page.getByLabel("搜索案例", { exact: true }).fill("");
	await page.getByRole("button", { name: "清空选择", exact: true }).click();
	const first = await boxes().nth(0).boundingBox();
	const last = await boxes().nth(2).boundingBox();
	if (!first || !last) throw Error("Selection controls missing");
	await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
	await page.mouse.down();
	await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, {
		steps: 20,
	});
	await page.mouse.up();
	await expect(boxes().nth(1)).toBeChecked();
	await expect(boxes().nth(2)).toBeChecked();
	await page.getByRole("button", { name: "清空选择", exact: true }).click();
	page.on("dialog", (d) => d.accept());
	const card = page.locator(".CaseCatalog .module-entry").filter({
		has: page.locator(`a[href="#/cases/${module.id}"]`),
	});
	await card.getByRole("button", { name: "归档", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "确认", exact: true })
		.click();
	await expect(card).toHaveCount(0);
	await page.getByRole("button", { name: "已归档模块", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "恢复模块", exact: true })
		.click();
	await page.getByRole("button", { name: /关闭|Close/, exact: true }).click();
	await expect(card).toHaveCount(1);
	await page.reload();
	await expect(
		page.getByRole("heading", { name: module.name, exact: true }),
	).toBeVisible();
});

test("evaluation workbench selects results inline and keeps filters and attempt history usable", async ({
	page,
	request,
}) => {
	const { module, item } = await seed(request, "工作台恢复验收");
	const failure = await send(request, "/api/cases", {
		moduleId: module.id,
		defaults,
		definition: {
			...item.definition,
			id: "回复检查失败",
			assertions: { contains: ["UNREACHABLE_EXPECTATION"] },
		},
	});
	const run = await send(request, "/api/runs", {
		caseIds: [item.id, failure.id],
		concurrency: 2,
		name: "工作台恢复",
	});
	await page.goto(`/#/run/${run.id}`);
	await expect(page.getByText("已完成", { exact: true })).toBeVisible({
		timeout: 60000,
	});
	const list = page.getByRole("region", { name: "案例结果列表", exact: true });
	const inspector = page.getByRole("region", {
		name: "选中案例详情",
		exact: true,
	});
	await expect(list.getByRole("button")).toHaveCount(2);
	await expect(inspector.getByText("最终回复", { exact: true })).toBeVisible();
	await expect(
		inspector.getByText("Use Bun. 已完成验证。", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByLabel("按执行结果筛选", { exact: true }).click();
	await page.getByRole("option", { name: "断言失败", exact: true }).click();
	await expect(list.getByRole("button")).toHaveCount(1);
	await expect(inspector.getByRole("alert")).toContainText(
		"UNREACHABLE_EXPECTATION",
	);
	await expect(page.getByLabel("执行尝试历史", { exact: true })).toBeVisible();
	await page.getByLabel("搜索批次案例", { exact: true }).fill("不存在的案例");
	await expect(list.getByRole("button")).toHaveCount(0);
	await expect(
		inspector.getByText("没有匹配的案例", { exact: true }),
	).toBeVisible();
	await page.getByLabel("搜索批次案例", { exact: true }).fill("");
	await page.getByLabel("按执行结果筛选", { exact: true }).click();
	await page.getByRole("option", { name: "全部结果", exact: true }).click();
	await list
		.getByRole("button", {
			name: `查看案例：${item.definition.id}`,
			exact: true,
		})
		.click();
	await expect(
		inspector.getByText("Use Bun. 已完成验证。", { exact: true }),
	).toBeVisible();
});

test("case workbench keeps legacy tabs, permanent result/history and scoped configuration", async ({
	page,
	request,
}, testInfo) => {
	const { module, item } = await seed(request, "原版案例工作台");
	await page.goto(`/#/case/${item.id}`);
	await expect(page.locator(".CaseEditor-form").getByRole("tab")).toHaveText([
		"输入",
		"判定规则",
		"配置",
	]);
	await expect(page.locator(".CaseEditor-results")).toContainText("执行结果");
	await expect(page.locator(".CaseEditor-results")).toContainText("历史记录");
	await page.getByRole("tab", { name: "配置", exact: true }).click();
	await expect(page.locator(".CaseConfig .HeaderEditor")).toHaveCount(2);
	await expect(page.getByLabel("Base URL", { exact: true })).toHaveCount(1);
	await expect(page.locator(".CaseConfig-environment")).toHaveCount(0);
	await page
		.getByRole("button", { name: "多轮回放（完整任务）", exact: false })
		.first()
		.click();
	await expect(page.locator(".CaseConfig-environment")).toBeVisible();
	await page.getByRole("tab", { name: "判定规则", exact: true }).click();
	await expect(page.locator(".Grading-goals").getByRole("button")).toHaveCount(
		4,
	);
	await page
		.getByRole("button", { name: "最终回复", exact: false })
		.first()
		.click();
	await expect(
		page.getByLabel("必须包含（每行一项）", { exact: true }),
	).toBeVisible();
	page.on("dialog", (d) => d.accept());
	await page.goto(`/#/case/new?module=${module.id}`);
	await expect(page.locator(".CaseEditor-results")).toContainText("尚未运行");
	await page.getByLabel("案例名称", { exact: true }).fill("UI-新增案例");
	await page.getByLabel("本轮输入", { exact: true }).fill("Use Bun");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page).toHaveURL(/#\/case\/(?!new)/);
	await page.getByRole("button", { name: "运行单轮回放", exact: true }).click();
	await expect(
		page
			.locator(".CaseEditor-results")
			.getByText("Use Bun. 已完成验证。", { exact: true }),
	).toBeVisible({ timeout: 60000 });
	for (const width of [1440, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			)
			.toBe(true);
		await page.screenshot({
			animations: "disabled",
			path: testInfo.outputPath(`case-workbench-${width}.png`),
			fullPage: true,
		});
	}
});

test("full-task Act configuration persists and actual runtime record is inspectable", async ({
	page,
	request,
}, testInfo) => {
	const { module, item } = await seed(request, "Act 配置对齐");
	await page.goto(`/#/case/${item.id}`);
	await page
		.getByRole("button", { name: "多轮回放（完整任务）", exact: false })
		.first()
		.click();
	await page.getByRole("tab", { name: "配置", exact: true }).click();
	await page.getByLabel("工具权限", { exact: true }).click();
	await page
		.getByRole("option", { name: "全部工具（自动批准）", exact: true })
		.click();
	await page.getByLabel("压缩策略", { exact: true }).click();
	await page.getByRole("option", { name: "Basic", exact: true }).click();
	await page.getByLabel("自动压缩上下文", { exact: true }).uncheck();
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/cases/${item.id}`)).json()).revision,
		)
		.toBe(2);
	await page.reload();
	await page.getByRole("tab", { name: "配置", exact: true }).click();
	await expect(
		page.getByLabel("自动压缩上下文", { exact: true }),
	).not.toBeChecked();
	await expect(page.getByText("Basic", { exact: true })).toBeVisible();
	for (const width of [1440, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			)
			.toBe(true);
		await page.screenshot({
			animations: "disabled",
			path: testInfo.outputPath(`act-config-${width}.png`),
			fullPage: true,
		});
	}
	await page
		.getByRole("button", { name: "运行多轮回放（完整任务）", exact: true })
		.click();
	const pane = page.locator(".CaseEditor-results");
	await expect(
		pane.getByText("Use Bun. 已完成验证。", { exact: true }),
	).toBeVisible({ timeout: 60000 });
	await pane.getByText("执行详情", { exact: true }).click();
	await pane.getByText("任务配置快照", { exact: true }).click();
	await pane.getByText("生效执行配置", { exact: true }).click();
	await expect(
		pane.getByText('"plugin-act-v1"', { exact: false }),
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("act-runtime-record.png"),
		fullPage: true,
	});
});

test("Ant Design rule removal, Judge activation and saved configuration roundtrip", async ({
	page,
	request,
}, testInfo) => {
	const { item } = await seed(request, "规则增删回归");
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(`/#/case/${item.id}`);
	await page.getByRole("tab", { name: "判定规则", exact: true }).click();
	await page.getByRole("button", { name: "移除包含检查", exact: true }).click();
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "移除", exact: true }),
	).toBeHidden();
	await expect(
		page.getByLabel("必须包含（每行一项）", { exact: true }),
	).toHaveValue("Bun");
	await page
		.getByRole("button", { name: "移除最终回复检查", exact: true })
		.click();
	await page.getByRole("button", { name: "移除", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "移除", exact: true }),
	).toBeHidden();
	await expect(
		page.getByLabel("必须包含（每行一项）", { exact: true }),
	).toBeHidden();
	await page.getByRole("button", { name: /^最终回复/ }).click();
	await page.getByRole("button", { name: /^最终回复/ }).click();
	await expect(
		page.getByLabel("必须包含（每行一项）", { exact: true }),
	).toHaveCount(1);
	await page.getByRole("button", { name: "移除包含检查", exact: true }).click();
	await page.getByRole("button", { name: /^文件产物/ }).click();
	await page.getByRole("button", { name: "添加检查", exact: true }).click();
	await page.getByLabel("文件相对路径", { exact: true }).fill("result.txt");
	await page.getByRole("button", { name: /^Python 脚本/ }).click();
	await page.getByRole("button", { name: "添加检查", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "移除检查", exact: true }),
	).toHaveCount(2);
	await page
		.getByRole("button", { name: "移除全部验收检查", exact: true })
		.click();
	await expect(
		page.getByText("将移除文件、Python 及其他全部验收规则。", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "移除", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "移除", exact: true }),
	).toBeHidden();
	await expect(
		page.getByRole("button", { name: "添加检查", exact: true }),
	).toBeHidden();
	// Removing an empty editor must also discard invalid JSON validation state.
	await page.getByRole("button", { name: /^文件产物/ }).click();
	await page
		.getByText("编辑全部规则（支持完整规则合同）", { exact: true })
		.click();
	await page.getByLabel("验收规则数组", { exact: true }).fill("{invalid");
	await page
		.getByRole("button", { name: "移除全部验收检查", exact: true })
		.click();
	await page.getByRole("button", { name: /^LLM 评分/ }).click();
	await page
		.getByRole("button", { name: "添加独立评分配置", exact: true })
		.click();
	await expect(
		page.getByLabel("启用 LLM Judge", { exact: true }),
	).toBeChecked();
	await page
		.getByLabel("参考答案", { exact: true })
		.fill("应包含任务架构与验证结果。".repeat(15));
	await page.getByLabel("启用 LLM Judge", { exact: true }).uncheck();
	await page.getByRole("button", { name: /^LLM 评分/ }).click();
	await expect(page.getByLabel("参考答案", { exact: true })).toHaveValue(
		"应包含任务架构与验证结果。".repeat(15),
	);
	await page.getByLabel("启用 LLM Judge", { exact: true }).uncheck();
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/cases/${item.id}`)).json()).revision,
		)
		.toBe(2);
	await page.reload();
	await page.getByRole("tab", { name: "判定规则", exact: true }).click();
	await expect(
		page.getByText("评分已停用，配置已保留", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: /^LLM 评分/ }).click();
	for (const width of [1440, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			)
			.toBe(true);
		await page.screenshot({
			animations: "disabled",
			path: testInfo.outputPath(`rules-judge-${width}.png`),
			fullPage: true,
		});
	}
	await page.getByRole("button", { name: "移除评分配置", exact: true }).click();
	await page.getByRole("button", { name: "移除", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "移除", exact: true }),
	).toBeHidden();
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/cases/${item.id}`)).json()).revision,
		)
		.toBe(3);
	const saved = await (await request.get(`/api/cases/${item.id}`)).json();
	expect(saved.definition.assertions?.contains).toBeUndefined();
	expect(saved.definition.grading).toBeUndefined();
	expect(saved.definition.llmJudge).toBeUndefined();
	expect(saved.definition.llmJudges).toBeUndefined();
	await page.reload();
	await page.getByRole("tab", { name: "判定规则", exact: true }).click();
	await expect(page.getByLabel("参考答案", { exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("Ant Design desktop page review", async ({ page, request }, testInfo) => {
	const { module, item } = await seed(request, "Ant Design 全站复核");
	const run = await send(request, "/api/runs", { caseIds: [item.id] });
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const routes = [
		["catalog", `/cases/${module.id}`],
		["editor", `/case/${item.id}`],
		["imports", "/import"],
		["runs", "/runs"],
		["new-run", "/run/new"],
		["verifiers", "/verifiers"],
		["settings", "/settings"],
		["result", `/run/${run.id}`],
	];
	for (const [name, route] of routes) {
		await page.goto(`/#${route}`);
		await expect(page.locator("main h1").first()).toBeVisible();
		await expect(page.locator(".ant-skeleton")).toHaveCount(0);
		if (name === "result")
			await expect(page.getByText("已完成", { exact: true })).toBeVisible({
				timeout: 60000,
			});
		for (const width of [1440, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await expect
				.poll(
					() =>
						page.evaluate(
							() => document.documentElement.scrollWidth <= innerWidth,
						),
					`${name} at ${width}`,
				)
				.toBe(true);
			if (name === "runs" || name === "new-run") {
				const search = page.getByPlaceholder(
					name === "runs" ? "搜索批次名称或备注" : "搜索案例",
					{ exact: true },
				);
				expect((await search.boundingBox())!.height).toBeLessThan(48);
			}
			await page.screenshot({
				animations: "disabled",
				path: testInfo.outputPath(`${name}-${width}.png`),
				fullPage: true,
			});
		}
	}
	expect(errors).toEqual([]);
});

test("DevAgent desktop alignment, scorer management and multiple independent scores", async ({
	page,
	request,
}, testInfo) => {
	const { item } = await seed(request, "多评分器");
	await page.goto("/#/scorers");
	await expect(
		page.getByRole("link", { name: "DevAgent / Agent Eval" }),
	).toBeVisible();
	await page.getByRole("button", { name: "新增评分器", exact: true }).click();
	await page.getByLabel("评分器名称", { exact: true }).fill("正确性评分器");
	await page
		.getByLabel("评分器说明", { exact: true })
		.fill("检查结果是否符合参考答案");
	await page
		.getByLabel("评分标准（可选）", { exact: true })
		.fill("判断正确性，使用 0–100 分");
	await page.getByLabel("独立配置评审模型", { exact: true }).check();
	await page.getByLabel("Judge 模型", { exact: true }).fill("ui-judge");
	await page
		.getByLabel("Judge Base URL", { exact: true })
		.fill(defaults.baseUrl);
	await page
		.getByLabel("Judge 密钥环境变量名", { exact: true })
		.fill("EVAL_BROWSER_KEY");
	await page.screenshot({
		path: testInfo.outputPath("scorer-form-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "保存评分器", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const all = await (await request.get("/api/llm-scorers")).json();
	const first = all.find((s: any) => s.name === "正确性评分器");
	expect(first).toBeTruthy();
	const second = await send(request, "/api/llm-scorers", {
		name: "完整性评分器",
		description: "检查任务要求覆盖",
		enabled: true,
		config: { ...first.config, rubric: "检查完整性" },
	});
	await page.reload();
	await expect(
		page.getByRole("cell", { name: "完整性评分器", exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("scorers-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.goto(`/#/case/${item.id}`);
	await expect(
		page.getByRole("heading", { name: "基本信息", exact: true }),
	).toBeVisible();
	const left = page.locator(".CaseEditor-form .ant-card:visible").first();
	const right = page.locator(".CaseEditor-results > .ant-card").first();
	for (const width of [1280, 1440, 1920]) {
		await page.setViewportSize({ width, height: 1000 });
		await expect
			.poll(async () =>
				Math.abs(
					((await left.boundingBox())?.y ?? -10000) -
						((await right.boundingBox())?.y ?? 10000),
				),
			)
			.toBeLessThan(2);
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.screenshot({
		path: testInfo.outputPath("alignment-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("tab", { name: "判定规则", exact: true }).click();
	await page.getByRole("button", { name: /^LLM 评分/ }).click();
	const select = page.getByRole("combobox", {
		name: "选择 LLM 评分器",
		exact: true,
	});
	await select.click();
	await page
		.getByRole("option", { name: "正确性评分器 · v1", exact: true })
		.click();
	await page
		.getByRole("option", { name: "完整性评分器 · v1", exact: true })
		.click();
	await page.keyboard.press("Escape");
	await page.getByLabel("参考答案", { exact: true }).nth(0).fill("Use Bun");
	await page
		.getByLabel("参考答案", { exact: true })
		.nth(1)
		.fill("Use Bun. 已完成验证。");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByText(/版本 v2 · 已保存/)).toBeVisible();
	const saved = await (await request.get(`/api/cases/${item.id}`)).json();
	expect(saved.definition.llmJudges).toHaveLength(2);
	expect(saved.definition.llmJudge).toBeUndefined();
	await send(
		request,
		`/api/llm-scorers/${first.id}`,
		{ ...first, config: { ...first.config, rubric: "更新标准" } },
		"PUT",
	);
	await page.reload();
	await page.getByRole("tab", { name: "判定规则", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "有新版本 · 更新" }),
	).toBeVisible();
	await expect(
		page.getByLabel("评分标准（可选）", { exact: true }).nth(0),
	).toHaveValue("判断正确性，使用 0–100 分");
	await page.screenshot({
		path: testInfo.outputPath("bindings-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	const run = await send(request, "/api/runs", { caseIds: [item.id] });
	let detail: any;
	await expect
		.poll(
			async () => {
				detail = await (await request.get(`/api/runs/${run.id}`)).json();
				return detail.items[0].status;
			},
			{ timeout: 60000 },
		)
		.toBe("passed");
	const full = await (
		await request.get(`/api/runs/${run.id}/items/${detail.items[0].id}`)
	).json();
	expect(full.result.llmJudges.map((s: any) => s.score)).toEqual([90, 90]);
	expect(detail.judgeSummary.scored).toBe(2);
	const path = `/api/runs/${run.id}/items/${full.id}/judge-scores/official-input`;
	expect((await request.get(path)).ok()).toBeFalsy();
	expect(
		(
			await request.get(
				`${path}?bindingId=${full.result.llmJudges[1].bindingId}`,
			)
		).ok(),
	).toBeTruthy();
	await page.goto(`/#/run/${run.id}`);
	await expect(page.getByText("LLM 已评分 2/2")).toBeVisible();
	await page
		.getByRole("button", { name: /多评分器-案例/ })
		.first()
		.click();
	await expect(
		page.getByText("LLM 评分 · 正确性评分器 · 90", { exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("multi-results-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("tab", { name: "试验证 / 试评分", exact: true }).click();
	const previewButtons = page.getByRole("button", {
		name: "预览评分输入",
		exact: true,
	});
	await expect(previewButtons).toHaveCount(2);
	await previewButtons.nth(0).click();
	await page
		.getByRole("button", { name: "确认试评分", exact: true })
		.nth(0)
		.click();
	await previewButtons.nth(1).click();
	await page
		.getByRole("button", { name: "确认试评分", exact: true })
		.nth(1)
		.click();
	await expect
		.poll(async () => {
			const records = await (
				await request.get(`/api/runs/${run.id}/items/${full.id}/judge-scores`)
			).json();
			return records.filter((r: any) => r.status === "completed" && r.binding)
				.length;
		})
		.toBe(2);
	await page.screenshot({
		path: testInfo.outputPath("trial-scorers-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	const conversation = `**/api/runs/${run.id}/items/${full.id}/conversation?*`;
	await page.route(conversation, (r) =>
		r.fulfill({
			json: {
				notice: "已保存上下文可能包含压缩记录。",
				total: 2,
				messages: [
					{
						id: "1",
						index: 0,
						role: "user",
						blocks: [
							{
								type: "text",
								text: '<user_input mode="act">请分析仓库用途</user_input>',
							},
						],
					},
					{
						id: "2",
						index: 1,
						role: "assistant",
						blocks: [
							{
								type: "thinking",
								text: JSON.stringify({
									type: "thinking",
									thinking: "正在分析已有会话记录。",
								}),
							},
							{ type: "text", text: "我来分析仓库用途。\n先查看项目结构。" },
							{
								type: "tool_use",
								toolName: "run_commands",
								toolCallId: "call-1",
								text: JSON.stringify(
									{ commands: ["ls -la", "cat README.md"] },
									null,
									2,
								),
							},
							{
								type: "tool_result",
								toolName: "run_commands",
								toolCallId: "call-1",
								text: `README.md\nsrc\n${"输出详情\n".repeat(80)}`,
							},
						],
					},
				],
			},
		}),
	);
	await page.getByRole("tab", { name: "会话与工具", exact: true }).click();
	await expect(page.getByText("请分析仓库用途", { exact: true })).toBeVisible();
	await expect(page.getByText("思考记录", { exact: true })).toBeVisible();
	await expect(page.getByText("工具返回", { exact: true })).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("conversation-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	const deletion = await request.delete(`/api/llm-scorers/${second.id}`, {
		data: { revision: second.revision },
	});
	expect(deletion.status()).toBe(409);
});

test("criterion editor and formal/trial results show every verdict independently of score", async ({
	page,
	request,
}, testInfo) => {
	const { item } = await seed(request, "逐条评分验收");
	await send(
		request,
		"/api/judge-settings",
		{
			...defaults,
			modelId: "ui-judge",
			tools: undefined,
			maxIterations: undefined,
			timeoutMs: undefined,
		},
		"PUT",
	);
	await page.goto("/#/scorers");
	await page.getByRole("button", { name: "新增评分器", exact: true }).click();
	await page.getByLabel("评分器名称", { exact: true }).fill("逐条质量检查");
	for (const [i, name, standard] of [
		[1, "准确性", "确认提到 Bun"],
		[2, "完整性", "故意失败：要求给出验证命令"],
		[3, "执行证据", "证据不足：需要实际测试日志"],
	] as const) {
		await page
			.getByRole("button", { name: "添加评分条目", exact: true })
			.click();
		await page.getByLabel(`条目 ${i} 名称`, { exact: true }).fill(name);
		await page.getByLabel(`条目 ${i} 判定标准`, { exact: true }).fill(standard);
	}
	await page.getByRole("button", { name: "移除条目 3", exact: true }).click();
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await expect(page.getByLabel("条目 3 名称", { exact: true })).toHaveValue(
		"执行证据",
	);
	await page
		.getByRole("button", { name: "使用全局 Judge 配置", exact: true })
		.click();
	await page.getByLabel("影响通过结果", { exact: true }).check();
	await expect(page.getByLabel("及格分", { exact: true })).toHaveCount(0);
	await page
		.locator(".JudgeCriteria h4")
		.evaluate((el) => el.scrollIntoView({ block: "start" }));
	await page.screenshot({
		path: testInfo.outputPath("criteria-editor-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "保存评分器", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const scorer = (await (await request.get("/api/llm-scorers")).json()).find(
		(s: any) => s.name === "逐条质量检查",
	);
	expect(scorer.config.criteria).toHaveLength(3);
	const binding = {
		bindingId: "criteria-review",
		name: scorer.name,
		scorerId: scorer.id,
		sourceRevision: scorer.revision,
		config: { ...scorer.config, referenceAnswer: "Use Bun. 已完成验证。" },
	};
	await send(
		request,
		`/api/cases/${item.id}`,
		{
			revision: item.revision,
			defaults,
			definition: { ...item.definition, llmJudges: [binding] },
		},
		"PUT",
	);
	const run = await send(request, "/api/runs", { caseIds: [item.id] });
	let detail: any;
	await expect
		.poll(
			async () => {
				detail = await (await request.get(`/api/runs/${run.id}`)).json();
				return detail.items[0].status;
			},
			{ timeout: 60000 },
		)
		.toBe("failed");
	const full = await (
		await request.get(`/api/runs/${run.id}/items/${detail.items[0].id}`)
	).json();
	const score = full.result.llmJudges[0];
	expect(score.score).toBe(90);
	expect(score.criteriaOutcome).toBe("fail");
	expect(score.meetsThreshold).toBe(false);
	expect(score.criteriaResults.map((c: any) => c.status)).toEqual([
		"pass",
		"fail",
		"insufficient",
	]);
	expect(score.promptVersion).toBe("reference-judge-criteria-v2");
	await page.goto(`/#/run/${run.id}`);
	await page
		.getByRole("button", { name: /逐条评分验收-案例/ })
		.first()
		.click();
	const table = page.locator(".JudgeCriteriaResults:visible");
	await expect(
		table.getByRole("cell", { name: "准确性", exact: true }),
	).toBeVisible();
	await expect(table.getByText("不通过", { exact: true })).toBeVisible();
	await expect(table.getByText("无法判定", { exact: true })).toBeVisible();
	await table.locator(".ant-table-row-expand-icon").nth(1).click();
	await expect(
		table.getByText("故意失败：要求给出验证命令", { exact: false }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("criteria-result-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("tab", { name: "试验证 / 试评分", exact: true }).click();
	await page.getByRole("button", { name: "预览评分输入", exact: true }).click();
	await page.getByRole("button", { name: "确认试评分", exact: true }).click();
	await expect
		.poll(async () => {
			const tasks = await (
				await request.get(`/api/runs/${run.id}/items/${full.id}/judge-scores`)
			).json();
			return tasks[0]?.result?.criteriaResults?.length;
		})
		.toBe(3);
	await expect(
		page
			.locator(".JudgeCriteriaResults:visible")
			.getByText("不通过", { exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("criteria-trial-1440.png"),
		fullPage: true,
		animations: "disabled",
	});
	const after = await (
		await request.get(`/api/runs/${run.id}/items/${full.id}`)
	).json();
	expect(after.result.llmJudges[0].id).toBe(score.id);
});

test("repeat report hierarchy, attempt modes, comparison and single-round states", async ({
	page,
	request,
}, testInfo) => {
	const { item } = await seed(request, "多轮报告原型验收");
	const run = await send(request, "/api/runs", {
		caseIds: [item.id],
		repeatCount: 1,
	});
	let detail: any;
	await expect
		.poll(
			async () => {
				detail = await (await request.get(`/api/runs/${run.id}`)).json();
				return detail.status;
			},
			{ timeout: 60000 },
		)
		.toBe("completed");
	const original = await (
		await request.get(`/api/runs/${run.id}/report?attemptMode=latest`)
	).json();
	const fixture: any = structuredClone(original);
	let fail = false;
	await page.route(`**/api/runs/${run.id}/report?*`, async (route) => {
		if (fail) {
			await route.fulfill({ status: 503, json: { error: "报告暂时不可用" } });
			return;
		}
		const data = structuredClone(fixture);
		if (
			new URL(route.request().url()).searchParams.get("attemptMode") ===
				"first" &&
			data.repeatReport.repeatCount > 1
		) {
			for (const c of data.repeatReport.cases)
				for (const r of c.rounds) r.status = "failed";
			data.repeatReport.cases[0].rounds[0].status = "cancelled";
		}
		await route.fulfill({ json: data });
	});
	await page.goto(`/#/run/${run.id}`);
	await page.getByRole("tab", { name: "多轮报告", exact: true }).click();
	const report = page.locator(".RepeatReport");
	await expect(
		report.getByText(
			"当前仅执行 1 轮，暂无法判断稳定性；至少执行 2 轮后可比较。",
		),
	).toBeVisible();
	await expect(report.locator(".RepeatMetrics")).not.toContainText("0 / 0");
	await report.screenshot({
		path: testInfo.outputPath("repeat-single-1440.png"),
	});
	const base = structuredClone(original.repeatReport.cases[0]);
	fixture.repeatReport = {
		...original.repeatReport,
		repeatCount: 3,
		caseCount: 3,
		completedRounds: 3,
		partial: false,
		rounds: [1, 2, 3].map((round) => ({
			...original.repeatReport.rounds[0],
			round,
		})),
		cases: ["仓库用途分析", "构建说明检查", "关键文件定位"].map((name, i) => ({
			...base,
			caseId: `case-${i}`,
			name,
			moduleName: ["read_file", "run_commands", "search_codebase"][i],
			comparedOutputs: 3,
			outputVariants: i ? 2 : 1,
			variants: i
				? [
						{ rounds: [1], itemIds: [detail.items[0].id] },
						{ rounds: [2, 3], itemIds: [detail.items[0].id] },
					]
				: [{ rounds: [1, 2, 3], itemIds: [detail.items[0].id] }],
			rounds: [1, 2, 3].map((round) => ({
				round,
				itemId: detail.items[0].id,
				status: i === 2 && round > 1 ? "failed" : "passed",
				failedAssertions: i === 2 && round > 1 ? ["未定位关键文件"] : [],
			})),
		})),
	};
	await page.reload();
	await page.getByRole("tab", { name: "多轮报告", exact: true }).click();
	await expect(report.locator(".RepeatMetrics")).toContainText("77.8%");
	await expect(report.locator(".RepeatMetrics")).toContainText("2 / 3");
	await report.screenshot({
		path: testInfo.outputPath("repeat-multi-1440.png"),
	});
	await report.getByText("有波动 1", { exact: true }).click();
	await expect(
		report.getByRole("button", { name: "查看对比", exact: true }),
	).toHaveCount(1);
	await report.getByRole("button", { name: "查看对比", exact: true }).click();
	await expect(page.getByRole("dialog")).toContainText("未定位关键文件");
	await expect(page.getByRole("dialog")).toContainText("输出版本 2");
	await page
		.getByRole("dialog")
		.screenshot({ path: testInfo.outputPath("repeat-comparison.png") });
	await page
		.getByRole("button", { name: "查看完整输出", exact: true })
		.first()
		.click();
	await expect(page.getByRole("dialog")).toContainText("Use Bun");
	await page
		.getByRole("dialog")
		.getByRole("button", { name: /关闭|Close/, exact: true })
		.click();
	await report.getByRole("button", { name: "第 2 轮", exact: true }).click();
	await expect(page.getByRole("dialog")).toContainText("仓库用途分析");
	await page
		.getByRole("dialog")
		.getByRole("button", { name: /关闭|Close/, exact: true })
		.click();
	await report.getByRole("combobox", { name: "统计口径" }).click();
	await page.getByText("各轮首次尝试", { exact: true }).last().click();
	await expect(report.locator(".RepeatMetrics")).toContainText("0.0%");
	await expect(report.getByText("每轮失败", { exact: true })).toHaveCount(2);
	await expect(
		report.getByText("阶段性报告：部分执行尚未完成或已取消，以下为当前结果。"),
	).toBeVisible();
	// Selected-attempt rows are authoritative even when legacy summaries differ.
	await report.getByRole("button", { name: "口径说明", exact: true }).click();
	await expect(report.getByText("原始报告数据", { exact: true })).toBeVisible();
	fixture.repeatReport.cases[0].name =
		"长名称案例：" + "评估仓库结构与关键文件".repeat(12);
	fixture.repeatReport.partial = true;
	fixture.repeatReport.cases[0].rounds[1].status = "error";
	fixture.repeatReport.cases[0].rounds[2].status = "running";
	fixture.repeatReport.cases[1].rounds[1].status = "cancelled";
	fixture.repeatReport.cases[1].rounds[2].status = "inconclusive";
	await page.reload();
	await page.getByRole("tab", { name: "多轮报告", exact: true }).click();
	await expect(
		report.getByText("阶段性报告：部分执行尚未完成或已取消，以下为当前结果。"),
	).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 1000 });
	await report.screenshot({
		path: testInfo.outputPath("repeat-long-partial-1280.png"),
	});
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	fixture.repeatReport.repeatCount = 8;
	fixture.repeatReport.rounds = Array.from({ length: 8 }, (_, i) => ({
		...original.repeatReport.rounds[0],
		round: i + 1,
	}));
	await page.reload();
	await page.getByRole("tab", { name: "多轮报告", exact: true }).click();
	const matrix = report.locator(".ant-table-content").nth(1);
	expect(await matrix.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
		true,
	);
	await matrix.evaluate((el) => {
		el.scrollLeft = el.scrollWidth;
	});
	await report.screenshot({
		path: testInfo.outputPath("repeat-eight-rounds-1280.png"),
	});
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);

	fail = true;
	await page.reload();
	await page.getByRole("tab", { name: "多轮报告", exact: true }).click();
	await expect(report.getByRole("button", { name: "重试加载" })).toBeVisible();
	await expect(report.getByRole("alert")).toHaveCount(1);
	await report.screenshot({
		path: testInfo.outputPath("repeat-error-1280.png"),
	});
	fail = false;
	fixture.repeatReport.cases = [];
	fixture.repeatReport.caseCount = 0;
	await report.getByRole("button", { name: "重试加载" }).click();
	await expect(report.getByText("暂无符合条件的案例")).toBeVisible();
	await report.screenshot({
		path: testInfo.outputPath("repeat-empty-1280.png"),
	});
});
