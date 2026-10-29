import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {binding,digest} from '../src/core.mjs';
import {Store} from '../src/store.mjs';
import {unitId,issueLeaseId,projectUnit} from '../src/dynamic.mjs';
import {inspectInterruptedWriter} from '../src/rescue-writer.mjs';
import {signGrant,verifyCoreUpgrade,coreDigest} from '../src/authority.mjs';
import {fixture as authorityFixture} from './fixtures.mjs';
import {Runtime} from '../src/runtime.mjs';
import {validateRescuePolicy,rescueLog,verifyRescueInvocation,verifyRescueSource,rescueWorkflow,providerTimeoutEvidence} from '../src/rescue-policy.mjs';
import {lockEvidence,recoverRescueLocks,ghFailureEvidence,probeGithubRead} from '../src/rescue-remedies.mjs';
import {queueActionRescues,dispatchRescue,runRescue} from '../src/rescue.mjs';
import {wakeRescueCases,startRescueWakeups,loadRescueWakeupGrant} from '../src/rescue-wakeup.mjs';
import {verificationBudget} from '../src/verification-runner.mjs';
import {verificationContinuation,ciContinuation} from '../src/rescue-continuation.mjs';
import {validateAiRepairPlan} from '../src/rescue-ai.mjs';

const policy={schemaVersion:1,workflowBlob:'a'.repeat(40),maxRepairsPerIssue:3,cooldownSeconds:60};
const issue={id:'I_190',repository:'taco3064/nibfin',repositoryId:'12',number:190,scopeHash:'scope',dependencies:[]};
const grant={recordId:'authority',manifest:{id:'cohort',issues:[issue],proposalRevision:'p',freezeRevision:'f'},policy:{grantId:'grant',revision:'r',maxParallel:2,actionExecution:{repository:'taco3064/kairo',repositoryId:'9',workflowPath:'.github/workflows/action-stage.yml',workflowBlob:'b'.repeat(40),actorIds:['7'],runnerIds:['2','22']}}};
function source(id='100'){return{id:Number(id),run_attempt:1,repository:{full_name:'taco3064/kairo',id:9},path:grant.policy.actionExecution.workflowPath,event:'workflow_dispatch',head_branch:'main',head_sha:'c'.repeat(40),actor:{id:7},triggering_actor:{id:7},status:'completed',conclusion:'failure',created_at:'2026-10-27T01:00:00Z',updated_at:'2026-10-27T02:00:00Z',jobs:[{status:'completed'}]};}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'kairo-rescue-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const writes=[],runs=new Map([['100',source()],['200',{...source('200'),status:'queued',conclusion:null}]]);
 const runtime={root,config:{stateDirectory:root,actionExecution:grant.policy.actionExecution,agent:{user:'1000:1000',image:'sha256:'+'d'.repeat(64)}},coreUpgrade:{rescue:policy,agentGithubRead:true},actionIdentity:{runId:'100',runAttempt:1},rescueIdentity:{runId:'300'},grant:async()=>grant,actionExecutionPolicy:()=>grant.policy.actionExecution,
  rescueCommand:async()=>({stdout:''}),github:{api:async(path,method='GET',body)=>{
   if(method==='POST'){writes.push({path,body});return{workflow_run_id:200};}
   if(path==='/user')return{id:7};
   if(path.includes('/contents/'))return{sha:grant.policy.actionExecution.workflowBlob};
   if(path.includes('/actions/runs/')){const id=path.split('/').at(-1);if(!runs.has(id))throw Error('Unexpected Run '+id);return runs.get(id);}
   throw Error('Unexpected API '+path);
  },list:async()=>[{status:'completed'}]}};
 const unit=new Store(root,unitId(grant,issue));await unit.transaction(0,s=>({...s,issues:{[issue.id]:{candidate:{head:'preserve'}}}}));
 async function queue(code='GITHUB_READ_UNAVAILABLE'){return(await queueActionRescues(runtime,{results:[{status:'BLOCKED',issueId:issue.id,code,reason:'GitHub unavailable'}]},{inputs:{issue_id:issue.id}}))[0];}
 async function state(id){return new Store(root,'rescue-case:'+id).read();}
 return{root,runtime,writes,runs,unit,queue,state,event:id=>({inputs:{request_id:id,source_run_id:'100',mode:'repair'}})};
}

test('bounded Rescue authority is signed and unknown permissions cannot be smuggled in',()=>{
 const keys=generateKeyPairSync('ed25519'),pub=keys.publicKey.export({type:'spki',format:'pem'}),priv=keys.privateKey.export({type:'pkcs8',format:'pem'});
 const g={...grant,policy:{...grant.policy,controlMode:'owner-project',runtimeHash:'runtime',coreDigest:'1'.repeat(64)}};
 const payload={schemaVersion:1,kind:'owner-core-upgrade',grantRecordId:g.recordId,manifestHash:digest(g.manifest),policyHash:digest(g.policy),runtimeHash:'runtime',fromCoreDigest:g.policy.coreDigest,toCoreDigest:'2'.repeat(64),sourceCommit:'3'.repeat(40),reason:'bounded known repairs',rescue:policy};
 assert.deepEqual(verifyCoreUpgrade(signGrant(payload,priv),g,payload.toCoreDigest,pub).rescue,policy);
 const forged=signGrant(structuredClone(payload),priv);forged.payload.rescue.maxRepairsPerIssue=1;assert.throws(()=>verifyCoreUpgrade(forged,g,payload.toCoreDigest,pub));
 for(const change of [{maxRepairsPerIssue:4},{cooldownSeconds:0},{workflowBlob:'main'},{arbitraryShell:true}])assert.throws(()=>validateRescuePolicy({...policy,...change}));
 const next={...payload,rescueContinuations:['verification-budget','ci-change']};
 assert.deepEqual(verifyCoreUpgrade(signGrant(next,priv),g,next.toCoreDigest,pub).rescue,policy);
 for(const value of [[],['shell'],['ci-change','ci-change'],true])assert.throws(()=>verifyCoreUpgrade(signGrant({...next,rescueContinuations:value},priv),g,next.toCoreDigest,pub));
 assert.throws(()=>validateRescuePolicy({...policy,continuationKinds:['verification-budget']}),'Original nested policy must stay byte-compatible with live old validators');
 const assistance={schemaVersion:1,aiRepair:true,verificationIo:true};
 assert.deepEqual(verifyCoreUpgrade(signGrant({...next,rescueAssistance:assistance},priv),g,next.toCoreDigest,pub).rescueAssistance,assistance);
 const actionsGrant={...g,policy:{...g.policy,executionMode:'actions-v1'}},display={...next,policyHash:digest(actionsGrant.policy),actionWorkflowBlob:'f'.repeat(40)};
 assert.equal(verifyCoreUpgrade(signGrant(display,priv),actionsGrant,display.toCoreDigest,pub).actionWorkflowBlob,display.actionWorkflowBlob);
 assert.throws(()=>verifyCoreUpgrade(signGrant({...display,actionWorkflowBlob:'main'},priv),actionsGrant,display.toCoreDigest,pub),/display-workflow/);
 for(const value of [{schemaVersion:2,aiRepair:true},{schemaVersion:1},{schemaVersion:1,aiRepair:false},{...assistance,hostShell:true}])assert.throws(()=>verifyCoreUpgrade(signGrant({...next,rescueAssistance:value},priv),g,next.toCoreDigest,pub));
 assert.throws(()=>verifyCoreUpgrade(signGrant({...next,rescue:undefined,rescueAssistance:assistance},priv),g,next.toCoreDigest,pub));
});
test('Rescue identities require exact current workflow bytes, approved actor, job and runner',async t=>{
 const f=await fixture(t),r=f.runtime,run={...source('300'),path:rescueWorkflow,status:'in_progress'};
 r.environment={GITHUB_REPOSITORY:'taco3064/kairo',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ID:'300',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'rescue',GITHUB_SHA:run.head_sha,RUNNER_NAME:'runner'};
 r.github.api=async path=>path.includes('/contents/')?{sha:policy.workflowBlob}:run;
 r.github.repository=async()=>({private:true});r.github.list=async()=>[{id:99,name:'rescue',status:'in_progress',runner_name:'runner',runner_id:2}];
 assert.equal((await verifyRescueInvocation(r,grant,f.event('a'.repeat(64)))).runnerId,'2');
 for(const change of [{path:grant.policy.actionExecution.workflowPath},{actor:{id:88}},{head_sha:'bad'},{repository:{full_name:'evil/core',id:9}},{run_attempt:2}]){
  const old=structuredClone(run);Object.assign(run,change);await assert.rejects(verifyRescueInvocation(r,grant,f.event('a'.repeat(64))),/identity/);Object.assign(run,old);
 }
 run.actor={id:41898282};run.triggering_actor={id:41898282};await assert.rejects(verifyRescueInvocation(r,grant,f.event('a'.repeat(64))),/fallback/);
 assert.equal((await verifyRescueInvocation(r,grant,{inputs:{source_run_id:'100'}})).runId,'300');
 r.github.repository=async()=>({private:false});await assert.rejects(verifyRescueInvocation(r,grant,{inputs:{source_run_id:'100'}}),/exact signed private/);
});
test('queued Rescue may use one explicitly approved historical pin while main stays exact',async t=>{
 const f=await fixture(t),r=f.runtime,run={...source('300'),path:rescueWorkflow,status:'in_progress'},previous='f'.repeat(40);
 r.environment={GITHUB_REPOSITORY:'taco3064/kairo',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ID:'300',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'rescue',GITHUB_SHA:run.head_sha,RUNNER_NAME:'runner'};
 r.github.repository=async()=>({private:true});r.github.list=async()=>[{id:99,name:'rescue',status:'in_progress',runner_name:'runner',runner_id:2}];
 r.github.api=async path=>path.includes('/contents/')?{sha:path.endsWith('ref=main')?policy.workflowBlob:previous}:run;
 await assert.rejects(verifyRescueInvocation(r,grant,f.event('a'.repeat(64))),{code:'RESCUE_PIN_CHANGED'});
 r.coreUpgrade.rescuePreviousWorkflowBlob=previous;assert.equal((await verifyRescueInvocation(r,grant,f.event('a'.repeat(64)))).workflowBlob,previous);
 r.github.api=async path=>path.includes('/contents/')?{sha:previous}:run;
 await assert.rejects(verifyRescueInvocation(r,grant,f.event('a'.repeat(64))),{code:'RESCUE_PIN_CHANGED'});
});

