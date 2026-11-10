import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { EvalDefaults } from "../../../../src/contracts/evaluation";
import { message, send, useApi } from "../../api/client";
import { assertValidEditors } from "../../components/editor-validity";
import {
	Alert,
	Box,
	Button,
	Check,
	DataState,
	Field,
	Heading,
	JsonView,
	Select,
	Text,
	modeLabel,
} from "../../components/ui";
import { ConfigEditor } from "../settings/config-editor";

export function NewRunPage() {
	const cases = useApi<any>("/api/cases");
	const modules = useApi<any>("/api/modules?view=summary");
	const settings = useApi<EvalDefaults>("/api/settings");
	return (
		<>
			<Heading
				title="新建评测"
				description="选择案例、确认运行配置，再提交执行"
			/>
			<DataState query={cases}>
				{cases.data && modules.data && settings.data && (
					<RunWizard
						cases={cases.data.cases}
						modules={modules.data.modules}
						settings={settings.data}
					/>
				)}
			</DataState>
			<Alert>
				{(modules.error && message(modules.error)) ||
					(settings.error && message(settings.error))}
			</Alert>
		</>
	);
}
function RunWizard({
	cases,
	modules,
	settings,
}: {
	cases: any[];
	modules: any[];
	settings: EvalDefaults;
}) {
	const scope = useLocation().state as any;
	const [selected, setSelected] = useState<Set<string>>(
		() =>
			new Set(
				cases
					.filter(
						(c) =>
							scope?.caseIds?.includes(c.id) ||
							scope?.moduleIds?.includes(c.moduleId),
					)
					.map((c) => c.id),
			),
	);
	const [step, setStep] = useState(1);
	const [search, setSearch] = useState("");
	const [moduleId, setModuleId] = useState("");
	const [name, setName] = useState("");
	const [note, setNote] = useState("");
	const [repeatCount, setRepeat] = useState(1);
	const [concurrency, setConcurrency] = useState(1);
	const [replayMode, setMode] = useState("");
	const [useSettings, setUseSettings] = useState(false);
	const [custom, setCustom] = useState(false);
	const [defaults, setDefaults] = useState(settings);
	const [error, setError] = useState("");
	const navigate = useNavigate();
	const body = {
		name: name || undefined,
		note: note || undefined,
		caseIds: Array.from(selected),
		repeatCount,
		concurrency,
		replayMode: replayMode || undefined,
		useSettings,
		...(custom ? { defaults } : {}),
	};
	const submit = useMutation({
		mutationFn: () => send<any>("/api/runs", body),
		onSuccess: (run) => navigate(`/run/${run.id}`),
	});
	const visible = cases.filter(
		(c) =>
			(!moduleId || c.moduleId === moduleId) &&
			`${c.definition.id} ${c.definition.description ?? ""} ${(c.definition.tags ?? []).join(" ")}`
				.toLowerCase()
				.includes(search.toLowerCase()),
	);
	const toggle = (id: string, checked: boolean) =>
		setSelected((v) => {
			const next = new Set(v);
			checked ? next.add(id) : next.delete(id);
			return next;
		});
	function next() {
		try {
			assertValidEditors();
		} catch (e) {
			setError(message(e));
			return;
		}
		if (!selected.size) {
			setError("请选择至少一个案例");
			return;
		}
		if (
			!Number.isInteger(repeatCount) ||
			repeatCount < 1 ||
			repeatCount > 100 ||
			!Number.isInteger(concurrency) ||
			concurrency < 1 ||
			concurrency > 4
		) {
			setError("重复轮数须为 1–100，并发数须为 1–4");
			return;
		}
		setError("");
		setStep((s) => s + 1);
	}
	return (
		<>
			<div className="react-row mb-3">
				{["选择案例", "运行配置", "确认提交"].map((label, i) => (
					<span
						key={label}
						className={`Label ${step === i + 1 ? "Label--accent" : ""}`}
					>
						{i + 1}. {label}
					</span>
				))}
			</div>
			{step === 1 && (
				<Box title={`选择案例 · 已选 ${selected.size}`}>
					<div className="react-filters">
						<Text value={search} onChange={setSearch} placeholder="搜索案例" />
						<Select
							value={moduleId}
							onChange={setModuleId}
							options={[
								["", "全部模块"],
								...modules.map((m) => [m.id, m.name] as [string, string]),
							]}
						/>
					</div>
					<div className="page-actions">
						<Button
							onClick={() =>
								setSelected((v) => new Set([...v, ...visible.map((c) => c.id)]))
							}
						>
							全选筛选结果
						</Button>
						<Button onClick={() => setSelected(new Set())}>清空选择</Button>
					</div>
					<div className="react-table-wrap">
						<table className="react-table">
							<thead>
								<tr>
									<th>选择</th>
									<th>案例</th>
									<th>模块</th>
									<th>回放方式</th>
									<th>模型</th>
								</tr>
							</thead>
							<tbody>
								{visible.map((c) => (
									<tr key={c.id}>
										<td>
											<input
												type="checkbox"
												aria-label={`选择 ${c.definition.id}`}
												checked={selected.has(c.id)}
												onChange={(e) => toggle(c.id, e.target.checked)}
											/>
										</td>
										<td>
											<span className="case-name">{c.definition.id}</span>
											{c.definition.isBadCase && (
												<span className="Label Label--danger">Bad case</span>
											)}
										</td>
										<td>{modules.find((m) => m.id === c.moduleId)?.name}</td>
										<td>{modeLabel(c.definition.replayMode)}</td>
										<td>{c.defaults.modelId}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Box>
			)}
			{step === 2 && (
				<>
					<Box title="批次配置">
						<Field label="批次名称">
							<Text value={name} onChange={setName} />
						</Field>
						<Field label="备注">
							<Text multiline value={note} onChange={setNote} />
						</Field>
						<div className="react-grid">
							<Field label="重复轮数">
								<Text
									type="number"
									min={1}
									max={100}
									value={repeatCount}
									onChange={(v) => setRepeat(Number(v))}
								/>
							</Field>
							<Field label="并发数">
								<Text
									type="number"
									min={1}
									max={4}
									value={concurrency}
									onChange={(v) => setConcurrency(Number(v))}
								/>
							</Field>
						</div>
						<Field label="回放方式">
							<Select
								value={replayMode}
								onChange={setMode}
								options={[
									["", "使用案例自身方式"],
									["single-turn", "强制单轮回放"],
									["full-task", "强制完整任务"],
									["function-call", "强制单轮函数调用"],
								]}
							/>
						</Field>
						<Check checked={useSettings} onChange={setUseSettings}>
							使用当前全局默认配置替换案例 defaults
						</Check>
						<Check checked={custom} onChange={setCustom}>
							指定本批次运行配置覆盖
						</Check>
						{custom && <ConfigEditor value={defaults} onChange={setDefaults} />}
					</Box>
				</>
			)}
			{step === 3 && (
				<Box title="确认执行">
					<p>
						{selected.size} 个案例 × {repeatCount} 轮，共{" "}
						{selected.size * repeatCount} 次执行，并发 {concurrency}。
					</p>
					<p>
						{useSettings ? "使用当前全局 defaults" : "保留案例 defaults"}
						{custom && "，应用本批次配置覆盖"}。任务将使用提交时的配置快照。
					</p>
					<details>
						<summary>查看提交配置</summary>
						<JsonView value={body} />
					</details>
				</Box>
			)}
			<Alert>{error || (submit.error && message(submit.error))}</Alert>
			<div className="page-actions">
				<Button
					onClick={() =>
						navigate(scope?.returnTo?.replace(/^#/, "") ?? "/runs")
					}
				>
					取消
				</Button>
				{step > 1 && (
					<Button
						disabled={submit.isPending}
						onClick={() => setStep((s) => s - 1)}
					>
						上一步
					</Button>
				)}
				{step < 3 ? (
					<Button primary onClick={next}>
						下一步
					</Button>
				) : (
					<Button
						primary
						disabled={submit.isPending}
						onClick={() => submit.mutate()}
					>
						{submit.isPending ? "提交中…" : "开始评测"}
					</Button>
				)}
			</div>
		</>
	);
}
