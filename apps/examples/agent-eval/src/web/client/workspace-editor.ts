import { node } from "./verifier-ui.js";
import {
	parseWorkspace,
	type WorkspaceConfig,
} from "../../workspace-config.js";
export function workspaceEditor(
	prefix: string,
	cwd?: string,
	config?: WorkspaceConfig,
) {
	const element = node("div", "", "WorkspaceEditor");
	const mode = node("select", "", "form-control");
	mode.id = `${prefix}-workspace-mode`;
	mode.append(
		new Option("复制后执行（每次独立副本）", "copy"),
		new Option("直接在指定目录执行", "direct"),
	);
	mode.value = config?.mode ?? "copy";
	const field = (
		label: string,
		control: HTMLInputElement | HTMLSelectElement,
		hint: string,
	) => {
		const group = node("div", "", "form-group");
		const title = node("label", label, "form-label");
		title.htmlFor = control.id;
		const help = node("p", hint, "form-hint");
		group.append(title, control, help);
		element.append(group);
		return { group, title, help };
	};
	field("工作区执行方式", mode, "仅用于多轮回放（完整任务）。");
	const source = node("input", "", "form-control");
	source.id = `${prefix}-cwd`;
	source.value = cwd ?? "";
	const sourceField = field("初始工作区目录（可选）", source, "");
	const copyRoot = node("input", "", "form-control");
	copyRoot.id = `${prefix}-copy-root`;
	copyRoot.value = config?.mode === "copy" ? (config.copyRoot ?? "") : "";
	const copyField = field(
		"副本保存根目录（可选）",
		copyRoot,
		"留空使用本轮默认目录；填写后每个案例和轮次在该目录下创建独立子目录，不覆盖已有文件。",
	);
	const notice = node("p", "", "form-hint");
	const error = node("p", "", "Grading-error");
	error.setAttribute("role", "alert");
	element.append(notice, error);
	const sync = () => {
		const direct = mode.value === "direct";
		copyField.group.hidden = direct;
		sourceField.title.textContent = direct
			? "执行目录（必填）"
			: "初始工作区目录（可选）";
		sourceField.help.textContent = direct
			? "服务端已存在的绝对路径。将在该目录直接读写文件。"
			: "服务端绝对路径；留空从空工作区启动，初始目录仅作复制来源。";
		notice.textContent = direct
			? "修改会保留在原目录，重复运行沿用当前文件状态；不会自动恢复或清理。同目录任务按序执行。"
			: "每次运行复制初始目录，工作区副本保留供查看；忽略 .git、node_modules、.cline 和 .eval-data。";
		error.textContent = "";
		source.removeAttribute("aria-invalid");
	};
	source.oninput = () => {
		source.removeAttribute("aria-invalid");
		error.textContent = "";
	};
	mode.onchange = sync;
	sync();
	return {
		element,
		read(validate = true) {
			const value = parseWorkspace({
				mode: mode.value,
				...(mode.value === "copy" && copyRoot.value.trim()
					? { copyRoot: copyRoot.value.trim() }
					: {}),
			})!;
			if (validate && value.mode === "direct" && !source.value.trim()) {
				error.textContent = "直接执行必须填写执行目录。";
				source.setAttribute("aria-invalid", "true");
				const panel = source.closest('[role="tabpanel"]');
				if (panel?.id)
					document
						.querySelector<HTMLButtonElement>(`[aria-controls="${panel.id}"]`)
						?.click();
				source.focus();
				throw Error(error.textContent);
			}
			error.textContent = "";
			source.removeAttribute("aria-invalid");
			return value;
		},
	};
}
