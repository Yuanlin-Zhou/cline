import type { EvalDefaults } from "../../contracts/evaluation.js";
import { parseEvalSuite } from "../../contracts/schema.js";
import { validateWorkspacePaths } from "../execution/workspace-validation.js";
import { parseJudgeModel } from "../judging/config.js";
import type { RecordRepository } from "../records.js";

export class SettingsService {
	constructor(private records: RecordRepository) {}
	get() {
		return this.records.require<EvalDefaults>("settings", "default");
	}
	save(input: unknown) {
		const settings = parseEvalSuite({
			defaults: input,
			cases: [{ id: "settings", prompt: "settings" }],
		}).defaults;
		validateWorkspacePaths(
			{
				id: "settings",
				prompt: "settings",
				history: [],
				replayMode: "full-task",
			},
			settings,
		);
		this.records.put("settings", "default", settings);
		return settings;
	}
	getJudge() {
		return this.records.get("judge-settings", "default") ?? null;
	}
	saveJudge(input: unknown) {
		const model = parseJudgeModel(input);
		this.records.put("judge-settings", "default", model);
		return model;
	}
}
