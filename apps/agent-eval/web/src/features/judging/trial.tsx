import { useMutation, useQuery } from "@tanstack/react-query";
import { Select as AntSelect } from "antd";
import { useState } from "react";
import {
	type JudgeBinding,
	judgeBindings,
} from "../../../../src/modules/judging/bindings";
import type {
	JudgeConfig,
	Scorer,
} from "../../../../src/modules/judging/types";
import { api, message, send, useApi } from "../../api/client";
import { Disclosure, DisclosureTitle } from "../../components/antd-compat";
import { assertValidEditors } from "../../components/editor-validity";
import { Alert, Box, Button, DataState, JsonView } from "../../components/ui";
import { useRememberedState } from "../../hooks/remembered-state";
import { CriteriaResults } from "./criteria";
import { JudgeEditor, judgeDefaults } from "./editor";

export function JudgeTrial({
	runId,
	item,
	initialConfig,
	bindingId = "legacy",
	binding,
}: {
	runId: string;
	item: any;
	initialConfig?: JudgeConfig;
	bindingId?: string;
	binding?: Omit<JudgeBinding, "config">;
}) {
	const [config, setConfig] = useState<JudgeConfig | undefined>(
		initialConfig ?? item.snapshot.definition.llmJudge ?? judgeDefaults(),
	);
	const [preview, setPreview] = useState<any>();
	const [taskId, setTask] = useRememberedState(
		`${runId}/${item.id}/${bindingId}`,
		"judgeTask",
		"",
	);
	const [requestId, setRequestId] = useState(() => crypto.randomUUID());
	const path = `/api/runs/${runId}/items/${item.id}/judge-scores`;
	const history = useApi<any[]>(path);
	const prepare = useMutation({
		mutationFn: () => {
			assertValidEditors();
			return send(`${path}/preview`, { config });
		},
		onSuccess: setPreview,
	});
	const start = useMutation({
		mutationFn: () =>
			send<any>(path, { requestId, config: preview.config, binding }),
		onSuccess: (task) => {
			setTask(task.id);
			void history.refetch();
		},
	});
	const task = useQuery<any>({
		queryKey: [`${path}/${taskId}`],
		queryFn: ({ signal }) => api(`${path}/${taskId}`, { signal }),
		enabled: !!taskId,
		refetchInterval: (q) =>
			!q.state.data || ["queued", "running"].includes(q.state.data.status)
				? 1000
				: false,
	});
	const running = ["queued", "running"].includes(task.data?.status);
	return (
		<Box title="历史结果试评分">
			<p className="form-hint">
				只调用
				Judge，消耗评审模型用量；不覆盖原批次结论。提交响应不确定时保留请求身份。
			</p>
			<JudgeEditor
				value={config}
				onChange={(value) => {
					setConfig(value);
					setPreview(undefined);
					setRequestId(crypto.randomUUID());
				}}
				mode={item.snapshot.definition.replayMode}
			/>
			<Alert>
				{(prepare.error && message(prepare.error)) ||
					(start.error && message(start.error))}
			</Alert>
			<div className="page-actions">
				<Button
					disabled={prepare.isPending || running}
					onClick={() => prepare.mutate()}
				>
					预览评分输入
				</Button>
				<Button
					primary
					disabled={!preview || start.isPending || running}
					onClick={() => start.mutate()}
				>
					确认试评分
				</Button>
				{running && (
					<Button onClick={() => send(`${path}/${taskId}/cancel`, {})}>
						停止试评分
					</Button>
				)}
			</div>
			{preview && (
				<Disclosure>
					<DisclosureTitle>本次评分输入</DisclosureTitle>
					<JsonView value={preview.input} />
				</Disclosure>
			)}
			{taskId && (
				<DataState query={task}>
					{task.data && (
						<>
							<p>试评分状态：{task.data.status}</p>
							<Alert>{task.data.error}</Alert>
							{task.data.result && (
								<CriteriaResults result={task.data.result} />
							)}
							<JsonView value={task.data.result ?? "等待结果"} />
						</>
					)}
				</DataState>
			)}
			<Disclosure>
				<DisclosureTitle>已保存的试评分记录</DisclosureTitle>
				<DataState query={history}>
					{history.data
						?.filter(
							(score) =>
								!score.binding || score.binding.bindingId === bindingId,
						)
						.map((score) => (
							<Button key={score.id} onClick={() => setTask(score.id)}>
								{score.binding?.name ?? "独立评分"} ·{" "}
								{new Date(score.createdAt).toLocaleString()} · {score.status} ·{" "}
								{score.result?.score ?? "—"}
							</Button>
						))}
				</DataState>
			</Disclosure>
		</Box>
	);
}

export function MultiJudgeTrial({
	runId,
	item,
	bindings: provided,
}: {
	runId: string;
	item: any;
	bindings?: JudgeBinding[];
}) {
	const library = useApi<Scorer[]>("/api/llm-scorers");
	const bindings = provided ?? judgeBindings(item.snapshot.definition);
	const options = [
		...bindings,
		...(library.data ?? [])
			.filter((s) => s.enabled && !bindings.some((b) => b.scorerId === s.id))
			.map((s) => ({
				bindingId: `library-${s.id}`,
				name: s.name,
				scorerId: s.id,
				sourceRevision: s.revision,
				config: {
					...s.config,
					referenceAnswer: bindings[0]?.config.referenceAnswer ?? "",
				},
			})),
	];
	const [selected, setSelected] = useState<string[]>(
		bindings.filter((b) => b.config.enabled).map((b) => b.bindingId),
	);
	return (
		<>
			<p className="form-hint">
				选择一个或多个评分器，分别预览并确认试评分。不会改变正式结论。
			</p>
			<AntSelect
				virtual={false}
				mode="multiple"
				aria-label="试评分器"
				style={{ width: "100%", marginBottom: 16 }}
				value={selected}
				onChange={setSelected}
				options={options.map((b) => ({ value: b.bindingId, label: b.name }))}
			/>
			{options
				.filter((b) => selected.includes(b.bindingId))
				.map((b) => (
					<Box key={b.bindingId} title={b.name}>
						<JudgeTrial
							runId={runId}
							item={item}
							initialConfig={b.config}
							bindingId={b.bindingId}
							binding={{
								bindingId: b.bindingId,
								name: b.name,
								scorerId: b.scorerId,
								sourceRevision: b.sourceRevision,
							}}
						/>
					</Box>
				))}
			{!options.length && <JudgeTrial runId={runId} item={item} />}
		</>
	);
}
