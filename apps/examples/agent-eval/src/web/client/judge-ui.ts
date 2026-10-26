import { headerEditor, readHeaderEditor } from "./header-editor.js";
import { parseJudgeConfig, parseJudgeModel } from "../../judge/config.js";
import {
	JUDGE_STATUS,
	type JudgeConfig,
	type JudgeModel,
	type JudgeResult,
	type JudgeInput,
} from "../../judge/types.js";
export type JudgeApi = <T>(url: string, init?: RequestInit) => Promise<T>;
export const judgeNode = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text = "",
	cls = "",
): HTMLElementTagNameMap[K] => {
	const el = document.createElement(tag);
	el.textContent = text;
	if (cls) el.className = cls;
	return el;
};
const node = judgeNode;
export function judgeButton(label: string, action: () => void) {
	const b = node("button", label, "btn btn-sm");
	b.type = "button";
	b.onclick = action;
	return b;
}
export function judgeField(
	label: string,
	control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	hint = "",
) {
	const group = node("div", "", "form-group");
	const title = node("label", label, "form-label");
	if (!control.id) control.id = `judge-${crypto.randomUUID()}`;
	title.htmlFor = control.id;
	group.append(title, control);
	if (hint) group.append(node("p", hint, "form-hint"));
	return group;
}
function textField(
	id: string,
	value: string | number | undefined,
	large = false,
) {
	const input = large ? node("textarea") : node("input");
	input.id = id;
	input.className = "form-control";
	input.value = String(value ?? "");
	if (input instanceof HTMLTextAreaElement) input.rows = 4;
	return input;
}
function checkbox(label: string, checked: boolean) {
	const control = node("input");
	control.type = "checkbox";
	control.checked = checked;
	const wrapper = node("label", "", "form-check");
	wrapper.append(control, document.createTextNode(label));
	return { control, wrapper };
}
export function judgeModelEditor(
	id: string,
	initial: JudgeModel | undefined,
	api: JudgeApi,
	execution?: () => JudgeModel,
	allowDefaults = true,
) {
	const element = node("section", "", "JudgeModel");
	const fields = node("div", "", "ModelFields");
	const error = node("div", "", "field-error");
	error.setAttribute("role", "alert");
	const controls = {
		providerId: textField(`${id}-provider`, initial?.providerId),
		modelId: textField(`${id}-model`, initial?.modelId),
		baseUrl: textField(`${id}-baseurl`, initial?.baseUrl),
		apiKeyEnv: textField(`${id}-keyenv`, initial?.apiKeyEnv),
	};
	fields.append(
		judgeField(
			"Judge Provider",
			controls.providerId,
			"例如 openai-compatible、anthropic、openai-native",
		),
		judgeField("Judge 模型", controls.modelId),
		judgeField("Judge Base URL", controls.baseUrl),
		judgeField(
			"Judge 密钥环境变量",
			controls.apiKeyEnv,
			"填写变量名称，例如 JUDGE_API_KEY；实际密钥只在服务端配置。",
		),
	);
	const headerBox = node("div");
	headerBox.append(
		headerEditor(`${id}-headers`, initial ?? {}, "Judge 自定义请求头"),
	);
	const set = (model: JudgeModel) => {
		for (const key of Object.keys(controls) as Array<keyof typeof controls>)
			controls[key].value = model[key] ?? "";
		headerBox.replaceChildren(
			headerEditor(`${id}-headers`, model, "Judge 自定义请求头"),
		);
		error.textContent = "";
		element.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const actions = node("div", "", "flex-center gap-2 wrap");
	if (allowDefaults)
		actions.append(
			judgeButton("使用全局 Judge 配置", () => {
				void api<JudgeModel | null>("/api/judge-settings")
					.then((model) => {
						if (!model)
							throw Error("尚未设置全局 Judge 配置，请在运行配置中保存。");
						set(model);
					})
					.catch((e) => (error.textContent = String(e)));
			}),
		);
	if (execution)
		actions.append(
			judgeButton("复制当前执行模型配置", () => {
				try {
					set(execution());
				} catch (e) {
					error.textContent = String(e);
				}
			}),
		);
	element.append(actions, fields, headerBox, error);
	return {
		element,
		set,
		read: (validate = true): JudgeModel => {
			const raw = {
				providerId: controls.providerId.value.trim(),
				modelId: controls.modelId.value.trim(),
				...(controls.baseUrl.value.trim()
					? { baseUrl: controls.baseUrl.value.trim() }
					: {}),
				...(controls.apiKeyEnv.value.trim()
					? { apiKeyEnv: controls.apiKeyEnv.value.trim() }
					: {}),
				...readHeaderEditor(`${id}-headers`),
			};
			if (!validate) return raw;
			try {
				return parseJudgeModel(raw);
			} catch (e) {
				error.textContent = String(e);
				controls.providerId.focus();
				throw e;
			}
		},
	};
}
export function judgeEditor(options: {
	id: string;
	initial?: JudgeConfig;
	api: JudgeApi;
	execution: () => JudgeModel;
	trial: (config: JudgeConfig) => void;
}) {
	const { id, initial } = options;
	let mode = "single-turn",
		touched = !!initial;
	const element = node("section", "", "Box Box-body JudgeEditor mt-3");
	const enabled = checkbox("启用 LLM 评分", initial?.enabled ?? false);
	enabled.control.id = `${id}-enabled`;
	const head = node("div", "", "flex-between wrap gap-2");
	head.append(node("h3", "LLM 评分", "section-title"), enabled.wrapper);
	const help = node(
		"p",
		"提供参考答案，由独立模型评分。默认只评分，不改变原案例通过结果。",
		"form-hint",
	);
	const body = node("div");
	body.hidden = !enabled.control.checked;
	const error = node("div", "", "field-error");
	error.setAttribute("role", "alert");
	const reference = textField(
		`${id}-reference`,
		initial?.referenceAnswer,
		true,
	);
	reference.setAttribute(
		"placeholder",
		"填写期望答案、关键结论或参考处理方式，不要求模型逐字复述。",
	);
	const result = checkbox(
			"执行结果",
			initial?.targets.includes("result") ?? true,
		),
		trajectory = checkbox(
			"执行轨迹",
			initial?.targets.includes("trajectory") ?? false,
		);
	result.control.id = `${id}-result`;
	trajectory.control.id = `${id}-trajectory`;
	const targets = node("div", "", "flex-center gap-2 wrap");
	targets.setAttribute("role", "group");
	targets.setAttribute("aria-label", "LLM 评审内容");
	targets.append(result.wrapper, trajectory.wrapper);
	const targetHint = node(
		"p",
		"结果：最终回复和选定文件。轨迹：已保存会话、工具请求和返回；可能压缩，不证明真实工具执行或审批。题目指令和原始案例历史始终作为上下文。",
		"form-hint",
	);
	const modelFold = node("details", "", "Verifier-details");
	const modelSummary = node(
		"summary",
		`Judge 模型 · ${initial?.model?.modelId || "尚未配置"}`,
	);
	modelFold.append(modelSummary);
	modelFold.open = !initial?.model;
	const model = judgeModelEditor(
		`${id}-model`,
		initial?.model,
		options.api,
		options.execution,
	);
	modelFold.append(model.element);
	const refreshModelSummary = () => {
		modelSummary.textContent = `Judge 模型 · ${model.element.querySelector<HTMLInputElement>(`#${id}-model-model`)?.value || "尚未配置"}`;
	};
	modelFold.addEventListener("toggle", refreshModelSummary);
	model.element.addEventListener("input", refreshModelSummary);
	const affects = checkbox(
		"参与通过判定（关闭时仅评分）",
		initial?.affectsOutcome ?? false,
	);
	affects.control.id = `${id}-affects`;
	const threshold = textField(`${id}-threshold`, initial?.passScore ?? 80);
	threshold.setAttribute("type", "number");
	threshold.setAttribute("min", "0");
	threshold.setAttribute("max", "100");
	const thresholdField = judgeField(
		"及格分（0–100）",
		threshold,
		"达到此分才满足 LLM 判分；不会将其他失败项升级为通过。",
	);
	thresholdField.hidden = !affects.control.checked;
	affects.control.onchange = () =>
		(thresholdField.hidden = !affects.control.checked);
	const advanced = node("details", "", "Verifier-details");
	advanced.append(node("summary", "评分标准与高级设置"));
	const rubric = textField(`${id}-rubric`, initial?.rubric, true),
		timeout = textField(`${id}-timeout`, initial?.timeoutMs ?? 120000),
		limit = textField(`${id}-limit`, initial?.maxInputBytes ?? 131072),
		files = textField(
			`${id}-files`,
			initial?.resultFiles.join("\n") ?? "",
			true,
		);
	timeout.setAttribute("type", "number");
	limit.setAttribute("type", "number");
	const filesHint = node("p", "", "form-hint");
	advanced.append(
		judgeField(
			"评分标准（可选）",
			rubric,
			"例如：关注正确性与完整性，允许合理的不同处理路径。",
		),
		judgeField(
			"评分超时（毫秒）",
			timeout,
			"1000–300000；独立于被测执行超时。",
		),
		judgeField(
			"送审材料上限（字节）",
			limit,
			"默认 128 KiB，超限停止评分，不自动截断。",
		),
		judgeField(
			"选定归档文本文件（每行一个）",
			files,
			"工作区相对路径，最多 20 个；只有完整任务的执行结果支持文件。",
		),
		filesHint,
	);
	const actions = node("div", "", "flex-center gap-2 wrap");
	const trial = judgeButton("试评分", () => {
		try {
			const config = read();
			if (!config?.enabled) throw Error("请先启用 LLM 评分");
			options.trial(config);
		} catch (e) {
			report(e);
		}
	});
	actions.append(
		trial,
		node("span", "使用历史执行，只调用 Judge，不修改原成绩。", "form-hint"),
	);
	body.append(
		error,
		judgeField("参考答案 *", reference),
		node("strong", "评审内容 *"),
		targets,
		targetHint,
		modelFold,
		affects.wrapper,
		thresholdField,
		advanced,
		actions,
	);
	element.append(head, help, body);
	const report = (e: unknown) => {
		error.textContent = e instanceof Error ? e.message : String(e);
		body.hidden = false;
		for (
			let parent: HTMLElement | null = element;
			parent;
			parent = parent.parentElement
		) {
			if (parent instanceof HTMLDetailsElement) parent.open = true;
			const panel = parent.closest('[role="tabpanel"]');
			if (panel?.id)
				document
					.querySelector<HTMLButtonElement>(`[aria-controls="${panel.id}"]`)
					?.click();
		}
		if (!reference.value.trim()) reference.focus();
		else if (!result.control.checked && !trajectory.control.checked)
			result.control.focus();
		else {
			const message = String(e);
			if (
				/timeout|maxInput|resultFiles|rubric|超时|上限|文件|标准/.test(message)
			) {
				advanced.open = true;
				(/timeout|超时/.test(message)
					? timeout
					: /maxInput|上限/.test(message)
						? limit
						: /rubric|标准/.test(message)
							? rubric
							: files
				).focus();
			} else {
				modelFold.open = true;
				model.element.querySelector<HTMLInputElement>("input")?.focus();
			}
		}
	};
	const read = (validate = true): JudgeConfig | undefined => {
		if (!touched && !enabled.control.checked) return undefined;
		const modelValue = model.read(false);
		const hasModel =
			!!modelValue.providerId ||
			!!modelValue.modelId ||
			!!modelValue.baseUrl ||
			!!modelValue.apiKeyEnv ||
			!!modelValue.headers ||
			!!modelValue.headersEnv;
		const raw: JudgeConfig = {
			enabled: enabled.control.checked,
			referenceAnswer: reference.value,
			targets: [
				...(result.control.checked ? ["result" as const] : []),
				...(trajectory.control.checked ? ["trajectory" as const] : []),
			],
			rubric: rubric.value || undefined,
			model: hasModel ? modelValue : undefined,
			affectsOutcome: affects.control.checked,
			passScore: Number(threshold.value),
			timeoutMs: Number(timeout.value),
			maxInputBytes: Number(limit.value),
			resultFiles: files.value
				.split(/\r?\n/)
				.map((v) => v.trim())
				.filter(Boolean),
		};
		if (!validate) return raw;
		try {
			const parsed = parseJudgeConfig(raw, mode);
			error.textContent = "";
			return parsed;
		} catch (e) {
			report(e);
			throw e;
		}
	};
	element.addEventListener("input", () => {
		touched = true;
		error.textContent = "";
	});
	element.addEventListener("change", () => {
		touched = true;
	});
	enabled.control.onchange = () => {
		touched = true;
		body.hidden = !enabled.control.checked;
	};
	return {
		element,
		read,
		open: () => {
			touched = true;
			enabled.control.checked = true;
			body.hidden = false;
			reference.focus();
			for (
				let parent = element.parentElement;
				parent;
				parent = parent.parentElement
			)
				if (parent instanceof HTMLDetailsElement) parent.open = true;
			element.scrollIntoView({ block: "start" });
			reference.focus({ preventScroll: true });
		},
		setMode: (value: string) => {
			mode = value;
			filesHint.textContent =
				value === "full-task"
					? ""
					: "当前模式不产生工作区产物；如已有文件列表，请清空或切换到完整任务。";
		},
	};
}
export function judgeResultPanel(
	result: JudgeResult,
	loadInput?: () => Promise<JudgeInput>,
	options: { trial?: boolean } = {},
) {
	const element = node("section", "", "Box Box-body JudgeResult mt-3");
	const title =
		result.status === "scored"
			? `LLM 评分 ${result.score}/100`
			: `LLM 评分 · ${JUDGE_STATUS[result.status]}`;
	element.append(
		node("h3", title, "section-title"),
		node("p", result.rationale),
	);
	if (result.affectsOutcome && result.status === "scored")
		element.append(
			node(
				"p",
				`${result.meetsThreshold ? "达到" : "未达到"}及格分 ${result.passScore} · ${options.trial ? "试评分，不改原成绩" : "影响案例通过结果"}`,
				result.meetsThreshold ? "form-hint" : "field-error",
			),
		);
	else
		element.append(
			node(
				"p",
				options.trial
					? "历史试评分，不修改原成绩。"
					: result.affectsOutcome
						? "本次评分影响通过结果；评分不可用时不能认定评分条件通过。"
						: "仅评分，不改变原案例结论。",
				"form-hint",
			),
		);
	if (result.limitations.length) {
		const fold = node("details", "", "Verifier-details");
		fold.append(
			node("summary", "材料范围与完整性"),
			node("p", result.limitations.join("；"), "form-hint"),
		);
		element.append(fold);
	}
	const evidence = node("details", "", "Verifier-details");
	evidence.append(node("summary", `评分依据（${result.evidence.length}）`));
	for (const e of result.evidence) {
		evidence.append(node("p", e.ref, "mono"));
		if (e.quote) evidence.append(node("blockquote", e.quote));
	}
	element.append(evidence);
	const details = node("details", "", "Verifier-details");
	details.append(
		node("summary", "Judge 模型、用量与版本"),
		node(
			"p",
			`${result.model?.providerId ?? "—"} / ${result.model?.modelId ?? "—"} · ${result.durationMs}ms · 输入 ${result.usage.inputTokens ?? "未提供"} / 输出 ${result.usage.outputTokens ?? "未提供"} Token · 费用 ${result.usage.totalCost === undefined ? "未提供" : `$${result.usage.totalCost.toFixed(4)}`}`,
			"form-hint",
		),
		node(
			"p",
			`提示词 ${result.promptVersion} · 配置 ${result.configHash} · 输入 ${result.inputHash ?? "无"}`,
			"form-hint",
		),
	);
	element.append(details);
	if (loadInput && result.inputHash) {
		const preview = node("pre", "", "code");
		preview.hidden = true;
		let loaded = false;
		const button = judgeButton("查看实际送审材料", () => {
			if (loaded) {
				preview.hidden = !preview.hidden;
				return;
			}
			button.disabled = true;
			void loadInput()
				.then((input) => {
					preview.textContent = JSON.stringify(input, null, 2);
					preview.hidden = false;
					loaded = true;
				})
				.catch((e) => {
					preview.textContent = String(e);
					preview.hidden = false;
				})
				.finally(() => (button.disabled = false));
		});
		element.append(button, preview);
	}
	return element;
}