test('a live source, foreign workflow or changed workflow pin cannot be repaired',async t=>{
 const f=await fixture(t),r=f.runtime;
 f.runs.get('100').status='in_progress';await assert.rejects(verifyRescueSource(r,grant,'100'),{code:'RESCUE_SOURCE_ACTIVE'});
 f.runs.get('100').status='completed';f.runs.get('100').path=rescueWorkflow;await assert.rejects(verifyRescueSource(r,grant,'100'),{code:'RESCUE_SOURCE_INVALID'});
 f.runs.set('100',source());r.github.api=async path=>path.includes('/contents/')?{sha:'f'.repeat(40)}:source();await assert.rejects(verifyRescueSource(r,grant,'100'),/bytes/);
});
test('dedup persists dispatch intent before uncertain writes and never reposts',async t=>{
 const f=await fixture(t);let attempts=0;const api=f.runtime.github.api;
 f.runtime.github.api=async(path,method,...rest)=>{if(method==='POST'){attempts++;throw Error('connection lost after write');}return api(path,method,...rest);};
 const id=await f.queue();await assert.rejects(dispatchRescue(f.runtime,grant,id),/connection lost/);assert.equal((await f.state(id)).rescueDispatch.status,'unknown');assert.equal(attempts,1);
 await dispatchRescue(f.runtime,grant,id);await f.queue();assert.equal(attempts,1);assert.equal((await f.state(id)).outcome,'UNRESOLVED');
});
test('a transient read resumes through Core; queued or receiptless runs are never called resolved',async t=>{
 const f=await fixture(t),id=await f.queue(),before=(await f.unit.read()).issues;
 let result=await runRescue(f.runtime,f.event(id));assert.equal(result.outcome,'PENDING_VERIFICATION');assert.equal(result.resumeRunId,'200');
 assert.deepEqual(f.writes.at(-1).body,{ref:'main',inputs:{issue_id:issue.id,issue_ref:'nibfin#190'},return_run_details:true});assert.deepEqual((await f.unit.read()).issues,before);
 result=await runRescue(f.runtime,f.event(id),{verifyOnly:true});assert.equal(result.outcome,'DEFERRED');
 f.runs.set('200',{...source('200'),conclusion:'success'});result=await runRescue(f.runtime,f.event(id),{verifyOnly:true});assert.equal(result.outcome,'UNRESOLVED');
 const receipt={operation:'close',action:{runId:'200',runAttempt:1},completedAt:new Date().toISOString()};
 let s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,actionReceipts:[receipt]}));
 result=await runRescue(f.runtime,f.event(id),{verifyOnly:true});assert.equal(result.outcome,'STAGE_RECOVERED');
 s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,completion:{status:'COMPLETE',receiptHash:digest(receipt)}}));
 result=await runRescue(f.runtime,f.event(id),{verifyOnly:true});assert.equal(result.outcome,'RESOLVED');
 s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,pending:{operation:'deliver'}}));result=await runRescue(f.runtime,f.event(id),{verifyOnly:true});assert.equal(result.outcome,'STAGE_RECOVERED');
 s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,pending:null,issues:{[issue.id]:{...v.issues[issue.id],blocked:{summary:'Still blocked'}}}}));
 result=await runRescue(f.runtime,f.event(id),{verifyOnly:true});assert.equal(result.outcome,'UNRESOLVED');assert.equal(result.verification,'Still blocked');
});

function timeoutSource(){return{...source(),conclusion:'cancelled',updated_at:'2026-10-27T04:00:39Z',jobs:[{id:77,name:'execute',status:'completed',conclusion:'cancelled',started_at:'2026-10-27T01:00:00Z',completed_at:'2026-10-27T04:00:39Z',check_run_url:'https://api.github.com/repos/taco3064/kairo/check-runs/77'}]};}
const timeoutAnnotation={annotation_level:'failure',message:'The job has exceeded the maximum execution time of 3h0m0s'};
test('a continuation timeout creates its own case under the original Issue repair budget',async t=>{
 const f=await fixture(t),parent=await f.queue();await runRescue(f.runtime,f.event(parent));
 const source200={...timeoutSource(),id:200};f.runs.set('200',source200);f.runs.set('201',{...source('201'),status:'queued',conclusion:null});
 f.runtime.coreUpgrade.executionLimits={jobTimeoutMinutes:180};f.runtime.github.list=async path=>path.endsWith('/annotations')?[timeoutAnnotation]:source200.jobs;
 const original=f.runtime.github.api;f.runtime.github.api=async(...args)=>{const r=await original(...args);return args[1]==='POST'?{workflow_run_id:201}:r;};
 let s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,pending:{operation:'accept',executionContext:{action:{runId:'200'}},artifacts:{candidateHash:'unchanged'}}}));
 await writeFile(join(f.unit.directory,'execution.lock'),JSON.stringify({pid:2147483647,startedAt:'2026-10-27T01:10:00Z'}));
 const budget=new Store(f.root,'rescue-budget:'+unitId(grant,issue)),b=await budget.read();await budget.transaction(b.revision,v=>({...v,lastAttemptAt:'2020-01-01T00:00:00Z'}));
 const report=await runRescue(f.runtime,{inputs:{source_run_id:'200',mode:'repair'}});assert.notEqual(report.caseId,parent);assert.equal(report.outcome,'PENDING_VERIFICATION');assert.equal((await f.state(report.caseId)).parentCaseId,parent);
 assert.equal((await budget.read()).attempts,2);assert.equal(f.writes.length,2);assert.equal((await f.unit.read()).pending,null);
 await runRescue(f.runtime,{inputs:{source_run_id:'200',mode:'repair'}});assert.equal(f.writes.length,2);
});

