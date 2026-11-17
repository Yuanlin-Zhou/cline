import { UploadOutlined } from "@ant-design/icons";
import { Button, Collapse, Empty, Table, Tag, Upload } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
	type ChangeEvent,
	Children,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useEffect,
	useState,
} from "react";

// Descriptor children keep existing cell event handlers and stable row identities
// while Ant Design owns table rendering, empty states and layout.
function elements(children: ReactNode): ReactElement<any>[] {
	return Children.toArray(children).filter(
		isValidElement,
	) as ReactElement<any>[];
}
export function DataTable({
	children,
	className,
	emptyText = "暂无数据",
}: {
	children: ReactNode;
	emptyText?: ReactNode;
	className?: string;
}) {
	const sections = elements(children);
	const header = sections.find((s) => s.type === "thead");
	const body = sections.find((s) => s.type === "tbody");
	const heads = elements(elements(header?.props.children)[0]?.props.children);
	const rows = elements(body?.props.children);
	const placeholder =
		rows.length === 1 &&
		elements(rows[0].props.children)[0]?.props.colSpan === heads.length
			? elements(rows[0].props.children)[0].props.children
			: undefined;
	const data = (placeholder ? [] : rows).map((row, index) => ({
		key: row.key ?? index,
		row,
		cells: elements(row.props.children),
	}));
	if (!data.length)
		return (
			<Empty
				image={Empty.PRESENTED_IMAGE_SIMPLE}
				description={placeholder ?? emptyText}
			/>
		);
	const columns: ColumnsType<(typeof data)[number]> = heads.map(
		(head, index) => ({
			key: String(index),
			title: head.props.children,
			className: head.props.className,
			width: className?.includes("CaseTable")
				? [48, 280, 170, 160, 65, 100, 140][index]
				: undefined,
			render: (_, record) => record.cells[index]?.props.children,
			onCell: (record) => {
				const { children: _, ...props } = record.cells[index]?.props ?? {};
				return props;
			},
		}),
	);
	return (
		<Table
			className={
				className?.includes("CaseTable") ? "eval-case-table" : "eval-table"
			}
			size="small"
			pagination={false}
			scroll={
				className?.includes("CaseTable")
					? { x: 1040 }
					: heads.length >= 5
						? { x: 720 }
						: undefined
			}
			columns={columns}
			dataSource={data}
			rowKey="key"
			onRow={(record) => {
				const { children: _, ...props } = record.row.props;
				return props;
			}}
			locale={{
				emptyText: (
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description={placeholder ?? emptyText}
					/>
				),
			}}
		/>
	);
}
export function DisclosureTitle({
	children,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return <>{children}</>;
}
export function Disclosure({
	children,
	open = false,
	onToggle,
	className,
}: {
	children: ReactNode;
	open?: boolean;
	onToggle?: (event: { currentTarget: { open: boolean } }) => void;
	className?: string;
}) {
	const items = Children.toArray(children);
	const title = items.find(
		(c) => isValidElement(c) && c.type === DisclosureTitle,
	) as ReactElement<{ children: ReactNode }> | undefined;
	const [expanded, setExpanded] = useState(open);
	useEffect(() => setExpanded(open), [open]);
	return (
		<Collapse
			className={`eval-disclosure ${className?.replace(/\bBox\b/g, "") ?? ""}`}
			activeKey={expanded ? ["content"] : []}
			onChange={(keys) => {
				const next = keys.includes("content");
				setExpanded(next);
				onToggle?.({ currentTarget: { open: next } });
			}}
			items={[
				{
					key: "content",
					label: title?.props.children,
					children: items.filter((c) => c !== title),
					forceRender: true,
				},
			]}
		/>
	);
}
export function Badge({
	children,
	className,
	...props
}: {
	children?: ReactNode;
	className?: string;
	[key: string]: any;
}) {
	return (
		<Tag
			{...props}
			color={
				className?.includes("attention")
					? "warning"
					: className?.includes("danger")
						? "error"
						: className?.includes("done")
							? "success"
							: className?.includes("accent")
								? "blue"
								: undefined
			}
		>
			{children}
		</Tag>
	);
}
export function FilePicker({
	onChange,
	accept,
	multiple,
	id,
	...props
}: {
	onChange: (event: ChangeEvent<HTMLInputElement>) => unknown;
	accept?: string;
	multiple?: boolean;
	id?: string;
	[key: string]: any;
}) {
	const [error, setError] = useState("");
	const [names, setNames] = useState<string[]>([]);
	return (
		<div>
			<Upload
				accept={accept}
				multiple={multiple}
				showUploadList={false}
				beforeUpload={(file, list) => {
					// Upload invokes beforeUpload once per file; dispatch a multi-file selection once.
					if (file === list[0]) {
						setError("");
						setNames(list.map((f) => f.name));
						void Promise.resolve(
							onChange({
								target: { files: list },
								currentTarget: { files: list },
							} as unknown as ChangeEvent<HTMLInputElement>),
						).catch((e) => setError(String(e)));
					}
					return false;
				}}
			>
				<Button
					id={id}
					aria-label={props["aria-label"] ?? "选择文件"}
					icon={<UploadOutlined />}
				>
					选择文件
				</Button>
			</Upload>
			{names.length > 0 && <div className="form-hint">{names.join("、")}</div>}
			{error && <div role="alert">{error}</div>}
		</div>
	);
}

export function ActionLink({
	to,
	href,
	className,
	children,
	...props
}: {
	to?: string;
	href?: string;
	className?: string;
	children: ReactNode;
	[key: string]: any;
}) {
	return (
		<Button
			{...props}
			type={className?.includes("primary") ? "primary" : "default"}
			href={to ? `#${to}` : href}
		>
			{children}
		</Button>
	);
}
