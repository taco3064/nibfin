import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {rescueFixture} from '../tooling/rescue-fixture.mjs';
import {verificationRescueContinuation,ciRescueContinuation,verificationBudget,contentIdentity,
  createRescueContinuation,captureRescueSession,restoreRescueSession,createRoleSessionRecovery} from '../src/index.mjs';
import {executeCodex} from '../src/codex-entry.mjs';
function verificationFixture() {
  const f=rescueFixture(),budget=verificationBudget(1000000,Date.parse(f.sourceRun.run_started_at)),receipt={schemaVersion:1,id:'receipt-1',execution:f.target.execution,
    status:'budget_exhausted',exitCode:124,deadlineAt:budget.stopVerificationAt,startedAt:budget.startedAt+1,finishedAt:budget.stopVerificationAt+100,logDigest:'a'.repeat(64)};
  return {...f,input:{target:f.target,blocked:f.blocked,budget,receipts:[receipt],enabled:['verification-budget','verification-io'],source:f.sourceRun}};
}
test('precise budget/EPIPE proof authorizes fresh normal verification only',()=>{
  const f=verificationFixture();assert.equal(verificationRescueContinuation(f.input).kind,'verification-budget');
  const io={...f.input,receipts:[{...f.input.receipts[0],status:'output_error',exitCode:74,errorCode:'EPIPE'}]};
  assert.equal(verificationRescueContinuation(io).kind,'verification-io');assert.equal(verificationRescueContinuation(io).freshVerification,true);
});
for(const [name,mutate]of Object.entries({laterFailed:v=>v.receipts.push({...v.receipts[0],id:'later',finishedAt:v.receipts[0].finishedAt+1,status:'failed',exitCode:1}),
  missing:v=>v.receipts=[],noOutput:v=>delete v.receipts[0].logDigest,wrongIO:v=>Object.assign(v.receipts[0],{status:'output_error',exitCode:74,errorCode:'EIO'}),
  unauthorized:v=>v.enabled=[],attempt:v=>v.source.run_attempt=2,cancelled:v=>v.source.conclusion='cancelled',
  conflict:v=>v.blocked.contractConflicts=[{}],candidate:v=>v.blocked.target.candidate='f'.repeat(64),deadline:v=>v.receipts[0].deadlineAt++,
  ambiguous:v=>v.receipts.push({...v.receipts[0],id:'another'})}))
  test('verification continuation rejects '+name+' without inventing passing evidence',()=>{
    const f=verificationFixture();mutate(f.input);assert.throws(()=>verificationRescueContinuation(f.input));
  });