async function interruptedWriter(t){
 const f=await fixture(t),g=structuredClone(grant);
 Object.assign(g.manifest,{schemaVersion:2,scheduling:'native-dependencies',membership:'fixed-approved-set',proposalHash:digest('fixture proposal')});g.policy.stateDirectory=f.root;g.policy.repositories={[issue.repository]:{repositoryId:issue.repositoryId}};g.approval={verified:true};f.runtime.grant=async()=>g;
 const projected=projectUnit(g,issue),authority=binding(projected.manifest,projected.policy),key=digest({repository:issue.repository,issue:issue.id,scope:issue.scopeHash,binding:authority,role:'deliver'}),sessionId=randomUUID();
 const sessionStore=new Store(f.root,'role-session:'+key);await sessionStore.transaction(0,s=>({...s,sessionStatus:'running',stage:'deliver',sessionId}));
 const directory=join(f.root,'role-sessions',key);await mkdir(directory,{recursive:true});const conversation=join(directory,sessionId+'.jsonl');await writeFile(conversation,JSON.stringify({type:'session_meta',payload:{id:sessionId,cwd:'/work'}})+'\n');
 const s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,issues:{[issue.id]:{repairs:0,shape:{body:'```kairo-candidate\n{"artifacts":[],"hooks":[]}\n```\n'}}},pending:{...authority,operation:'deliver',executionContext:{action:{runId:'100'}},artifacts:{base:'e'.repeat(40)}}}));
 f.runtime.workspace=(_grant,_issue,stored)=>({root:join(f.root,'attempt-'+(stored.repairs??0)),preparedBase:async()=>'e'.repeat(40),snapshotRepair:async()=>({candidate:{base:'e'.repeat(40),tree:'f'.repeat(40),paths:['source.mjs']}})});
 const src=timeoutSource();f.runs.set('100',src);f.runtime.coreUpgrade.executionLimits={jobTimeoutMinutes:180};f.runtime.github.list=async path=>path.endsWith('/annotations')?[timeoutAnnotation]:src.jobs;
 return{...f,g,src,sessionStore,sessionId,conversation};
}
test('a stopped interrupted Writer preserves its original conversation and unaccepted source for fresh delivery',async t=>{
 const f=await interruptedWriter(t),record=JSON.stringify({pid:2147483647,startedAt:'2026-10-27T01:10:00Z'});
 await writeFile(join(f.unit.directory,'execution.lock'),record);await mkdir(f.sessionStore.directory,{recursive:true});await writeFile(join(f.sessionStore.directory,'execution.lock'),record);
 const before=await f.unit.read(),id=await f.queue('RUN_FAILED'),r=await runRescue(f.runtime,f.event(id)),s=await f.unit.read();
 assert.equal(r.outcome,'PENDING_VERIFICATION');assert.equal(s.pending,null);assert.equal(s.issues[issue.id].repairs,1);assert.equal(s.issues[issue.id].repairSeed.sourceAttempt,0);
 assert.deepEqual(s.issues[issue.id].shape,before.issues[issue.id].shape);assert.equal(s.issues[issue.id].candidate,undefined);assert.equal(s.issues[issue.id].accept,undefined);
 assert.equal((await f.sessionStore.read()).sessionId,f.sessionId);assert.equal((await f.sessionStore.read()).sessionStatus,'ready');assert.equal(f.writes.length,1);
});
test('an active Writer with a partially written conversation defers without removing locks or spending budget',async t=>{
 const f=await interruptedWriter(t),record=JSON.stringify({pid:process.pid,startedAt:'2026-10-27T01:10:00Z'});
 await writeFile(join(f.unit.directory,'execution.lock'),record);await writeFile(f.conversation,'{"incomplete":');
 f.runtime.rescueCommand=async(_name,args)=>({stdout:args.includes('ps')?'live\n':JSON.stringify([{Id:'live',State:{Running:true},Mounts:[{Destination:'/work',Source:join(f.root,'workspaces',digest(unitId(f.g,issue)))}]}])});
 const before=await f.unit.read(),id=await f.queue('RUN_FAILED'),r=await runRescue(f.runtime,f.event(id));
 assert.equal(r.outcome,'DEFERRED');assert.deepEqual(await f.unit.read(),before);assert.equal(await readFile(join(f.unit.directory,'execution.lock'),'utf8'),record);assert.equal(f.writes.length,0);
 assert.equal((await new Store(f.root,'rescue-budget:'+unitId(f.g,issue)).read()).attempts,undefined);
});
test('durable continuation verification queues a distinct timeout repair once when its completion hint is lost',async t=>{
 const f=await fixture(t),parent=await f.queue();await runRescue(f.runtime,f.event(parent));
 const src={...timeoutSource(),id:200};f.runs.set('200',src);f.runtime.coreUpgrade.executionLimits={jobTimeoutMinutes:180};f.runtime.github.list=async path=>path.endsWith('/annotations')?[timeoutAnnotation]:src.jobs;
 const s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,pending:{operation:'accept',executionContext:{action:{runId:'200'}}}}));
 const before=await f.unit.read(),r=await runRescue(f.runtime,f.event(parent),{verifyOnly:true});assert.equal(r.outcome,'UNRESOLVED');assert(r.nextCaseId);assert.notEqual(r.nextCaseId,parent);
 assert.equal(f.writes.length,2);assert(f.writes[1].path.endsWith('kairo-rescue.yml/dispatches'));assert.deepEqual(await f.unit.read(),before);
 await runRescue(f.runtime,f.event(parent),{verifyOnly:true});assert.equal(f.writes.length,2);
});
test('linked continuation incidents cannot reset the Issue repair limit or remove locks after exhaustion',async t=>{
 const f=await fixture(t),parent=await f.queue();await runRescue(f.runtime,f.event(parent));
 const src={...timeoutSource(),id:200};f.runs.set('200',src);f.runtime.coreUpgrade.executionLimits={jobTimeoutMinutes:180};f.runtime.github.list=async path=>path.endsWith('/annotations')?[timeoutAnnotation]:src.jobs;
 let s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,pending:{operation:'accept',executionContext:{action:{runId:'200'}}}}));
 const record=JSON.stringify({pid:2147483647,startedAt:'2026-10-27T01:10:00Z'}),path=join(f.unit.directory,'execution.lock');await writeFile(path,record);
 const budget=new Store(f.root,'rescue-budget:'+unitId(grant,issue)),b=await budget.read();await budget.transaction(b.revision,v=>({...v,attempts:3,lastAttemptAt:'2020-01-01T00:00:00Z'}));
 const before=await f.unit.read(),r=await runRescue(f.runtime,{inputs:{source_run_id:'200',mode:'repair'}});
 assert.equal(r.outcome,'UNRESOLVED');assert.equal((await f.state(r.caseId)).repairCode,'RESCUE_BUDGET_EXHAUSTED');assert.deepEqual(await f.unit.read(),before);assert.equal(await readFile(path,'utf8'),record);assert.equal(f.writes.length,1);
});
test('Writer recovery refuses changed authority, missing conversation or an uncertain write',async t=>{
 for(const mutation of ['authority','conversation','write'])await t.test(mutation,async t=>{
  const f=await interruptedWriter(t),s=await f.unit.read();
  if(mutation==='authority')s.pending.policyHash='changed';if(mutation==='conversation')await writeFile(f.conversation,'{}\n');if(mutation==='write')s.pending.writeAttempted=true;
  assert.equal(await inspectInterruptedWriter(f.runtime,f.g,issue,s,f.src,{kind:'provider-job-timeout'}),null);
 });
});
test('provider cancellation recovery requires exact job annotation, signed duration and completed source identity',async t=>{
 const f=await fixture(t);f.runtime.coreUpgrade.executionLimits={jobTimeoutMinutes:180};f.runtime.github.list=async()=>[timeoutAnnotation];
 assert.equal((await providerTimeoutEvidence(f.runtime,grant,timeoutSource())).jobId,'77');
 for(const change of ['no-signature','no-annotation','near-message','wrong-level','early','late','missing-time','foreign-check','active-job','duplicate-job']){
  const r=timeoutSource();f.runtime.coreUpgrade.executionLimits={jobTimeoutMinutes:180};f.runtime.github.list=async()=>[timeoutAnnotation];
  if(change==='no-signature')delete f.runtime.coreUpgrade.executionLimits;
  if(change==='no-annotation')f.runtime.github.list=async()=>[];
  if(change==='near-message')f.runtime.github.list=async()=>[{...timeoutAnnotation,message:'user says '+timeoutAnnotation.message}];
  if(change==='wrong-level')f.runtime.github.list=async()=>[{...timeoutAnnotation,annotation_level:'notice'}];
  if(change==='early')r.jobs[0].completed_at='2026-10-27T01:05:00Z';
  if(change==='late')r.jobs[0].completed_at='2026-10-27T05:00:00Z';
  if(change==='missing-time')delete r.jobs[0].completed_at;
  if(change==='foreign-check')r.jobs[0].check_run_url='https://evil.test/repos/taco3064/kairo/check-runs/77';
  if(change==='active-job')r.jobs[0].status='in_progress';
  if(change==='duplicate-job')r.jobs.push({...r.jobs[0]});
  assert.equal(await providerTimeoutEvidence(f.runtime,grant,r),null,change);
 }
});
test('proven timed-out independent review retains artifacts and archives pending state before fresh Core dispatch',async t=>{
 const f=await fixture(t),src=timeoutSource(),pending={operation:'accept',executionContext:{action:{runId:'100'}},artifacts:{candidateHash:'preserved'}};
 f.runs.set('100',src);f.runtime.coreUpgrade.executionLimits={jobTimeoutMinutes:180};f.runtime.github.list=async(path)=>path.endsWith('/annotations')?[timeoutAnnotation]:src.jobs;
 let s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,pending}));
 const path=join(f.unit.directory,'execution.lock');await writeFile(path,JSON.stringify({pid:2147483647,startedAt:'2026-10-27T01:10:00Z'}));
 const id=await f.queue('RUN_FAILED'),before=(await f.unit.read()).issues,result=await runRescue(f.runtime,f.event(id)),after=await f.unit.read();
 assert.equal(result.outcome,'PENDING_VERIFICATION');assert.deepEqual(after.issues,before);assert.equal(after.pending,null);
 assert.deepEqual(after.rescueRecoveries[0].pending,pending);assert.equal(after.rescueRecoveries[0].proof.jobId,'77');assert.equal(f.writes.length,1);
});
test('a deferred live Agent is rechecked without consuming a repair or removing its lock',async t=>{
 const f=await fixture(t);let active=true;
 f.runtime.rescueCommand=async(_name,args)=>({stdout:args.includes('ps')?(active?'live\n':''):JSON.stringify([{Id:'live',State:{Running:true},Mounts:[{Destination:'/work',Source:join(f.root,'workspaces',digest(unitId(grant,issue)))}]}])});
 const id=await f.queue(),before=await f.unit.read();let report=await runRescue(f.runtime,f.event(id));
 assert.equal(report.outcome,'DEFERRED');assert.equal(report.nextCheckAt!==null,true);assert.deepEqual(await f.unit.read(),before);
 const budget=new Store(f.root,'rescue-budget:'+unitId(grant,issue));assert.equal((await budget.read()).attempts,undefined);
 await runRescue(f.runtime,f.event(id));assert.equal((await f.state(id)).deferredChecks,1);assert.equal(f.writes.length,0);
 active=false;const cs=new Store(f.root,'rescue-case:'+id),c=await cs.read();await cs.transaction(c.revision,v=>({...v,nextCheckAt:'2020-01-01T00:00:00Z'}));
 report=await wakeRescueCases(f.runtime,grant);
 assert.equal(report.outcome,'RECHECKED');assert.equal(report.results[0].outcome,'NOTIFIED');assert.equal(f.writes.length,1);assert.equal((await budget.read()).attempts,undefined);assert(f.writes[0].path.endsWith('kairo-rescue.yml/dispatches'));
 assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'PENDING_VERIFICATION');assert.equal((await budget.read()).attempts,1);
 await wakeRescueCases(f.runtime,grant);assert.equal(f.writes.length,2);
});
test('a verified source completion wakes a deferred case before its fallback deadline',async t=>{
 const f=await fixture(t);let active=true;
 f.runtime.rescueCommand=async(_name,args)=>({stdout:args.includes('ps')?(active?'live\n':''):JSON.stringify([{Id:'live',State:{Running:true},Mounts:[{Destination:'/work',Source:join(f.root,'workspaces',digest(unitId(grant,issue)))}]}])});
 const id=await f.queue();assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'DEFERRED');assert(Date.parse((await f.state(id)).nextCheckAt)>Date.now());
 active=false;assert.equal((await runRescue(f.runtime,{inputs:{source_run_id:'100',mode:'repair'}})).outcome,'PENDING_VERIFICATION');assert.equal(f.writes.length,1);
});

test('host pending rechecks stop at the bound and never replay a partially attempted dispatch',async t=>{
 const f=await fixture(t),id=await f.queue(),cs=new Store(f.root,'rescue-case:'+id);let c=await cs.read();
 await cs.transaction(c.revision,v=>({...v,outcome:'DEFERRED',repairCode:'RESCUE_SOURCE_ACTIVE',deferredChecks:71}));f.runs.get('100').status='in_progress';
 await wakeRescueCases(f.runtime,grant);assert.equal((await f.state(id)).repairCode,'RESCUE_RECHECK_EXHAUSTED');assert.equal(f.writes.length,0);
 c=await cs.read();await cs.transaction(c.revision,v=>({...v,outcome:'DEFERRED',repairCode:'RESCUE_AGENT_ACTIVE',repairStartedAt:'previous',resumeDispatch:{status:'attempted'}}));f.runs.get('100').status='completed';
 await wakeRescueCases(f.runtime,grant);assert.equal(f.writes.length,0);
});
test('Rescue admission rejects cron and non-Actions host execution',async t=>{
 const f=await fixture(t),r=f.runtime;
 for(const name of ['schedule',undefined]){
  r.environment={GITHUB_REPOSITORY:'taco3064/kairo',GITHUB_EVENT_NAME:name,GITHUB_RUN_ID:'300',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'rescue'};
  await assert.rejects(verifyRescueInvocation(r,grant,{schedule:'*/5 * * * *'}),{code:'RESCUE_ORIGIN_INVALID'});
 }
});
test('host wakeup batch bounds due work and leaves remaining cases for the next tick',async t=>{
 const f=await fixture(t),original=await f.queue(),template=await f.state(original),index=new Store(f.root,'rescue-index:'+grant.policy.grantId),cases={};
 for(let n=0;n<12;n++){
  const id=digest({pendingCase:n});cases[id]={sourceRunId:'100',resumeRunId:'200',issueId:issue.id};
  await new Store(f.root,'rescue-case:'+id).transaction(0,()=>({...template,request:{...template.request,id},outcome:'PENDING_VERIFICATION',resumeRunId:'200',resumeDispatch:{status:'confirmed'},nextCheckAt:new Date(n*1000).toISOString()}));
 }
 const s=await index.read();await index.transaction(s.revision,v=>({...v,cases}));
 let r=await wakeRescueCases(f.runtime,grant);assert.equal(r.results.length,10);assert.equal(r.results[0].caseId,Object.keys(cases)[0]);
 r=await wakeRescueCases(f.runtime,grant);assert.equal(r.results.length,2);assert.equal(f.writes.length,0);
});
async function pendingContinuations(f){
 const original=await f.queue(),template=await f.state(original),index=new Store(f.root,'rescue-index:'+grant.policy.grantId),cases={};
 for(let n=0;n<11;n++){
  const id=digest({recheckFailure:n}),resumeRunId=n<10?'404':'200';cases[id]={sourceRunId:'100',resumeRunId,issueId:issue.id};
  await new Store(f.root,'rescue-case:'+id).transaction(0,()=>({...template,request:{...template.request,id},outcome:'PENDING_VERIFICATION',resumeRunId,resumeDispatch:{status:'confirmed'},nextCheckAt:new Date(n*1000).toISOString()}));
 }
 const s=await index.read();await index.transaction(s.revision,v=>({...v,cases}));
 return Object.keys(cases);
}

