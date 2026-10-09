import { MongoCatalog, mongoConfig, mongoFailure } from "../src/web/mongo-catalog.js";
import { prepareMongoCollections } from "../src/web/mongo-schema.js";

const repository = await MongoCatalog.connect(mongoConfig(), false);
try {
	await prepareMongoCollections(repository.db, repository.config.caseCollection, repository.config.moduleCollection, repository.config.verifierCollection);
	await repository.preflight();
	if (process.argv.includes("--seed-modules")) {
		const session = repository.client.startSession();
		try {
			await session.withTransaction(async () => {
				if (await repository.modules.countDocuments({}, { session })) return;
				if (await repository.cases.countDocuments({}, { session })) throw new Error("已有案例的数据库不能自动初始化默认模块");
				const { randomUUID } = await import("node:crypto");
				await repository.modules.insertMany([
					["read_file", "文件读取、路径处理与边界行为"], ["write_file", "文件创建、内容修改与写入验证"],
					["execute_command", "命令执行与错误处理"], ["task_completion", "完整任务执行与最终结果验证"],
				].map(([name, description]) => ({ _id: randomUUID(), name, nameKey: name, description, tags: [], archived: false, createdAt: new Date(), writeVersion: 1 })), { session });
			}, { timeoutMS: 15000 });
		} finally { await session.endSession(); }
	}
	console.log("MongoDB collections, validators and indexes are ready.");
} catch (error) { console.error(mongoFailure(error).message); process.exitCode = 1; }
finally { await repository.close(); }
