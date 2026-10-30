import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm,readdir}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createHmac}from'node:crypto';
import{receiveRescueCompletion,processRescueCompletions,startRescueCompletions}from'../src/rescue-completion.mjs';
import{queueActionRescues,rescueCaseStore}from'../src/rescue.mjs';import{wakeCase,pendingRescueWakeups,startRescueWakeups}from'../src/rescue-wakeup.mjs';import{Store}from'../src/store.mjs';import{unitId}from'../src/dynamic.mjs';import{digest}from'../src/core.mjs';
const secret=Buffer.from('s'.repeat(64)),issue={id:'I_1',number:1,repository:'owner/app',repositoryId:'12',scopeHash:'scope',dependencies:[]};
const grant={recordId:'grant',manifest:{id:'cohort',issues:[issue],proposalRevision:'p',freezeRevision:'f'},policy:{grantId:'grant',revision:'r',maxParallel:2,actionExecution:{repository:'retired-private-source',repositoryId:'9',workflowPath:'.github/workflows/action-stage.yml',workflowBlob:'b'.repeat(40),actorIds:['7']}}};
async function fixture(t,conclusion='failure'){
 const root=await mkdtemp(join(tmpdir(),'nibfin-completion-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source={id:123,run_attempt:1,head_sha:'a'.repeat(40),head_branch:'main',repository:{id:9,full_name:'retired-private-source'},actor:{id:7},triggering_actor:{id:7},path:grant.policy.actionExecution.workflowPath,event:'workflow_dispatch',status:'completed',conclusion},posts=[],reads=[];
 const runtime={root,config:{stateDirectory:root,agent:{}},actionIdentity:{runId:'123',runAttempt:1},coreUpgrade:{rescue:{}},grant:async()=>grant,actionExecutionPolicy:()=>grant.policy.actionExecution,rescueCommand:async()=>({stdout:''}),github:{api:async(path,method='GET',body)=>{if(method==='POST'){posts.push({path,body});return{workflow_run_id:456};}reads.push(path);return path.includes('/contents/')?{sha:grant.policy.actionExecution.workflowBlob}:source;},list:async()=>[{status:'completed'}]}};
 const event=()=>({action:'completed',repository:{...source.repository,private:true},workflow_run:structuredClone(source)});
 const receive=async(e=event(),headers={})=>{const bytes=Buffer.from(JSON.stringify(e));return receiveRescueCompletion(runtime,grant,secret,bytes,{'x-github-event':'workflow_run','x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(bytes).digest('hex'),...headers});};
 return{root,runtime,source,posts,reads,event,receive};
}
test('normal successful completion creates no inbox, provider read or Actions Run',async t=>{
 const f=await fixture(t,'success');assert.equal((await f.receive()).reason,'NORMAL_COMPLETION');assert.deepEqual(await readdir(f.root),[]);assert.equal(f.reads.length,0);assert.equal(f.posts.length,0);
});
test('signature validation precedes JSON parsing and unrelated sources cannot trigger recovery',async t=>{
 const f=await fixture(t);await assert.rejects(f.receive(undefined,{'x-hub-signature-256':'sha256='+'0'.repeat(64)}),/signature/);
 for(const change of [{path:'.github/workflows/nibfin-rescue.yml'},{event:'push'},{head_branch:'feature'},{status:'in_progress'}]){const e=f.event();Object.assign(e.workflow_run,change);assert.equal((await f.receive(e)).status,'IGNORED');}
 const e=f.event();e.repository.private=false;assert.equal((await f.receive(e)).status,'IGNORED');assert.equal(f.posts.length,0);
});
test('a crash before Core case creation is durably dispatched once; duplicate deliveries and restart do not replay',async t=>{
 const f=await fixture(t),first=await f.receive();assert.equal(f.posts.length,0);assert.equal((await f.receive()).id,first.id);
 assert.equal((await processRescueCompletions(f.runtime,grant))[0].status,'confirmed');assert.equal(f.posts.length,1);assert.equal(f.posts[0].body.inputs.source_run_id,'123');
 await f.receive();await processRescueCompletions({...f.runtime},grant);assert.equal(f.posts.length,1);
});
test('attempt, SHA, actor and completed-job provenance are checked before a dispatch',async t=>{
 for(const change of [{run_attempt:2},{head_sha:'c'.repeat(40)},{actor:{id:99}}]){const f=await fixture(t);await f.receive();Object.assign(f.source,change);assert.equal((await processRescueCompletions(f.runtime,grant))[0].status,'unresolved');assert.equal(f.posts.length,0);}
});
test('manual cancellation stays local and never launches automatic repair',async t=>{
 const f=await fixture(t,'cancelled');await f.receive();assert.equal((await processRescueCompletions(f.runtime,grant))[0].status,'ignored');assert.equal(f.posts.length,0);
});
test('an uncertain dispatch is retained and never replayed on delivery or restart',async t=>{
 const f=await fixture(t),api=f.runtime.github.api;let posts=0;f.runtime.github.api=async(...args)=>{if(args[1]==='POST'){posts++;throw Error('Unknown write');}return api(...args);};await f.receive();assert.equal((await processRescueCompletions(f.runtime,grant))[0].status,'unresolved');await f.receive();await processRescueCompletions(f.runtime,grant);assert.equal(posts,1);
});
test('transient provider reads retry locally with bounded backoff and no Actions allocation',async t=>{
 const f=await fixture(t);await f.receive();f.runtime.github.api=async()=>{throw Object.assign(Error('Unavailable'),{requestMethod:'GET',status:503});};
 for(let n=0;n<8;n++){const result=await processRescueCompletions(f.runtime,grant,{now:()=>Date.now()+(n+1)*3600000});assert.equal(result[0].status,n===7?'unresolved':'pending');}assert.equal(f.posts.length,0);
});
test('green structured BLOCKED cases are notified by the host without a blanket completion Action',async t=>{
 const f=await fixture(t,'success'),[id]=await queueActionRescues(f.runtime,{results:[{status:'BLOCKED',issueId:issue.id,code:'AGENT_BLOCKED'}]},{inputs:{issue_id:issue.id}});
 await f.receive();assert.equal((await processRescueCompletions(f.runtime,grant))[0].status,'processed');assert.equal(f.posts.length,1);assert.equal(f.posts[0].body.inputs.request_id,id);
});
test('unchanged recovery observations do not allocate another Actions Run after a new deadline',async t=>{
 const f=await fixture(t,'success'),[id]=await queueActionRescues(f.runtime,{results:[{status:'BLOCKED',issueId:issue.id,code:'AGENT_BLOCKED'}]},{inputs:{issue_id:issue.id}}),store=rescueCaseStore(f.runtime,id);
 await wakeCase(f.runtime,grant,id);const c=await store.read();await store.transaction(c.revision,s=>({...s,outcome:'DEFERRED',repairCode:'RESCUE_CONTINUATION_ACTIVE',nextCheckAt:'2000-01-01T00:00:00Z'}));
 assert.equal((await wakeCase(f.runtime,grant,id)).outcome,'UNCHANGED');assert.equal(f.posts.length,1);
 const unit=new Store(f.root,unitId(grant,issue)),s=await unit.read();await unit.transaction(s.revision,v=>({...v,actionReceipts:[{operation:'close',completedAt:'2026-10-29'}]}));
 const deferred=await store.read();await store.transaction(deferred.revision,v=>({...v,nextCheckAt:'2000-01-01T00:00:00Z'}));
 await wakeCase(f.runtime,grant,id);assert.equal(f.posts.length,2);
});
test('unchanged local state still wakes when exact-head CI or merge readiness changes',async t=>{
 for(const mode of ['merge','checks']){
  const f=await fixture(t,'success'),g=structuredClone(grant),head='f'.repeat(40),candidate={head};let ready=false;
  g.policy.repositories={[issue.repository]:{ciMode:'github-repository',baseBranch:'main',trustedCheckAppIds:[1]}};
  f.runtime.grant=async()=>g;f.runtime.coreUpgrade.verified=true;f.runtime.coreUpgrade.rescueContinuations=['ci-change'];
  const checks=()=>[{id:1,status:ready?'success':'pending'}];
  f.runtime.github.pull=async()=>({head:{sha:head,repo:{full_name:issue.repository}},base:{ref:'main'},state:'open',merged:false,draft:false,mergeable:true,mergeable_state:ready?'clean':'blocked'});
  f.runtime.github.checks=async()=>checks();
  const unit=new Store(f.root,unitId(g,issue));await unit.transaction(0,v=>({...v,issues:{[issue.id]:{candidate,prNumber:1,review:{artifactIdentities:{head}},...(mode==='checks'?{blocked:{resumeOn:'ci-change',failureClass:'external_failure',outcome:'blocked',reviewHead:head,candidateHash:digest(candidate),checksHash:digest(checks())}}:{})}}}));
  const[id]=await queueActionRescues(f.runtime,{results:[{status:'BLOCKED',issueId:issue.id,code:'MERGE_REQUIREMENTS_PENDING'}]},{inputs:{issue_id:issue.id}});
  await wakeCase(f.runtime,g,id);const store=rescueCaseStore(f.runtime,id),c=await store.read();await store.transaction(c.revision,v=>({...v,outcome:'DEFERRED',repairCode:'RESCUE_MERGE_PENDING',nextCheckAt:'2000-01-01T00:00:00Z'}));
  assert.equal((await wakeCase(f.runtime,g,id)).outcome,'UNCHANGED');assert.equal(f.posts.length,1);
  ready=true;const deferred=await store.read();await store.transaction(deferred.revision,v=>({...v,nextCheckAt:'2000-01-01T00:00:00Z'}));assert.equal((await wakeCase(f.runtime,g,id)).outcome,'NOTIFIED');assert.equal(f.posts.length,2);
 }
});

test('early completion preserves a deferred wakeup across notifier restart until its deadline',async t=>{
 for(const repairCode of ['RESCUE_SOURCE_ACTIVE','RESCUE_AGENT_ACTIVE','RESCUE_COOLDOWN'])await t.test(repairCode,async t=>{
  const f=await fixture(t,'success'),[id]=await queueActionRescues(f.runtime,{results:[{status:'BLOCKED',issueId:issue.id,code:'AGENT_BLOCKED'}]},{inputs:{issue_id:issue.id}}),store=rescueCaseStore(f.runtime,id);
  const c=await store.read();await store.transaction(c.revision,v=>({...v,outcome:'DEFERRED',repairCode,nextCheckAt:new Date(Date.now()+300000).toISOString()}));
  await f.receive();await processRescueCompletions(f.runtime,grant);assert.equal(f.posts.length,0);
  assert.equal((await wakeCase(f.runtime,grant,id)).outcome,'WAITING');assert.equal((await pendingRescueWakeups(f.runtime,grant)).length,1);
  assert.equal((await new Store(f.root,'rescue-wakeup:'+id).read()).attempts,undefined);
  const timers=new Set(),service=await startRescueWakeups(f.runtime,async()=>grant,{watchDirectory:()=>({on(){},close(){}}),setTimer:(work,ms)=>{const timer={work,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer)});
  assert.equal(timers.size,1);assert([...timers][0].ms>0);service.close();
  const waiting=await store.read();await store.transaction(waiting.revision,v=>({...v,nextCheckAt:'2000-01-01T00:00:00Z'}));
  assert.equal((await wakeCase(f.runtime,grant,id)).outcome,'NOTIFIED');assert.equal(f.posts.length,1);
  await wakeCase(f.runtime,grant,id);assert.equal(f.posts.length,1);
 });
});

test('completion notifier is idle without an inbox and allocates no polling interval',async t=>{
 const f=await fixture(t);let loads=0;const service=await startRescueCompletions(f.runtime,async()=>{loads++;return grant;});t.after(()=>service.close());assert.equal(loads,1);assert.equal(f.reads.length,0);assert.equal(f.posts.length,0);service.close();
});