test('permanent recheck failures are persisted and cannot monopolize later sweeps',async t=>{
 const f=await fixture(t),ids=await pendingContinuations(f),api=f.runtime.github.api;
 f.runtime.github.api=async(path,...args)=>{if(path.endsWith('/runs/404'))throw Object.assign(Error('Run no longer exists'),{requestMethod:'GET',status:404});return api(path,...args);};
 let report=await wakeRescueCases(f.runtime,grant);assert.equal(report.results.length,10);
 for(const id of ids.slice(0,10)){const c=await f.state(id);assert.equal(c.outcome,'UNRESOLVED');assert.equal(c.nextCheckAt,null);assert.equal(c.recheckError.code,'UNCLASSIFIED');}
 report=await wakeRescueCases(f.runtime,grant);assert.equal(report.results.length,1);assert.equal(report.results[0].caseId,ids[10]);
 assert.equal((await f.state(ids[10])).repairCode,'RESCUE_CONTINUATION_ACTIVE');assert.equal(f.writes.length,0);
});

test('unavailable recheck reads back off, yield to later cases and stop at the deferral bound',async t=>{
 const f=await fixture(t),ids=await pendingContinuations(f),api=f.runtime.github.api;
 f.runtime.github.api=async(path,...args)=>{if(path.endsWith('/runs/404'))throw Object.assign(Error('Provider temporarily unavailable'),{requestMethod:'GET',status:503});return api(path,...args);};
 await wakeRescueCases(f.runtime,grant);
 for(const id of ids.slice(0,10)){
  const c=await f.state(id);assert.equal(c.outcome,'DEFERRED');assert.equal(c.repairCode,'RESCUE_RECHECK_UNAVAILABLE');assert.equal(c.deferredChecks,1);assert(Date.parse(c.nextCheckAt)>Date.now());
 }
 let report=await wakeRescueCases(f.runtime,grant);assert.equal(report.results.length,1);assert.equal(report.results[0].caseId,ids[10]);
 const store=new Store(f.root,'rescue-case:'+ids[0]);let c=await store.read();await store.transaction(c.revision,v=>({...v,nextCheckAt:'2020-01-01T00:00:00Z'}));
 const before=Date.now();report=await wakeRescueCases(f.runtime,grant);c=await store.read();assert.equal(report.results.length,1);assert.equal(c.deferredChecks,2);assert(Date.parse(c.nextCheckAt)>=before+600000);
 await store.transaction(c.revision,v=>({...v,deferredChecks:71,nextCheckAt:'2020-01-01T00:00:00Z'}));
 await wakeRescueCases(f.runtime,grant);c=await store.read();assert.equal(c.outcome,'UNRESOLVED');assert.equal(c.repairCode,'RESCUE_RECHECK_EXHAUSTED');assert.equal(c.nextCheckAt,null);
 await wakeRescueCases(f.runtime,grant);assert.equal((await store.read()).deferredChecks,72);assert.equal(f.writes.length,0);
});

test('rate-limit rechecks honor the provider reset and do not overwrite concurrent completion',async t=>{
 for(const completed of [false,true])await t.test(completed?'completion wins':'provider reset',async t=>{
  const f=await fixture(t),id=await f.queue();await runRescue(f.runtime,f.event(id));
  const cs=new Store(f.root,'rescue-case:'+id),c=await cs.read(),retryAt=Date.now()+3600000,api=f.runtime.github.api;
  await cs.transaction(c.revision,v=>({...v,nextCheckAt:'2020-01-01T00:00:00Z'}));
  f.runtime.github.api=async(path,...args)=>{
   if(path.endsWith('/runs/200')){
    if(completed){const current=await cs.read();await cs.transaction(current.revision,v=>({...v,outcome:'RESOLVED',nextCheckAt:null,verification:'Independent completion verified'}));}
    throw Object.assign(Error('Rate limit reset pending'),{code:'GITHUB_RATE_LIMIT',requestMethod:'GET',retryAt});
   }
   return api(path,...args);
  };
  await wakeRescueCases(f.runtime,grant);const after=await cs.read();
  if(completed){assert.equal(after.outcome,'RESOLVED');assert.equal(after.verification,'Independent completion verified');assert.equal(after.recheckError,undefined);}
  else{assert.equal(after.outcome,'DEFERRED');assert(Date.parse(after.nextCheckAt)>=retryAt);assert.equal(after.deferredChecks,1);}
  assert.equal(f.writes.length,1);
 });
});

test('Agent races at either later probe defer without spending repair budget',async t=>{
 for(const atProbe of [2,3])await t.test('probe '+atProbe,async t=>{
  const f=await fixture(t);let probes=0,race=true;
  f.runtime.rescueCommand=async(_name,args)=>({stdout:args.includes('ps')?(++probes===atProbe&&race?'live\n':''):JSON.stringify([{Id:'live',State:{Running:true},Mounts:[{Destination:'/work',Source:join(f.root,'workspaces',digest(unitId(grant,issue)))}]}])});
  const id=await f.queue(),cs=new Store(f.root,'rescue-case:'+id),budget=new Store(f.root,'rescue-budget:'+unitId(grant,issue)),before=await f.unit.read();
  for(let n=0;n<4;n++){
   probes=0;assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'DEFERRED');
   const c=await cs.read();assert.equal(c.repairStartedAt,undefined);assert.deepEqual(c.actions,[]);await cs.transaction(c.revision,v=>({...v,nextCheckAt:'2020-01-01T00:00:00Z'}));
   assert.equal((await budget.read()).attempts,undefined);assert.deepEqual(await f.unit.read(),before);
  }
  assert.equal(f.writes.length,0);race=false;probes=0;
  assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'PENDING_VERIFICATION');assert.equal((await budget.read()).attempts,1);assert.equal(f.writes.length,1);
 });
});

test('lock removals and continuation share one repair charge, enforced before any removal',async t=>{
 for(const exhausted of [false,true])await t.test(exhausted?'budget exhausted':'one charge',async t=>{
  const f=await fixture(t),record=JSON.stringify({pid:2147483647,startedAt:'2026-10-27T01:10:00Z'}),paths=[join(f.unit.directory,'execution.lock'),join(new Store(f.root,issueLeaseId(issue)).directory,'execution.lock')];
  for(const path of paths){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,record);}
  const budget=new Store(f.root,'rescue-budget:'+unitId(grant,issue));if(exhausted)await budget.transaction(0,v=>({...v,attempts:3}));
  const id=await f.queue(),report=await runRescue(f.runtime,f.event(id));
  if(exhausted){
   assert.equal(report.outcome,'UNRESOLVED');assert.equal((await f.state(id)).repairCode,'RESCUE_BUDGET_EXHAUSTED');
   for(const path of paths)assert.equal(await readFile(path,'utf8'),record);assert.equal(f.writes.length,0);
  }else{
   assert.equal(report.outcome,'PENDING_VERIFICATION');assert.equal((await budget.read()).attempts,1);assert.equal(f.writes.length,1);
   for(const path of paths)await assert.rejects(lstat(path),{code:'ENOENT'});assert.equal(report.actions.filter(a=>a.startsWith('Removed')).length,2);
  }
 });
});

test('host wakeups notify only ready continuations once and never execute repairs',async t=>{
 const f=await fixture(t),id=await f.queue();await runRescue(f.runtime,f.event(id));
 f.runtime.execute=()=>assert.fail('Host must not execute stages');f.runtime.resume=()=>assert.fail('Host must not resume work');
 const cs=new Store(f.root,'rescue-case:'+id);let c=await cs.read();await cs.transaction(c.revision,v=>({...v,nextCheckAt:'2020-01-01T00:00:00Z'}));
 let report=await wakeRescueCases(f.runtime,grant);assert.equal(report.results[0].outcome,'DEFERRED');assert.equal(f.writes.length,1);
 c=await cs.read();await cs.transaction(c.revision,v=>({...v,nextCheckAt:'2020-01-01T00:00:00Z'}));f.runs.set('200',{...source('200'),conclusion:'success'});
 report=await wakeRescueCases(f.runtime,grant);assert.equal(report.results[0].outcome,'NOTIFIED');assert.equal(f.writes.length,2);
 assert(f.writes[1].path.endsWith('kairo-rescue.yml/dispatches'));assert.equal(f.writes[1].body.inputs.request_id,id);
 assert.equal((await wakeRescueCases(f.runtime,grant)).results.length,0);assert.equal(f.writes.length,2);
 assert.equal((await cs.read()).outcome,'DEFERRED'); // Only the authenticated Action may verify resolution.
});

