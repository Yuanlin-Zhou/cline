import path from "node:path";
import { MongoCatalog, mongoConfig } from "../src/web/mongo-catalog.js";
import { migrateSqliteCatalog } from "../src/web/mongo/migrate.js";

const args = process.argv.slice(2);
const index = args.indexOf("--sqlite");
if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Usage: bun run mongo:migrate --sqlite /absolute/path/eval.sqlite [--apply]");
const repository = await MongoCatalog.connect(mongoConfig());
try {
	const report = await migrateSqliteCatalog(repository, path.resolve(args[index + 1]), !args.includes("--apply"));
	console.log(JSON.stringify(report, null, 2)); if (report.conflicts.length) process.exitCode = 1;
} catch (error) { console.error(error instanceof Error ? error.message : "Migration failed"); process.exitCode = 1; }
finally { await repository.close(); }
