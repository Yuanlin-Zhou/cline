import { useEffect, useState } from "react";
import { useBlocker } from "react-router-dom";

export function useDraft<T>(initial: T) {
	const [value, setValue] = useState(() => structuredClone(initial));
	const [saved, setSaved] = useState(() => JSON.stringify(initial));
	const dirty = JSON.stringify(value) !== saved;
	const blocker = useBlocker(dirty);
	useEffect(() => {
		if (blocker.state === "blocked") {
			if (window.confirm("有未保存的修改，确定离开？")) blocker.proceed();
			else blocker.reset();
		}
	}, [blocker]);
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
