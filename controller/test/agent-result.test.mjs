import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAgent,selectAgentResult,resultSchema} from '../src/agent.mjs';
import {validateSchema} from '../src/schema.mjs';
const id='11111111-1111-4111-8111-111111111111';
const valid={outcome:'ready',body:'',summary:'Validated fixture',rootCause:'',failureClass:'none',evidenceReferences:['fixture://evidence'],blockingFindings:[],contractConflicts:[]};
const stream=(text=JSON.stringify(valid))=>[{type:'thread.started',thread_id:id},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'Earlier progress'}},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed'}];
const encode=events=>events.map(e=>JSON.stringify(e)).join('\n')+'\n';
test('completed stream final message supersedes a stale progress file and remains schema-checked',()=>{
 const r=selectAgentResult('Earlier progress',encode(stream()),true);
 assert.equal(r.source,'completed-json-stream');assert.equal(r.fileMatched,false);
 assert.deepEqual(JSON.parse(r.text),valid);validateSchema(JSON.parse(r.text),resultSchema);
 assert.equal(selectAgentResult(JSON.stringify(valid),encode(stream()),true).fileMatched,true);
});
for(const[name,change]of Object.entries({truncated:e=>e.pop(),failed:e=>e[e.length-1]={type:'turn.failed'},duplicate:e=>e.push({type:'turn.completed'}),newTurn:e=>e.push({type:'turn.started'}),toolLast:e=>e.splice(-1,0,{type:'item.completed',item:{type:'command_execution'}})}))test('rejects incomplete or ambiguous stream '+name,()=>{const e=stream();change(e);assert.throws(()=>selectAgentResult(JSON.stringify(valid),encode(e),true));});
test('never falls back to an earlier valid file when the terminal message is invalid',()=>{
 assert.throws(()=>JSON.parse(selectAgentResult(JSON.stringify(valid),encode(stream('progress only')),true).text));
 assert.throws(()=>validateSchema(JSON.parse(selectAgentResult(JSON.stringify(valid),encode(stream('{"outcome":"ready"}')),true).text),resultSchema));
 assert.throws(()=>selectAgentResult(JSON.stringify(valid),'not JSON',true));
 assert.equal(selectAgentResult(JSON.stringify(valid),'',false).source,'last-message-file');
});
async function fixture(t,finalText){
 const root=await mkdtemp(join(tmpdir(),'nibfin-final-result-'));t.after(()=>rm(root,{recursive:true}));
 await mkdir(join(root,'skills','deliver'),{recursive:true});await writeFile(join(root,'skills','deliver','SKILL.md'),'---\nname: deliver\n---\nProduce verified evidence.\n');
 const agent=new CodexAgent({},root,root,async()=>{const execution=(await readdir(join(root,'executions')))[0];await writeFile(join(root,'executions',execution,'result.json'),'Earlier progress');return{stdout:encode(stream(finalText)),stderr:''};});
 agent.login=async()=>{};agent.credentialValues=async()=>['synthetic-credential-for-test'];agent.executionArgs=()=>['run'];
 return{root,agent};
}
test('controller preserves raw output and separately persists the schema-valid terminal result',async t=>{
 const f=await fixture(t,JSON.stringify(valid)),r=await f.agent.executeTurn('deliver',{issue:{id:'I_A'}},f.root,null,{directory:f.root,id:null,role:'deliver'});
 assert.equal(r.session.id,id);assert.deepEqual(r.result,valid);assert.match(r.evidencePath,/validated-result.json$/);
 assert.equal(await readFile(join(f.root,'executions',r.executionId,'result.json'),'utf8'),'Earlier progress');
 assert.deepEqual(JSON.parse(await readFile(r.evidencePath,'utf8')),valid);
});
test('credential-bearing terminal JSON is rejected before validated evidence is written',async t=>{
 const f=await fixture(t,JSON.stringify({...valid,summary:'synthetic-credential-for-test'}));
 await assert.rejects(f.agent.executeTurn('deliver',{},f.root,null,{directory:f.root,id:null,role:'deliver'}),/credential material/);
 const execution=(await readdir(join(f.root,'executions')))[0];
 await assert.rejects(readFile(join(f.root,'executions',execution,'validated-result.json')),{code:'ENOENT'});
});

test('independent reviews get separate execution-local recovery sessions and validated final streams',async t=>{
 const f=await fixture(t,JSON.stringify(valid));await mkdir(join(f.root,'skills','accept'));await writeFile(join(f.root,'skills','accept','SKILL.md'),'---\nname: accept\n---\nReview independently.\n');
 const captured=[];let io;
 f.agent.executionArgs=(work,directory,writable,session)=>{io=directory;captured.push({session,writable});return['run'];};
 f.agent.run=async()=>{await writeFile(join(io,'result.json'),'stale progress');return{stdout:encode(stream()),stderr:''};};
 const first=await f.agent.executeTurn('accept',{},f.root,null,null),second=await f.agent.executeTurn('accept',{},f.root,null,null);
 assert.notEqual(captured[0].session.directory,captured[1].session.directory);
 for(let n=0;n<2;n++){const r=[first,second][n];assert.equal(captured[n].session.id,null);assert.equal(captured[n].session.directory,join(f.root,'executions',r.executionId,'isolated-role-session'));assert.equal(captured[n].writable,false);assert.equal(r.session,undefined);assert.match(r.evidencePath,/validated-result.json$/);assert.deepEqual(r.result,valid);}
 f.agent.run=async()=>{await writeFile(join(io,'result.json'),JSON.stringify(valid));return{stdout:encode(stream().slice(0,-1)),stderr:''};};
 await assert.rejects(f.agent.executeTurn('accept',{},f.root,null,null),/unambiguous completed/);
});
