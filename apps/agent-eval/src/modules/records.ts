/** Business services persist records without depending on a database driver. */
export interface RecordRepository {
	readonly directory: string;
	transaction<T>(fn: () => T): { (): T; immediate(): T };
	get<T>(kind: string, id: string): T | undefined;
	require<T>(kind: string, id: string): T;
	list<T>(kind: string): T[];
	put(kind: string, id: string, value: unknown): void;
}
