import { useEffect, useId, useRef, useState } from "react";
import type { HeaderConfig } from "../../../src/contracts/headers";
import { message } from "../api/client";
import { editorError } from "./editor-validity";
import { headersFromRows, type HeaderRow } from "./header-rows";
import { Alert, Button, Select, Text } from "./ui";

const toRows = (v: HeaderConfig): HeaderRow[] => [
	...Object.entries(v.headers ?? {}).map(([name, value]) => ({
		name,
		value,
		source: "literal" as const,
	})),
	...Object.entries(v.headersEnv ?? {}).map(([name, value]) => ({
		name,
		value,
		source: "env" as const,
	})),
];
export function HeadersEditor({
	value,
	onChange,
	title,
}: {
	value: HeaderConfig;
	title?: string;
	onChange: (config: HeaderConfig) => void;
}) {
	const id = useId();
	const [rows, setRows] = useState(() => toRows(value));
	const [error, setError] = useState("");
	const signature = JSON.stringify([value.headers, value.headersEnv]);
	const previous = useRef(signature);
	useEffect(() => {
		if (previous.current !== signature) {
			previous.current = signature;
			setRows(toRows(value));
			setError("");
			editorError(id);
		}
	}, [signature, id, value]);
	useEffect(() => () => editorError(id), [id]);
	function change(next: HeaderRow[]) {
		setRows(next);
		try {
			const parsed = headersFromRows(next);
			previous.current = JSON.stringify([parsed.headers, parsed.headersEnv]);
			onChange(parsed);
			setError("");
			editorError(id);
		} catch (e) {
			const text = message(e);
			setError(text);
			editorError(id, text);
		}
	}
	return (
		<section className={title ? "HeaderEditor" : undefined}>
			<div className={title ? "HeaderEditor-toolbar" : "react-row"}>
				<strong className="HeaderEditor-title">
					{title ?? "自定义模型请求头"}
				</strong>
				<Button
					className={title ? "btn-sm HeaderEditor-add" : undefined}
					onClick={() => {
						const next = [
							...rows,
							{ name: "", value: "", source: "literal" as const },
						];
						change(next);
					}}
				>
					＋ 添加请求头
				</Button>
			</div>
			<p className="form-hint">
				Authorization 等凭据请选择环境变量，填写评测服务端变量名。支持{" "}
				{"{{sessionId}}、{{caseId}}、{{evaluationId}}、{{requestId}}"} 模板。
			</p>
			{rows.map((row, index) => (
				<div className={title ? "HeaderRow" : "react-header-row"} key={index}>
					<label
						htmlFor={`${id}-${index}-name`}
						className={
							title ? "HeaderRow-field HeaderRow-name" : "react-header-field"
						}
					>
						{title && <span className="HeaderRow-label">请求头名称</span>}
						<Text
							id={`${id}-${index}-name`}
							aria-label="请求头名称"
							value={row.name}
							onChange={(name) =>
								change(rows.map((r, i) => (i === index ? { ...r, name } : r)))
							}
						/>
					</label>
					<label
						htmlFor={`${id}-${index}-source`}
						className={
							title ? "HeaderRow-field HeaderRow-source" : "react-header-field"
						}
					>
						{title && <span className="HeaderRow-label">值来源</span>}
						<Select
							id={`${id}-${index}-source`}
							value={row.source}
							onChange={(source) =>
								change(
									rows.map((r, i) =>
										i === index
											? { ...r, source: source as HeaderRow["source"] }
											: r,
									),
								)
							}
							options={[
								["literal", "固定值"],
								["env", "环境变量"],
							]}
						/>
					</label>
					<label
						htmlFor={`${id}-${index}-value`}
						className={
							title ? "HeaderRow-field HeaderRow-value" : "react-header-field"
						}
					>
						{title && (
							<span className="HeaderRow-label">
								{row.source === "env" ? "服务端环境变量名" : "固定值"}
							</span>
						)}
						<Text
							id={`${id}-${index}-value`}
							aria-label="请求头值或环境变量名"
							value={row.value}
							onChange={(value) =>
								change(rows.map((r, i) => (i === index ? { ...r, value } : r)))
							}
						/>
					</label>
					<Button
						aria-label="移除请求头"
						className={title ? "HeaderRow-remove" : undefined}
						danger
						onClick={() => change(rows.filter((_, i) => i !== index))}
					>
						{title ? "×" : "移除"}
					</Button>
				</div>
			))}
			{!rows.length &&
				(title ? (
					<div className="HeaderEditor-empty">
						<span>暂无自定义请求头</span>
						<span>点击上方「添加请求头」开始配置</span>
					</div>
				) : (
					<p className="form-hint">暂无自定义请求头</p>
				))}
			<Alert>{error}</Alert>
		</section>
	);
}
