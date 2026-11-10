import { useState } from "react";
import type { JudgeConfig } from "../../../../src/modules/judging/types";
import { useApi } from "../../api/client";
import { DataState, Field, Modal, Select } from "../../components/ui";
import { JudgeTrial } from "../judging/trial";
import { VerifierTrial } from "../verifiers/trial";

export function HistoryTrials({
	caseId,
	rule,
	judge,
	close,
}: {
	caseId?: string;
	rule?: any;
	judge?: JudgeConfig;
	close: () => void;
}) {
	const runs = useApi<any[]>(`/api/cases/${caseId}/runs`, !!caseId);
	const [selected, setSelected] = useState("");
	const entries = (runs.data ?? []).flatMap((run) =>
		run.items
			.filter((item: any) => !["queued", "running"].includes(item.status))
			.map((item: any) => ({ run, item })),
	);
	const entry = entries.find((value) => value.item.id === selected);
	const item = useApi<any>(
		`/api/runs/${entry?.run.id}/items/${selected}`,
		!!entry,
	);
	return (
		<Modal
			open
			title={rule ? "用历史结果试验证" : "用历史结果试评分"}
			onClose={close}
		>
			{!caseId ? (
				<p>请先保存并执行案例，再选择已有结果。</p>
			) : (
				<DataState query={runs}>
					<Field label="历史执行">
						<Select
							value={selected}
							onChange={setSelected}
							options={[
								["", "选择已结束的执行"],
								...entries.map(
									(value) =>
										[
											value.item.id,
											`${value.run.name} · 第 ${value.item.round ?? 1} 轮 · ${value.item.status}`,
										] as [string, string],
								),
							]}
						/>
					</Field>
					{!entries.length && <p>没有可用的历史执行，请先运行案例。</p>}
				</DataState>
			)}
			{entry && (
				<DataState query={item}>
					{item.data &&
						(rule ? (
							<VerifierTrial
								key={selected}
								runId={entry.run.id}
								item={item.data}
								rule={rule}
							/>
						) : (
							<JudgeTrial
								key={selected}
								runId={entry.run.id}
								item={item.data}
								initialConfig={judge}
							/>
						))}
				</DataState>
			)}
		</Modal>
	);
}
