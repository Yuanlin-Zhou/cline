import { Popconfirm, Table, Tag } from "antd";
import type {
	JudgeCriterion,
	JudgeResult,
} from "../../../../src/modules/judging/types";
import { Box, Button, Field, Text } from "../../components/ui";
export function CriteriaEditor({
	value,
	onChange,
}: {
	value: JudgeCriterion[];
	onChange: (value: JudgeCriterion[]) => void;
}) {
	const update = (index: number, patch: Partial<JudgeCriterion>) =>
		onChange(value.map((c, i) => (i === index ? { ...c, ...patch } : c)));
	return (
		<section className="JudgeCriteria">
			<h4>评分条目</h4>
			<p className="form-hint">
				每条独立判定；全部通过才算评分器达标，总分仅展示。没有条目时沿用总分及格线。
			</p>
			{value.map((c, i) => (
				<Box key={c.id} title={`条目 ${i + 1}`}>
					<Field label={`条目 ${i + 1} 名称`}>
						<Text value={c.name} onChange={(name) => update(i, { name })} />
					</Field>
					<Field label={`条目 ${i + 1} 判定标准`}>
						<Text
							multiline
							value={c.standard}
							onChange={(standard) => update(i, { standard })}
						/>
					</Field>
					<Popconfirm
						title="移除此评分条目？"
						onConfirm={() => onChange(value.filter((_, j) => j !== i))}
					>
						<Button danger>移除条目 {i + 1}</Button>
					</Popconfirm>
				</Box>
			))}
			<Button
				onClick={() =>
					onChange([
						...value,
						{ id: crypto.randomUUID(), name: "", standard: "" },
					])
				}
			>
				添加评分条目
			</Button>
		</section>
	);
}
const labels = {
	pass: "通过",
	fail: "不通过",
	insufficient: "无法判定",
	pending: "未判定",
};
export function CriteriaResults({ result }: { result: JudgeResult }) {
	const entries = result.criteria?.length
		? result.criteria.map((c) => ({
				criterionId: c.id,
				name: c.name,
				standard: c.standard,
				result: result.criteriaResults?.find((r) => r.criterionId === c.id),
			}))
		: (result.criteriaResults ?? []).map((r) => ({
				criterionId: r.criterionId,
				name: r.name,
				standard: "",
				result: r,
			}));
	if (!entries.length) return null;
	return (
		<section className="JudgeCriteriaResults">
			<p className="form-hint">逐项判定决定是否达标；总分仅展示。</p>
			<Table
				size="small"
				pagination={false}
				rowKey="criterionId"
				dataSource={entries}
				columns={[
					{ title: "评分条目", dataIndex: "name", width: "28%" },
					{
						title: "通过情况",
						width: 100,
						render: (_, r) => {
							const status = ["error", "cancelled", "skipped"].includes(
								result.status,
							)
								? "pending"
								: (r.result?.status ?? "pending");
							return (
								<Tag
									color={
										status === "pass"
											? "success"
											: status === "fail"
												? "error"
												: "warning"
									}
								>
									{labels[status]}
								</Tag>
							);
						},
					},
					{
						title: "判定理由",
						render: (_, r) => (
							<span
								style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
							>
								{r.result?.rationale ??
									(result.rationale || "尚无有效条目判定")}
							</span>
						),
					},
				]}
				expandable={{
					expandedRowRender: (r) => (
						<>
							<p>
								<strong>判定标准：</strong>
								{r.standard || "见执行配置快照"}
							</p>
							{r.result?.evidence.length ? (
								r.result.evidence.map((e, i) => (
									<p key={i}>
										<Tag>{e.ref}</Tag>
										{e.quote || "引用此送审材料"}
									</p>
								))
							) : (
								<p className="form-hint">未提供证据引用</p>
							)}
						</>
					),
				}}
			/>
		</section>
	);
}
