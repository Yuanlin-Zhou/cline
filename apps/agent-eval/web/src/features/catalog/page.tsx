import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
	CaseListResponse,
	ModuleSummaryResponse,
} from "../../../../src/contracts/api";
import type { Module, SavedCase } from "../../../../src/contracts/catalog";
import type { CaseSummary } from "../../../../src/contracts/projections";
import { api, message, send, useApi } from "../../api/client";
import { assertValidEditors } from "../../components/editor-validity";
import { Tags } from "../../components/tags";
import {
	Alert,
	Box,
	Button,
	DataState,
	Field,
	Heading,
	JsonInput,
	Modal,
	Select,
	Status,
	Text,
	modeLabel,
	useNotice,
} from "../../components/ui";

type Summary = CaseSummary;
type CasesResponse = CaseListResponse;
const listState = new Map<
	string,
	{
		search: string;
		mode: string;
		bad: string;
		status: string;
		selected: Set<string>;
	}
>();
export function CasesPage() {
	const { moduleId } = useParams();
	const key = moduleId ?? "";
	const [view, setView] = useState(
		() =>
			listState.get(key) ?? {
				search: "",
				mode: "",
				bad: "",
				status: "",
				selected: new Set<string>(),
			},
	);
	useEffect(() => {
		setView(
			listState.get(key) ?? {
				search: "",
				mode: "",
				bad: "",
				status: "",
				selected: new Set(),
			},
		);
	}, [key]);
	useEffect(() => {
		listState.set(key, view);
	}, [key, view]);
	const modules = useApi<ModuleSummaryResponse>("/api/modules?view=summary");
	const cases = useApi<CasesResponse>(
		`/api/cases${moduleId ? `?moduleId=${encodeURIComponent(moduleId)}` : ""}`,
	);
	const navigate = useNavigate();
	const client = useQueryClient();
	const notice = useNotice();
	const [moduleEditor, setModuleEditor] = useState<Module | "new">();
	const [archived, setArchived] = useState(false);
	const [transfer, setTransfer] = useState<"copy" | "move">();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const dragging = useRef<{
		id: string;
		checked: boolean;
		moved: boolean;
	} | null>(null);
	const dragClick = useRef(false);
	const [dragToolbar, setDragToolbar] = useState<boolean>();
	const anchor = useRef<string | undefined>(undefined);
	useEffect(() => {
		const stop = () => {
			dragClick.current = dragging.current?.moved ?? false;
			dragging.current = null;
			setDragToolbar(undefined);
		};
		window.addEventListener("pointerup", stop);
		return () => window.removeEventListener("pointerup", stop);
	}, []);
	const rows = useMemo(
		() =>
			(cases.data?.cases ?? []).filter(
				(c) =>
					(!view.mode || c.definition.replayMode === view.mode) &&
					(!view.bad || !!c.definition.isBadCase === (view.bad === "bad")) &&
					(!view.status ||
						(cases.data?.latest[c.id]?.status ?? "none") === view.status) &&
					`${c.definition.id} ${c.definition.description ?? ""} ${(c.definition.tags ?? []).join(" ")}`
						.toLowerCase()
						.includes(view.search.toLowerCase()),
			),
		[cases.data, view.search, view.mode, view.bad, view.status],
	);
	const selected = (cases.data?.cases ?? []).filter((c) =>
		view.selected.has(c.id),
	);
	const select = (ids: string[], checked: boolean) =>
		setView((v) => {
			const next = new Set(v.selected);
			ids.forEach((id) => {
				if (checked) next.add(id);
				else next.delete(id);
			});
			return { ...v, selected: next };
		});
	const invalidate = () =>
		client.invalidateQueries({
			predicate: (q) =>
				String(q.queryKey[0]).startsWith("/api/cases") ||
				String(q.queryKey[0]).startsWith("/api/modules"),
		});
	async function action(fn: () => Promise<unknown>) {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await fn();
			await invalidate();
			notice("操作成功");
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	}
	async function deleteModule(module: Module) {
		await action(async () => {
			const preview = await send<any>(
				`/api/modules/${module.id}/delete-preview`,
				{},
			);
			const typed = window.prompt(
				`将永久删除模块和 ${preview.count} 个案例。请输入模块名称“${module.name}”确认`,
			);
			if (typed === null) return;
			await send(
				`/api/modules/${module.id}`,
				{ name: typed, expectedToken: preview.token },
				"DELETE",
			);
			if (moduleId === module.id) navigate("/cases");
		});
	}
	const startRun = (ids: string[], mods: string[] = []) =>
		navigate("/run/new", {
			state: { caseIds: ids, moduleIds: mods, returnTo: location.hash },
		});
	return (
		<>
			<Heading
				title={
					modules.data?.modules.find((m) => m.id === moduleId)?.name ??
					"全部案例"
				}
				description="跨模块查看、调试与批量评测案例"
			>
				<Link
					className="btn"
					to={`/import${moduleId ? `?module=${moduleId}` : ""}`}
				>
					导入案例
				</Link>
				<Link
					className="btn"
					to={`/case/new${moduleId ? `?module=${moduleId}` : ""}`}
				>
					新建案例
				</Link>
				<Button
					primary
					onClick={() =>
						startRun(
							selected.map((c) => c.id),
							selected.length
								? []
								: moduleId
									? [moduleId]
									: (modules.data?.modules.map((m) => m.id) ?? []),
						)
					}
				>
					新建评测
				</Button>
			</Heading>
			<Alert>{error}</Alert>
			<div className="react-catalog-layout">
				<aside className="react-module-list">
					<div className="flex-between">
						<strong>模块</strong>
						<Button onClick={() => setModuleEditor("new")}>＋ 新建模块</Button>
					</div>
					<Link
						className={`module-item ${!moduleId ? "active" : ""}`}
						to="/cases"
					>
						<strong>全部案例</strong>
						<span>
							{Object.values(modules.data?.counts ?? {}).reduce(
								(a, b) => a + b,
								0,
							)}
						</span>
						<small>跨模块搜索与筛选</small>
					</Link>
					<DataState query={modules}>
						{modules.data?.modules.map((m) => (
							<div
								key={m.id}
								className={`module-item ${m.id === moduleId ? "active" : ""}`}
							>
								<Link to={`/cases/${m.id}`}>
									<strong>{m.name}</strong>
								</Link>
								<span>{modules.data.counts[m.id] ?? 0}</span>
								<small>{m.description}</small>
								<div className="page-actions">
									<Button onClick={() => setModuleEditor(m)}>编辑</Button>
									<Button
										disabled={busy}
										onClick={() =>
											action(() => send(`/api/modules/${m.id}/archive`, {}))
										}
									>
										归档
									</Button>
									<Button
										danger
										disabled={busy}
										onClick={() => deleteModule(m)}
									>
										删除
									</Button>
								</div>
							</div>
						))}
					</DataState>
					<Button onClick={() => setArchived(true)}>已归档模块</Button>
				</aside>
				<section className="react-cases">
					<div className="react-filters">
						<Text
							aria-label="搜索案例"
							placeholder="按名称、描述或标签筛选…"
							value={view.search}
							onChange={(search) => setView((v) => ({ ...v, search }))}
						/>
						<Select
							aria-label="回放方式筛选"
							value={view.mode}
							onChange={(mode) => setView((v) => ({ ...v, mode }))}
							options={[
								["", "全部回放方式"],
								["single-turn", "单轮回放"],
								["full-task", "多轮回放（完整任务）"],
								["function-call", "单轮函数调用"],
							]}
						/>
						<Select
							value={view.bad}
							onChange={(bad) => setView((v) => ({ ...v, bad }))}
							options={[
								["", "全部案例"],
								["bad", "Bad case"],
								["normal", "非 Bad case"],
							]}
						/>
						<Select
							value={view.status}
							onChange={(status) => setView((v) => ({ ...v, status }))}
							options={[
								["", "全部结果"],
								["passed", "通过"],
								["failed", "失败"],
								["error", "执行错误"],
								["inconclusive", "无法判定"],
								["none", "未运行"],
							]}
						/>
						<span className="muted">{rows.length} 个案例</span>
					</div>
					<div className="page-actions mb-3">
						<Button
							onClick={() =>
								select(
									rows.map((c) => c.id),
									true,
								)
							}
						>
							全选筛选结果
						</Button>
						<Button
							onClick={() =>
								setView((v) => {
									const next = new Set(v.selected);
									rows.forEach((c) => {
										if (next.has(c.id)) next.delete(c.id);
										else next.add(c.id);
									});
									return { ...v, selected: next };
								})
							}
						>
							反选筛选结果
						</Button>
						<Button
							onClick={() => setView((v) => ({ ...v, selected: new Set() }))}
						>
							清空选择
						</Button>
						<span className="muted">拖动复选框列或 Shift 连选</span>
					</div>
					{(dragToolbar ?? view.selected.size > 0) && (
						<Box>
							<div className="page-actions">
								<strong>
									已选 {view.selected.size} 个（隐藏{" "}
									{
										Array.from(view.selected).filter(
											(id) => !rows.some((c) => c.id === id),
										).length
									}{" "}
									个）
								</strong>
								<Button
									primary
									onClick={() => startRun(selected.map((c) => c.id))}
								>
									运行所选
								</Button>
								<Button onClick={() => setTransfer("copy")}>复制到…</Button>
								<Button onClick={() => setTransfer("move")}>移动到…</Button>
								<Button
									danger
									disabled={busy}
									onClick={() =>
										window.confirm(
											`永久删除 ${selected.length} 个所选案例？`,
										) &&
										action(async () => {
											await send("/api/cases/delete-batch", {
												items: selected.map(({ id, revision }) => ({
													id,
													revision,
												})),
											});
											setView((v) => ({ ...v, selected: new Set() }));
										})
									}
								>
									删除所选
								</Button>
							</div>
						</Box>
					)}
					<DataState query={cases}>
						<div className="react-table-wrap">
							<table className="react-table">
								<thead>
									<tr>
										<th>
											<input
												aria-label="选择筛选结果"
												type="checkbox"
												checked={
													rows.length > 0 &&
													rows.every((c) => view.selected.has(c.id))
												}
												onChange={(e) =>
													select(
														rows.map((c) => c.id),
														e.target.checked,
													)
												}
											/>
										</th>
										<th>案例</th>
										<th>回放方式</th>
										<th>标签</th>
										<th>版本</th>
										<th>最近结果</th>
										<th>操作</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((c) => (
										<tr
											key={c.id}
											className={view.selected.has(c.id) ? "selected" : ""}
										>
											<td
												onPointerDown={() => {
													setDragToolbar(view.selected.size > 0);
													dragClick.current = false;
													dragging.current = {
														id: c.id,
														checked: !view.selected.has(c.id),
														moved: false,
													};
												}}
												onPointerEnter={() => {
													const drag = dragging.current;
													if (drag && drag.id !== c.id) {
														drag.moved = true;
														select([drag.id, c.id], drag.checked);
													}
												}}
											>
												<input
													aria-label={`选择 ${c.definition.id}`}
													type="checkbox"
													checked={view.selected.has(c.id)}
													onClick={(e) => {
														if (dragClick.current) {
															dragClick.current = false;
															anchor.current = c.id;
															return;
														}
														if (e.shiftKey && anchor.current !== undefined) {
															const from = rows.findIndex(
																(row) => row.id === anchor.current,
															);
															const to = rows.findIndex(
																(row) => row.id === c.id,
															);
															select(
																(from < 0
																	? [c]
																	: rows.slice(
																			Math.min(from, to),
																			Math.max(from, to) + 1,
																		)
																).map((row) => row.id),
																!view.selected.has(c.id),
															);
														} else select([c.id], !view.selected.has(c.id));
														anchor.current = c.id;
													}}
													onChange={() => {}}
												/>
											</td>
											<td>
												<Link className="case-name" to={`/case/${c.id}`}>
													{c.definition.id}
												</Link>
												{c.definition.isBadCase && (
													<span className="Label Label--danger">Bad case</span>
												)}
												<small className="muted react-block">
													{c.definition.description}
												</small>
											</td>
											<td>{modeLabel(c.definition.replayMode)}</td>
											<td>
												{(c.definition.tags ?? []).map((t) => (
													<span key={t} className="Label">
														{t}
													</span>
												))}
											</td>
											<td>v{c.revision}</td>
											<td>
												<Status value={cases.data?.latest[c.id]?.status} />
											</td>
											<td>
												<div className="page-actions">
													<Button onClick={() => startRun([c.id])}>运行</Button>
													<Link className="btn" to={`/case/${c.id}`}>
														编辑
													</Link>
													<Button
														onClick={() => {
															select([c.id], true);
															setTransfer("copy");
														}}
													>
														复制
													</Button>
													<Button
														danger
														disabled={busy}
														onClick={() =>
															window.confirm(
																`永久删除“${c.definition.id}”？`,
															) &&
															action(() =>
																send(`/api/cases/${c.id}`, undefined, "DELETE"),
															)
														}
													>
														删除
													</Button>
												</div>
											</td>
										</tr>
									))}
								</tbody>
							</table>
							{!rows.length && (
								<div className="empty">
									没有匹配的案例，试试调整筛选条件或导入案例。
								</div>
							)}
						</div>
					</DataState>
				</section>
			</div>
			{moduleEditor && (
				<ModuleDialog
					module={moduleEditor === "new" ? undefined : moduleEditor}
					close={() => setModuleEditor(undefined)}
					done={invalidate}
				/>
			)}
			{archived && (
				<ArchivedModules close={() => setArchived(false)} done={invalidate} />
			)}
			{transfer && (
				<TransferDialog
					operation={transfer}
					selected={selected}
					modules={modules.data?.modules ?? []}
					close={() => setTransfer(undefined)}
					done={() => {
						setView((v) => ({ ...v, selected: new Set() }));
						void invalidate();
					}}
				/>
			)}
		</>
	);
}
function ModuleDialog({
	module,
	close,
	done,
}: {
	module?: Module;
	close: () => void;
	done: () => unknown;
}) {
	const [value, setValue] = useState({
		name: module?.name ?? "",
		description: module?.description ?? "",
		tags: module?.tags ?? [],
	});
	const save = useMutation({
		mutationFn: () =>
			send(
				module ? `/api/modules/${module.id}` : "/api/modules",
				value,
				module ? "PUT" : "POST",
			),
		onSuccess: () => {
			done();
			close();
		},
	});
	return (
		<Modal open onClose={close} title={module ? "编辑模块" : "新建模块"}>
			<Field label="模块名称">
				<Text
					aria-label="模块名称"
					value={value.name}
					onChange={(name) => setValue((v) => ({ ...v, name }))}
				/>
			</Field>
			<Field label="描述">
				<Text
					value={value.description}
					onChange={(description) => setValue((v) => ({ ...v, description }))}
				/>
			</Field>
			<Field label="标签">
				<Tags
					value={value.tags}
					onChange={(tags) => setValue((v) => ({ ...v, tags }))}
					limit={20}
				/>
			</Field>
			<Alert>{save.error && message(save.error)}</Alert>
			<Button
				primary
				disabled={save.isPending || !value.name.trim()}
				onClick={() => save.mutate()}
			>
				保存模块
			</Button>
		</Modal>
	);
}
function ArchivedModules({
	close,
	done,
}: {
	close: () => void;
	done: () => unknown;
}) {
	const query = useApi<Module[]>("/api/modules?includeArchived=1");
	const restore = useMutation({
		mutationFn: (id: string) => send(`/api/modules/${id}/unarchive`, {}),
		onSuccess: () => {
			void query.refetch();
			done();
		},
	});
	return (
		<Modal open onClose={close} title="已归档模块">
			<DataState query={query}>
				{query.data
					?.filter((m) => m.archived)
					.map((m) => (
						<div key={m.id} className="flex-between">
							<strong>{m.name}</strong>
							<Button
								disabled={restore.isPending}
								onClick={() => restore.mutate(m.id)}
							>
								恢复模块
							</Button>
						</div>
					))}
				{!query.data?.some((m) => m.archived) && (
					<p className="empty">没有已归档模块</p>
				)}
			</DataState>
			<Alert>{restore.error && message(restore.error)}</Alert>
		</Modal>
	);
}
export function TransferDialog({
	operation,
	selected,
	modules,
	close,
	done,
}: {
	operation: "copy" | "move";
	selected: Array<Pick<SavedCase, "id" | "revision">>;
	modules: Module[];
	close: () => void;
	done: () => void;
}) {
	const [target, setTarget] = useState(modules[0]?.id ?? "");
	const [policy, setPolicy] = useState("rename");
	const [drafts, setDrafts] = useState<
		Record<
			string,
			{ definition: SavedCase["definition"]; defaults: SavedCase["defaults"] }
		>
	>({});
	const [editing, setEditing] = useState<string>();
	const [preview, setPreview] = useState<any>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const payload = () => ({
		operation,
		targetModuleId: target,
		conflictPolicy: policy,
		items: selected.map((c) => ({
			id: c.id,
			revision: c.revision,
			...(drafts[c.id] ? { draft: drafts[c.id] } : {}),
		})),
	});
	async function run(apply: boolean) {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			assertValidEditors();
			const body: any = payload();
			if (apply)
				body.items = body.items.map((item: any) => {
					const row = preview.items.find((r: any) => r.id === item.id);
					return {
						...item,
						expectedDefinitionId: row.proposedDefinitionId,
						...(row.draftFingerprint
							? { expectedDraftFingerprint: row.draftFingerprint }
							: {}),
					};
				});
			const result = await send<any>(
				apply ? "/api/cases/transfer" : "/api/cases/transfer/preview",
				body,
			);
			if (apply) {
				done();
				close();
			} else setPreview(result);
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	}
	async function edit(id: string) {
		setError("");
		try {
			if (!drafts[id]) {
				const c = await api<SavedCase>(`/api/cases/${id}`);
				setDrafts((v) => ({
					...v,
					[id]: { definition: c.definition, defaults: c.defaults },
				}));
			}
			setEditing(id);
			setPreview(undefined);
		} catch (e) {
			setError(message(e));
		}
	}
	return (
		<Modal
			open
			onClose={close}
			title={operation === "copy" ? "复制案例与配置" : "移动案例"}
		>
			<Field label="目标模块">
				<Select
					value={target}
					onChange={(v) => {
						setTarget(v);
						setPreview(undefined);
					}}
					options={modules.map((m) => [m.id, m.name])}
				/>
			</Field>
			<Field label="同名处理">
				<Select
					value={policy}
					onChange={(v) => {
						setPolicy(v);
						setPreview(undefined);
					}}
					options={[
						["rename", "自动重命名"],
						["abort", "中止并提示冲突"],
					]}
				/>
			</Field>
			{operation === "copy" &&
				selected.map((c) => (
					<Button key={c.id} disabled={busy} onClick={() => edit(c.id)}>
						编辑副本配置{drafts[c.id] ? "（已修改）" : ""}
					</Button>
				))}
			{editing && drafts[editing] && (
				<Box title="副本草稿（原案例不变）">
					<JsonInput
						label="副本案例与执行配置"
						value={drafts[editing]}
						onChange={(v) => {
							setDrafts((d) => ({ ...d, [editing]: v }));
							setPreview(undefined);
						}}
					/>
					<Button onClick={() => setEditing(undefined)}>完成副本编辑</Button>
				</Box>
			)}
			{preview && (
				<Box title="预览">
					{preview.items.map((row: any) => (
						<p key={row.id}>
							{row.originalDefinitionId} → {row.targetModuleName} /{" "}
							{row.proposedDefinitionId} {row.conflict && "（同名冲突）"}
						</p>
					))}
				</Box>
			)}
			<Alert>{error}</Alert>
			<div className="page-actions">
				<Button disabled={busy || !target} onClick={() => run(false)}>
					预览
				</Button>
				<Button
					primary
					disabled={busy || !preview?.canApply}
					onClick={() => run(true)}
				>
					确认{operation === "copy" ? "复制" : "移动"}
				</Button>
			</div>
		</Modal>
	);
}
