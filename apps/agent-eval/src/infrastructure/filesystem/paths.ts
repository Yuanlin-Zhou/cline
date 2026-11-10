import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const applicationDirectory = fileURLToPath(
	new URL("../../../", import.meta.url),
);
/** Old server resolved ../../.. from src/web, i.e. apps/examples, not the app directory. */
export function defaultDataDirectory(application = applicationDirectory) {
	const legacy = path.resolve(application, "../examples");
	const repository = path.resolve(application, "../..");
	return existsSync(path.join(repository, "sdk/packages/sdk/package.json")) &&
		existsSync(path.join(legacy, "agent-eval/package.json"))
		? path.join(legacy, ".eval-data")
		: path.join(application, ".eval-data");
}
