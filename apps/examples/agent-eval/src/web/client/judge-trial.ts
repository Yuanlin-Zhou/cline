import type {
	JudgeConfig,
	JudgeInput,
	JudgeResult,
} from "../../judge/types.js";
import {
	judgeNode as node,
	judgeButton as button,
	judgeField as field,
	judgeResultPanel,
	type JudgeApi,
} from "./judge-ui.js";
type Target = { runId: string; itemId: string; label: string };
type Task = {
	id: string;
	runId: string;
	itemId: string;
	status: string;
	trial: boolean;
	config: JudgeConfig;
	result?: JudgeResult;
	error?: string;
	input?: JudgeInput;
};
export function judgeTrial(options: {
	api: JudgeApi;
	config: JudgeConfig;
	caseId?: string;
	runId?: string;
	itemId?: string;
}) {
	const { api, config } = options;
	const element = node("section", "", "JudgeTrial");
	const hint = node(
		"p",
		"试评分会调用 Judge 并产生用量，不调用被测模型，不修改原正式评分或批次结论。关闭窗口后后台继续，可用“停止试评分”取消。",
		"form-hint",
	);
	const select = node("select", "", "form-control");
	select.setAttribute("aria-label", "试评分的历史执行");
	const notice = node("div", "", "form-hint");
	notice.setAttribute("role", "status");
	const result = node("div"),
		input = node("pre", "", "code");
	input.hidden = true;
	const materialList = node("div", "", "JudgeMaterials");
	const rawInput = node("details", "", "Verifier-details");
	rawInput.hidden = true;
	rawInput.append(node("summary", "查看送审原文"), input);
	const actions = node("div", "", "flex-center gap-2 wrap");
	let targets: Target[] = [],
		current: Task | undefined,
		preview: { input: JudgeInput; config: JudgeConfig } | undefined,
		timer: ReturnType<typeof setTimeout> | undefined,
		disposed = false,
		version = 0,
		busy = false;
	let requestId = crypto.randomUUID();
	const target = () => targets[select.selectedIndex];
	const base = () => {
		const t = target();
		if (!t) throw Error("没有可评分的历史执行");
		return `/api/runs/${t.runId}/items/${t.itemId}/judge-scores`;
	};
	const paint = () => {
		const active = current && ["queued", "running"].includes(current.status);
		select.disabled = busy || !!active;
		start.disabled = busy || !!active || !preview;
		view.disabled = busy || !!active || !target();
		stop.disabled = !active;
		if (current?.result)
			result.replaceChildren(
				node("p", "试评分结果（不影响原成绩）", "form-hint"),
				judgeResultPanel(
					current.result,
					() =>
						api<Task>(`${base()}/${current!.id}?input=1`).then((t) => t.input!),
					{ trial: true },
				),
			);
		else if (current?.error)
			result.replaceChildren(node("p", current.error, "field-error"));
		else
			result.replaceChildren(
				...(active ? [node("p", "Judge 试评分中…", "form-hint")] : []),
			);
	};
	const poll = async () => {
		if (disposed || !current) return;
		const epoch = version;
		try {
			const task = await api<Task>(`${base()}/${current.id}`);
			if (disposed || epoch !== version) return;
			current = task;
			notice.textContent = ["queued", "running"].includes(task.status)
				? "Judge 试评分中…"
				: task.status === "cancelled"
					? "试评分已取消"
					: "试评分已结束";
			paint();
			if (["queued", "running"].includes(task.status))
				timer = setTimeout(() => void poll(), 600);
		} catch (e) {
			notice.textContent = `同步失败：${String(e)}`;
			if (!disposed) timer = setTimeout(() => void poll(), 1500);
		}
	};
	const load = async () => {
		clearTimeout(timer);
		const epoch = ++version;
		preview = undefined;
		current = undefined;
		input.hidden = true;
		rawInput.hidden = true;
		rawInput.open = false;
		materialList.replaceChildren();
		result.replaceChildren();
		notice.textContent = "预览送审材料后可开始试评分。";
		requestId = crypto.randomUUID();
		paint();
		if (!target()) return;
		try {
			const tasks = await api<Task[]>(base());
			if (disposed || epoch !== version) return;
			current = tasks[0];
			paint();
			if (current && ["queued", "running"].includes(current.status))
				void poll();
		} catch (e) {
			notice.textContent = String(e);
		}
	};
	const view = button("预览送审材料", () => {
		void (async () => {
			if (busy) return;
			busy = true;
			paint();
			const epoch = version;
			try {
				const data = await api<{ input: JudgeInput; config: JudgeConfig }>(
					`${base()}/preview`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ config }),
					},
				);
				if (disposed || epoch !== version) return;
				preview = data;
				input.textContent = JSON.stringify(data.input, null, 2);
				input.hidden = false;
				rawInput.hidden = false;
				rawInput.open = false;
				materialList.replaceChildren(
					node(
						"p",
						`送审材料 · ${new TextEncoder().encode(JSON.stringify(data.input)).length.toLocaleString()} 字节`,
						"form-hint",
					),
					...data.input.sources.map((source) =>
						node("p", `${source.title} · ${source.completeness}`, "small"),
					),
					...data.input.limitations.map((text) =>
						node("p", text, "Verifier-warning"),
					),
				);
				notice.textContent = `仅预览，尚未调用 Judge。送审 ${data.input.sources.length} 段材料。`;
				requestId = crypto.randomUUID();
			} catch (e) {
				notice.textContent = String(e);
			} finally {
				busy = false;
				paint();
			}
		})();
	});
	const start = button("开始试评分", () => {
		void (async () => {
			if (!preview || busy) return;
			busy = true;
			paint();
			try {
				current = await api<Task>(base(), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requestId, config: preview.config }),
				});
				notice.textContent = "已提交，Judge 试评分中…";
				void poll();
			} catch (e) {
				notice.textContent = String(e);
			} finally {
				busy = false;
				paint();
			}
		})();
	});
	const stop = button("停止试评分", () => {
		if (!current) return;
		stop.disabled = true;
		void api(`${base()}/${current.id}/cancel`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		})
			.then(() => {
				notice.textContent = "已请求停止，等待评分结束…";
			})
			.catch((e) => {
				notice.textContent = String(e);
			});
	});
	select.onchange = () => void load();
	actions.append(view, start, stop);
	element.append(
		hint,
		field("历史执行", select),
		actions,
		notice,
		materialList,
		rawInput,
		result,
	);
	void (async () => {
		try {
			if (options.runId && options.itemId)
				targets = [
					{
						runId: options.runId,
						itemId: options.itemId,
						label: "当前选中的执行",
					},
				];
			else if (options.caseId) {
				const runs = await api<
					Array<{
						id: string;
						name: string;
						items: Array<{
							id: string;
							round?: number;
							attempt?: number;
							status: string;
						}>;
					}>
				>(`/api/cases/${options.caseId}/runs`);
				targets = runs.flatMap((r) =>
					[...r.items]
						.reverse()
						.filter((i) => !["queued", "running"].includes(i.status))
						.map((i) => ({
							runId: r.id,
							itemId: i.id,
							label: `${r.name} · 第 ${i.round ?? 1} 轮 · ${i.attempt ? `重试 ${i.attempt}` : "首次执行"} · ${i.status}`,
						})),
				);
			}
			for (const t of targets) {
				const option = node("option", t.label);
				option.value = t.itemId;
				select.append(option);
			}
			if (!targets.length)
				notice.textContent =
					"暂无已保存的历史执行。先保存并运行案例，再选择历史试评分。";
			await load();
		} catch (e) {
			notice.textContent = String(e);
		}
	})();
	const observer = new MutationObserver(() => {
		if (!element.isConnected) {
			disposed = true;
			clearTimeout(timer);
			observer.disconnect();
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	return element;
}
