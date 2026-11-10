import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import {
	pythonArtifactTemplate,
	pythonConversationTemplate,
	pythonFields,
	pythonReplyTemplate,
} from "../../../../src/modules/grading/python-guide";
import { message, send, useApi } from "../../api/client";
import {
	Alert,
	Box,
	Button,
	DataState,
	Field,
	Heading,
	JsonView,
	Modal,
	Select,
	Text,
	useNotice,
} from "../../components/ui";
import { useDraft } from "../../hooks/draft";

export function VerifiersPage() {
	const list = useApi<any>("/api/verifiers?manage=1");
	const runtime = useApi<any>("/api/verifiers/runtime-status");
	const [selected, setSelected] = useState<string>();
	const [upload, setUpload] = useState(false);
	const [guide, setGuide] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [search, setSearch] = useState("");
	const choose = (id: string) => {
		if (dirty && !confirm("有未保存的修改，确定切换脚本？")) return;
		setDirty(false);
		setSelected(id);
	};
	return (
		<>
			<Heading
				title="验证脚本"
				description="管理团队的验收脚本及引用关系；历史运行使用已冻结的脚本版本"
			>
				<Button onClick={() => setGuide(true)}>编写指南</Button>
				<Button primary onClick={() => setUpload(true)}>
					上传 .py
				</Button>
			</Heading>
			<DataState query={runtime}>
				{runtime.data && (
					<Alert kind={runtime.data.ready ? "success" : "warning"}>
						{runtime.data.ready
							? "Python 运行环境已就绪"
							: "Python 尚未就绪，脚本可上传，执行前需配置运行环境"}
						<details>
							<summary>环境详情</summary>
							<JsonView value={runtime.data} />
						</details>
					</Alert>
				)}
			</DataState>
			<Text
				aria-label="搜索脚本"
				placeholder="搜索脚本名称"
				value={search}
				onChange={setSearch}
			/>
			<div className="react-grid mt-3">
				<Box title="脚本库">
					<DataState query={list}>
						{list.data?.verifiers
							.filter((v: any) =>
								`${v.label} ${v.filename ?? v.id}`
									.toLowerCase()
									.includes(search.toLowerCase()),
							)
							.map((v: any) => (
								<div key={v.id} className="module-item">
									<Button onClick={() => choose(v.id)}>
										{v.label ?? v.filename ?? v.id}
									</Button>
									<p className="form-hint">
										{v.source === "uploaded" ? "用户上传" : "配置注册"} ·{" "}
										{v.runtime} · {v.version} · 引用 {v.referenceCount ?? "—"}
									</p>
								</div>
							))}
						{!list.data?.verifiers.length && (
							<p className="empty">还没有验证脚本，上传一个 .py 文件开始。</p>
						)}
					</DataState>
				</Box>
				{selected && (
					<VerifierDetail
						key={selected}
						id={selected}
						onDirty={setDirty}
						done={() => list.refetch()}
						close={() => setSelected(undefined)}
					/>
				)}
			</div>
			{upload && (
				<UploadDialog
					close={() => setUpload(false)}
					done={() => list.refetch()}
				/>
			)}
			{guide && <Guide close={() => setGuide(false)} />}
		</>
	);
}
function VerifierDetail({
	id,
	onDirty,
	done,
	close,
}: {
	id: string;
	onDirty: (value: boolean) => void;
	done: () => unknown;
	close: () => void;
}) {
	const query = useApi<any>(`/api/verifiers/${id}`);
	return (
		<DataState query={query}>
			{query.data && (
				<VerifierEditor
					initial={query.data}
					onDirty={onDirty}
					done={done}
					close={close}
				/>
			)}
		</DataState>
	);
}
function VerifierEditor({
	initial,
	onDirty,
	done,
	close,
}: {
	initial: any;
	onDirty: (value: boolean) => void;
	done: () => unknown;
	close: () => void;
}) {
	const draft = useDraft({
		filename: initial.filename,
		label: initial.label,
		content: initial.content,
	});
	const [token, setToken] = useState(initial.token);
	const [error, setError] = useState("");
	const notice = useNotice();
	useEffect(() => {
		onDirty(draft.dirty);
	}, [draft.dirty, onDirty]);
	const save = useMutation({
		mutationFn: () =>
			send<any>(
				`/api/verifiers/${initial.id}`,
				{ ...draft.value, expectedToken: token },
				"PUT",
			),
		onSuccess: (value) => {
			setToken(value.token);
			draft.markSaved();
			notice("脚本已保存");
			done();
		},
	});
	const remove = useMutation({
		mutationFn: () =>
			send(`/api/verifiers/${initial.id}`, { expectedToken: token }, "DELETE"),
		onSuccess: () => {
			flushSync(() => draft.markSaved());
			done();
			close();
		},
	});
	return (
		<Box title="脚本详情">
			<Field label="文件名">
				<Text
					value={draft.value.filename}
					onChange={(filename) => draft.setValue((v) => ({ ...v, filename }))}
				/>
			</Field>
			<Field label="名称">
				<Text
					value={draft.value.label}
					onChange={(label) => draft.setValue((v) => ({ ...v, label }))}
				/>
			</Field>
			<Field label="Python 源码">
				<Text
					multiline
					className="mono react-editor"
					value={draft.value.content}
					onChange={(content) => draft.setValue((v) => ({ ...v, content }))}
				/>
			</Field>
			<Alert>
				{error ||
					(save.error && message(save.error)) ||
					(remove.error && message(remove.error))}
			</Alert>
			<div className="page-actions">
				<Button
					primary
					disabled={save.isPending || remove.isPending}
					onClick={() => save.mutate()}
				>
					保存脚本
				</Button>
				<Button
					danger
					disabled={
						save.isPending || remove.isPending || !!initial.references?.length
					}
					onClick={() => confirm("永久删除此脚本？") && remove.mutate()}
				>
					删除脚本
				</Button>
			</div>
			<details>
				<summary>引用案例（{initial.references?.length ?? 0}）</summary>
				{initial.references?.map((r: any) => (
					<p key={r.id}>
						<a href={`#/case/${r.id}`}>
							{r.moduleName} / {r.name}
						</a>
						{r.archived && "（已归档）"}
					</p>
				))}
			</details>
		</Box>
	);
}
export function UploadDialog({
	close,
	done,
}: {
	close: () => void;
	done: () => unknown;
}) {
	const [filename, setFilename] = useState("verify_case.py");
	const [label, setLabel] = useState("");
	const [content, setContent] = useState(pythonReplyTemplate);
	const upload = useMutation({
		mutationFn: () =>
			send("/api/verifiers", { filename, label: label || filename, content }),
		onSuccess: () => {
			done();
			close();
		},
	});
	return (
		<Modal open onClose={close} title="上传 Python 验证脚本">
			<input
				type="file"
				accept=".py"
				onChange={async (e) => {
					const file = e.target.files?.[0];
					if (file) {
						setFilename(file.name);
						setContent(await file.text());
					}
				}}
			/>
			<Field label="文件名">
				<Text value={filename} onChange={setFilename} />
			</Field>
			<Field label="脚本名称">
				<Text value={label} onChange={setLabel} />
			</Field>
			<Field label="脚本源码">
				<Text
					multiline
					className="mono react-editor"
					value={content}
					onChange={setContent}
				/>
			</Field>
			<Alert>{upload.error && message(upload.error)}</Alert>
			<Button
				primary
				disabled={upload.isPending}
				onClick={() => upload.mutate()}
			>
				上传脚本
			</Button>
		</Modal>
	);
}
export function Guide({ close }: { close: () => void }) {
	const [template, setTemplate] = useState("reply");
	return (
		<Modal open onClose={close} title="Python 验证脚本编写指南">
			<p>
				入口 verify(ctx)，返回 verdict、message 和可选 checks。print
				输出进入日志，不执行 pip；依赖需预先安装在评测服务 Python 环境。
			</p>
			<Select
				value={template}
				onChange={setTemplate}
				options={[
					["reply", "回复验证模板"],
					["artifacts", "文件产物模板"],
					["conversation", "会话验证模板"],
				]}
			/>
			<JsonView
				value={
					template === "reply"
						? pythonReplyTemplate
						: template === "conversation"
							? pythonConversationTemplate
							: pythonArtifactTemplate
				}
			/>
			<Button
				onClick={() =>
					navigator.clipboard.writeText(
						template === "reply"
							? pythonReplyTemplate
							: template === "conversation"
								? pythonConversationTemplate
								: pythonArtifactTemplate,
					)
				}
			>
				复制模板
			</Button>
			<dl>
				{pythonFields.map(([field, description]) => (
					<div key={field}>
						<dt>
							<code>{field}</code>
						</dt>
						<dd>{description}</dd>
					</div>
				))}
			</dl>
		</Modal>
	);
}
