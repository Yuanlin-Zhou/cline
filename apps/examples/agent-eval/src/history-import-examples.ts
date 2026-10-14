const standard = [
	{ role: "system", content: "你是代码助手。需要修改文件时使用 editor 工具。" },
	{ role: "user", content: "读取 demo.py" },
	{
		role: "assistant",
		content: null,
		tool_calls: [
			{
				id: "call_1",
				type: "function",
				function: { name: "read_files", arguments: '{"paths":["demo.py"]}' },
			},
		],
	},
	{ role: "tool", tool_call_id: "call_1", content: "print('hello')\n" },
	{
		role: "user",
		content: "把 demo.py 中的 hello 改成 world，使用 editor 工具。",
	},
];
export const clineHistoryExample = {
	version: 1,
	agent: "lead",
	sessionId: "original-session",
	system_prompt: standard[0].content,
	messages: [
		{
			id: "m1",
			role: "user",
			content: [{ type: "text", text: standard[1].content }],
		},
		{
			id: "m2",
			role: "assistant",
			content: [
				{ type: "text", text: "先查看文件。" },
				{
					type: "tool_use",
					id: "internal_1",
					call_id: "call_1",
					name: "read_files",
					input: { paths: ["demo.py"] },
				},
			],
		},
		{
			id: "m3",
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "internal_1",
					name: "read_files",
					content: "print('hello')\n",
					is_error: false,
				},
			],
		},
		{
			id: "m4",
			role: "user",
			content: [{ type: "text", text: standard[4].content }],
		},
	],
};
export const historyImportExamples = [
	{
		label: "Cline 原生记录",
		value: JSON.stringify(clineHistoryExample, null, 2),
	},
	{
		label: "标准 messages",
		value: JSON.stringify({ messages: standard }, null, 2),
	},
	{
		label: "type/data 包装",
		value: JSON.stringify(
			{ messages: standard.map(({ role, ...data }) => ({ type: role, data })) },
			null,
			2,
		),
	},
];