test('changed current exact-head CI resumes only the original reviewed Candidate; unchanged/foreign CI cannot',()=>{
  const f=rescueFixture(),old=contentIdentity([]),checks=[{id:'77',head:'b'.repeat(40),status:'pending'}];
  const v={target:f.target,blocked:{...f.blocked,resumeOn:'ci-change',head:'b'.repeat(40)},previous:old,current:checks,
    pr:{state:'open',merged:false,draft:false,head:'b'.repeat(40),candidate:f.target.candidate},enabled:['ci-change']};
  assert.equal(ciRescueContinuation(v).kind,'ci-change');assert.throws(()=>ciRescueContinuation({...v,current:[]}));
  assert.throws(()=>ciRescueContinuation({...v,pr:{...v.pr,head:'c'.repeat(40)}}));
});
test('continuation cannot replace missing source/session, change member, or reuse execution',async()=>{
  const f=rescueFixture();
  const target=f.target,load=async()=>({status:'UNACCEPTED',target,terminated:true,workspace:f.flags.workspace,session:target.session,memberId:'7'});
  for(const changed of [{session:'different'},{memberId:'8'},{execution:target.execution},{freshBudget:false},{access:'read-only'}]) {
    const next=createRescueContinuation({load,retain:async()=>({outcome:'retained'}),prepare:async()=>({execution:'new',session:target.session,memberId:'7',
      role:'deliver',freshBudget:true,status:'UNACCEPTED',workspace:f.flags.workspace,access:'writer',...changed})});
    await assert.rejects(next({target,caseId:'case',proof:{kind:'ai-repair'}}));
  }
});
test('private Codex session capture/restore binds member, original role, bytes and conversation; CLI resumes in a fresh execution',async t=>{
  const root=mkdtempSync(join(tmpdir(),'nibfin-session-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),dest=join(root,'dest');mkdirSync(source,{mode:0o700});mkdirSync(dest,{mode:0o700});
  const f=rescueFixture(),id=f.target.session;writeFileSync(join(source,'rollout-'+id+'.jsonl'),'{"private":"preserved conversation"}\n');
  const expected={memberId:'7',role:'deliver',session:id,execution:f.target.execution,adapter:'codex'};
  const snapshot=captureRescueSession({directory:source,...expected});
  assert.throws(()=>restoreRescueSession({snapshot,directory:dest,expected:{...expected,memberId:'8'}}));
  const restore=createRoleSessionRecovery({current:async()=>({status:'UNACCEPTED',target:f.target}),load:async()=>snapshot,
    restore:async()=>restoreRescueSession({snapshot,directory:dest,expected}),retain:async()=>({outcome:'retained'})});
  const restored=await restore({target:f.target,session:id,originalExecution:f.target.execution,caseId:'case'});
  assert.equal(restored.id,id);assert.equal(readFileSync(join(dest,'rollout-'+id+'.jsonl'),'utf8'),'{"private":"preserved conversation"}\n');
  const result={version:1,outcome:'ready',failureClass:'none',summary:'fresh verification required',conflicts:[]};
  const stream=[{type:'thread.started',thread_id:id},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}},{type:'turn.completed'}].map(v=>JSON.stringify(v)).join('\n')+'\n';
  let args;const observed=executeCodex({access:'write',timeout:1000,prompt:'retry',resume:{id,memberId:'7'},context:{memberId:'7',execution:{id:'fresh-execution'}}},[],(_file,a)=>{args=a;return {status:0,stdout:stream};},{sessionDirectory:dest});
  assert.ok(args.includes('resume'));assert.ok(args.includes(id));assert.equal(observed.session.id,id);assert.equal(observed.evidence.execution.id,'fresh-execution');
  assert.throws(()=>executeCodex({access:'write',timeout:1000,prompt:'retry',resume:{id,memberId:'8'},context:{memberId:'7'}},[],()=>assert.fail('foreign login executed'),{sessionDirectory:dest}));
});
test('an interrupted Codex CLI preserves only a unique observed conversation with actual private session bytes; it remains failed',t=>{
  const root=mkdtempSync(join(tmpdir(),'nibfin-interrupted-session-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const f=rescueFixture(),id=f.target.session;writeFileSync(join(root,'rollout-'+id+'.jsonl'),'preserved');
  const request={access:'write',timeout:1000,prompt:'original',sessionOutput:'/verification/role-session.json',context:{memberId:'7'}};
  const partial=JSON.stringify({type:'thread.started',thread_id:id})+'\n';
  const failed=executeCodex(request,[],()=>({status:null,error:Error('timeout'),stdout:partial}),{sessionDirectory:root});
  assert.equal(failed.evidence,undefined);assert.equal(failed.session.id,id);assert.equal(failed.diagnostic,'provider-failure');
  const absent=executeCodex(request,[],()=>({status:1,stdout:partial.replace(id,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')}),{sessionDirectory:root});
  assert.equal(absent.session,undefined);
});
test('Shape continuation preserves the existing read-only role boundary before a published Shape/Candidate exists',async()=>{
  const f=rescueFixture(),target={...f.target,role:'shape',shapeHash:null,candidate:null};
  let access='read-only';const next=createRescueContinuation({load:async()=>({status:'UNACCEPTED',target,terminated:true,workspace:f.flags.workspace,session:target.session,memberId:'7'}),
    retain:async()=>({outcome:'retained'}),prepare:async()=>({execution:'new-shape',session:target.session,memberId:'7',role:'shape',freshBudget:true,status:'UNACCEPTED',workspace:f.flags.workspace,access})});
  assert.equal((await next({target,caseId:'shape-case',proof:{kind:'ai-repair'}})).next.access,'read-only');
  access='writer';await assert.rejects(next({target,caseId:'shape-case',proof:{kind:'ai-repair'}}));
});