test('unknown host notification writes are durable and cannot be replayed',async t=>{
 const f=await fixture(t),id=await f.queue();await runRescue(f.runtime,f.event(id));
 const cs=new Store(f.root,'rescue-case:'+id),c=await cs.read(),api=f.runtime.github.api;let posts=0;
 await cs.transaction(c.revision,v=>({...v,nextCheckAt:'2020-01-01T00:00:00Z'}));f.runs.set('200',{...source('200'),conclusion:'success'});
 f.runtime.github.api=async(path,method,...args)=>{if(method==='POST'){posts++;throw Error('Write outcome unknown');}return api(path,method,...args);};
 assert.equal((await wakeRescueCases(f.runtime,grant)).results[0].outcome,'UNRESOLVED');
 assert.equal((await cs.read()).repairCode,'RESCUE_WAKEUP_DISPATCH_UNKNOWN');
 await wakeRescueCases({...f.runtime},grant);assert.equal(posts,1);
});

test('host notifier is idle without pending work and restores one-shot waits after restart',async t=>{
 const f=await fixture(t),timers=new Set(),watched=new Set();let reads=0,loads=0;
 const api=f.runtime.github.api;f.runtime.github.api=async(...args)=>{reads++;return api(...args);};
 const options={watchDirectory:directory=>{watched.add(directory);return{on(){},close(){watched.delete(directory);}};},setTimer:(work,ms)=>{const timer={work,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer),onError:error=>assert.fail(error.message)};
 const load=async()=>{loads++;return grant;};let service=await startRescueWakeups(f.runtime,load,options);t.after(()=>service.close());
 assert.equal(timers.size,0);assert.equal(reads,0);assert.equal(loads,1);
 const id=await f.queue();await service.refresh();assert(watched.has(new Store(f.root,'rescue-case:'+id).directory));assert.equal(timers.size,0);
 await runRescue(f.runtime,f.event(id));await service.refresh();assert.equal(timers.size,1);assert([...timers][0].ms>0);
 service.close();assert.equal(timers.size,0);service=await startRescueWakeups(f.runtime,load,options);assert.equal(timers.size,1);assert.equal(f.writes.length,2);
 const cs=new Store(f.root,'rescue-case:'+id),c=await cs.read();await cs.transaction(c.revision,v=>({...v,outcome:'RESOLVED',nextCheckAt:null}));
 await service.refresh();assert.equal(timers.size,0);assert.equal(f.writes.length,2);
});

test('host authority read failures retain a bounded pending timer',async t=>{
 const f=await fixture(t),id=await f.queue();await runRescue(f.runtime,f.event(id));
 const cs=new Store(f.root,'rescue-case:'+id),c=await cs.read(),timers=new Set(),errors=[];let loads=0;
 await cs.transaction(c.revision,v=>({...v,nextCheckAt:'2020-01-01T00:00:00Z'}));
 const service=await startRescueWakeups(f.runtime,async()=>{if(++loads>1)throw Object.assign(Error('Grant read temporarily unavailable'),{requestMethod:'GET',status:503});return grant;},
  {watchDirectory:()=>({on(){},close(){}}),setTimer:(work,ms)=>{const timer={work,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer),onError:error=>errors.push(error)});
 t.after(()=>service.close());assert.equal(errors.length,1);assert.equal(timers.size,1);assert([...timers][0].ms>0);
 assert.equal((await cs.read()).repairCode,'RESCUE_RECHECK_UNAVAILABLE');assert.equal(f.writes.length,1);
});

test('filesystem events discover pending work without an idle polling interval',{skip:process.platform==='win32'?'Production notifier uses Linux inotify; Windows open-file rename semantics differ':false},async t=>{
 const f=await fixture(t),timers=new Set(),errors=[];
 const service=await startRescueWakeups(f.runtime,async()=>grant,{setTimer:(work,ms)=>{const timer={work,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer),onError:error=>errors.push(error)});
 t.after(()=>service.close());assert.equal(timers.size,0);
 f.runs.set('100',{...source(),status:'in_progress'});const id=await f.queue();
 const deadline=Date.now()+5000;while(!timers.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(errors.length,0);assert.equal(timers.size,1);assert([...timers][0].ms>0);assert.equal(f.writes.length,0);assert.equal((await f.state(id)).repairCode,'RESCUE_SOURCE_ACTIVE');service.close();
});

test('host notification enrollment requires the signed grant, installed amendment and private workflow pin',async t=>{
 const f=await fixture(t),keys=generateKeyPairSync('ed25519'),pub=keys.publicKey.export({type:'spki',format:'pem'}),priv=keys.privateKey.export({type:'pkcs8',format:'pem'});
 const {manifest,policy:base}=authorityFixture(),proposal='Notification enrollment fixture';manifest.proposalHash=digest(proposal);
 for(const i of manifest.issues){i.scopeBody='Implement '+i.id;i.scopeHash=digest(i.scopeBody);}
 const p={...base,manifestHash:digest(manifest),controlMode:'owner-project',executionMode:'actions-v1',runtimeHash:'runtime',coreDigest:'1'.repeat(64),actionExecution:grant.policy.actionExecution};
 const payload={recordId:'notification-grant',actor:'owner',revoked:false,manifest,policy:p,proposal},installed=await coreDigest(process.cwd());
 const amendment={schemaVersion:1,kind:'owner-core-upgrade',grantRecordId:payload.recordId,manifestHash:digest(manifest),policyHash:digest(p),runtimeHash:p.runtimeHash,fromCoreDigest:p.coreDigest,toCoreDigest:installed,sourceCommit:'3'.repeat(40),reason:'Pending notifications',rescue:policy};
 f.runtime.root=process.cwd();f.runtime.config.publicKeyPath=join(f.root,'owner.pem');await writeFile(f.runtime.config.publicKeyPath,pub);
 for(const variant of ['valid','revoked','tampered-grant','tampered-amendment','wrong-installation','foreign-workflow','public-repo']){
  const bundle={...signGrant({...payload,revoked:variant==='revoked'},priv),coreUpgrade:signGrant({...amendment,toCoreDigest:variant==='wrong-installation'?'9'.repeat(64):installed},priv)};
  if(variant==='tampered-grant')bundle.payload.actor='different-owner';if(variant==='tampered-amendment')bundle.coreUpgrade.payload.reason='unsigned change';
  f.runtime.github.grant=async()=>bundle;f.runtime.github.repository=async()=>({private:variant!=='public-repo'});
  f.runtime.github.api=async()=>({sha:variant==='foreign-workflow'?'f'.repeat(40):policy.workflowBlob});
  if(variant==='valid')assert.equal((await loadRescueWakeupGrant(f.runtime)).recordId,payload.recordId);
  else await assert.rejects(loadRescueWakeupGrant(f.runtime),undefined,variant);
 }
 assert.equal(f.writes.length,0);
});

test('unknown failures, changed work, uncertain writes, Owner holds and cancellation preserve state',async t=>{
 for(const variant of ['unknown','drift','write','hold','cancel','diagnose'])await t.test(variant,async t=>{
  const f=await fixture(t);if(variant==='write'){const s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,pending:{writeAttempted:true}}));}
  const id=await f.queue(variant==='unknown'?'ACCEPT_FAILED':'GITHUB_READ_UNAVAILABLE');
  if(variant==='drift'){const s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,issues:{[issue.id]:{candidate:{head:'new work'}}}}));}
  if(variant==='hold')f.runtime.ownerExecutionHolds=[{issueId:issue.id,repository:issue.repository}];
  if(variant==='cancel')f.runs.get('100').conclusion='cancelled';
  const event=f.event(id);if(variant==='diagnose')event.inputs.mode='diagnose';const before=await f.unit.read();
  const result=await runRescue(f.runtime,event);assert.equal(result.outcome,variant==='drift'?'SUPERSEDED':'UNRESOLVED');assert.deepEqual(await f.unit.read(),before);assert.equal(f.writes.length,0);
 });
});
test('a repaired continuation cannot recursively trigger another repair',async t=>{
 const f=await fixture(t),id=await f.queue();await runRescue(f.runtime,f.event(id));f.runtime.rescueInvocation=null;f.runtime.actionIdentity={runId:'200',runAttempt:1};
 f.runs.set('300',{...source('300'),status:'in_progress'});const count=f.writes.length;
 assert.deepEqual(await queueActionRescues(f.runtime,{results:[{status:'BLOCKED',issueId:issue.id,code:'ACCEPT_FAILED'}]},f.event(id)),[]);assert.equal(f.writes.length,count);
 assert.equal((await f.state(id)).coreReturn.runId,'200');
});
test('cooldown and maximum repairs apply to the same Issue cycle across different failed Runs',async t=>{
 const f=await fixture(t);const first=await f.queue();await runRescue(f.runtime,f.event(first));
 f.runtime.rescueInvocation=null;f.runtime.actionIdentity={runId:'101',runAttempt:1};f.runs.set('101',source('101'));
 const second=await f.queue();await runRescue(f.runtime,f.event(second));assert.equal((await f.state(second)).repairCode,'RESCUE_COOLDOWN');
 const budget=new Store(f.root,'rescue-budget:'+unitId(grant,issue)),s=await budget.read();await budget.transaction(s.revision,v=>({...v,attempts:3,lastAttemptAt:'2020-01-01T00:00:00Z'}));
 f.runtime.rescueInvocation=null;f.runtime.actionIdentity={runId:'102',runAttempt:1};f.runs.set('102',source('102'));
 const third=await f.queue();await runRescue(f.runtime,f.event(third));assert.equal((await f.state(third)).repairCode,'RESCUE_BUDGET_EXHAUSTED');
});
test('dead lock recovery requires completed provider jobs, attributable time and dead process',async t=>{
 const src=source(),record={pid:2147483647,startedAt:'2026-10-27T01:10:00Z'};
 assert.equal(lockEvidence(record,src,()=>false),true);
 for(const [r,s,alive]of [[record,src,()=>true],[record,{...src,status:'in_progress'},()=>false],[record,{...src,jobs:[]},()=>false],[{...record,startedAt:'2020-01-01'},src,()=>false],[{...record,pid:0},src,()=>false]])assert.equal(lockEvidence(r,s,alive),false);
 const f=await fixture(t),target=join(new Store(f.root,issueLeaseId(issue)).directory,'execution.lock');await mkdir(join(target,'..'),{recursive:true});await writeFile(target,JSON.stringify(record));
 const capacity=join(new Store(f.root,'actions-capacity:'+grant.policy.grantId+':0').directory,'execution.lock');await mkdir(join(capacity,'..'),{recursive:true});await writeFile(capacity,JSON.stringify(record));
 const other=join(new Store(f.root,'actions-capacity:'+grant.policy.grantId+':1').directory,'execution.lock');await mkdir(join(other,'..'),{recursive:true});await writeFile(other,JSON.stringify({...record,pid:process.pid}));
 const before=await f.unit.read(),audit=[];const removed=await recoverRescueLocks(f.runtime,grant,issue,src,{onRemoved:r=>audit.push(r)});assert.equal(removed.length,2);assert.equal(audit.length,2);await assert.rejects(lstat(target),{code:'ENOENT'});assert((await lstat(other)).isFile());assert.deepEqual(await f.unit.read(),before);
});
test('lock identity is rechecked after waiting for the repair budget',async t=>{
 const f=await fixture(t),path=join(f.unit.directory,'execution.lock'),old=JSON.stringify({pid:2147483647,startedAt:'2026-10-27T01:10:00Z'}),replacement=JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()});
 await writeFile(path,old);
 await assert.rejects(recoverRescueLocks(f.runtime,grant,issue,source(),{beforeRemove:()=>writeFile(path,replacement)}),{code:'RESCUE_LOCK_CHANGED'});
 assert.equal(await readFile(path,'utf8'),replacement);
});

