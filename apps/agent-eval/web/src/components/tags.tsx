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
	const [open, setOpen] = useState(false);
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
			<div className="react-row">
				{value.map((tag, i) => (
					<span className="Label" key={tag}>
						{tag}{" "}
						<button
							type="button"
							aria-label={`移除标签 ${tag}`}
							onClick={() => onChange(value.filter((_, index) => index !== i))}
						>
							×
						</button>
					</span>
				))}
				<Button onClick={() => setOpen((v) => !v)}>新增或选择标签</Button>
			</div>
			{open && (
				<div className="Box Box-body mt-3">
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
					<div className="react-row mt-3">
						{Array.from(new Set([...candidates, ...(query.data ?? [])]))
							.filter((t) => !value.includes(t))
							.map((tag) => (
								<Button key={tag} onClick={() => add(tag, true)}>
									{tag}
								</Button>
							))}
					</div>
					<Alert>{error}</Alert>
				</div>
			)}
		</div>
	);
}
