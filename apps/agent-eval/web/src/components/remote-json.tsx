import { useState } from "react";
import { useApi } from "../api/client";
import { Disclosure, DisclosureTitle } from "./antd-compat";
import { DataState, JsonView } from "./ui";
export function RemoteJson({ path, title }: { path: string; title: string }) {
	const [open, setOpen] = useState(false);
	const query = useApi<any>(path, open);
	return (
		<Disclosure onToggle={(e) => setOpen(e.currentTarget.open)}>
			<DisclosureTitle>{title}</DisclosureTitle>
			{open && (
				<DataState query={query}>
					{query.data && <JsonView value={query.data} />}
				</DataState>
			)}
		</Disclosure>
	);
}