test('an active Agent prevents lock recovery, and Docker read failure is not treated as absence',async t=>{
 const f=await fixture(t);f.runtime.rescueCommand=async(_name,args)=>({stdout:args[0]==='ps'?'active\n':JSON.stringify([{Id:'active',State:{Running:true},Mounts:[{Destination:'/work',Source:join(f.root,'workspaces',digest(unitId(grant,issue)))}]}])});
 await assert.rejects(recoverRescueLocks(f.runtime,grant,issue,source()),{code:'RESCUE_AGENT_ACTIVE'});
 f.runtime.rescueCommand=async()=>{throw Error('Docker unavailable');};await assert.rejects(recoverRescueLocks(f.runtime,grant,issue,source()),/Docker unavailable/);
});
test('gh repair requires real failed-command evidence tied to this Issue and source Run',async t=>{
 const f=await fixture(t),id=randomUUID(),root=join(f.root,'executions',id);await mkdir(root,{recursive:true});
 const blocked={failureClass:'external_failure',outcome:'blocked',executionId:id};
 await writeFile(join(root,'context.json'),JSON.stringify({issue:{id:issue.id},executionContext:{action:{runId:'100'}}}));
 const transcript=command=>writeFile(join(root,'transcript.json'),JSON.stringify({stdout:JSON.stringify({item:{type:'command_execution',command,exit_code:127,aggregated_output:'/bin/sh: gh: not found'}})}));
 await transcript('echo gh is broken');assert.equal(await ghFailureEvidence(f.runtime,issue,blocked,'100'),false);
 await transcript('gh issue view 190 --json title');assert.equal(await ghFailureEvidence(f.runtime,issue,blocked,'100'),true);assert.equal(await ghFailureEvidence(f.runtime,issue,blocked,'101'),false);
 assert.equal(await ghFailureEvidence(f.runtime,issue,{...blocked,failureClass:'implementation_failure'},'100'),false);
});
test('actual gh probe can restart only the exact approved service then revalidate',async t=>{
 const f=await fixture(t),calls=[];let failed=false;
 f.runtime.rescueCommand=async(name,args)=>{calls.push({name,args});if(name==='sudo')return{stdout:''};if(!failed){failed=true;throw Error('socket unavailable');}return{stdout:JSON.stringify({nameWithOwner:issue.repository,isPrivate:false})};};
 const result=await probeGithubRead(f.runtime,issue.repository);assert.equal(result.restarted,true);assert.equal(calls.length,3);
 assert.deepEqual(calls[1],{name:'sudo',args:['-n','/usr/bin/systemctl','restart','kairo-github-read.service']});assert(calls[0].args.includes('none'));assert(!JSON.stringify(calls).includes('GH_TOKEN'));
});
test('proven gh failure archives its block, preserves the candidate and dispatches original Core only once',async t=>{
 const f=await fixture(t),executionId=randomUUID(),root=join(f.root,'executions',executionId);await mkdir(root,{recursive:true});
 const blocked={failureClass:'external_failure',outcome:'blocked',executionId,rootCause:'gh is not installed',summary:'Required read could not run'};
 await writeFile(join(root,'context.json'),JSON.stringify({issue:{id:issue.id},executionContext:{action:{runId:'100'}}}));
 await writeFile(join(root,'transcript.json'),JSON.stringify({stdout:JSON.stringify({item:{type:'command_execution',command:'gh issue view 190',exit_code:127,aggregated_output:'gh: not found'}})}));
 const s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,issues:{[issue.id]:{...v.issues[issue.id],blocked}}}));
 f.runtime.rescueCommand=async(_name,args)=>({stdout:args[0]==='ps'?'':JSON.stringify({nameWithOwner:issue.repository,isPrivate:false})});
 const id=await f.queue('AGENT_BLOCKED'),result=await runRescue(f.runtime,f.event(id)),after=await f.unit.read();
 assert.equal(result.outcome,'PENDING_VERIFICATION');assert.equal(after.issues[issue.id].blocked,undefined);assert.deepEqual(after.issues[issue.id].candidate,{head:'preserve'});assert.deepEqual(after.rescueRecoveries[0].blocked,blocked);assert.equal(f.writes.length,1);
 await runRescue(f.runtime,f.event(id));assert.equal(f.writes.length,1);
});
test('Rescue summaries carry cause, action and honest outcome without log commands or credentials',async t=>{
 const f=await fixture(t),summary=join(f.root,'summary.md'),lines=[];
 await rescueLog({outcome:'UNRESOLVED',reason:'ghp_abc123\n::error::x <script>|',actions:['readback'],verification:'not cleared'}, {summary,log:line=>lines.push(line)});
 assert.equal(lines.length,1);assert(!lines[0].includes('\n'));assert(!lines[0].includes('ghp_abc123'));const text=await readFile(summary,'utf8');assert(text.includes('Cause'));assert(text.includes('UNRESOLVED'));assert(text.includes('&lt;script&gt;&#124;'));
});
test('Rescue cannot execute or resume the product lifecycle',async()=>{
 await assert.rejects(Runtime.prototype.execute.call({rescueInvocation:{}},null),/cannot execute/);
 await assert.rejects(Runtime.prototype.resume.call({rescueInvocation:{}}),/original signed Actions/);
});

