import * as Dialog from "@radix-ui/react-dialog";
import * as RadixTabs from "@radix-ui/react-tabs";
import { type UseQueryResult } from "@tanstack/react-query";
import {
	cloneElement,
	createContext,
	isValidElement,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { message } from "../api/client";
import { editorError } from "./editor-validity";

export function Alert({
	children,
	kind = "error",
}: {
	children?: ReactNode;
	kind?: string;
}) {
	return children ? (
		<div
			role={kind === "error" ? "alert" : "status"}
			className={`flash flash-${kind}`}
		>
			{children}
		</div>
	) : null;
}
export function Field({
	label,
	children,
	hint,
}: {
	label: string;
	children: ReactNode;
	hint?: string;
}) {
	const id = useId();
	return (
		<div className="form-group">
			<label className="form-label" id={id + "-label"} htmlFor={id}>
				{label}
			</label>
			<div>
				{isValidElement<{ id?: string }>(children)
					? cloneElement(children, { id: children.props.id ?? id })
					: children}
			</div>
			{hint && <p className="form-hint">{hint}</p>}
		</div>
	);
}
export function Text({
	value,
	onChange,
	multiline = false,
	...props
}: {
	value?: string | number;
	onChange: (value: string) => void;
	multiline?: boolean;
	[key: string]: any;
}) {
	const shared = {
		...props,
		className: `form-control ${props.className ?? ""}`,
		value: value ?? "",
		onChange: (e: any) => onChange(e.target.value),
	};
	return multiline ? <textarea rows={5} {...shared} /> : <input {...shared} />;
}
export function Select({
	value,
	onChange,
	options,
	...props
}: {
	value?: string;
	onChange: (value: string) => void;
	options: Array<[string, string]>;
	[key: string]: any;
}) {
	return (
		<select
			{...props}
			className="form-control"
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value)}
		>
			{options.map(([v, label]) => (
				<option key={v} value={v}>
					{label}
				</option>
			))}
		</select>
	);
}
export function Check({
	checked,
	onChange,
	children,
	disabled,
}: {
	checked?: boolean;
	onChange: (value: boolean) => void;
	children: ReactNode;
	disabled?: boolean;
}) {
	return (
		<label className="form-check">
			<input
				type="checkbox"
				checked={!!checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
			/>{" "}
			{children}
		</label>
	);
}
export function Button({
	children,
	primary,
	danger,
	...props
}: {
	children: ReactNode;
	primary?: boolean;
	danger?: boolean;
	[key: string]: any;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const inFlight = useRef(false);
	const click = (event: any) => {
		if (inFlight.current) return;
		setError("");
		try {
			const result = props.onClick?.(event);
			if (result && typeof result.then === "function") {
				inFlight.current = true;
				setPending(true);
				void Promise.resolve(result)
					.catch((e) => setError(message(e)))
					.finally(() => {
						inFlight.current = false;
						setPending(false);
					});
			}
		} catch (e) {
			setError(message(e));
		}
	};
	return (
		<>
			<button
				type="button"
				{...props}
				disabled={props.disabled || pending}
				onClick={click}
				className={`btn ${primary ? "btn-primary" : ""} ${danger ? "btn-danger" : ""} ${props.className ?? ""}`}
			>
				{children}
			</button>
			<Alert>{error}</Alert>
		</>
	);
}
export function Heading({
	title,
	description,
	children,
}: {
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="page-head flex-between wrap gap-3">
			<div>
				<h1 className="page-title">{title}</h1>
				{description && <p className="page-desc">{description}</p>}
			</div>
			<div className="page-actions">{children}</div>
		</div>
	);
}
export function Box({
	title,
	children,
}: {
	title?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="Box mb-3">
			{title && (
				<div className="Box-header">
					<strong>{title}</strong>
				</div>
			)}
			<div className="Box-body">{children}</div>
		</section>
	);
}
export function Tabs({
	entries,
	initial,
	onChange,
}: {
	entries: Array<[string, string, ReactNode]>;
	initial?: string;
	onChange?: (value: string) => void;
}) {
	return (
		<RadixTabs.Root
			defaultValue={initial ?? entries[0]?.[0]}
			onValueChange={onChange}
		>
			<RadixTabs.List className="tab-nav" aria-label="内容分类">
				{entries.map(([id, title]) => (
					<RadixTabs.Trigger className="tab-button" key={id} value={id}>
						{title}
					</RadixTabs.Trigger>
				))}
			</RadixTabs.List>
			{entries.map(([id, , content]) => (
				<RadixTabs.Content
					forceMount
					className="react-tab-panel"
					key={id}
					value={id}
				>
					{content}
				</RadixTabs.Content>
			))}
		</RadixTabs.Root>
	);
}
export function Modal({
	open,
	onClose,
	title,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="react-modal-overlay" />
				<Dialog.Content className="react-modal">
					<Dialog.Title>{title}</Dialog.Title>
					<Dialog.Description className="sr-only">
						{title}操作窗口
					</Dialog.Description>
					<Dialog.Close asChild>
						<Button className="react-modal-close" aria-label="关闭">
							×
						</Button>
					</Dialog.Close>
					{children}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
export function DataState({
	query,
	children,
}: {
	query: UseQueryResult<any, any>;
	children: ReactNode;
}) {
	if (query.isPending) return <output className="empty">加载中…</output>;
	if (query.isError)
		return (
			<>
				<Alert>{message(query.error)}</Alert>
				<Button onClick={() => query.refetch()}>重试加载</Button>
			</>
		);
	return <>{children}</>;
}
const labels: Record<string, string> = {
	queued: "排队中",
	running: "运行中",
	passed: "通过",
	failed: "失败",
	error: "执行错误",
	cancelled: "已取消",
	inconclusive: "无法判定",
	completed: "已完成",
	interrupted: "已中断",
};
export const modeLabel = (mode?: string) =>
	mode === "full-task"
		? "多轮回放（完整任务）"
		: mode === "function-call"
			? "单轮函数调用"
			: "单轮回放";
export const duration = (ms?: number) =>
	ms === undefined
		? "—"
		: ms < 1000
			? `${ms} ms`
			: `${(ms / 1000).toFixed(1)} s`;
export function Status({ value }: { value?: string }) {
	return (
		<span className={`Label status-${value}`}>
			{value ? (labels[value] ?? value) : "未运行"}
		</span>
	);
}
export function JsonView({ value }: { value: unknown }) {
	return (
		<pre className="react-code">
			{typeof value === "string" ? value : JSON.stringify(value, null, 2)}
		</pre>
	);
}
export function JsonInput<T>({
	value,
	onChange,
	label,
	validate,
}: {
	value: T;
	onChange: (value: T) => void;
	label: string;
	validate?: (value: unknown) => T;
}) {
	const id = useId();
	const canonical = JSON.stringify(value ?? null, null, 2);
	const [source, setSource] = useState(canonical);
	const [error, setError] = useState("");
	const previous = useRef(canonical);
	useEffect(() => {
		if (previous.current !== canonical) {
			previous.current = canonical;
			setSource(canonical);
			setError("");
			editorError(id);
		}
	}, [canonical, id]);
	useEffect(() => () => editorError(id), [id]);
	return (
		<Field label={label}>
			<Text
				multiline
				className="mono"
				aria-label={label}
				aria-invalid={!!error}
				value={source}
				onChange={(text) => {
					setSource(text);
					try {
						const parsed = JSON.parse(text);
						const next = validate ? validate(parsed) : parsed;
						previous.current = JSON.stringify(next ?? null, null, 2);
						onChange(next);
						setError("");
						editorError(id);
					} catch (e) {
						const problem = `${label}：${message(e)}`;
						setError(problem);
						editorError(id, problem);
					}
				}}
			/>
			<Alert>{error}</Alert>
		</Field>
	);
}
const Notices = createContext<(text: string) => void>(() => {});
export const useNotice = () => useContext(Notices);
export function NoticesProvider({ children }: { children: ReactNode }) {
	const [notice, setNotice] = useState("");
	useEffect(() => {
		if (notice) {
			const timer = setTimeout(() => setNotice(""), 5000);
			return () => clearTimeout(timer);
		}
	}, [notice]);
	return (
		<Notices.Provider value={setNotice}>
			{children}
			<output className="ToastRoot" aria-live="polite">
				{notice && <div className="flash flash-success">{notice}</div>}
			</output>
		</Notices.Provider>
	);
}
