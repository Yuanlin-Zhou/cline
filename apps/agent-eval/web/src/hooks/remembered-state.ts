import { useQueryClient } from "@tanstack/react-query";
import { useState, type SetStateAction } from "react";

/** Session-only UI state. Closing a panel never cancels or loses a submitted trial. */
export function useRememberedState<T>(
	owner: string,
	field: string,
	initial: T,
) {
	const client = useQueryClient();
	const key = ["trial-state", owner, field];
	const [value, update] = useState<T>(
		() => client.getQueryData<T>(key) ?? initial,
	);
	const set = (next: SetStateAction<T>) =>
		update((previous) => {
			const resolved =
				typeof next === "function" ? (next as (v: T) => T)(previous) : next;
			client.setQueryData(key, resolved);
			return resolved;
		});
	return [value, set] as const;
}
