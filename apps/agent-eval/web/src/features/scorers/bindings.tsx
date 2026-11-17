import { Popconfirm, Select, Space, Tag } from "antd";
import type { EvalCase } from "../../../../src/contracts/evaluation";
import {
	type JudgeBinding,
	judgeBindings,
} from "../../../../src/modules/judging/bindings";
import type { Scorer } from "../../../../src/modules/judging/types";
import { send, useApi } from "../../api/client";
import { Box, Button } from "../../components/ui";
import { JudgeEditor, judgeDefaults } from "../judging/editor";
export function ScorerBindings({
	value,
	onChange,
}: {
	value: EvalCase;
	onChange: (value: EvalCase) => void;
}) {
	const query = useApi<Scorer[]>("/api/llm-scorers");
	const bindings = judgeBindings(value);
	const update = (next: JudgeBinding[]) =>
		onChange({ ...value, llmJudge: undefined, llmJudges: next });
	const change = (i: number, b: JudgeBinding) =>
		update(bindings.map((v, j) => (j === i ? b : v)));
	return (
		<Box title="LLM 评分器">
			<p className="form-hint">
				选择一个或多个评分器，对同一次执行分别评分。配置按案例保存，来源更新后需显式同步。
			</p>
			<Select
				virtual={false}
				mode="multiple"
				style={{ width: "100%", marginBottom: 16 }}
				placeholder="选择 LLM 评分器"
				aria-label="选择 LLM 评分器"
				value={bindings
					.filter(
						(b) => b.scorerId && query.data?.some((s) => s.id === b.scorerId),
					)
					.map((b) => b.scorerId!)}
				options={query.data?.map((s) => ({
					value: s.id,
					label: `${s.name} · v${s.revision}${s.enabled ? "" : "（已停用）"}`,
					disabled: !s.enabled,
				}))}
				onChange={(ids) => {
					const next = bindings.filter(
						(b) =>
							!b.scorerId ||
							!query.data?.some((s) => s.id === b.scorerId) ||
							ids.includes(b.scorerId),
					);
					for (const id of ids)
						if (!next.some((b) => b.scorerId === id)) {
							const s = query.data?.find((s) => s.id === id);
							if (!s) continue;
							next.push({
								bindingId: crypto.randomUUID(),
								name: s.name,
								scorerId: s.id,
								sourceRevision: s.revision,
								config: {
									...s.config,
									enabled: true,
									referenceAnswer: bindings[0]?.config.referenceAnswer ?? "",
								},
							});
						}
					update(next);
				}}
			/>
			{query.isError && (
				<Button onClick={() => query.refetch()}>
					加载评分器失败，点击重试
				</Button>
			)}
			{bindings.map((b, i) => {
				const source = query.data?.find((s) => s.id === b.scorerId);
				return (
					<Box
						key={b.bindingId}
						title={
							<Space>
								{b.name}
								{b.sourceRevision && <Tag>v{b.sourceRevision}</Tag>}
								{b.scorerId && !source && <Tag>独立快照 / 来源不可用</Tag>}
								{source && !source.enabled && <Tag>来源已停用</Tag>}
							</Space>
						}
					>
						<Space wrap style={{ marginBottom: 12 }}>
							{source && source.revision !== b.sourceRevision && (
								<Popconfirm
									title="更新至评分器最新版本？"
									description="保留案例参考答案和产物路径，其他评分配置采用最新版本。"
									onConfirm={() =>
										change(i, {
											...b,
											name: source.name,
											sourceRevision: source.revision,
											config: {
												...source.config,
												enabled: b.config.enabled,
												referenceAnswer: b.config.referenceAnswer,
												resultFiles: b.config.resultFiles,
											},
										})
									}
								>
									<Button>有新版本 · 更新</Button>
								</Popconfirm>
							)}
							<Popconfirm
								title="移除此评分器配置？"
								onConfirm={() => update(bindings.filter((_, j) => i !== j))}
							>
								<Button danger>移除评分器</Button>
							</Popconfirm>
							{!b.scorerId && (
								<Button
									onClick={async () => {
										const s = await send<Scorer>("/api/llm-scorers", {
											name: b.name,
											description: "从案例保存",
											enabled: true,
											config: b.config,
										});
										change(i, {
											...b,
											scorerId: s.id,
											sourceRevision: s.revision,
										});
										await query.refetch();
									}}
								>
									另存为公共评分器
								</Button>
							)}
						</Space>
						<JudgeEditor
							value={b.config}
							onChange={(config) => config && change(i, { ...b, config })}
							mode={value.replayMode}
						/>
					</Box>
				);
			})}
			<Button
				onClick={() =>
					update([
						...bindings,
						{
							bindingId: crypto.randomUUID(),
							name: "案例独立评分配置",
							config: judgeDefaults(),
						},
					])
				}
			>
				添加独立评分配置
			</Button>
		</Box>
	);
}
