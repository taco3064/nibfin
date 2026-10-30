// Kairo PR54 runCase/AI/result/dead-lock tests adapted to the existing Nibfin
// authorization, custody, completion and controlled-operation interfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rescueFixture} from '../tooling/rescue-fixture.mjs';
import {createRescueController,createRescueRecords,contentIdentity,validateAiRepairPlan,
  rescueConclusion,rescueReport,reportRescueOutcome,lockEvidence,recoverRescueLocks,
  rescueInstallation,validateRescueTarget} from '../src/index.mjs';
test('eligible AI plan preserves UNACCEPTED source/session and dispatches fresh original role through retained operations',async()=>{
  const f=rescueFixture(),id=await f.register(),original=f.flags.workspace;
  const r=await f.controller.run(id);assert.equal(r.outcome,'PENDING_VERIFICATION');assert.equal(r.conclusion,'neutral');
  assert.equal(f.flags.diagnoses,1);assert.equal(f.flags.repairs,1);assert.equal(f.flags.workspace,original);
  const input=f.retained.find(r=>r.status==='UNACCEPTED');assert.equal(input.session,f.target.session);
  assert.equal(f.flags.freshExecution,'fresh-execution');assert.notEqual(f.flags.freshExecution,f.target.execution);assert.ok(input.requiredGates.includes('accept'));
  assert.equal([...f.ops.values()][0].writes().length,1);
  assert.equal((await f.controller.report()).verifiedAutomaticResolutions,0);
});
test('deterministic remedies require a retained AI diagnosis and do not claim resolution',async()=>{
  const f=rescueFixture();f.flags.remedy={kind:'github-read',proof:{status:'healthy'},apply:async()=>({status:'healthy'})};
  const r=await f.controller.run(await f.register());assert.equal(r.outcome,'PENDING_VERIFICATION');assert.equal(f.flags.diagnoses,1);
});
for(const [name,mutate]of Object.entries({noPlan:f=>f.flags.diagnosisResult.body='',
  invalid:f=>f.flags.diagnosisResult.body='{"action":"run-shell","steps":["curl"]}',
  overbroad:f=>f.flags.diagnosisResult.body='{"action":"retry-original-role","steps":["a"],"command":"rm"}',
  noEvidence:f=>f.flags.diagnosisResult.evidenceReferences=[],conflict:f=>f.flags.diagnosisResult.contractConflicts=[{}],
  failed:f=>f.flags.diagnosisResult.outcome='blocked',mutation:f=>f.flags.diagnose=()=>{f.flags.workspace='f'.repeat(64);},
  wrongMember:f=>f.flags.adapter={capabilities:{rescueReadOnly:true},diagnose:async()=>({execution:'diagnostic',terminated:true,memberId:'8',adapter:'codex',result:f.flags.diagnosisResult})},
  unsupported:f=>f.flags.adapter={capabilities:{rescueReadOnly:false}}}))
  test('AI '+name+' stops with retained evidence and no repair dispatch',async()=>{
    const f=rescueFixture();mutate(f);const r=await f.controller.run(await f.register());
    assert.equal(r.outcome,'UNRESOLVED');assert.equal(f.flags.repairs,0);assert.equal(f.ops.size,0);
    assert.equal((await f.controller.report()).verifiedAutomaticResolutions,0);
  });
for(const [name,mutate]of Object.entries({permission:f=>f.flags.allowed=false,active:f=>f.flags.active=true,
  hold:f=>f.state().hold=true,pause:f=>f.state().paused=true,conflict:f=>f.state().conflict=true,
  write:f=>f.state().unknownWrite=true,scope:f=>f.state().target.scopeHash='f'.repeat(64),
  shape:f=>f.state().target.shapeHash='f'.repeat(64),candidate:f=>f.state().target.candidate='f'.repeat(64),
  session:f=>f.state().target.session='new',authority:f=>f.state().authority='f'.repeat(64)}))
  test('current '+name+' cannot start diagnosis, spend budget or borrow login',async()=>{
    const f=rescueFixture(),id=await f.register();mutate(f);const r=await f.controller.run(id);
    assert.ok(['UNRESOLVED','SUPERSEDED','DEFERRED'].includes(r.outcome));assert.equal(f.flags.diagnoses,0);
    assert.deepEqual(f.snapshot().budgets,{});assert.equal(f.ops.size,0);
  });
