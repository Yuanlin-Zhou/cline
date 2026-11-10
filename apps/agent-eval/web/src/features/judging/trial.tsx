import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { JudgeConfig } from "../../../../src/modules/judging/types";
import { api, message, send, useApi } from "../../api/client";
import { Alert, Box, Button, DataState, JsonView } from "../../components/ui";
import { useRememberedState } from "../../hooks/remembered-state";
import { JudgeEditor, judgeDefaults } from "./editor";

export function JudgeTrial({
	runId,
	item,
	initialConfig,
}: {
	runId: string;
	item: any;
	initialConfig?: JudgeConfig;
}) {
	const [config, setConfig] = useState<JudgeConfig | undefined>(
		initialConfig ?? item.snapshot.definition.llmJudge ?? judgeDefaults(),
	);
	const [preview, setPreview] = useState<any>();
	const [taskId, setTask] = useRememberedState(
		runId + "/" + item.id,
		"judgeTask",
		"",
	);
	const [requestId, setRequestId] = useState(() => crypto.randomUUID());
	const path = `/api/runs/${runId}/items/${item.id}/judge-scores`;
	const history = useApi<any[]>(path);
	const prepare = useMutation({
		mutationFn: () => send(`${path}/preview`, { config }),
		onSuccess: setPreview,
	});
	const start = useMutation({
		mutationFn: () => send<any>(path, { requestId, config: preview.config }),
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
				<details>
					<summary>本次评分输入</summary>
					<JsonView value={preview.input} />
				</details>
			)}
			{taskId && (
				<DataState query={task}>
					{task.data && (
						<>
							<p>试评分状态：{task.data.status}</p>
							<Alert>{task.data.error}</Alert>
							<JsonView value={task.data.result ?? "等待结果"} />
						</>
					)}
				</DataState>
			)}
			<details>
				<summary>已保存的试评分记录</summary>
				<DataState query={history}>
					{history.data?.map((score) => (
						<Button key={score.id} onClick={() => setTask(score.id)}>
							{new Date(score.createdAt).toLocaleString()} · {score.status} ·{" "}
							{score.result?.score ?? "—"}
						</Button>
					))}
				</DataState>
			</details>
		</Box>
	);
}
