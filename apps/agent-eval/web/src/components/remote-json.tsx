import { useState } from "react";
import { useApi } from "../api/client";
import { DataState, JsonView } from "./ui";
export function RemoteJson({ path, title }: { path: string; title: string }) {
	const [open, setOpen] = useState(false);
	const query = useApi<any>(path, open);
	return (
		<details onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary>{title}</summary>
			{open && (
				<DataState query={query}>
					{query.data && <JsonView value={query.data} />}
				</DataState>
			)}
		</details>
	);
}
