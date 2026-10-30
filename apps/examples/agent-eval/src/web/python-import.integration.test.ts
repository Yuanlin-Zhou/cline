import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MongoCatalog, mongoConfig } from "./mongo-catalog.js";
import { prepareMongoCollections } from "./mongo-schema.js";
import { parseEvalSuite } from "../schema.js";

const uri = process.env.EVAL_TEST_MONGODB_URI, python = process.env.EVAL_TEST_PYTHON;
const integration = uri && python ? test : test.skip;
const examples = path.resolve(import.meta.dir, "../../examples/python-mongodb-import");
integration("Python imports pass real validators, preserve tool chains and coordinate retries and conflicts", async () => {
	const config = {...mongoConfig({EVAL_MONGODB_URI:uri}), database:`eval_python_${randomUUID().replaceAll("-","")}`};
	const repo = await MongoCatalog.connect(config,false);
	try {
		await prepareMongoCollections(repo.db,config.caseCollection,config.moduleCollection,config.verifierCollection);
		const module = await repo.createModule("Python imports");
		const call = async (code: string) => {
			const proc = Bun.spawn([python!,"-c",code],{cwd:examples,env:{...process.env,EVAL_MONGODB_URI:uri!,TEST_DATABASE:config.database,TEST_MODULE:module.id},stdout:"pipe",stderr:"pipe"});
			const [output,errors,exit] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
			expect(errors).toBe(""); expect(exit).toBe(0); return JSON.parse(output);
		};
		const setup = `import os,json\nfrom pathlib import Path\nfrom concurrent.futures import ThreadPoolExecutor\nfrom pymongo import MongoClient\nfrom import_cases import *\nclient=MongoClient(os.environ['EVAL_MONGODB_URI'])\ndatabase=os.environ['TEST_DATABASE']\ndef payload(name):\n p=json.loads(Path(name).read_text());p['moduleId']=os.environ['TEST_MODULE'];return p\n`;
		const results = await call(setup+`p=payload('bad-case.json')\nnormal=payload('single-turn.json')\nf=payload('function-call-bad-case.json')\na=import_single_turn_case(client,database,normal)\nb=import_bad_case(client,database,p)\nc=import_bad_case(client,database,f)\nwith ThreadPoolExecutor(max_workers=2) as pool:\n repeats=list(pool.map(lambda _:import_bad_case(client,database,p),range(2)))\np['badCase']['reason']='changed'\nconflict=import_bad_case(client,database,p)\nprint(json.dumps([a,b,c,*repeats,conflict]))`);
		expect(results.map((r:any)=>r.status)).toEqual(["created","created","created","unchanged","unchanged","conflict"]);
		const race = await call(setup+`p=payload('bad-case.json');p['name']='simultaneous-import';p['source']['turnId']='simultaneous'\nwith ThreadPoolExecutor(max_workers=2) as pool:\n results=list(pool.map(lambda _:import_bad_case(client,database,p),range(2)))\nprint(json.dumps(results))`);
		expect(race.map((r:any)=>r.status).sort()).toEqual(["created","unchanged"]);
		expect(race[0].caseId).toBe(race[1].caseId);
		expect(await repo.cases.countDocuments({_id:race[0].caseId})).toBe(1);
		await repo.cases.deleteOne({_id:race[0].caseId});
		const saved = await repo.snapshot(); expect(saved.cases).toHaveLength(3);
		for (const c of saved.cases) {
			const parsed = parseEvalSuite({defaults:c.defaults,cases:[c.definition]}); expect(parsed.cases[0]).toEqual(c.definition);
		}
		const bad = saved.cases.find(c=>c.id===results[1].caseId)!;
		expect(bad.definition.badCase?.observedOutput).toContain("npm install");
		const summaries = await repo.summaries();
		expect(summaries.cases.filter(c=>c.definition.isBadCase)).toHaveLength(2);
		expect(JSON.stringify(summaries)).not.toContain("observedOutput");
		expect(JSON.stringify(summaries)).not.toContain("npm install");
		const copied = await repo.duplicateCase(bad.id); expect(copied.definition.badCase).toEqual(bad.definition.badCase);
		await repo.setArchived("case",bad.id,true);
		expect((await call(setup+`print(json.dumps(import_bad_case(client,database,payload('bad-case.json'))))`)).status).toBe("conflict");
		await repo.db.command({collMod:config.caseCollection,validator:{"definition.id":{$ne:"rejected"}},validationLevel:"strict",validationAction:"error"});
		const before = await repo.modules.findOne({_id:module.id});
		const rejected = await call(setup+`p=payload('single-turn.json');p['name']='rejected';p['source']['turnId']='rejected'\nprint(json.dumps(import_single_turn_case(client,database,p)))`);
		expect(rejected).toMatchObject({status:"validation-failed",collection:config.caseCollection,stage:"insert-case",code:121});
		expect(await repo.modules.findOne({_id:module.id})).toEqual(before);
		expect(await repo.cases.countDocuments({"definition.id":"rejected"})).toBe(0);
		// 模块规则也可能拒绝导入；诊断必须明确这是 touch-module，而不是 cases。
		await repo.db.command({collMod:config.moduleCollection,validator:{writeVersion:before!.writeVersion},validationLevel:"strict",validationAction:"error"});
		const rejectedModule = await call(setup+`p=payload('single-turn.json');p['name']='module-rejected';p['source']['turnId']='module-rejected'\nprint(json.dumps(import_single_turn_case(client,database,p)))`);
		expect(rejectedModule).toMatchObject({status:"validation-failed",collection:config.moduleCollection,stage:"touch-module",code:121});
	} finally { await repo.db.dropDatabase(); await repo.close(); }
},60000);

