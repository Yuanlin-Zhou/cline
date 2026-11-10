import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, message, send, useApi } from "../../api/client";
import { assertValidEditors } from "../../components/editor-validity";
import { RemoteJson } from "../../components/remote-json";
import {
	Alert,
	Box,
	Button,
	DataState,
	Field,
	JsonInput,
	JsonView,
	Select,
} from "../../components/ui";
import { useRememberedState } from "../../hooks/remembered-state";

export function VerifierTrial({
	runId,
	item,
	rule,
}: {
	runId: string;
	item: any;
	rule?: any;
}) {
	const scripts = useApi<any>("/api/verifiers");
	const [verifierId, setVerifier] = useState(
		rule?.verifierId ??
			item.snapshot.definition.grading?.rules.find(
				(r: any) => r.kind === "script",
			)?.verifierId ??
			"",
	);
	const [params, setParams] = useState<Record<string, unknown>>(
		rule?.params ?? {},
	);
	const [taskId, setTask] = useRememberedState(
		runId + "/" + item.id,
		"verifierTask",
		"",
	);
	const path = `/api/runs/${runId}/items/${item.id}`;
	const start = useMutation({
		mutationFn: () => {
			assertValidEditors();
			return send<any>(`${path}/verifier-tests`, {
				verifierId,
				params,
				...(rule?.required_inputs
					? { required_inputs: rule.required_inputs }
					: {}),
				...(rule?.require_complete
					? { require_complete: rule.require_complete }
					: {}),
			});
		},
		onSuccess: (task) => setTask(task.id),
	});
	const task = useQuery<any>({
		queryKey: [`${path}/verifier-tests/${taskId}`],
		queryFn: ({ signal }) =>
			api(`${path}/verifier-tests/${taskId}`, { signal }),
		enabled: !!taskId,
		refetchInterval: (q) =>
			!q.state.data || ["queued", "running"].includes(q.state.data.status)
				? 500
				: false,
	});
	const [log, setLog] = useState("");
	const evidence = useApi<any>(
		`${path}/verifier-tests/${taskId}/evidence/${log}`,
		!!log,
	);
	return (
		<Box title="用历史结果试验证">
			<p className="form-hint">
				使用固定验证输入，不重新调用被测模型，不改变正式结论。
			</p>
			<RemoteJson path={`${path}/validation-input`} title="预览冻结输入" />
			<a className="btn" href={`${path}/validation-input?download=1`}>
				下载验证输入
			</a>
			<Field label="Python 验证脚本">
				<Select
					value={verifierId}
					onChange={setVerifier}
					options={[
						["", "请选择"],
						...(scripts.data?.verifiers ?? [])
							.filter((v: any) => v.runtime === "python")
							.map((v: any) => [v.id, v.label ?? v.id] as [string, string]),
					]}
				/>
			</Field>
			<JsonInput label="试验证参数" value={params} onChange={setParams} />
			<Alert>{start.error && message(start.error)}</Alert>
			<Button
				disabled={
					start.isPending ||
					!verifierId ||
					["queued", "running"].includes(task.data?.status)
				}
				onClick={() => start.mutate()}
			>
				开始试验证
			</Button>
			{taskId && (
				<>
					<DataState query={task}>
						{task.data && (
							<>
								<p>状态：{task.data.status}</p>
								<Alert>{task.data.error}</Alert>
								<JsonView value={task.data.result ?? "等待结果"} />
								{["queued", "running"].includes(task.data.status) && (
									<Button
										onClick={() =>
											send(`${path}/verifier-tests/${taskId}/cancel`, {})
										}
									>
										停止试验证
									</Button>
								)}
								{task.data.result?.evidenceRefs?.map((id: string) => (
									<Button key={id} onClick={() => setLog(id)}>
										查看日志与证据
									</Button>
								))}
							</>
						)}
					</DataState>
					{log && (
						<DataState query={evidence}>
							{evidence.data && <JsonView value={evidence.data.text} />}
						</DataState>
					)}
				</>
			)}
		</Box>
	);
}
