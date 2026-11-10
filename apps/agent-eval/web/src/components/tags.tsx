import { useState } from "react";
import { message, useApi } from "../api/client";
import { TagSelection } from "./tag-selection";
import { Alert, Button, Text } from "./ui";

export function Tags({
	value,
	onChange,
	candidates = [],
	limit,
}: {
	value: string[];
	onChange: (tags: string[]) => void;
	candidates?: string[];
	limit?: number;
}) {
	const query = useApi<string[]>("/api/cases/tags", candidates.length === 0);
	const [name, setName] = useState("");
	const [open, setOpen] = useState<"add" | "choose">();
	const [search, setSearch] = useState("");
	const [error, setError] = useState("");
	function add(input: string, existing = false) {
		try {
			const selection = new TagSelection(value, limit);
			existing ? selection.select(input) : selection.add(input);
			onChange(selection.read());
			setName("");
			setError("");
		} catch (e) {
			setError(message(e));
		}
	}
	return (
		<div className="TagEditor">
			<div className="TagEditor-chips">
				{!value.length && <span className="muted small">尚未添加标签</span>}
				{value.map((tag, i) => (
					<span className="TagEditor-chip" key={tag}>
						<span className="TagEditor-name">{tag}</span>
						<button
							type="button"
							className="TagEditor-remove"
							aria-label={`移除标签 ${tag}`}
							onClick={() => onChange(value.filter((_, index) => index !== i))}
						>
							×
						</button>
					</span>
				))}
			</div>
			<div className="page-actions mt-2">
				<Button
					className="btn-sm"
					aria-expanded={open === "add"}
					onClick={() => setOpen(open === "add" ? undefined : "add")}
				>
					＋ 新增标签
				</Button>
				<Button
					className="btn-sm"
					aria-expanded={open === "choose"}
					onClick={() => setOpen(open === "choose" ? undefined : "choose")}
				>
					选择已有标签
				</Button>
			</div>
			{open && (
				<div className="TagEditor-panel">
					{open === "add" ? (
						<>
							<div className="react-row">
								<Text
									aria-label="标签名称"
									value={name}
									onChange={setName}
									onKeyDown={(e: any) => {
										if (e.key === "Enter") {
											e.preventDefault();
											add(name);
										}
									}}
								/>
								<Button onClick={() => add(name)}>添加标签</Button>
							</div>
						</>
					) : (
						<>
							<Text
								aria-label="搜索已有标签"
								placeholder="搜索已有标签"
								value={search}
								onChange={setSearch}
							/>
							<div className="TagEditor-choices">
								{Array.from(new Set([...candidates, ...(query.data ?? [])]))
									.filter((t) => t.toLowerCase().includes(search.toLowerCase()))
									.map((tag) => (
										<label key={tag} className="TagEditor-option">
											<input
												type="checkbox"
												checked={value.includes(tag)}
												onChange={(event) =>
													event.target.checked
														? add(tag, true)
														: onChange(value.filter((v) => v !== tag))
												}
											/>
											<span className="TagEditor-name">{tag}</span>
										</label>
									))}
							</div>
						</>
					)}
					<Alert>{error}</Alert>
				</div>
			)}
		</div>
	);
}
