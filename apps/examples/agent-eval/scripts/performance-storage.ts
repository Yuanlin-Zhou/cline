import { assertServiceStopped } from "../src/web/service-lock.js";
import { Database } from "bun:sqlite";
import { Projections } from "../src/web/projections.js";
import path from "node:path";
const args = process.argv.slice(2),
	directory = args.find((a) => !a.startsWith("--"));
if (!directory || !args.includes("--rebuild"))
	throw Error(
		"用法：先停止 Web 服务，再执行 bun scripts/performance-storage.ts /绝对路径/数据目录 --rebuild",
	);
const absolute = path.resolve(directory);
assertServiceStopped(absolute);
const db = new Database(path.join(absolute, "eval.sqlite"), { create: false });
try {
	new Projections(db, absolute, true);
	console.log("摘要/进度索引已重建，原始记录及最新进度已保留；重新启动 Web。");
} finally {
	db.close();
}
