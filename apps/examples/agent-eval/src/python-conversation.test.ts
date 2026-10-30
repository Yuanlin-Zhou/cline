import { expect, test } from "bun:test";
import path from "node:path";
import { readHistoryDocument, convertHistoryDocument } from "./function-call-history.js";

const python = process.env.EVAL_TEST_PYTHON ?? Bun.which("python3") ?? Bun.which("python");
const crossTest = python ? test : test.skip;
const directory = path.resolve(import.meta.dir, "../examples/python-mongodb-import");
type Input = { name:string; conversation: any; options?: any; badMessageIndex?: number };
function reference(input: Input) {
	const source = typeof input.conversation === "string" ? input.conversation.replace(/^\uFEFF/,"") : JSON.stringify(input.conversation);
	let doc = readHistoryDocument(source);
	const originalCount = doc.messages.length;
	if (input.badMessageIndex !== undefined) {
		const index = input.badMessageIndex;
		if (!Number.isInteger(index) || index <= 0 || index >= originalCount || doc.messages[index]?.role !== "assistant") throw Error("invalid bad index");
		const raw = JSON.parse(source);
		const prefix = Array.isArray(raw) ? raw.slice(0,index) : {...raw,["messgaes" in raw ? "messgaes" : "messages"]:(raw.messages??raw.messgaes).slice(0,index)};
		doc = readHistoryDocument(JSON.stringify(prefix));
	}
	const last = doc.candidates.find(c=>c.index===doc.messages.length-1);
	const converted = convertHistoryDocument(doc,{...(last?{currentIndex:last.index}:{}),ignoreThinking:input.options?.ignoreThinking,systemSource:input.options?.systemSource});
	if (last) {
		converted.source.notices = converted.source.notices.filter(n=>!n.startsWith(`第 ${last.index+1} 条作为本轮输入`));
		converted.source.notices.push("实际末条用户消息作为本轮输入；原对话顺序完整保留，未追加续接消息");
	} else {
		converted.prompt=input.options?.continuation??"继续";
		converted.source.notices.push("完整保留历史，自动追加用户消息作为本轮输入");
	}
	if(input.badMessageIndex!==undefined)converted.source.notices.push(`按 badMessageIndex=${input.badMessageIndex} 截取：原始第 ${input.badMessageIndex+1} 条错误回复及后续 ${originalCount-input.badMessageIndex-1} 条消息不进入回放输入`);
	return {...converted,boundary:{originalCount,selectedCount:doc.messages.length,excludedCount:originalCount-doc.messages.length,appended:!last,...(input.badMessageIndex!==undefined?{badMessageIndex:input.badMessageIndex}:{})}};
}

