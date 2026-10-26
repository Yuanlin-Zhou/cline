import {
	existsSync,
	readFileSync,
	unlinkSync,
	openSync,
	writeFileSync,
	closeSync,
	mkdirSync,
} from "node:fs";
import path from "node:path";
const file = (directory: string) => path.join(directory, "eval-service.lock");
export function assertServiceStopped(directory: string) {
	const lock = file(directory);
	if (!existsSync(lock)) return;
	const pid = Number(readFileSync(lock, "utf8"));
	let active = true;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") active = false;
	}
	if (active)
		throw Error(
			"此数据目录已有运行中的评测服务，请先停止该实例再启动或重建索引",
		);
	unlinkSync(lock);
}
export function acquireServiceLock(directory: string) {
	mkdirSync(directory, { recursive: true });
	assertServiceStopped(directory);
	const lock = file(directory),
		fd = openSync(lock, "wx"),
		owner = String(process.pid);
	try {
		writeFileSync(fd, owner);
	} finally {
		closeSync(fd);
	}
	return () => {
		if (existsSync(lock) && readFileSync(lock, "utf8") === owner)
			unlinkSync(lock);
	};
}
