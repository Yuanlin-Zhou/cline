import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { EvalDefaults } from "../../../../src/contracts/evaluation";
import { parseEvalSuite } from "../../../../src/contracts/schema";
import { message, send, useApi } from "../../api/client";
import { assertValidEditors } from "../../components/editor-validity";
import {
	Alert,
	Box,
	Button,
	DataState,
	Heading,
	useNotice,
} from "../../components/ui";
import { useDraft } from "../../hooks/draft";
import { JudgeModelEditor } from "../judging/editor";
import { ConfigEditor } from "./config-editor";

function SettingsForm({ initial }: { initial: EvalDefaults }) {
	const draft = useDraft(initial);
	const notice = useNotice();
	const client = useQueryClient();
	const save = useMutation({
		mutationFn: async () => {
			assertValidEditors();
			const parsed = parseEvalSuite({
				defaults: draft.value,
				cases: [{ id: "settings", prompt: "settings" }],
			}).defaults;
			return send<EvalDefaults>("/api/settings", parsed, "PUT");
		},
		onSuccess: (value) => {
			draft.setValue(value);
			draft.markSaved(value);
			client.setQueryData(["/api/settings"], value);
			notice("运行配置已保存");
		},
	});
	return (
		<Box title="被测模型与默认执行配置">
			<ConfigEditor value={draft.value} onChange={draft.setValue} />
			<Alert>{save.error && message(save.error)}</Alert>
			<Button primary disabled={save.isPending} onClick={() => save.mutate()}>
				{save.isPending ? "保存中…" : "保存运行配置"}
			</Button>
		</Box>
	);
}
export function SettingsPage() {
	const settings = useApi<EvalDefaults>("/api/settings");
	return (
		<>
			<Heading
				title="运行配置"
				description="新案例使用的默认配置；已保存案例和历史快照不追溯修改"
			/>
			<DataState query={settings}>
				{settings.data && <SettingsForm initial={settings.data} />}
			</DataState>
			<JudgeSettings />
		</>
	);
}
function JudgeSettings() {
	const query = useApi<any>("/api/judge-settings");
	const [draft, setDraft] = useState<any>();
	const notice = useNotice();
	useEffect(() => {
		if (query.data !== undefined)
			setDraft(
				query.data ?? {
					providerId: "openai-compatible",
					modelId: "",
					baseUrl: "",
					apiKeyEnv: "",
				},
			);
	}, [query.data]);
	const save = useMutation({
		mutationFn: () => send("/api/judge-settings", draft, "PUT"),
		onSuccess: () => notice("Judge 默认配置已保存"),
	});
	return (
		<Box title="Judge 默认模型">
			<DataState query={query}>
				{draft && <JudgeModelEditor value={draft} onChange={setDraft} />}
			</DataState>
			<Alert>{save.error && message(save.error)}</Alert>
			<Button disabled={!draft || save.isPending} onClick={() => save.mutate()}>
				保存 Judge 默认配置
			</Button>
		</Box>
	);
}
