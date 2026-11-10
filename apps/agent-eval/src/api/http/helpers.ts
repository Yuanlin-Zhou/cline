export { validateWorkspacePaths } from "../../modules/execution/workspace-validation.js";
export const json = (data: unknown, status = 200) =>
	Response.json(data, { status });
