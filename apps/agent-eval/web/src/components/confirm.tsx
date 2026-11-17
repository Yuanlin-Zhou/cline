import { Input, Modal } from "antd";

export function confirmAction(title: string): Promise<boolean> {
	return new Promise((resolve) => {
		Modal.confirm({
			title,
			okText: "确认",
			cancelText: "取消",
			okButtonProps: { autoInsertSpace: false },
			cancelButtonProps: { autoInsertSpace: false },
			onOk: () => resolve(true),
			onCancel: () => resolve(false),
		});
	});
}
export function promptText(title: string): Promise<string | null> {
	return new Promise((resolve) => {
		let value = "";
		Modal.confirm({
			title,
			content: (
				<Input
					aria-label="确认模块名称"
					onChange={(event) => {
						value = event.target.value;
					}}
				/>
			),
			okText: "确认",
			cancelText: "取消",
			okButtonProps: { autoInsertSpace: false },
			cancelButtonProps: { autoInsertSpace: false },
			onOk: () => resolve(value),
			onCancel: () => resolve(null),
		});
	});
}
