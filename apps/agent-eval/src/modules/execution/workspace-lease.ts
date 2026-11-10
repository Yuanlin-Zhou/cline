import path from "node:path";
import { within } from "./workspace.js";
const active = new Set<string>();
const waiting: Array<{
	root: string;
	signal?: AbortSignal;
	resolve: (release: () => void) => void;
	reject: (e: unknown) => void;
	abort: () => void;
}> = [];
function drain() {
	for (let i = 0; i < waiting.length; ) {
		const job = waiting[i];
		if (
			[...active].some(
				(root) => within(root, job.root) || within(job.root, root),
			)
		) {
			i++;
			continue;
		}
		waiting.splice(i, 1);
		job.signal?.removeEventListener("abort", job.abort);
		active.add(job.root);
		let released = false;
		job.resolve(() => {
			if (released) return;
			released = true;
			active.delete(job.root);
			drain();
		});
	}
}
/** Same-process leases cover execution and archiving; other services do not share this coordinator. */
export async function workspaceLease(
	root: string,
	signal?: AbortSignal,
): Promise<() => void> {
	signal?.throwIfAborted();
	root = path.resolve(root);
	if (process.platform === "win32") root = root.toLowerCase();
	return new Promise((resolve, reject) => {
		const job = {
			root,
			signal,
			resolve,
			reject,
			abort: () => {
				const i = waiting.indexOf(job);
				if (i >= 0) waiting.splice(i, 1);
				reject(signal?.reason ?? new Error("等待工作区已取消"));
				drain();
			},
		};
		waiting.push(job);
		signal?.addEventListener("abort", job.abort, { once: true });
		drain();
	});
}
