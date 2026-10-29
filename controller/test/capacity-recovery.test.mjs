import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capacitySession,recoverCapacity,codexAttempt,availableFallback,withModel,explicitModel,capacityModels} from '../src/capacity-recovery.mjs';
import {verificationBudget} from '../src/verification-runner.mjs';
import {CodexAgent,selectAgentResult} from '../src/agent.mjs';
const id='01a173fe-6736-7853-9c48-ef50822e7337',other='01a173fe-6736-7853-9c48-ef50822e7338';
const event=x=>JSON.stringify(x)+'\n',start=event({type:'thread.started',thread_id:id});
const capacity={exitCode:1,stdout:start+event({type:'turn.failed',error:{message:'Selected model is at capacity. Please try a different model.'}}),stderr:''};
const success={exitCode:0,stdout:start+event({type:'turn.started'})+event({type:'item.completed',item:{type:'agent_message',text:'final'}})+event({type:'turn.completed'}),stderr:''};
const args=['exec','--json','--output-schema','/io/schema.json','-'];
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'capacity-'));t.after(()=>rm(directory,{recursive:true,force:true}));return{directory,budget:verificationBudget(3600000),pause:async()=>{},delays:[0,0,0]};}
test('only exact terminal capacity failure with one original session can recover',()=>{
 assert.equal(capacitySession(capacity),id);assert.equal(capacitySession(capacity,id),id);
 for(const r of [{...capacity,exitCode:0},{...capacity,stdout:capacity.stdout+'junk'}, {...capacity,stdout:capacity.stdout+event({type:'turn.completed'})},{...capacity,stdout:capacity.stdout.replace('at capacity','quota exhausted')},{...capacity,stdout:event({type:'thread.started',thread_id:other})+capacity.stdout},{...capacity,stdout:start+event({type:'error',message:'authentication failed'})+capacity.stdout}])assert.equal(capacitySession(r),null);
 assert.equal(capacitySession(capacity,other),null);
});
test('same container session retries keep fixed budget and expose only final unambiguous turn',async t=>{
 const f=await fixture(t),calls=[],delays=[];
 const result=await recoverCapacity(args,'original scope',{...f,pause:async ms=>{delays.push(ms);await writeFile(join(f.directory,'verification-still-running'),'retained');},run:async(a,p)=>{calls.push({a,p});if(calls.length===1)return capacity;assert.equal(await readFile(join(f.directory,'verification-still-running'),'utf8'),'retained');return success;}});
 assert.equal(result,success);assert.deepEqual(calls[1].a,[...args.slice(0,-1),'resume',id,'-']);assert.match(calls[1].p,/do not launch it again/);assert.match(calls[1].p,/Partial output is not a pass/);
 assert.equal(selectAgentResult('final',result.stdout,true).text,'final');
 const receipt=JSON.parse(await readFile(join(f.directory,'capacity-recovery.json')));assert.equal(receipt.deadlineAt,f.budget.deadlineAt);assert.equal(receipt.attempts.length,2);assert.equal(receipt.attempts[0].retry,true);assert(!JSON.stringify(receipt).includes('original scope'));
});
test('already resumed role retains original resume arguments and never changes model',async t=>{
 const f=await fixture(t),original=[...args.slice(0,-1),'--model','exact-approved-model','resume',id,'-'];let count=0;
 await recoverCapacity(original,'prompt',{...f,run:async a=>{assert.deepEqual(a,original);return ++count===1?capacity:success;}});assert.equal(count,2);
});
test('capacity exhaustion is bounded to three retries and remains failure',async t=>{
 const f=await fixture(t);let count=0;const result=await recoverCapacity(args,'prompt',{...f,run:async()=>{count++;return capacity;}});assert.equal(count,4);assert.equal(result.exitCode,1);assert.throws(()=>selectAgentResult('old success',result.stdout,true));
});
for(const [name,result]of Object.entries({quota:{...capacity,stdout:capacity.stdout.replace('Selected model is at capacity. Please try a different model.','Usage limit reached')},auth:{exitCode:1,stdout:'',stderr:'authentication failed'},timeout:{...capacity,exitCode:124},defect:{...capacity,exitCode:2},success}))test('no retry for '+name,async t=>{let count=0;const f=await fixture(t);assert.equal(await recoverCapacity(args,'x',{...f,run:async()=>{count++;return result;}}),result);assert.equal(count,1);});
test('budget reserve and cancellation prevent new attempts',async t=>{
 const f=await fixture(t);let count=0;await recoverCapacity(args,'x',{...f,now:()=>f.budget.stopVerificationAt-60000,run:async()=>{count++;return capacity;}});assert.equal(count,1);
 const controller=new AbortController();controller.abort();await assert.rejects(recoverCapacity(args,'x',{...f,signal:controller.signal,run:async()=>{throw Error('must not launch');}}),/cancelled/);
});
test('unexpected session identity fails without replacement launch',async t=>{
 const f=await fixture(t);let count=0;const original=[...args.slice(0,-1),'resume',other,'-'];await recoverCapacity(original,'x',{...f,run:async()=>{count++;return capacity;}});assert.equal(count,1);
 await assert.rejects(recoverCapacity(['exec','--ephemeral','-'],'x',f),/session-backed/);
});
test('only persistent roles receive the read-only recovery helper',()=>{
 const agent=new CodexAgent({image:'sha256:'+'a'.repeat(64),network:'restricted',user:'1000:1000',authDirectory:'/auth'},'/core','/state');
 const a=agent.executionArgs('/work','/io',true,{id,directory:'/session'});assert(a.some(x=>x.endsWith('dst=/capacity-recovery.mjs,readonly')));assert(a.some(x=>x.includes('exec node /capacity-recovery.mjs')));
 const independent=agent.executionArgs('/work','/io',false);assert(!independent.some(x=>x.includes('capacity-recovery.mjs')));assert(independent.includes('--ephemeral'));
});
test('capacity fallback changes only the approved model and preserves resume, schema and gates',async t=>{
 const f=await fixture(t),calls=[],waits=[],original=[...args.slice(0,-1),'--model','gpt-6.1-sol','--sandbox','read-only','resume',id,'-'];
 const r=await recoverCapacity(original,'same role',{...f,delays:[30000,60000,120000],pause:async ms=>waits.push(ms),selectFallback:async()=>({from:'gpt-6.1-sol',to:'gpt-6-sol'}),run:async a=>{calls.push(a);return calls.length<3?capacity:success;}});
 assert.equal(r.exitCode,0);assert.equal(explicitModel(calls[0]),'gpt-6.1-sol');assert.equal(explicitModel(calls[1]),'gpt-6-sol');assert.deepEqual(calls[1],calls[2]);assert(calls[1].includes(id));assert(calls[1].includes('/io/schema.json'));assert(calls[1].includes('read-only'));assert.deepEqual(waits,[5000,60000]);
 const receipt=JSON.parse(await readFile(join(f.directory,'capacity-recovery.json')));assert.equal(receipt.attempts[0].nextModel,'gpt-6-sol');assert.equal(receipt.attempts[1].model,'gpt-6-sol');assert.equal(receipt.deadlineAt,f.budget.deadlineAt);
 for(const form of [['exec','-m','gpt-6.1-sol','--json','-'],['exec','--model=gpt-6.1-sol','--json','-']])assert.equal(explicitModel(withModel(form,'gpt-6-sol')),'gpt-6-sol');
 assert.throws(()=>withModel(args,'unapproved'),/Unapproved/);assert.throws(()=>withModel(['exec','-m','a','--model','b','-'],'gpt-6-sol'),/Ambiguous/);
});
test('fallback needs an actual matching current turn and visible account catalog entry',async t=>{
 const f=await fixture(t),home=f.directory;await mkdir(join(home,'sessions'));const path=join(home,'sessions','rollout-'+id+'.jsonl');
 const turn=model=>writeFile(path,event({type:'turn_context',payload:{model}}));const catalog=models=>writeFile(join(home,'models_cache.json'),JSON.stringify({models}));
 await turn('gpt-6.1-sol');await catalog([{slug:'gpt-6-sol',visibility:'list'}]);assert.deepEqual(await availableFallback(args,id,{home}),{from:'gpt-6.1-sol',to:'gpt-6-sol'});
 assert.equal(await availableFallback([...args.slice(0,-1),'--model','different','-'],id,{home}),null);
 await turn('gpt-6-astra');assert.equal(await availableFallback(args,id,{home}),null);
 await turn('gpt-6.1-sol');await catalog([{slug:'gpt-6-sol',visibility:'hide'}]);assert.equal(await availableFallback(args,id,{home}),null);
 await catalog([{slug:'arbitrary-model',visibility:'list'}]);assert.equal(await availableFallback(args,id,{home}),null);
 assert.equal(await availableFallback(args,other,{home}),null);
 await writeFile(path,'malformed');assert.equal(await availableFallback(args,id,{home}),null);
});
test('quota and identity failures never select a fallback; arbitrary selectors fail closed',async t=>{
 const f=await fixture(t);let selected=0;await recoverCapacity(args,'x',{...f,selectFallback:async()=>{selected++;return null;},run:async()=>({...capacity,stdout:capacity.stdout.replace('at capacity','over quota')})});assert.equal(selected,0);
 await assert.rejects(recoverCapacity(args,'x',{...f,selectFallback:async()=>({from:capacityModels.primary,to:'unapproved'}),run:async()=>capacity}),/Unapproved/);
});
test('real child exit preserves detached guarded verification and resumes without relaunch', {skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),bin=join(f.directory,'bin');await mkdir(bin);
 const helper=new URL('../src/verification-runner.mjs',import.meta.url).href;
 const guard=`import{runVerification,verificationBudget}from ${JSON.stringify(helper)};await runVerification(process.execPath,['-e',"setTimeout(()=>process.stdout.write('retained verification'),500)"],{directory:${JSON.stringify(join(f.directory,'verification'))},budget:verificationBudget(10000)});`;
 const program=`#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process');
const root=process.env.CAPACITY_TEST_ROOT,id=${JSON.stringify(id)};
const emit=x=>console.log(JSON.stringify(x));
(async()=>{let calls=0;try{calls=Number(fs.readFileSync(root+'/calls'));}catch{}fs.writeFileSync(root+'/calls',String(++calls));
emit({type:'thread.started',thread_id:id});
if(calls===1){
 const code=${JSON.stringify(guard)};
 const child=spawn(process.execPath,['--input-type=module','-e',code],{detached:true,stdio:'ignore'});child.unref();
 for(let i=0;i<200&&!fs.existsSync(root+'/verification/active.lock');i++)await new Promise(r=>setTimeout(r,10));
 if(!fs.existsSync(root+'/verification/active.lock'))throw Error('guard did not launch');
 emit({type:'turn.failed',error:{message:${JSON.stringify('Selected model is at capacity. Please try a different model.')}}});process.exitCode=1;
}else{
 if(!process.argv.includes('resume')||!process.argv.includes(id))throw Error('not original session');
 const lock=JSON.parse(fs.readFileSync(root+'/verification/active.lock'));process.kill(lock.pid,0);
 for(let i=0;i<200&&fs.existsSync(root+'/verification/active.lock');i++)await new Promise(r=>setTimeout(r,10));
 const receipts=fs.readdirSync(root+'/verification').filter(n=>n.endsWith('.json'));if(receipts.length!==1)throw Error('duplicate verification');
 const r=JSON.parse(fs.readFileSync(root+'/verification/'+receipts[0]));if(r.status!=='passed')throw Error('not passed');
 emit({type:'turn.started'});emit({type:'item.completed',item:{type:'agent_message',text:'final'}});emit({type:'turn.completed'});
}
})().catch(e=>{console.error(e.message);process.exitCode=2;});`;
 await writeFile(join(bin,'codex'),program,{mode:0o755});
 const oldPath=process.env.PATH,oldRoot=process.env.CAPACITY_TEST_ROOT;process.env.PATH=bin+':'+oldPath;process.env.CAPACITY_TEST_ROOT=f.directory;
 try{const r=await recoverCapacity(args,'original',{...f,run:codexAttempt});assert.equal(r.exitCode,0,r.stderr);assert.equal(selectAgentResult('final',r.stdout,true).text,'final');assert.equal(await readFile(join(f.directory,'calls'),'utf8'),'2');}
 finally{process.env.PATH=oldPath;if(oldRoot===undefined)delete process.env.CAPACITY_TEST_ROOT;else process.env.CAPACITY_TEST_ROOT=oldRoot;}
});
