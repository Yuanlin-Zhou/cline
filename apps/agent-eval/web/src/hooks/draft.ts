import { App } from "antd";
import { useEffect, useState } from "react";
import { useBlocker } from "react-router-dom";

export function useDraft<T>(initial: T) {
	const [value, setValue] = useState(() => structuredClone(initial));
	const [saved, setSaved] = useState(() => JSON.stringify(initial));
	const dirty = JSON.stringify(value) !== saved;
	const blocker = useBlocker(dirty);
	const { modal } = App.useApp();
	useEffect(() => {
		if (blocker.state === "blocked") {
			const dialog = modal.confirm({
				title: "有未保存的修改，确定离开？",
				onOk: () => blocker.proceed(),
				onCancel: () => blocker.reset(),
			});
			return () => dialog.destroy();
		}
	}, [blocker, modal]);
	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);
	return {
		value,
		setValue,
		dirty,
		markSaved: (next = value) => setSaved(JSON.stringify(next)),
	};
}
