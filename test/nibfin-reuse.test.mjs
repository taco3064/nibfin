import {repairFixture} from '../tooling/repair-fixture.mjs';
// Adapted fixed donor candidate-contract, role-session and GitHub observations.
// No upstream verdict, credentials or deployed configuration is inherited.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {candidateContract} from '../src/candidate-contract.mjs';
import {GithubObservation} from '../src/github.mjs';
import {sessionIdFromEvents,createRoleSession,hasSessionData} from '../src/role-session.mjs';
import {candidateCheckpoint} from '../src/runtime.mjs';
import {nextDeliveryStage} from '../src/delivery-planner.mjs';
import {createGithubProvider,captureWorkspace} from '../src/index.mjs';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const block=value=>'```nibfin-candidate\n'+JSON.stringify(value)+'\n```\n';
test('upstream candidate schema rejects omitted/extra inventory, unsupported events and unsafe paths',()=>{
  const valid={artifacts:[{path:'out/report.json',purpose:'AC1'}],hooks:[{path:'.githooks/pre-commit',event:'pre-commit'}]};
  assert.deepEqual(candidateContract(block(valid)),valid);
  for(const body of ['',block(valid)+block(valid),block({...valid,skipAccept:true}),block({...valid,hooks:[{path:'x',event:'post-commit'}]})])assert.throws(()=>candidateContract(body));
  for(const path of ['../token','/etc/passwd','C:/token','x/../y','x\\y','x/.git/config','x//y','x;id','x\ny'])
    assert.throws(()=>candidateContract(block({...valid,artifacts:[{path,purpose:'proof'}]})));
});
test('upstream read observation is bounded, cloned and invalidated by nested fresh reads and mutations',async()=>{
  let n=0;const observation=new GithubObservation(async()=>({data:{n:++n}}));
  const input={endpoint:'/repos/public/repo',target:'42',operation:'observe',correlation:'one'};
  await observation.readObservation(async()=>{
    const first=await observation.request(input);first.data.n=999;
    assert.equal((await observation.request(input)).data.n,1);
    await observation.freshReadObservation(async()=>assert.equal((await observation.request(input)).data.n,2));
    assert.equal((await observation.request(input)).data.n,3);
    await assert.rejects(observation.request({...input,method:'PATCH'}),/Writes are forbidden/);
    assert.equal((await observation.request(input)).data.n,4);
  });
  assert.equal((await observation.request(input)).data.n,5);
  await observation.readObservation(async()=>{
    await observation.request(input);await observation.request({...input,operation:'other'});
    const signal=AbortSignal.abort();await observation.request({...input,signal});
  });
  assert.equal(n,8);
});
test('provider observation cannot share authorization context or replay a write',async()=>{
  let writes=0,reads=0;
  const provider=createGithubProvider({identity:'hosted-authorized',authorize:()=>true,transport:async r=>{
    if(r.method==='GET'){reads++;return {status:200,body:'{"id":42}'};}
    writes++;return {failure:'transport'};
  }});
  const options={endpoint:'/repos/public/repo',target:'42',operation:'observe',correlation:'one'};
  await provider.readObservation(async()=>{
    await provider.request(options);await provider.request(options);assert.equal(reads,1);
    await provider.request({...options,context:{member:'a'}});await provider.request({...options,context:{member:'b'}});
    assert.equal(reads,3);
    await assert.rejects(provider.request({...options,method:'PATCH'}));assert.equal(writes,0);
  });
  assert.equal((await provider.request({...options,method:'PATCH'})).outcome,'unknown');assert.equal(writes,1);
});
test('cached observations never bypass current expected identity or payload validators',async()=>{
  let reads=0,validations=0,allow=true;
  const provider=createGithubProvider({identity:'hosted-authorized',transport:async()=>{
    reads++;return {status:200,body:'{"id":42}'};
  }});
  const options={endpoint:'/repos/public/repo',target:'42',operation:'observe',correlation:'validation'};
  const validate=data=>{validations++;return allow&&data.id==='42';};
  const malformed=result=>{assert.equal(result.outcome,'failed');assert.equal(result.diagnostic.kind,'malformed');};
  await provider.readObservation(async()=>{
    assert.equal((await provider.request({...options,expectedId:'42'})).outcome,'read');
    malformed(await provider.request({...options,expectedId:'99'}));
    // Populate the unconstrained cache too: neither kind of hit may override a
    // later caller's rejection, and a rejected request must not poison it.
    assert.equal((await provider.request(options)).outcome,'read');
    const cachedReads=reads;
    assert.equal((await provider.request(options)).outcome,'read');assert.equal(reads,cachedReads);
    malformed(await provider.request({...options,expectedId:'99'}));
    malformed(await provider.request({...options,validate:()=>{validations++;return false;}}));
    malformed(await provider.request(Object.assign(Object.create({expectedId:'99'}),options)));
    assert.equal(validations,1);
    assert.equal((await provider.request({...options,validate})).outcome,'read');
    allow=false;malformed(await provider.request({...options,validate}));assert.equal(validations,3);
    malformed(await provider.request({...options,validate:()=>{throw Error('reject');}}));
    assert.equal((await provider.request(options)).outcome,'read');
  });
});
test('upstream session identity rejects absent/ambiguous IDs; persisted data must exist uniquely without symlinks',()=>{
  assert.equal(sessionIdFromEvents(JSON.stringify({type:'thread.started',thread_id:A})),A);
  assert.throws(()=>sessionIdFromEvents('no session'));
  assert.throws(()=>sessionIdFromEvents([A,B].map(thread_id=>JSON.stringify({type:'thread.started',thread_id})).join('\n')));
  const root=mkdtempSync(join(tmpdir(),'nibfin-session-'));
  try{
    assert.equal(hasSessionData(root,A),false);writeFileSync(join(root,'rollout-'+A+'.jsonl'),'session');
    assert.equal(hasSessionData(root,A),true);mkdirSync(join(root,'other'));
    writeFileSync(join(root,'other','rollout-'+A+'.jsonl'),'session');assert.equal(hasSessionData(root,A),false);
    rmSync(join(root,'other'),{recursive:true});symlinkSync(root,join(root,'linked'));
    assert.equal(hasSessionData(root,A),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('bound continuity cannot switch role, member, candidate, provider or unresolved session; fresh review is separate',()=>{
  const request={access:'write',context:{execution:{id:'deliver',role:'deliver'},binding:{member:'a',candidate:'one'}}};
  let data=true;const s=createRoleSession(request,'codex','fixed',{persisted:()=>data});
  s.start();s.observe(A);s.end(true);s.start();s.observe(A);assert.throws(()=>s.observe(B));
  s.end(true);data=false;assert.throws(()=>s.start(),/missing/);data=true;
  for(const key of ['member','candidate']){
    const old=request.context.binding[key];request.context.binding[key]='foreign';assert.throws(()=>s.start(),/recovery/);request.context.binding[key]=old;
  }
  request.context.execution.role='accept';assert.throws(()=>s.start(),/recovery/);request.context.execution.role='deliver';
  s.start();s.end(false);assert.throws(()=>s.start(),/recovery/);
  const review=createRoleSession({access:'read',context:{execution:{id:'fresh-review',role:'shaper-review'}}},'claude','fixed');
  assert.equal(review.id,null);review.start();review.observe(B);assert.notEqual(review.id,s.id);
});
test('donor pre/post-hook capture refuses missing or changed Candidate and requests fresh delivery',async()=>{
  const candidate={tree:'one'},events=[];
  const good=await candidateCheckpoint({stage:'pre-accept-hooks',expected:candidate,capture:()=>{events.push('capture');return candidate;},
    execute:()=>{events.push('hook');return {ok:true,receipt:{status:'not-applicable'}};}});
  assert.equal(good.ok,true);assert.deepEqual(events,['capture','hook','capture']);
  let calls=0;
  const missing=await candidateCheckpoint({stage:'pre-commit-hooks',expected:candidate,capture:()=>{throw Error('missing artifact');},execute:()=>{calls++;}});
  assert.equal(calls,0);assert.equal(missing.repairRequired.stage,'deliver');
  for(const phase of ['pre-accept-hooks','pre-commit-hooks']){
    let changed=false;
    const result=await candidateCheckpoint({stage:phase,expected:candidate,capture:()=>changed?{tree:'changed'}:candidate,
      execute:()=>{changed=true;return {ok:true};}});
    assert.equal(result.outcome,'blocked');assert.equal(result.repairRequired.cause,'candidate-obligation');
  }
});
test('single per-Issue planner preserves every independent checkpoint and never promotes failed role evidence',()=>{
  const stages=['shape','shape-validator','publication','deliver','pre-accept-hooks','accept','pre-commit-hooks','pr','ci','shaper-review','merge','final','closure','delivered'];
  const receipts={};
  for(const stage of stages){assert.equal(nextDeliveryStage(receipts),stage);receipts[stage]={result:null};}
  assert.equal(nextDeliveryStage(receipts),'fanout');
  receipts.accept.result={outcome:'changes_required',failureClass:'implementation_defect'};
  assert.throws(()=>nextDeliveryStage(receipts),/accept/);
  assert.equal(nextDeliveryStage(receipts,'repair'),'repair');assert.throws(()=>nextDeliveryStage(receipts,'shell'));
});

test('real Hook Candidate mismatch follows the existing authorized repair owner and invalidates affected evidence',async()=>{
  const f=await repairFixture();
  try {
    const fault=await candidateCheckpoint({stage:'pre-commit-hooks',expected:f.pin.attempt.candidate,binding:f.pin.binding,
      capture:()=>captureWorkspace(f.f.captureInput).candidate,
      execute:()=>{writeFileSync(join(f.f.root,'binary'),Buffer.from([0,255,7,8,9]));return {ok:true};}});
    const observation=fault.repairRequired.observation;
    assert.equal(observation.failureClass,'implementation_defect');
    f.pin.source={kind:'candidate',observation};
    const result=await f.flow.run(observation);
    assert.equal(result.outcome,'handoff');assert.equal(result.disposition,'repair');
    assert(result.record.invalidation.invalidated.length>=2);
    assert.deepEqual(result.requiredGates.slice(0,4),['deliver','pre-accept-hooks','accept','pre-commit-hooks']);
    assert.equal((await f.flow.run(observation)).outcome,'blocked');
    const forged={...observation,candidate:{...observation.candidate,base:'f'.repeat(40)}};
    assert.equal((await f.fresh().run(forged)).outcome,'blocked');
  } finally {f.close();}
});

test('unavailable Candidate observation remains an external failure in the repair owner and cannot release a Writer',async()=>{
  const f=await repairFixture();
  try {
    const fault=await candidateCheckpoint({stage:'pre-accept-hooks',expected:f.pin.attempt.candidate,binding:f.pin.binding,
      capture:()=>{throw Error('unavailable');},execute:()=>assert.fail('must not start Hook')});
    const observation=fault.repairRequired.observation;assert.equal(observation.failureClass,'external_failure');
    f.pin.source={kind:'candidate',observation};const result=await f.flow.run(observation);
    assert.equal(result.outcome,'blocked');assert.equal(result.disposition,'wait');
  } finally {f.close();}
});
