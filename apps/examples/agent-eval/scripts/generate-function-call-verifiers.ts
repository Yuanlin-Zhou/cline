import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "../../../../sdk/packages/shared/src/parse/zod.ts";
import {
	ReadFilesInputSchema,
	SearchCodebaseInputSchema,
	RunCommandsInputSchema,
	FetchWebContentInputSchema,
	EditFileInputSchema,
	SkillsInputSchema,
} from "../../../../sdk/packages/core/src/extensions/tools/schemas.ts";
const root = new URL("../", import.meta.url);
const schemas = {
	read_files: ReadFilesInputSchema,
	search_codebase: SearchCodebaseInputSchema,
	run_commands: RunCommandsInputSchema,
	fetch_web_content: FetchWebContentInputSchema,
	editor: EditFileInputSchema,
	skills: SkillsInputSchema,
};
const exported = Object.fromEntries(
	Object.entries(schemas).map(([name, schema]) => [
		name,
		zodToJsonSchema(schema),
	]),
);
const template = await readFile(
	new URL("scripts/function-call-verifier.py", root),
	"utf8",
);
const source = await readFile(
	new URL(
		"../../../../sdk/packages/core/src/extensions/tools/schemas.ts",
		import.meta.url,
	),
);
const files = new Map<string, string>();
files.set(
	"src/function-call-schemas.json",
	JSON.stringify(exported, null, 2) + "\n",
);
files.set(
	"examples/function-calls/schemas.json",
	JSON.stringify(exported, null, 2) + "\n",
);
files.set(
	"examples/function-calls/manifest.json",
	JSON.stringify(
		{
			schemaVersion: 1,
			source: "sdk/packages/core/src/extensions/tools/schemas.ts",
			sourceSha256: createHash("sha256").update(source).digest("hex"),
			tools: Object.keys(exported),
		},
		null,
		2,
	) + "\n",
);
for (const [name, schema] of Object.entries(exported))
	files.set(
		`examples/function-calls/verify_${name}.py`,
		template
			.replace("__TOOL_LITERAL__", JSON.stringify(name))
			.replace("__SCHEMA_LITERAL__", JSON.stringify(JSON.stringify(schema))),
	);
for (const [relative, content] of files) {
	const target = new URL(relative, root);
	if (process.argv.includes("--check")) {
		if ((await readFile(target, "utf8")) !== content)
			throw Error(`Generated file differs: ${fileURLToPath(target)}`);
	} else await writeFile(target, content);
}
console.log(
	process.argv.includes("--check")
		? "Function call schemas and six verifiers are current."
		: "Generated six standalone Python verifiers and schema snapshots.",
);
