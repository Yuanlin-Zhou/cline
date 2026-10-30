import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvalServer } from "./server.js";
import { SqliteCatalog } from "./catalog.js";

test("result details and retries retain the original bad example after catalog edits or deletion", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "bad-example-result-"));
	const app = await createEvalServer({directory,port:0,storage:"sqlite",execute:async item=>({
		id:item.snapshot.definition.id,sessionId:item.id,status:item.attempt?"passed":"failed",text:"CURRENT_RUN_OUTPUT",durationMs:12,iterations:1,usage:{inputTokens:1,outputTokens:1},toolCalls:[],assertions:[],
	})});
	const origin = `http://127.0.0.1:${app.server.port}`;
	try {
		const module = app.store.activeModules()[0]!;
		const definition = {id:"bad example",prompt:"question",history:[],badCase:{observedOutput:"ORIGINAL_BAD_EXAMPLE",reason:"original cause"}};
		const saved = app.store.createCase(module.id,app.store.settings(),definition);
		const run = app.store.createRun({caseIds:[saved.id]}); app.queue.kick(); await app.queue.idle();
		const first = app.store.items(run.id)[0]!;
		new SqliteCatalog(app.store).updateCase(saved.id,saved.revision,saved.defaults,{...definition,badCase:{observedOutput:"CHANGED_CATALOG_EXAMPLE"}});
		app.store.deleteCase(saved.id);
		const read = async (id: string) => (await fetch(`${origin}/api/runs/${run.id}/items/${id}`)).json();
		expect((await read(first.id)).snapshot.definition.badCase).toEqual(definition.badCase);
		const retried = await fetch(`${origin}/api/runs/${run.id}/retry`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:"bad-example-retry",expectedRetryRevision:0,itemIds:[first.id]})});
		expect(retried.status).toBe(202); const retry = await retried.json(); await app.queue.idle();
		const second = await read(retry.itemIds[0]);
		expect(second.snapshot.definition.badCase).toEqual(definition.badCase);
		expect(second.result.text).toBe("CURRENT_RUN_OUTPUT"); expect(second.status).toBe("passed");
		expect((await read(first.id)).status).toBe("failed");
		const overview = await (await fetch(`${origin}/api/runs/${run.id}/overview`)).text();
		expect(overview).not.toContain("ORIGINAL_BAD_EXAMPLE");
		expect(overview).not.toContain("CHANGED_CATALOG_EXAMPLE");
	} finally { await app.close(); await rm(directory,{recursive:true,force:true}); }
});
