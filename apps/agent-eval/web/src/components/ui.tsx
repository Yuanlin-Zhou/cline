import type { UseQueryResult } from "@tanstack/react-query";
import {
	Alert as AntAlert,
	Button as AntButton,
	Modal as AntModal,
	Select as AntSelect,
	Tabs as AntTabs,
	App,
	Card,
	Checkbox,
	Form,
	Input,
	InputNumber,
	Skeleton,
	Tag,
} from "antd";
import {
	cloneElement,
	createContext,
	isValidElement,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
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
		<AntAlert
			role={kind === "error" ? "alert" : "status"}
			type={
				kind === "warning"
					? "warning"
					: kind === "success"
						? "success"
						: kind === "error"
							? "error"
							: "info"
			}
			title={children}
			showIcon
			className="eval-alert"
		/>
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
		<Form.Item layout="vertical" label={label} htmlFor={id} extra={hint}>
			{isValidElement<{ id?: string }>(children)
				? cloneElement(children, { id: children.props.id ?? id })
				: children}
		</Form.Item>
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
		className: props.className,
		value: value ?? "",
		onChange: (e: any) => onChange(e.target.value),
	};
	if (props.type === "number")
		return (
			<InputNumber
				{...props}
				value={value === "" || value === undefined ? null : Number(value)}
				onChange={(v) => onChange(v === null ? "" : String(v))}
				style={{ width: "100%" }}
			/>
		);
	return multiline ? (
		<Input.TextArea rows={5} {...shared} />
	) : (
		<Input {...shared} />
	);
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
		<AntSelect
			virtual={false}
			{...props}
			value={value ?? ""}
			onChange={onChange}
			options={options.map(([value, label]) => ({ value, label }))}
			style={{ width: "100%", ...props.style }}
		/>
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
		<Checkbox
			checked={!!checked}
			disabled={disabled}
			onChange={(e) => onChange(e.target.checked)}
		>
			{children}
		</Checkbox>
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
			<AntButton
				htmlType="button"
				{...props}
				disabled={props.disabled || pending}
				onClick={click}
				type={primary ? "primary" : "default"}
				danger={danger}
				loading={pending}
				size={
					props.size ??
					(props.className?.includes("btn-sm") ? "small" : "middle")
				}
				className={props.className?.replace(
					/\bbtn(?:-sm|-primary|-danger)?\b/g,
					"",
				)}
			>
				{children}
			</AntButton>
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
		<Card title={title} className="eval-card" size="small">
			{children}
		</Card>
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
		<AntTabs
			defaultActiveKey={initial ?? entries[0]?.[0]}
			onChange={onChange}
			destroyOnHidden={false}
			items={entries.map(([key, label, children]) => ({
				key,
				label,
				children,
				forceRender: true,
			}))}
		/>
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
		<AntModal
			open={open}
			onCancel={onClose}
			title={title}
			footer={null}
			width={800}
			destroyOnHidden={false}
			maskClosable={false}
		>
			{children}
		</AntModal>
	);
}

export function DataState({
	query,
	children,
}: {
	query: UseQueryResult<any, any>;
	children: ReactNode;
}) {
	if (query.isPending) return <Skeleton active title paragraph={{ rows: 3 }} />;
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
		<Tag
			color={
				value === "passed" || value === "completed"
					? "success"
					: value === "failed" || value === "error"
						? "error"
						: value === "running"
							? "processing"
							: value === "inconclusive"
								? "warning"
								: "default"
			}
		>
			{value ? (labels[value] ?? value) : "未运行"}
		</Tag>
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
	const { message: notice } = App.useApp();
	return (
		<Notices.Provider
			value={(text) => {
				void notice.success({ key: "eval-notice", content: text });
			}}
		>
			{children}
		</Notices.Provider>
	);
}
