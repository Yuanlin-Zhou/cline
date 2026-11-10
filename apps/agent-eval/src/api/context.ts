import type { EvalStore } from "../infrastructure/sqlite/store.js";
import type { CatalogRepository } from "../modules/catalog/repository.js";
import type { VerifierRepository } from "../modules/grading/uploaded-verifiers.js";
import type { VerifierTests } from "../modules/grading/verifier-tests.js";
import type { JudgeScores } from "../modules/judging/scores.js";
import type { RunViews } from "../modules/runs/queries.js";
import type { EvalQueue } from "../modules/runs/queue.js";
export type ApiContext = {
	store: EvalStore;
	catalog: CatalogRepository;
	queue: EvalQueue;
	views: RunViews;
	verifierRepository: VerifierRepository;
	verifierTests: VerifierTests;
	judgeScores: JudgeScores;
};