async function budgetFailure(f,{stage='deliver',latest='budget_exhausted'}={}){
 f.runtime.coreUpgrade.rescue=policy;f.runtime.coreUpgrade.rescueContinuations=['verification-budget','ci-change'];
 const executionId=randomUUID(),id=randomUUID(),root=join(f.root,'executions',executionId),budget=verificationBudget(600000,Date.parse('2026-10-27T01:10:00Z'));
 await mkdir(join(root,'verification'),{recursive:true});const state=await f.unit.read(),stored=state.issues[issue.id];
 const result={outcome:'blocked',failureClass:'external_failure',summary:'Required verification did not finish',rootCause:'Verification deadline',blockingFindings:['Full check remains required'],contractConflicts:[]};
 const blocked={...result,executionId,stage};
 const context={issue,cohort:{id:unitId(grant,issue)},skillSelection:{stage},binding:{policyHash:'test-binding'},candidate:stored.candidate??null,shape:stored.shape?.body??null,executionContext:{action:{runId:'100'}},repositoryObservation:{base:'e'.repeat(40)}};
 await writeFile(join(root,'context.json'),JSON.stringify(context));await writeFile(join(root,'validated-result.json'),JSON.stringify(result));await writeFile(join(root,'verification-budget.json'),JSON.stringify(budget));
 const receipt={schemaVersion:1,id,status:latest,exitCode:latest==='budget_exhausted'?124:1,startedAt:budget.startedAt+1,finishedAt:budget.stopVerificationAt+1,deadlineAt:budget.stopVerificationAt};
 await writeFile(join(root,'verification',id+'.json'),JSON.stringify(receipt));
 if(['deliver','shaper-review'].includes(stage)){
  const role=stage==='deliver'?'deliver':'shaper',key=digest({repository:issue.repository,issue:issue.id,scope:issue.scopeHash,binding:context.binding,role});
  const session=new Store(f.root,'role-session:'+key);await session.transaction(0,s=>({...s,sessionStatus:'ready',lastExecution:executionId,sessionId:randomUUID()}));
 }
 await f.unit.transaction(state.revision,v=>({...v,issues:{[issue.id]:{...v.issues[issue.id],blocked}}}));
 return{root,receipt,context,blocked,budget};
}
test('budget recovery needs exact validated result, execution/cycle, latest guarded deadline and ready original session',async t=>{
 const f=await fixture(t),b=await budgetFailure(f),stored=(await f.unit.read()).issues[issue.id];
 assert.equal((await verificationContinuation(f.runtime,grant,issue,stored)).kind,'verification-budget');
 for(const mutation of ['result','cycle','receipt','scope','shape','session'])await t.test(mutation,async t=>{
  const x=await fixture(t),b=await budgetFailure(x),s=(await x.unit.read()).issues[issue.id];
  if(mutation==='result')await writeFile(join(b.root,'validated-result.json'),JSON.stringify({...b.blocked,rootCause:'Different result'}));
  if(mutation==='cycle')await writeFile(join(b.root,'context.json'),JSON.stringify({...b.context,cohort:{id:'wrong'}}));
  if(mutation==='scope')await writeFile(join(b.root,'context.json'),JSON.stringify({...b.context,issue:{...issue,scopeHash:'old'}}));
  if(mutation==='shape')s.shape={body:'changed'};
  if(mutation==='receipt')await writeFile(join(b.root,'verification',b.receipt.id+'.json'),JSON.stringify({...b.receipt,status:'failed',exitCode:1}));
  if(mutation==='session'){
   const key=digest({repository:issue.repository,issue:issue.id,scope:issue.scopeHash,binding:b.context.binding,role:'deliver'}),store=new Store(x.root,'role-session:'+key),r=await store.read();await store.transaction(r.revision,v=>({...v,sessionStatus:'recovery-required'}));
  }
  assert.equal(await verificationContinuation(x.runtime,grant,issue,s),null);
 });
});
test('a later failed check, cancelled source, conflict or unsigned continuation never becomes a budget retry',async t=>{
 const f=await fixture(t),b=await budgetFailure(f);const stored=(await f.unit.read()).issues[issue.id],id=randomUUID();
 await writeFile(join(b.root,'verification',id+'.json'),JSON.stringify({...b.receipt,id,status:'failed',exitCode:1,finishedAt:b.receipt.finishedAt+1}));
 assert.equal(await verificationContinuation(f.runtime,grant,issue,stored),null);
 const x=await fixture(t);await budgetFailure(x);const s=(await x.unit.read()).issues[issue.id];x.runs.get('100').conclusion='cancelled';assert.equal(await verificationContinuation(x.runtime,grant,issue,s),null);
 x.runs.get('100').conclusion='success';s.blocked.contractConflicts=[{}];assert.equal(await verificationContinuation(x.runtime,grant,issue,s),null);
 s.blocked.contractConflicts=[];delete x.runtime.coreUpgrade.rescueContinuations;assert.equal(await verificationContinuation(x.runtime,grant,issue,s),null);
});
test('budget resumption archives the failure, retains the candidate and records no passing tests or acceptance',async t=>{
 const f=await fixture(t);await budgetFailure(f,{stage:'accept'});const before=(await f.unit.read()).issues[issue.id],id=await f.queue('STAGE_BLOCKED');
 const result=await runRescue(f.runtime,f.event(id)),after=await f.unit.read();assert.equal(result.outcome,'PENDING_VERIFICATION');
 assert.deepEqual(after.issues[issue.id].candidate,before.candidate);assert.equal(after.issues[issue.id].accept,undefined);assert.equal(after.issues[issue.id].delivery,undefined);
 assert.equal(after.issues[issue.id].rescueContinuation.stage,'accept');assert.deepEqual(after.rescueRecoveries[0].blocked,before.blocked);assert.equal(f.writes.length,1);
});
test('text claiming budget exhaustion without the guarded receipt is diagnosed without clearing work',async t=>{
 const f=await fixture(t),b=await budgetFailure(f);await rm(join(b.root,'verification'),{recursive:true});const before=await f.unit.read(),id=await f.queue('STAGE_BLOCKED');
 assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'UNRESOLVED');assert.deepEqual(await f.unit.read(),before);assert.equal(f.writes.length,0);
});
async function ciFixture(t,{blocked=true}={}){
 const f=await fixture(t),g=structuredClone(grant);g.policy.repositories={[issue.repository]:{ciMode:'github-repository',baseBranch:'main',trustedCheckAppIds:[1]}};f.runtime.grant=async()=>g;f.runtime.coreUpgrade.rescue=policy;f.runtime.coreUpgrade.rescueContinuations=['ci-change'];
 const head='d'.repeat(40),pr={head:{repo:{full_name:issue.repository},sha:head},base:{ref:'main'},state:'open',merged:false,draft:false,mergeable:true,mergeable_state:'clean'};
 f.runtime.github.pull=async()=>pr;let checks=[{head,status:'completed',conclusion:'success'}];f.runtime.github.checks=async()=>checks;
 const s=await f.unit.read();await f.unit.transaction(s.revision,v=>{const stored=v.issues[issue.id];Object.assign(stored,{prNumber:1,review:{artifactIdentities:{head}}});if(blocked)stored.blocked={outcome:'blocked',failureClass:'external_failure',stage:'shaper-review',summary:'CI pending',resumeOn:'ci-change',reviewHead:head,candidateHash:digest(stored.candidate),checksHash:digest([{head,status:'in_progress'}])};return v;});
 return{...f,g,pr,setChecks:value=>checks=value};
}
test('changed exact-head CI delegates block reconciliation to Core; unchanged/foreign CI does not retry',async t=>{
 const f=await ciFixture(t),before=await f.unit.read(),id=await f.queue('STAGE_BLOCKED');assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'PENDING_VERIFICATION');assert.deepEqual(await f.unit.read(),before);
 const x=await ciFixture(t),stored=(await x.unit.read()).issues[issue.id];x.setChecks([{head:x.pr.head.sha,status:'in_progress'}]);assert.equal(await ciContinuation(x.runtime,x.g,issue,stored,'STAGE_BLOCKED'),null);
 x.pr.head.sha='a'.repeat(40);assert.equal(await ciContinuation(x.runtime,x.g,issue,stored,'STAGE_BLOCKED'),null);
});
test('merge wait is resumed only after exact reviewed PR readiness, without issuing merge in Rescue',async t=>{
 const f=await ciFixture(t,{blocked:false}),stored=(await f.unit.read()).issues[issue.id];f.pr.mergeable_state='blocked';assert.equal((await ciContinuation(f.runtime,f.g,issue,stored,'MERGE_REQUIREMENTS_PENDING')).kind,'ci-wait');
 f.pr.mergeable_state='clean';const id=(await queueActionRescues(f.runtime,{results:[{status:'WAITING',issueId:issue.id,code:'MERGE_REQUIREMENTS_PENDING'}]},{inputs:{issue_id:issue.id}}))[0];
 assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'PENDING_VERIFICATION');assert.equal(f.writes.length,1);assert(f.writes[0].path.endsWith('action-stage.yml/dispatches'));
});

test('pending merge requirements defer with no mutation, dispatch or repair budget',async t=>{
 const f=await ciFixture(t,{blocked:false});f.pr.mergeable_state='blocked';
 const before=await f.unit.read(),id=(await queueActionRescues(f.runtime,{results:[{status:'WAITING',issueId:issue.id,code:'MERGE_REQUIREMENTS_PENDING'}]},{inputs:{issue_id:issue.id}}))[0];
 const report=await runRescue(f.runtime,f.event(id));assert.equal(report.outcome,'DEFERRED');assert.equal((await f.state(id)).repairCode,'RESCUE_MERGE_PENDING');
 assert.deepEqual(await f.unit.read(),before);assert.equal(f.writes.length,0);assert.equal((await new Store(f.root,'rescue-budget:'+unitId(f.g,issue)).read()).attempts,undefined);
 f.pr.mergeable_state='dirty';f.pr.mergeable=false;assert.equal(await ciContinuation(f.runtime,f.g,issue,before.issues[issue.id],'MERGE_REQUIREMENTS_PENDING'),null);
});

test('proven EPIPE resumes the original role only with separately signed IO capability',async t=>{
 const f=await fixture(t),b=await budgetFailure(f,{stage:'accept',latest:'output_error'}),receipt={...b.receipt,exitCode:74,errorCode:'EPIPE'};
 await writeFile(join(b.root,'verification',receipt.id+'.json'),JSON.stringify(receipt));
 const stored=(await f.unit.read()).issues[issue.id];assert.equal(await verificationContinuation(f.runtime,grant,issue,stored),null);
 f.runtime.coreUpgrade.rescueAssistance={schemaVersion:1,verificationIo:true};
 assert.equal((await verificationContinuation(f.runtime,grant,issue,stored)).kind,'verification-io');
 const before=await f.unit.read(),id=await f.queue('STAGE_BLOCKED'),report=await runRescue(f.runtime,f.event(id)),after=await f.unit.read();
 assert.equal(report.outcome,'PENDING_VERIFICATION');assert.equal(after.issues[issue.id].rescueContinuation.kind,'verification-io');
 assert.deepEqual(after.issues[issue.id].candidate,before.issues[issue.id].candidate);assert.equal(after.issues[issue.id].accept,undefined);assert.equal(f.writes.length,1);
});

test('IO recovery cannot reinterpret failed checks, missing receipts or other IO failures as EPIPE',async t=>{
 for(const variant of ['missing','failed','code','latest'])await t.test(variant,async t=>{
  const f=await fixture(t),b=await budgetFailure(f,{stage:'accept',latest:'output_error'});f.runtime.coreUpgrade.rescueAssistance={schemaVersion:1,verificationIo:true};
  const receipt={...b.receipt,exitCode:74,errorCode:'EPIPE'};
  if(variant==='failed'){receipt.status='failed';receipt.exitCode=1;}
  if(variant==='code')receipt.errorCode='ENOSPC';
  await writeFile(join(b.root,'verification',receipt.id+'.json'),JSON.stringify(receipt));
  if(variant==='missing')await rm(join(b.root,'verification',receipt.id+'.json'));
  if(variant==='latest'){const id=randomUUID();await writeFile(join(b.root,'verification',id+'.json'),JSON.stringify({...receipt,id,status:'failed',exitCode:1,finishedAt:receipt.finishedAt+1}));}
  const before=await f.unit.read(),id=await f.queue('STAGE_BLOCKED');assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'UNRESOLVED');assert.deepEqual(await f.unit.read(),before);assert.equal(f.writes.length,0);
 });
});

test('completion-triggered Rescue authenticates the pinned workflow and verifies the hinted source',async t=>{
 const f=await fixture(t),r=f.runtime,run={...source('300'),path:rescueWorkflow,event:'workflow_run',status:'in_progress'};
 r.environment={GITHUB_REPOSITORY:'taco3064/kairo',GITHUB_EVENT_NAME:'workflow_run',GITHUB_RUN_ID:'300',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'rescue',GITHUB_SHA:run.head_sha,RUNNER_NAME:'runner'};
 r.github.api=async path=>path.includes('/contents/')?{sha:policy.workflowBlob}:run;r.github.repository=async()=>({private:true});r.github.list=async()=>[{id:99,name:'rescue',status:'in_progress',runner_name:'runner',runner_id:2}];
 const event={repository:{private:true},workflow_run:source()};assert.equal((await verifyRescueInvocation(r,grant,event)).runId,'300');
 event.workflow_run.path=rescueWorkflow;await assert.rejects(verifyRescueInvocation(r,grant,event),/approved private Core hint/);
});

