import { Input, Space, Table, Tag } from "antd";
import { useState } from "react";
import type { Scorer } from "../../../../src/modules/judging/types";
import { send, useApi } from "../../api/client";
import { confirmAction } from "../../components/confirm";
import { assertValidEditors } from "../../components/editor-validity";
import { Button, DataState, Field, Modal, Text } from "../../components/ui";
import { useDraft } from "../../hooks/draft";
import { JudgeEditor, judgeDefaults } from "../judging/editor";
export function ScorersPage() {
	const query = useApi<Scorer[]>("/api/llm-scorers");
	const form = useDraft<any>(null);
	const draft = form.value,
		setDraft = form.setValue;
	const openDraft = (value: any) => {
		setDraft(value);
		form.markSaved(value);
	};
	const closeDraft = () => {
		setDraft(null);
		form.markSaved(null);
	};
	const [search, setSearch] = useState("");
	const create = () =>
		openDraft({
			name: "",
			description: "",
			enabled: true,
			config: { ...judgeDefaults(), referenceAnswer: "由案例提供" },
		});
	return (
		<>
			<h1>LLM 评分器</h1>
			<p className="form-hint">
				集中管理模型与评分标准，案例可选择多个评分器。更新不会改变已有案例的配置快照。
			</p>
			<Space style={{ marginBottom: 16 }}>
				<Input
					placeholder="搜索评分器"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<Button primary onClick={create}>
					新增评分器
				</Button>
			</Space>
			<DataState query={query}>
				{query.data && (
					<Table
						rowKey="id"
						dataSource={query.data.filter((s) =>
							(s.name + s.description).includes(search),
						)}
						columns={[
							{ title: "名称", dataIndex: "name" },
							{ title: "说明", dataIndex: "description" },
							{ title: "模型", render: (_, s) => s.config.model?.modelId },
							{ title: "版本", render: (_, s) => `v${s.revision}` },
							{
								title: "状态",
								render: (_, s) => <Tag>{s.enabled ? "已启用" : "已停用"}</Tag>,
							},
							{
								title: "操作",
								render: (_, s) => (
									<Space>
										<Button
											onClick={() =>
												openDraft({
													...s,
													config: {
														...s.config,
														referenceAnswer: "由案例提供",
													},
												})
											}
										>
											编辑
										</Button>
										<Button
											onClick={() =>
												openDraft({
													...s,
													id: undefined,
													revision: undefined,
													name: `${s.name} 副本`,
													config: {
														...s.config,
														referenceAnswer: "由案例提供",
													},
												})
											}
										>
											复制
										</Button>
										<Button
											onClick={async () => {
												await send(
													`/api/llm-scorers/${s.id}`,
													{ ...s, enabled: !s.enabled },
													"PUT",
												);
												await query.refetch();
											}}
										>
											{s.enabled ? "停用" : "启用"}
										</Button>
										<Button
											danger
											onClick={async () => {
												if (
													await confirmAction(
														"删除评分器？被案例引用的评分器不能删除，可改为停用。",
													)
												) {
													await send(
														`/api/llm-scorers/${s.id}`,
														{ revision: s.revision },
														"DELETE",
													);
													await query.refetch();
												}
											}}
										>
											删除
										</Button>
									</Space>
								),
							},
						]}
					/>
				)}
			</DataState>
			{draft && (
				<Modal
					title={draft.id ? "编辑评分器" : "新增评分器"}
					open
					onClose={async () => {
						if (
							!form.dirty ||
							(await confirmAction("放弃未保存的评分器修改？"))
						)
							closeDraft();
					}}
				>
					<Field label="评分器名称">
						<Text
							value={draft.name}
							onChange={(name) => setDraft({ ...draft, name })}
						/>
					</Field>
					<Field label="评分器说明">
						<Text
							value={draft.description}
							onChange={(description) => setDraft({ ...draft, description })}
						/>
					</Field>
					<JudgeEditor
						value={draft.config}
						onChange={(config) => setDraft({ ...draft, config })}
						mode="full-task"
						template
					/>
					<Button
						primary
						onClick={async () => {
							assertValidEditors();
							await send(
								`/api/llm-scorers${draft.id ? `/${draft.id}` : ""}`,
								draft,
								draft.id ? "PUT" : "POST",
							);
							closeDraft();
							await query.refetch();
						}}
					>
						保存评分器
					</Button>
				</Modal>
			)}
		</>
	);
}
