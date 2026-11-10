import { expect, test, type APIRequestContext } from "@playwright/test";

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
			id: name + "-案例",
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
	await page.setViewportSize({ width: 390, height: 844 });
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("case-mobile.png"),
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
	await dialog.getByLabel("目标模块", { exact: true }).selectOption(target.id);
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
	await expect(page.getByRole("alert")).toContainText("案例已被其他页面修改");
	await expect(page.getByLabel("本轮输入", { exact: true })).toHaveValue(
		"local unsaved input",
	);
	page.on("dialog", (d) => d.accept());
	await page.getByRole("link", { name: "验证脚本", exact: true }).click();
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
	const runId = page.url().split("/run/")[1];
	const script = await send(request, "/api/verifiers", {
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
	await page
		.getByLabel("Python 验证脚本", { exact: true })
		.selectOption(script.id);
	await page.getByRole("button", { name: "开始试验证", exact: true }).click();
	await expect(
		page.getByText("状态：completed", { exact: true }),
	).toBeVisible();
	await expect(page.getByText(/browser verified/).first()).toBeVisible();
	expect(
		(await (await request.get(`http://127.0.0.1:${port + 1}/requests`)).json())
			.length,
	).toBe(before);
	await page.getByRole("button", { name: "关闭", exact: true }).click();
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
	await page.getByRole("button", { name: "关闭", exact: true }).click();
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
	const boxes = () => page.locator("tbody input[type=checkbox]");
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
	await expect(card).toHaveCount(0);
	await page.getByRole("button", { name: "已归档模块", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "恢复模块", exact: true })
		.click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
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
	await page
		.getByLabel("按执行结果筛选", { exact: true })
		.selectOption("failed");
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
	await page.getByLabel("按执行结果筛选", { exact: true }).selectOption("");
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
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 900 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await page.screenshot({
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
	await page.getByLabel("工具权限", { exact: true }).selectOption("full");
	await page.getByLabel("压缩策略", { exact: true }).selectOption("basic");
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
	await expect(page.getByLabel("压缩策略", { exact: true })).toHaveValue(
		"basic",
	);
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 900 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await page.screenshot({
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
		path: testInfo.outputPath("act-runtime-record.png"),
		fullPage: true,
	});
});
