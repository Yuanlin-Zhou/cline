import type { SavedCase } from "../../contracts/catalog.js";
import type { CaseSummary } from "../../contracts/projections.js";

export function caseSummary(c: SavedCase): CaseSummary {
	return {
		summary: true,
		id: c.id,
		moduleId: c.moduleId,
		revision: c.revision,
		updatedAt: c.updatedAt,
		archived: c.archived,
		definition: {
			isBadCase: Boolean(
				c.definition.badCase ||
					(c.definition as { isBadCase?: boolean }).isBadCase,
			),
			id: c.definition.id,
			description: c.definition.description,
			tags: c.definition.tags,
			replayMode: c.definition.replayMode,
		},
		defaults: {
			providerId: c.defaults.providerId,
			modelId: c.defaults.modelId,
		},
	};
}