test('authority/current membership are checked again after retained AI diagnosis',async()=>{
  const f=rescueFixture(),id=await f.register();f.flags.diagnose=()=>{f.flags.allowed=false;};
  const r=await f.controller.run(id);assert.equal(r.outcome,'UNRESOLVED');assert.equal(f.flags.diagnoses,1);assert.equal(f.flags.repairs,0);
});
test('side effects and dispatch loss never reset the shared cycle repair budget',async()=>{
  const f=rescueFixture(),id=await f.register();f.flags.operation=o=>{o.state.failRead=true;o.state.lost=true;};
  assert.equal((await f.controller.run(id)).outcome,'UNRESOLVED');
  for(let n=0;n<3;n++)await f.controller.run(id);
  assert.equal(f.flags.diagnoses,1);assert.equal(Object.values(f.snapshot().budgets)[0].attempts,1);
});
test('linked cases share budget/cooldown; deferrals and duplicate notifications spend no repair attempts',async()=>{
  const f=rescueFixture(),first=await f.register();await f.controller.run(first);
  const make=async n=>{const t=structuredClone(f.target);t.execution='execution-'+n;const b={...f.blocked,execution:t.execution,target:t};
    f.setState({...f.state(),target:t});return f.controller.register({target:t,source:f.source,code:'FAILURE_'+n,blocked:b});};
  let id=await make(2);const before=f.flags.diagnoses;assert.equal((await f.controller.run(id)).outcome,'DEFERRED');assert.equal(f.flags.diagnoses,before);
  // New execution targets require independently current source ownership; no old
  // target can be silently treated as the latest original-role conversation.
  assert.equal(Object.values(f.snapshot().budgets)[0].attempts,1);
});
test('integrity-checked host records reject corrupted bytes, CAS failure and unknown persistence',async()=>{
  const f=rescueFixture();f.replace({...f.snapshot(),revision:99});await assert.rejects(f.records.read(),/record-integrity/);
  const g=rescueFixture();const records=createRescueRecords({...g.recordsConfig,commit:async()=>({outcome:'unknown'})});
  await assert.rejects(records.update(s=>{s.cases.x={};return s;}),/retention/);
});
test('duplicate case registration is idempotent, not an additional eligible block',async()=>{
  const f=rescueFixture();assert.equal(await f.register(),await f.register());assert.equal((await f.controller.report()).eligibleBlocks,1);
});
test('unaccepted target rejects cross-member sessions/Runner ownership before persistence',async()=>{
  const f=rescueFixture();for(const key of ['sessionMemberId','runnerMemberId']) {
    const t={...f.target,[key]:'8'};assert.throws(()=>validateRescueTarget(t));
  }
  assert.throws(()=>validateRescueTarget({...f.target,command:'untrusted'}));
});
test('active agent defers locally without Action allocation or changing locks',async()=>{
  const f=rescueFixture(),id=await f.register();f.flags.active=true;
  assert.equal((await f.controller.wake(id)).outcome,'DEFERRED');assert.equal(f.ops.size,0);assert.deepEqual(f.snapshot().budgets,{});
});
test('unchanged source/formal evidence creates no repeated Run and bounded rechecks become visible',async()=>{
  const f=rescueFixture(),id=await f.register();await f.controller.wake(id);const size=f.ops.size;
  for(let n=0;n<73;n++){f.tick(300001);await f.controller.wake(id);}
  assert.equal(f.ops.size,size);assert.equal(f.snapshot().cases[id].outcome,'UNRESOLVED');
});
test('dead-lock attribution rejects alive PID, wrong Run, cross-attempt and out-of-source time',()=>{
  const f=rescueFixture(),s={...f.sourceRun,jobs:f.jobs};
  const lock={pid:123,runId:'100',attempt:'1',startedAt:'2026-10-28T12:01:00Z'};
  assert.equal(lockEvidence(lock,s,()=>false),true);assert.equal(lockEvidence(lock,s,()=>true),false);
  for(const l of [{...lock,runId:'101'},{...lock,attempt:'2'},{...lock,startedAt:'2026-10-29'}])assert.equal(lockEvidence(l,s,()=>false),false);
});
test('lock removal rechecks exact inode/bytes and active work immediately before unlink',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nibfin-rescue-lock-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'execution.lock'),f=rescueFixture(),source={...f.sourceRun,jobs:f.jobs};
  const lock={pid:123,runId:'100',attempt:'1',startedAt:'2026-10-28T12:01:00Z'};await writeFile(path,JSON.stringify(lock));
  await assert.rejects(recoverRescueLocks({paths:[path],source,active:async()=>false,alive:()=>false,
    beforeRemove:async()=>writeFile(path,JSON.stringify({...lock,pid:456})),removed:async()=>{}}),/lock-changed/);
  assert.equal(JSON.parse(await readFile(path)).pid,456);
  await writeFile(path,JSON.stringify(lock));let removed=0;
  await recoverRescueLocks({paths:[path],source,active:async()=>false,alive:()=>false,beforeRemove:async()=>{},removed:async()=>removed++});
  assert.equal(removed,1);await assert.rejects(access(path));
});
test('every result has truthful semantics; missing/unknown cannot be green',()=>{
  assert.equal(rescueConclusion('RESOLVED'),'success');assert.equal(rescueConclusion('UNRESOLVED'),'failure');
  for(const outcome of ['STAGE_RECOVERED','DEFERRED','PENDING_VERIFICATION','SUPERSEDED','NOT_NEEDED'])assert.equal(rescueConclusion(outcome),'neutral');
  assert.equal(rescueConclusion(undefined),'failure');assert.equal(rescueConclusion('unexpected'),'failure');
});
test('reporting never cancels source/continuation; unsupported, wrong Run and failed readback are visible',async()=>{
  const calls=[],report=async x=>{calls.push(x);return {confirmed:true};};
  assert.equal((await reportRescueOutcome({outcome:'DEFERRED',reportingRun:'200',report})).outcome,'unsupported');
  assert.equal(calls.length,0);
  const capability={runId:'200',scope:'reporting-run',neutralCheck:true};
  for(const outcome of ['STAGE_RECOVERED','DEFERRED','PENDING_VERIFICATION','SUPERSEDED','NOT_NEEDED'])
    assert.equal((await reportRescueOutcome({outcome,reportingRun:'200',capability,report})).outcome,'unsupported');
  assert.equal(calls.length,0); // A separate neutral Check cannot gray the Run.
  assert.equal((await reportRescueOutcome({outcome:'RESOLVED',reportingRun:'200',capability,report})).conclusion,'success');
  assert.deepEqual(calls[0],{runId:'200',conclusion:'success',outcome:'RESOLVED'});
  assert.equal((await reportRescueOutcome({outcome:'RESOLVED',reportingRun:'201',capability,report})).outcome,'failed');
  assert.equal((await reportRescueOutcome({outcome:'RESOLVED',reportingRun:'200',capability,report:async()=>({confirmed:false})})).outcome,'failed');
});
test('case report deduplicates by durable identity; zero denominators and human/external resolution are separate',()=>{
  const f=rescueFixture();assert.equal(rescueReport(f.snapshot()).triggerCoverage.rate,null);
  const c={id:'one',source:f.source,eligible:true,triggered:true,outcome:'RESOLVED',resolution:'external',repairAttempt:{},diagnosis:{attempted:true,status:'completed'}};
  const s={cases:{one:c,two:{...c,id:'two',resolution:'automatic'},three:{...c,id:'three',outcome:'UNRESOLVED',code:'BUDGET_EXHAUSTED',repairAttempt:null}}};
  const report=rescueReport(s);assert.deepEqual(report.verifiedRepairSuccess,{numerator:1,denominator:2,rate:0.5});
  assert.deepEqual(report.triggerCoverage,{numerator:3,denominator:3,rate:1});assert.equal(report.cases[2].reason,'BUDGET_EXHAUSTED');
});
test('installation requires actual authority, one existing host and protected secret; URL updates preserve identity',()=>{
  const f=rescueFixture(),options={policy:f.policy,permission:{repositoryId:'42',administration:'write',workflows:'write',ownerAuthorized:true},
    relay:{existing:true,single:true,perRunner:false,controller:'nibfin',sharedModelLogin:false,sharedOwnerCredentials:false},
    hook:{id:'55',url:'https://relay.example/webhook',repositoryId:'42',events:['workflow_run']},
    secret:{protected:true,minimumBytes:32,outsideAgent:true,public:false,identity:'secret-v1'},
    notifier:{durable:true,owner:'existing-host',cron:false},backfill:{from:0,to:1000,maxRuns:10}};
  assert.equal(rescueInstallation(options).hook.operation,'create');
  assert.equal(rescueInstallation({...options,previous:{...options.hook,url:'https://old.example/webhook',secretIdentity:'secret-v1'}}).hook.id,'55');
  for(const patch of [{permission:{...options.permission,administration:'read'}},{relay:{...options.relay,perRunner:true}},
    {relay:{...options.relay,sharedModelLogin:true}},{secret:{...options.secret,public:true}},
    {backfill:{from:0,to:86400001,maxRuns:10}},{previous:{...options.hook,id:'56',secretIdentity:'secret-v1'}}])
    assert.throws(()=>rescueInstallation({...options,...patch}));
});
test('active-Agent race after reservation refunds only the unspent reservation and allocates no Action',async()=>{
  const f=rescueFixture();let reads=0;f.options.active=async()=>++reads>=3;
  const controller=createRescueController(f.options),id=await f.register();
  const r=await controller.run(id);assert.equal(r.outcome,'DEFERRED');assert.equal(f.flags.diagnoses,0);
  assert.equal(f.ops.size,0);assert.deepEqual(f.snapshot().budgets,{});
});
test('pending exact-head CI retains one AI diagnosis without spending a repair budget or repeating it',async()=>{
  const f=rescueFixture();f.flags.remedy={kind:'ci-wait'};
  const id=await f.register(),r=await f.controller.run(id);assert.equal(r.outcome,'DEFERRED');assert.deepEqual(f.snapshot().budgets,{});assert.equal(f.flags.diagnoses,1);assert.equal(f.ops.size,0);
  await f.controller.run(id);assert.equal(f.flags.diagnoses,1);
});