crossTest("Python normalizes complete conversations exactly like the Web importer across formats and boundaries", async () => {
	const fixtures:Input[]=[];
	for(const file of ["openai-messages","cline-messages","type-data-messages","openai-reasoning-messages"]){
		const value=await Bun.file(new URL(`../examples/history-import/${file}.json`,import.meta.url)).json();
		fixtures.push({name:file,conversation:value,options:{ignoreThinking:true}});
		fixtures.push({name:file+"-tool-tail",conversation:{...value,messages:value.messages.slice(0,-1)},options:{ignoreThinking:true,continuation:"再继续"}});
	}
	const user={role:"user",content:"question"}, assistant={role:"assistant",content:"context"};
	const call={role:"assistant",content:null,tool_calls:[{id:"call_1",type:"function",function:{name:"read_files",arguments:'{"paths":["demo.py"]}'}}]};
	const tool={role:"tool",tool_call_id:"call_1",content:""};
	const cline={system_prompt:"file instruction",messages:[{role:"system",content:"message instruction"},user,assistant]};
	fixtures.push(
		{name:"assistant-tail",conversation:[user,assistant]},
		{name:"developer",conversation:[{role:"developer",content:"instructions"},user]},
		{name:"system-conflict-file",conversation:cline,options:{systemSource:"file"}},
		{name:"system-conflict-messages",conversation:cline,options:{systemSource:"messages"}},
		{name:"misspelling",conversation:{messgaes:[user,assistant]}},
		{name:"reasoning-empty",conversation:[user,{...assistant,reasoning_content:null}]},
		{name:"current-user-name",conversation:[{...user,name:"human"}]},
		{name:"bad-response-and-future",conversation:{messages:[{role:"system",content:"instruction"},user,{role:"assistant",content:"WRONG"},{role:"user",content:"FUTURE"}]},badMessageIndex:2},
		{name:"bad-after-tool",conversation:[user,call,tool,{role:"assistant",content:"WRONG"}],badMessageIndex:3},
		{name:"bad-previous-assistant",conversation:[user,assistant,{role:"assistant",content:"WRONG"}],badMessageIndex:2},
		{name:"type-data-bad",conversation:{messgaes:[{type:"user",data:{content:"question"}},{type:"assistant",data:{content:"WRONG"}}]},badMessageIndex:1},
		{name:"cline-structured-blocks",conversation:{sessionId:"s",system_prompt:"system",messages:[
			{role:"user",id:"u",sessionId:"s",content:[{type:"text",text:"read file",signature:"not transmitted"}]},
			{role:"assistant",sessionId:"s",content:[{type:"thinking",thinking:"private"},{type:"tool_use",id:"internal",call_id:"public",name:"read_files",signature:"sig",input:{"10":10,"2":2,small:1e-7,zero:-0,large:1e21,path:"中文.py"}}]},
			{role:"user",content:[{type:"tool_result",name:"read_files",tool_use_id:"internal",content:{ok:false,n:1.25},is_error:true},{type:"text",text:"next"}]},
		]},options:{ignoreThinking:true}},
		{name:"cline-file",conversation:{messages:[{role:"user",content:[{type:"file",path:"never-read.txt",content:"inline"}]},{role:"assistant",content:[{type:"text",text:"ok"}]}]}},
		{name:"tool-text-file-result",conversation:{messages:[{role:"assistant",content:[{type:"tool_use",id:"a",name:"read_files",input:{}}]},{role:"user",content:[{type:"tool_result",name:"read_files",tool_use_id:"a",content:[{type:"text",text:"part"},{type:"file",path:"inline",content:"body"}]}]}]}},
	);
	const invalid:Input[]=[
		{name:"system-conflict",conversation:cline},
		{name:"missing-tool-result",conversation:[user,call]},
		{name:"duplicate-tool-result",conversation:[call,tool,tool]},
		{name:"duplicate-call-id",conversation:[call,tool,call,tool]},
		{name:"both-message-fields",conversation:{messages:[user],messgaes:[user]}},
		{name:"system-in-middle",conversation:[user,{role:"system",content:"late"},assistant]},
		{name:"unsupported-function",conversation:[{role:"function",content:"old protocol"}]},
		{name:"unknown-field",conversation:[{...user,extra:true}]},
		{name:"mismatched-wrapper",conversation:{messages:[{type:"user",data:{role:"assistant",content:"x"}}]}},
		{name:"thinking-not-approved",conversation:[user,{...assistant,reasoning_content:"private"}]},
		{name:"mixed-sessions",conversation:[{...user,sessionId:"one"},{...assistant,sessionId:"two"}]},
		{name:"bad-non-assistant",conversation:[user,assistant],badMessageIndex:0},
		{name:"bad-index-outside",conversation:[user,assistant],badMessageIndex:2},
		{name:"bad-first-no-input",conversation:[assistant],badMessageIndex:0},
		{name:"compressed-cline",conversation:{messages:[{role:"user",content:[{type:"tool_result",name:"read_files",tool_use_id:"missing",content:"result"}]}]}},
		{name:"unsupported-media",conversation:{messages:[{role:"user",content:[{type:"image",source:"data"}]}]}},
		{name:"bad-call-arguments",conversation:[{...call,tool_calls:[{id:"c",type:"function",function:{name:"read_files",arguments:"[]"}}]},{...tool,tool_call_id:"c"}]},
		{name:"duplicate-json",conversation:'{"messages":[{"role":"user","role":"assistant","content":"x"}]}'},
		{name:"overflow-integer-arguments",conversation:[{...call,tool_calls:[{id:"c",type:"function",function:{name:"read_files",arguments:'{"x":'+"9".repeat(400)+'}'}}]},{...tool,tool_call_id:"c"}]},
		{name:"empty",conversation:{messages:[]}},
		{name:"too-many",conversation:Array.from({length:501},()=>user)},
		{name:"too-large",conversation:[{role:"user",content:"汉".repeat(400000)}]},
	];
	const inputs=[...fixtures,...invalid];
	const proc=Bun.spawn([python!,"-c",`import sys,json\nfrom conversation_history import convert_conversation\nresults=[]\nfor v in json.load(sys.stdin):\n try:\n  results.append(convert_conversation(v['conversation'],v.get('options'),bad_message_index=v.get('badMessageIndex')))\n except (ValueError,TypeError,RecursionError,OverflowError):\n  results.append({'error':True})\nprint(json.dumps(results,ensure_ascii=False))`],{cwd:directory,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
	proc.stdin.write(JSON.stringify(inputs));proc.stdin.end();
	const [output,error,exit]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
	expect(error).toBe("");expect(exit).toBe(0);const actual=JSON.parse(output);
	for(const [index,input] of inputs.entries()){
		if(index<fixtures.length)expect(actual[index],input.name).toEqual(reference(input));
		else {expect(()=>reference(input),input.name).toThrow();expect(actual[index],input.name).toEqual({error:true});}
	}
},30000);