integration("Python complete-conversation entries persist Web-compatible snapshots without leaking selected bad responses", async () => {
	const config={...mongoConfig({EVAL_MONGODB_URI:uri}),database:`eval_conversation_${randomUUID().replaceAll("-","")}`};
	const repo=await MongoCatalog.connect(config,false);
	try {
		await prepareMongoCollections(repo.db,config.caseCollection,config.moduleCollection,config.verifierCollection);
		const module=await repo.createModule("Conversation imports");
		const script=`import os,json,copy\nfrom pathlib import Path\nfrom pymongo import MongoClient\nfrom import_cases import import_case_from_conversation,import_bad_case_from_conversation,preview_conversation_case\nclient=MongoClient(os.environ['EVAL_MONGODB_URI'])\ndatabase=os.environ['TEST_DATABASE']\ndef load(name):\n p=json.loads(Path(name).read_text());p['moduleId']=os.environ['TEST_MODULE'];return p\np=load('conversation-bad-case.json')\na=import_bad_case_from_conversation(client,database,p)\nb=import_bad_case_from_conversation(client,database,p)\np['badCase']['reason']='changed'\nc=import_bad_case_from_conversation(client,database,p)\nnormal=import_case_from_conversation(client,database,load('conversation-normal.json'))\ncline=import_case_from_conversation(client,database,load('conversation-cline.json'))\ntyped=import_case_from_conversation(client,database,load('conversation-type-data.json'))\nclinebad=import_bad_case_from_conversation(client,database,load('conversation-cline-bad-case.json'))\nbefore=client[database]['agent_eval_modules'].find_one({'_id':os.environ['TEST_MODULE']})['writeVersion']\np['badMessageIndex']=999\ntry:\n import_bad_case_from_conversation(client,database,p)\n invalid=False\nexcept ValueError:\n invalid=True\nafter=client[database]['agent_eval_modules'].find_one({'_id':os.environ['TEST_MODULE']})['writeVersion']\nprint(json.dumps({'results':[a,b,c,normal,cline,typed,clinebad],'invalidBeforeWrite':invalid and before==after}))`;
		const proc=Bun.spawn([python!,"-c",script],{cwd:examples,env:{...process.env,EVAL_MONGODB_URI:uri!,TEST_DATABASE:config.database,TEST_MODULE:module.id},stdout:"pipe",stderr:"pipe"});
		const [output,errors,exit]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
		expect(errors).toBe("");expect(exit).toBe(0);const data=JSON.parse(output);
		expect(data.results.map((r:any)=>r.status)).toEqual(["created","unchanged","conflict","created","created","created","created"]);
		expect(data.invalidBeforeWrite).toBe(true);
		expect(data.results[0].boundary).toMatchObject({badMessageIndex:2,selectedCount:2,excludedCount:2});
		const saved=(await repo.snapshot()).cases;expect(saved).toHaveLength(5);
		for(const item of saved){
			expect(parseEvalSuite({defaults:item.defaults,cases:[item.definition]}).cases[0]).toEqual(item.definition);
			expect(item.definition.replayMode).toBe("function-call");
			expect(item.definition.functionCall!.history!.length).toBe(item.definition.functionCall!.historySource!.messages.length);
		}
		const bad=saved.find(c=>c.id===data.results[0].caseId)!;
		expect(bad.definition.badCase!.observedOutput).toContain("npm install");
		expect(JSON.stringify([bad.definition.prompt,bad.definition.functionCall!.history])).not.toContain("npm install");
		expect(JSON.stringify([bad.definition.prompt,bad.definition.functionCall!.history])).not.toContain("后续消息");
		const clineBad=saved.find(c=>c.id===data.results[6].caseId)!;
		expect(JSON.stringify(clineBad.definition.functionCall!.history)).not.toContain("FUTURE_INPUT_NOT_REPLAYED");
		expect(clineBad.definition.functionCall!.history!.some(m=>m.role==="tool"&&m.tool_call_id==="call_1")).toBe(true);
		const count=await repo.cases.countDocuments();
		await repo.db.command({collMod:config.caseCollection,validator:{"definition.id":{$ne:"blocked-conversation"}},validationLevel:"strict",validationAction:"error"});
		const before=await repo.modules.findOne({_id:module.id});
		const blocked=Bun.spawn([python!,"-c",`import os,json\nfrom pathlib import Path\nfrom pymongo import MongoClient\nfrom import_cases import import_bad_case_from_conversation\np=json.loads(Path('conversation-bad-case.json').read_text());p['moduleId']=os.environ['TEST_MODULE'];p['source']['turnId']='blocked';p['name']='blocked-conversation'\nprint(json.dumps(import_bad_case_from_conversation(MongoClient(os.environ['EVAL_MONGODB_URI']),os.environ['TEST_DATABASE'],p)))`],{cwd:examples,env:{...process.env,EVAL_MONGODB_URI:uri!,TEST_DATABASE:config.database,TEST_MODULE:module.id},stdout:"pipe",stderr:"pipe"});
		const blockedOutput=await new Response(blocked.stdout).text();expect(await new Response(blocked.stderr).text()).toBe("");expect(await blocked.exited).toBe(0);
		expect(JSON.parse(blockedOutput)).toMatchObject({status:"validation-failed",stage:"insert-case",code:121});
		expect(await repo.cases.countDocuments()).toBe(count);expect(await repo.modules.findOne({_id:module.id})).toEqual(before);
	} finally {await repo.db.dropDatabase();await repo.close();}
},60000);
