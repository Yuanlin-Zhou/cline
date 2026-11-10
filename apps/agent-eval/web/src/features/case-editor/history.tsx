import { useState } from "react";
import type { EvalCase } from "../../../../src/contracts/evaluation";
import type { HistoryDocument } from "../../../../src/modules/catalog/function-call-history";
import {
	convertHistoryDocument,
	readHistoryDocument,
} from "../../../../src/modules/catalog/function-call-history";
import { message } from "../../api/client";
import {
	Alert,
	Box,
	Button,
	Check,
	Field,
	JsonInput,
	Select,
	Text,
} from "../../components/ui";

export function HistoryEditor({
	value,
	onChange,
}: {
	value: EvalCase;
	onChange: (value: EvalCase) => void;
}) {
	const native = value.replayMode === "function-call";
	const [source, setSource] = useState("");
	const [reasoning, setReasoning] = useState(false);
	const [error, setError] = useState("");
	const [document, setDocument] = useState<HistoryDocument>();
	const [current, setCurrent] = useState("auto");
	const [system, setSystem] = useState("");
	const [preview, setPreview] = useState<any>();
	return (
		<details
			className="Box mb-3 HistoryPanel"
			open={native || value.history.length > 0}
		>
			<summary className="Box-header">
				{native ? "历史对话" : "历史消息（可选）"}
			</summary>
			<div className="Box-body">
				{native && (
					<p className="form-hint">
						选中响应之前的上下文；原始错误响应不能加入模型输入。
					</p>
				)}
				{native ? (
					<JsonInput
						label="原生 Function Call 历史"
						value={value.functionCall?.history ?? []}
						onChange={(history) =>
							onChange({
								...value,
								functionCall: {
									...value.functionCall!,
									history,
									historySource: undefined,
								},
							})
						}
					/>
				) : (
					<>
						<div className="section-title flex-between">
							<span>历史消息</span>
							{(["user", "assistant"] as const).map((role) => (
								<Button
									className="btn-sm"
									key={role}
									onClick={() =>
										onChange({
											...value,
											history: [...value.history, { role, content: "" }],
										})
									}
								>
									{role === "user" ? "＋ 用户消息" : "＋ 助手消息"}
								</Button>
							))}
						</div>
						{value.history.map((m, index) => (
							<div key={index} className="history-item CaseEditor-message">
								<div className={`role ${m.role}`}>
									<span>{m.role === "user" ? "用户" : "助手"}</span>
									<Button
										className="btn-sm btn-icon"
										aria-label={`移除消息 ${index + 1}`}
										onClick={() =>
											onChange({
												...value,
												history: value.history.filter((_, i) => i !== index),
											})
										}
									>
										×
									</Button>
								</div>
								<Text
									multiline
									rows={4}
									aria-label={`历史消息 ${index + 1}`}
									value={m.content}
									onChange={(content) =>
										onChange({
											...value,
											history: value.history.map((entry, i) =>
												i === index ? { ...entry, content } : entry,
											),
										})
									}
								/>
							</div>
						))}
						<p className="form-hint">
							{value.replayMode === "full-task"
								? "可选，作为任务初始背景；不会依次重放这些消息。"
								: "可选，为本轮问题提供上下文。例如用户：项目使用 Bun。留空则只发送本轮问题。"}
						</p>
					</>
				)}

				{native && (
					<details>
						<summary>粘贴 JSON 导入历史</summary>
						<Field label="原始对话 JSON">
							<Text
								multiline
								value={source}
								onChange={(v) => {
									setSource(v);
									setPreview(undefined);
								}}
							/>
						</Field>
						<Field label="哪些内容作为本轮输入？">
							<Select
								value={current}
								onChange={(v) => {
									setCurrent(v);
									setPreview(undefined);
								}}
								options={[
									["auto", "末尾用户输入单独保存；其他结尾全部作为历史"],
									["history", "全部作为历史，保留当前本轮输入"],
									...(document?.candidates ?? []).map(
										(c) =>
											[
												String(c.index),
												String(c.index + 1) + ". " + c.text.slice(0, 100),
											] as [string, string],
									),
								]}
							/>
						</Field>
						<Field label="系统指令来源">
							<Select
								value={system}
								onChange={(v) => {
									setSystem(v);
									setPreview(undefined);
								}}
								options={[
									["", "按原记录判断，冲突时要求明确选择"],
									["file", "顶层系统提示词"],
									["messages", "messages 中的系统指令"],
								]}
							/>
						</Field>
						<Check
							checked={reasoning}
							onChange={(v) => {
								setReasoning(v);
								setPreview(undefined);
							}}
						>
							不发送思考块（同意省略 reasoning 内容）
						</Check>
						<Button
							onClick={() => {
								setError("");
								try {
									const doc = readHistoryDocument(source);
									setDocument(doc);
									const last = doc.candidates.find(
										(c) => c.index === doc.messages.length - 1,
									);
									setPreview(
										convertHistoryDocument(doc, {
											ignoreThinking: reasoning,
											currentIndex:
												current === "auto"
													? last?.index
													: current === "history"
														? undefined
														: Number(current),
											...(system
												? { systemSource: system as "file" | "messages" }
												: {}),
										}),
									);
								} catch (e) {
									setError(message(e));
								}
							}}
						>
							解析预览
						</Button>
						<Alert>{error}</Alert>
						{preview && (
							<>
								<pre className="react-code">
									{JSON.stringify(preview, null, 2)}
								</pre>
								<Button
									onClick={() => {
										onChange({
											...value,
											...(preview.prompt !== undefined
												? { prompt: preview.prompt }
												: {}),
											functionCall: {
												...value.functionCall!,
												history: preview.history,
												historySource: preview.source,
											},
										});
										setPreview(undefined);
									}}
								>
									导入到草稿
								</Button>
							</>
						)}
					</details>
				)}
			</div>
		</details>
	);
}