async function aiFixture(t,{stage='accept',result,mutate=false}={}){
 const f=await fixture(t);
 const g=structuredClone(grant);Object.assign(g.manifest,{schemaVersion:2,scheduling:'native-dependencies',membership:'fixed-approved-set',proposalHash:digest('fixture proposal')});g.policy.stateDirectory=f.root;g.policy.repositories={[issue.repository]:{repositoryId:issue.repositoryId}};g.approval={verified:true};f.runtime.grant=async()=>g;
 if(stage==='deliver'){const s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,issues:{[issue.id]:{repairs:0,shape:{body:'```kairo-candidate\n{"artifacts":[],"hooks":[]}\n```\n'}}}}));}
 const b=await budgetFailure(f,{stage,latest:'failed'});f.runtime.coreUpgrade.rescueContinuations=[];f.runtime.coreUpgrade.rescueAssistance={schemaVersion:1,aiRepair:true};
 const projected=projectUnit(g,issue);b.context.binding=binding(projected.manifest,projected.policy);await writeFile(join(b.root,'context.json'),JSON.stringify(b.context));
 if(stage==='deliver'){const key=digest({repository:issue.repository,issue:issue.id,scope:issue.scopeHash,binding:b.context.binding,role:'deliver'}),session=new Store(f.root,'role-session:'+key);await session.transaction(0,s=>({...s,sessionStatus:'ready',sessionId:randomUUID(),lastExecution:b.blocked.executionId}));}
 await writeFile(join(b.root,'transcript.json'),JSON.stringify({stdout:'A required command rejected an unsupported flag',stderr:''}));
 const calls=[],work=join(f.root,'preserved-work');await mkdir(work);await writeFile(join(work,'source.mjs'),'preserve');
 const workspace={root:join(f.root,'attempt-0'),work,preparedBase:async()=>b.context.repositoryObservation.base,captureAttempt:async()=>({bytes:await readFile(join(work,'source.mjs'),'utf8')}),snapshotRepair:async()=>({candidate:{base:b.context.repositoryObservation.base,tree:'f'.repeat(40),paths:['source.mjs']}})};
 f.runtime.workspace=(_g,_i,s)=>s.repairs===1?{root:join(f.root,'attempt-1')}:workspace;
 f.runtime.agent={executionTimeoutMs:600000,execute:async(stage,context,path,customization)=>{
  calls.push({stage,context,path,customization,timeout:f.runtime.agent.executionTimeoutMs});if(mutate)await writeFile(join(work,'source.mjs'),'changed');
  const selected=result??{outcome:'ready',failureClass:'external_failure',body:JSON.stringify({action:'retry-original-role',steps:['Replace the unsupported command flag using repository documentation','Run the required guarded regression']}),rootCause:'The failed invocation used an unsupported flag',summary:'Retry the corrected command',evidenceReferences:['/io/context.json'],blockingFindings:[],contractConflicts:[]};
  return{executionId:randomUUID(),result:selected,resultHash:digest(selected)};
 }};
 return{...f,b,calls,work};
}

test('unknown attributable failures invoke isolated AI before escalating and dispatch only normal Core repair',async t=>{
 const f=await aiFixture(t),before=await f.unit.read(),id=await f.queue('STAGE_BLOCKED'),report=await runRescue(f.runtime,f.event(id)),after=await f.unit.read();
 assert.equal(report.outcome,'PENDING_VERIFICATION');assert.equal(f.calls.length,1);assert.equal(f.calls[0].stage,'rescue-diagnosis');assert.equal(f.calls[0].timeout,180000);assert.equal(f.runtime.agent.executionTimeoutMs,600000);
 assert.equal(f.calls[0].context.rescue.originalRole,'accept');assert.equal(after.issues[issue.id].rescueContinuation.kind,'ai-repair');assert.deepEqual(after.issues[issue.id].candidate,before.issues[issue.id].candidate);assert.equal(after.issues[issue.id].accept,undefined);
 assert.equal((await f.state(id)).aiDiagnosis.status,'completed');assert.equal(f.writes.length,1);assert(f.writes[0].path.endsWith('/action-stage.yml/dispatches'));
 await runRescue(f.runtime,f.event(id));assert.equal(f.calls.length,1);assert.equal(f.writes.length,1);
 f.runs.set('200',{...source('200'),conclusion:'success'});
 const receipt={operation:'close',completedAt:new Date().toISOString(),action:{runId:'200',runAttempt:1}},s=await f.unit.read();await f.unit.transaction(s.revision,v=>({...v,completion:{status:'COMPLETE',receiptHash:digest(receipt)},actionReceipts:[receipt]}));
 const verified=await runRescue(f.runtime,f.event(id));assert.equal(verified.outcome,'RESOLVED');assert.equal(verified.resolutionSource,'verified-ai-repair');
});

test('AI Writer recovery snapshots unaccepted source into a fresh attempt and preserves the original conversation',async t=>{
 const f=await aiFixture(t,{stage:'deliver'}),key=digest({repository:issue.repository,issue:issue.id,scope:issue.scopeHash,binding:f.b.context.binding,role:'deliver'}),session=new Store(f.root,'role-session:'+key),beforeSession=await session.read();
 const id=await f.queue('STAGE_BLOCKED'),report=await runRescue(f.runtime,f.event(id)),stored=(await f.unit.read()).issues[issue.id];
 assert.equal(report.outcome,'PENDING_VERIFICATION');assert.equal(stored.repairs,1);assert.equal(stored.repairSeed.sourceAttempt,0);assert.equal(stored.repairSeed.targetAttempt,1);
 assert.equal(stored.candidate,undefined);assert.deepEqual(await session.read(),beforeSession);assert.equal(await readFile(join(f.work,'source.mjs'),'utf8'),'preserve');
});

test('AI refusal, overbroad plans and read-only mutation escalate with evidence and no continuation',async t=>{
 for(const variant of ['refusal','overbroad','mutation'])await t.test(variant,async t=>{
  const result={outcome:variant==='refusal'?'blocked':'ready',failureClass:'external_failure',body:JSON.stringify({action:'host-shell',steps:['Change authority']}),rootCause:'Required host operation is outside current permissions',evidenceReferences:['/io/context.json'],contractConflicts:[]};
  const f=await aiFixture(t,{result:variant==='mutation'?undefined:result,mutate:variant==='mutation'}),before=await f.unit.read(),id=await f.queue('STAGE_BLOCKED'),report=await runRescue(f.runtime,f.event(id));
  assert.equal(report.outcome,'UNRESOLVED');assert.deepEqual(await f.unit.read(),before);assert.equal(f.writes.length,0);assert.equal((await f.state(id)).aiDiagnosis.status,'completed');
  await runRescue(f.runtime,f.event(id));assert.equal(f.calls.length,1);
 });
});

test('AI never bypasses Owner holds, uncertain writes, contract conflicts or unsigned capability',async t=>{
 for(const variant of ['hold','write','conflict','unsigned','source','session'])await t.test(variant,async t=>{
  const f=await aiFixture(t,{stage:variant==='session'?'deliver':'accept'});
  if(variant==='hold')f.runtime.ownerExecutionHolds=[{issueId:issue.id,repository:issue.repository}];
  if(variant==='unsigned')delete f.runtime.coreUpgrade.rescueAssistance;
  if(variant==='source')f.b.context.executionContext.action.runId='999';
  if(variant==='source')await writeFile(join(f.b.root,'context.json'),JSON.stringify(f.b.context));
  if(variant==='session'){const key=digest({repository:issue.repository,issue:issue.id,scope:issue.scopeHash,binding:f.b.context.binding,role:'deliver'}),s=new Store(f.root,'role-session:'+key),v=await s.read();await s.transaction(v.revision,x=>({...x,sessionStatus:'recovery-required'}));}
  if(['write','conflict'].includes(variant)){const s=await f.unit.read();await f.unit.transaction(s.revision,v=>{if(variant==='write')v.pending={writeAttempted:true};else v.issues[issue.id].blocked.contractConflicts=[{}];return v;});}
  const before=await f.unit.read(),id=await f.queue('STAGE_BLOCKED');assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'UNRESOLVED');assert.deepEqual(await f.unit.read(),before);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
 });
});

test('AI plans are proposals only and cannot encode arbitrary controller operations',()=>{
 for(const action of ['merge','mark-delivered','shell','restart-host','clear-authority'])assert.throws(()=>validateAiRepairPlan({outcome:'ready',failureClass:'external_failure',rootCause:'reason',evidenceReferences:['evidence'],contractConflicts:[],body:JSON.stringify({action,steps:['do it']})}),/bounded/);
});

test('Owner hold arriving during AI diagnosis prevents applying the plan or dispatching repair',async t=>{
 const f=await aiFixture(t),execute=f.runtime.agent.execute;
 f.runtime.agent.execute=async(...args)=>{const result=await execute(...args);f.runtime.ownerExecutionHolds=[{issueId:issue.id,repository:issue.repository}];return result;};
 const before=await f.unit.read(),id=await f.queue('STAGE_BLOCKED'),report=await runRescue(f.runtime,f.event(id));
 assert.equal(report.outcome,'UNRESOLVED');assert.equal(f.calls.length,1);assert.deepEqual(await f.unit.read(),before);assert.equal(f.writes.length,0);assert.equal((await f.state(id)).repairCode,'OWNER_REAUTHORIZATION_REQUIRED');
});

test('external recovery closes a stale incident only with a bound successful completion receipt, without repair attribution',async t=>{
 const f=await fixture(t),id=await f.queue('ACCEPT_FAILED');assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'UNRESOLVED');
 const receipt={operation:'close',completedAt:new Date().toISOString(),action:{runId:'100',runAttempt:1}},s=await f.unit.read();
 await f.unit.transaction(s.revision,v=>({...v,completion:{status:'COMPLETE',receiptHash:digest(receipt)},actionReceipts:[receipt]}));
 f.runs.get('100').conclusion='failure';assert.equal((await runRescue(f.runtime,f.event(id))).outcome,'UNRESOLVED');
 f.runs.get('100').conclusion='success';const report=await runRescue(f.runtime,f.event(id));assert.equal(report.outcome,'RESOLVED');assert.equal(report.resolutionSource,'verified-external-completion');assert.deepEqual(report.actions,[]);assert.equal(f.writes.length,0);
});

test('manual reconciliation of an unrelated successful source does not invent a failed recovery case',async t=>{
 const f=await fixture(t);f.runs.get('100').conclusion='success';const before=await f.unit.read();
 const report=await runRescue(f.runtime,{inputs:{source_run_id:'100',mode:'repair'}});assert.equal(report.outcome,'NOT_NEEDED');assert.deepEqual(await f.unit.read(),before);assert.equal(f.writes.length,0);
});