test('diagnose mode actually invokes AI and retains its reason without dispatching a repair',async()=>{
 const f=rescueFixture(),id=await f.register();const r=await f.controller.run(id,{diagnoseOnly:true});
 assert.equal(r.diagnosis.record.result.result.rootCause,'Invocation failure');assert.equal(f.flags.diagnoses,1);
 assert.equal(f.flags.repairs,0);assert.equal(f.ops.size,0);assert.deepEqual(f.snapshot().budgets,{});
});

test('failed diagnosis prevents even a known deterministic remedy from claiming success',async()=>{
 const f=rescueFixture();let applied=false;f.flags.remedy={kind:'github-read',proof:{status:'healthy'},apply:async()=>{applied=true;return{status:'healthy'};}};
 f.flags.diagnosisResult.outcome='blocked';const r=await f.controller.run(await f.register());
 assert.equal(r.outcome,'UNRESOLVED');assert.equal(applied,false);assert.equal(f.flags.repairs,0);
});
test('invalid AI proposals count as diagnoses, never actual repair attempts or verified success',async()=>{
  const f=rescueFixture();f.flags.diagnosisResult.body='invalid';await f.controller.run(await f.register());
  const report=await f.controller.report();assert.equal(report.aiDiagnoses,1);assert.equal(report.repairAttempts,0);assert.equal(report.verifiedRepairSuccess.rate,null);
});
