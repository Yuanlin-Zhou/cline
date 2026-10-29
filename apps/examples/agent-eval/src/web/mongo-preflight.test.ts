import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Db, MongoClient } from "mongodb";
import { MongoCatalog } from "./mongo-catalog.js";
import {
	MongoVerifiers,
	verifierValidator,
} from "../grading/uploaded-verifiers.js";
import {
	prepareMongoCollections,
	caseValidator,
	moduleValidator,
} from "./mongo-schema.js";

const config = {
	uri: "unused",
	database: "test",
	caseCollection: "cases",
	moduleCollection: "modules",
	verifierCollection: "scripts",
};
function collectionOnlyDatabase(names = ["cases", "modules", "scripts"]) {
	const calls: Array<{ filter: unknown; options: unknown }> = [];
	const forbidden = () => {
		throw Error(
			"Runtime account cannot inspect indexes/options/topology or execute DDL",
		);
	};
	const db = {
		collection: (name: string) => ({
			collectionName: name,
			options: forbidden,
			listIndexes: forbidden,
			createIndexes: forbidden,
			dropIndexes: forbidden,
		}),
		command: forbidden,
		createCollection: forbidden,
		listCollections: (
			filter: { name: string; type?: string },
			options: unknown,
		) => {
			calls.push({ filter, options });
			return { hasNext: async () => names.includes(filter.name) };
		},
	} as unknown as Db;
	return { db, calls };
}
test("Mongo startup accepts collection-listing privileges without inspecting indexes, validators or topology", async () => {
	const { db, calls } = collectionOnlyDatabase();
	await new MongoCatalog({} as MongoClient, db, config).preflight();
	await new MongoVerifiers(db, config.verifierCollection).preflight();
	expect(calls).toEqual(
		["cases", "modules", "scripts"].map((name) => ({
			filter: { name, type: "collection" },
			options: { nameOnly: true },
		})),
	);
});
test("Mongo startup names missing collections and does not swallow failed collection inspection", async () => {
	for (const missing of ["cases", "modules", "scripts"]) {
		const { db } = collectionOnlyDatabase(
			["cases", "modules", "scripts"].filter((name) => name !== missing),
		);
		const check =
			missing === "scripts"
				? new MongoVerifiers(db, "scripts").preflight()
				: new MongoCatalog({} as MongoClient, db, config).preflight();
		await expect(check).rejects.toMatchObject({
			status: 503,
			message: expect.stringContaining(missing),
		});
	}
	const { db } = collectionOnlyDatabase();
	db.listCollections = (() => {
		throw Error("collection listing denied");
	}) as Db["listCollections"];
	await expect(
		new MongoCatalog({} as MongoClient, db, config).preflight(),
	).rejects.toThrow("collection listing denied");
	await expect(
		new MongoVerifiers(db, "scripts").preflight(),
	).rejects.toMatchObject({ status: 503 });
});
test("explicit Mongo preparation creates or updates validators without accessing indexes", async () => {
	const existing = new Set<string>(),
		creates: Array<{ name: string; options: unknown }> = [],
		updates: Array<Record<string, unknown>> = [];
	const db = {
		listCollections: ({ name }: { name: string }) => ({
			hasNext: async () => existing.has(name),
		}),
		createCollection: async (name: string, options: unknown) => {
			existing.add(name);
			creates.push({ name, options });
		},
		command: async (command: Record<string, unknown>) => {
			expect(command.collMod).toBeString();
			updates.push(command);
		},
		collection: () => {
			throw Error("Index access not permitted");
		},
	} as unknown as Db;
	await prepareMongoCollections(db, "cases", "modules", "scripts");
	expect(creates).toHaveLength(3);
	for (const [name, validator] of [
		["cases", caseValidator],
		["modules", moduleValidator],
		["scripts", verifierValidator],
	] as const)
		expect(creates.find((c) => c.name === name)?.options).toEqual({
			validator,
			validationLevel: "strict",
			validationAction: "error",
		});
	await prepareMongoCollections(db, "cases", "modules", "scripts");
	expect(creates).toHaveLength(3);
	expect(updates).toHaveLength(3);
	await expect(
		prepareMongoCollections(db, "same", "same", "scripts"),
	).rejects.toThrow("不能同名");
});
test("native Mongo commands keep complete validators with no custom index operations", async () => {
	for (const name of ["create", "update", "rebuild"]) {
		const text = await readFile(
			new URL(
				`../../docs/mongodb-admin/${name}-collections.txt`,
				import.meta.url,
			),
			"utf8",
		);
		expect(text).not.toMatch(/\b(?:createIndexes?|dropIndexes?|listIndexes)\b/);
		const commands = [...text.matchAll(/db\.runCommand\(([\s\S]*?)\);/g)].map(
			(match) => JSON.parse(match[1]),
		);
		expect(commands).toHaveLength(3);
		expect(commands.map((command) => command.validator)).toEqual([
			caseValidator,
			moduleValidator,
			verifierValidator,
		]);
		expect(
			commands.map(
				(command) => command[name === "update" ? "collMod" : "create"],
			),
		).toEqual([
			"agent_eval_cases",
			"agent_eval_modules",
			"agent_eval_verifiers",
		]);
		if (name === "rebuild") expect(text.match(/\.drop\(\);/g)).toHaveLength(3);
	}
});
