// Adapted PR57 tests: normal zero allocation, exact signatures, green BLOCKED,
// duplicate/restart, unknown POST and bounded read retry use public Nibfin owners.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createRescueCompletionReceiver,startRescueWakeups,createRescueProvenance,createRescueController} from '../src/index.mjs';
import {rescueFixture} from '../tooling/rescue-fixture.mjs';
test('normal successful source completion allocates no inbox, provider read, dispatch or Runner',async()=>{
  const f=rescueFixture();f.sourceRun.conclusion='success';
  assert.equal((await f.receiver.receive(...f.signed())).reason,'NORMAL_COMPLETION');
  assert.deepEqual(f.snapshot().inbox,{});assert.equal(f.reads.length,0);assert.equal(f.ops.size,0);
});
test('signature is checked before JSON; exact bytes, malformed signatures and ping',async()=>{
  const f=rescueFixture(),[bytes,h]=f.signed();
  await assert.rejects(f.receiver.receive(Buffer.from('{'),h),/signature/);
  await assert.rejects(f.receiver.receive(Buffer.concat([bytes,Buffer.from(' ')]),h),/signature/);
  await assert.rejects(f.receiver.receive(bytes,{...h,'x-hub-signature-256':'sha256=00'}),/signature/);
  const ping=Buffer.from('{}'),headers={'x-github-event':'ping','x-hub-signature-256':'sha256='+createHmac('sha256',f.secret).update(ping).digest('hex')};
  assert.equal((await f.receiver.receive(ping,headers)).reason,'PING');assert.deepEqual(f.snapshot().inbox,{});
});
for(const [name,change]of Object.entries({repository:e=>e.repository.id='43',private:e=>e.repository.private=true,
  workflow:e=>e.workflow_run.path='.github/workflows/nibfin-rescue.yml',actor:e=>e.workflow_run.actor.id='8',
  attempt:e=>e.workflow_run.run_attempt=0,sha:e=>e.workflow_run.head_sha='bad',event:e=>e.workflow_run.event='pull_request'}))
  test('completion rejects '+name+' mismatch before allocation',async()=>{
    const f=rescueFixture(),e=f.event();change(e);assert.equal((await f.receiver.receive(...f.signed(e))).status,'IGNORED');assert.deepEqual(f.snapshot().inbox,{});
  });
test('green durable BLOCKED case wakes; duplicate and restart retain a single dispatch identity',async()=>{
  const f=rescueFixture();await f.register();f.sourceRun.conclusion='success';
  const first=await f.receiver.receive(...f.signed()),second=await f.receiver.receive(...f.signed());assert.equal(first.id,second.id);
  assert.equal(Object.keys(f.snapshot().inbox).length,1);
  assert.equal((await f.receiver.process())[0].status,'processed');assert.equal(f.ops.size,1);
  const receiver=createRescueCompletionReceiver({policy:f.policy,secret:f.secret,records:f.records,provenance:f.provenance,controller:f.controller,
    attribute:async()=>{throw Error('must not recreate');},now:f.now});
  await receiver.receive(...f.signed());assert.deepEqual(await receiver.process(),[]);assert.equal(f.ops.size,1);
});
test('provider failure before case persistence is attributed to retained original execution',async()=>{
  const f=rescueFixture();await f.receiver.receive(...f.signed());await f.receiver.process();
  assert.equal(Object.keys(f.snapshot().cases).length,1);assert.equal(f.ops.size,1);assert.equal(f.flags.repairs,0);
});
test('manual cancellation remains stopped; exact provider timeout may wake',async()=>{
  const f=rescueFixture();f.sourceRun.conclusion='cancelled';f.jobs[0].conclusion='cancelled';
  await f.receiver.receive(...f.signed());assert.equal((await f.receiver.process())[0].status,'ignored');assert.equal(f.ops.size,0);
  const g=rescueFixture();g.sourceRun.conclusion='cancelled';g.jobs[0].conclusion='cancelled';
  g.flags.annotations=[{annotation_level:'failure',message:'The job has exceeded the maximum execution time of 3h0m0s'}];
  await g.receiver.receive(...g.signed());assert.equal((await g.receiver.process())[0].status,'processed');assert.equal(g.ops.size,1);
});
test('unknown POST does not retry after restart or a lost completion notification',async()=>{
  const f=rescueFixture();await f.register();f.flags.operation=o=>{o.state.lost=true;o.state.failRead=true;};
  await f.receiver.receive(...f.signed());await f.receiver.process();
  const [c]=Object.values(f.snapshot().cases);assert.equal(c.outcome,'UNRESOLVED');
  const writes=[...f.ops.values()].reduce((n,o)=>n+o.writes().length,0);assert.equal(writes,1);
  f.tick(86400000);await f.controller.wake(c.id);assert.equal([...f.ops.values()].reduce((n,o)=>n+o.writes().length,0),1);
});
test('local read failures are bounded without resetting repair budgets',async()=>{
  const f=rescueFixture();await f.receiver.receive(...f.signed());f.flags.readFailure=true;
  for(let n=0;n<8;n++){await f.receiver.process();f.tick(1000000);}
  const [n]=Object.values(f.snapshot().inbox);assert.equal(n.status,'unresolved');assert.equal(n.checks,8);assert.deepEqual(f.snapshot().budgets,{});assert.equal(f.ops.size,0);
});
test('notifier reconstructs deadlines on restart and has no idle polling timer',async()=>{
  const f=rescueFixture();let timers=0;const options={records:f.records,controller:f.controller,receiver:f.receiver,now:f.now,
    setTimer:()=>{timers++;return timers;},clearTimer:()=>{},onError:async()=>assert.fail('notifier error')};
  const idle=await startRescueWakeups(options);assert.equal(timers,0);idle.close();
  const id=await f.register();const running=await startRescueWakeups(options);assert.equal(f.ops.size,1);assert.ok(timers>=1);running.close();
  const count=f.ops.size;f.tick(300001);const restarted=await startRescueWakeups(options);assert.equal(f.ops.size,count);restarted.close();
  assert.ok(f.snapshot().cases[id].checks>=1);
});
for(const [name,mutate]of Object.entries({actor:d=>{if(d.actor)d.actor.id='8';},attempt:d=>{if(d.run_attempt)d.run_attempt=2;},
  workflow:d=>{if(d.path)d.path='.github/workflows/evil.yml';},repository:d=>{if(d.repository)d.repository.private=true;},pin:d=>{if(d.sha)d.sha='f'.repeat(40);}}))
  test('independent provider provenance rejects forged '+name,async()=>{
    const f=rescueFixture();f.flags.mutateRead=mutateWrapper(mutate);await assert.rejects(f.provenance.verify('100','1'));
  });
function mutateWrapper(fn){return data=>{fn(data);return data;};}
test('historical queued source needs exact approved original head AND bytes; current main stays pinned',async()=>{
  const f=rescueFixture(),old='d'.repeat(40);f.flags.mutateRead=(d,r)=>r.endpoint.includes('ref='+f.source.head)?{sha:old}:d;
  await assert.rejects(f.provenance.verify('100','1'));
  f.policy.historical=[{kind:'stage',head:f.source.head,blob:old}];
  const provenance=createRescueProvenance({policy:f.policy,provider:f.provider});assert.equal((await provenance.verify('100','1')).id,'100');
  f.flags.mutateRead=(d,r)=>r.endpoint.includes('ref=main')?{sha:old}:r.endpoint.includes('/contents/')?{sha:old}:d;
  await assert.rejects(provenance.verify('100','1'));
});
test('authenticated source reread rejects a validly shaped but mismatched completion SHA',async()=>{
  const f=rescueFixture(),e=f.event();e.workflow_run.head_sha='d'.repeat(40);
  await f.receiver.receive(...f.signed(e));assert.equal((await f.receiver.process())[0].status,'unresolved');assert.equal(f.ops.size,0);
});
test('bounded upgrade backfill uses actual provider provenance; normal successes still allocate nothing',async()=>{
  const f=rescueFixture(),from=Date.parse(f.sourceRun.created_at),window={from,to:from+3600000,maxRuns:10};
  const original=f.provider.collection;f.provider.collection=async r=>r.envelope==='workflow_runs'?{outcome:'complete',data:[f.sourceRun]}:original(r);
  f.sourceRun.conclusion='success';const r=await f.receiver.backfill(window);assert.equal(r.results[0].reason,'NORMAL_COMPLETION');assert.deepEqual(f.snapshot().inbox,{});
  f.sourceRun.conclusion='failure';await f.receiver.backfill(window);await f.receiver.backfill(window);assert.equal(Object.keys(f.snapshot().inbox).length,1);
  await assert.rejects(f.receiver.backfill({...window,to:from+86400001}));
  f.provider.collection=async r=>r.envelope==='workflow_runs'?{outcome:'complete',data:Array.from({length:11},()=>f.sourceRun)}:original(r);
  await assert.rejects(f.receiver.backfill(window));
});

for(const conclusion of ['failure','success'])test('restart recovers a lost continuation '+conclusion+' notification after Candidate progress, without a second repair',async()=>{
  const f=rescueFixture(),id=await f.register();await f.controller.wake(id);
  await f.controller.run(id);const repairs=f.flags.repairs,attempts=Object.values(f.snapshot().budgets)[0].attempts;
  f.state().target.candidate='e'.repeat(64);f.state().target.execution='fresh-execution';
  f.flags.mutateRead=(data,r)=>r.endpoint.includes('/runs/70/attempts/')?{...data,id:'70',conclusion}:data;
  f.tick(300001);
  const restarted=createRescueController(f.options),before=f.ops.size;
  const notifier=await startRescueWakeups({records:f.records,controller:restarted,receiver:f.receiver,now:f.now,
    setTimer:()=>1,clearTimer:()=>{},onError:async()=>assert.fail('restart failed')});notifier.close();
  assert.ok(f.reads.some(r=>r.endpoint.includes('/runs/70/attempts/1')));
  assert.equal(f.ops.size,before+1);
  const verification=[...f.ops.values()].at(-1).input.payload.inputs;
  assert.equal(verification.mode,'verify');assert.equal(verification.request_id,id);
  assert.equal(verification.source_run_id,'100');assert.equal(verification.source_attempt,'1');
  assert.equal(f.flags.repairs,repairs);assert.equal(Object.values(f.snapshot().budgets)[0].attempts,attempts);
  f.tick(300001);assert.equal((await restarted.wake(id)).outcome,'UNCHANGED');assert.equal(f.ops.size,before+1);
  // A green continuation without its stage/completion proof is still unresolved.
  assert.equal((await restarted.verify(id)).outcome,'UNRESOLVED');
  assert.equal((await restarted.report()).verifiedAutomaticResolutions,0);
});
test('active continuation defers locally; its later completion changes the notification fingerprint',async()=>{
  const f=rescueFixture(),id=await f.register();await f.controller.run(id);let status='in_progress';
  f.flags.mutateRead=(data,r)=>r.endpoint.includes('/runs/70/attempts/')?{...data,id:'70',status,conclusion:status==='completed'?'failure':null}:data;
  f.tick(300001);const before=f.ops.size;
  assert.equal((await f.controller.wake(id)).outcome,'DEFERRED');assert.equal(f.ops.size,before);
  status='completed';f.tick(300001);assert.equal((await f.controller.wake(id)).outcome,'confirmed-success');assert.equal(f.ops.size,before+1);
});
for(const changed of ['requirements','authority','memberId'])test('continuation notification cannot relax changed '+changed,async()=>{
  const f=rescueFixture(),id=await f.register();await f.controller.run(id);
  f.state().target[changed]=changed==='memberId'?'8':'f'.repeat(64);f.tick(300001);const before=f.ops.size;
  assert.equal((await f.controller.wake(id)).outcome,'UNRESOLVED');assert.equal(f.ops.size,before);
});

test('Rescue provenance, workflow pins, timeout annotations and bounded backfill compose through the maintained hosted provider',async()=>{
  const {createGithubProvider,hostedGithubTransport}=await import('../src/index.mjs');
  const f=rescueFixture(),calls=[],credentials={token:'test-token',expiresAt:Date.now()+60000,repositoryIds:['42'],permissions:{contents:'read',actions:'read',checks:'read'}};
  let pin=f.policy.stageBlob;
  const transport=hostedGithubTransport({repository:f.policy.repository,repositoryId:'42',getCredential:()=>credentials,
    fetcher:async(url,args)=>{
      calls.push({url,method:args.method});const u=new URL(url),path=u.pathname;let data;
      if(path.endsWith('/jobs'))data={jobs:f.jobs};
      else if(path.endsWith('/annotations'))data=[{annotation_level:'failure',message:'The job has exceeded the maximum execution time of 3h0m0s'}];
      else if(path.includes('/attempts/'))data=f.sourceRun;
      else if(path.includes('/contents/'))data={sha:pin,type:'file',path:f.policy.stageWorkflow,encoding:'base64',content:Buffer.from('workflow').toString('base64')};
      else if(path.includes('/commits/'))data={sha:f.source.head};
      else if(path.endsWith('/runs'))data={workflow_runs:[f.sourceRun]};
      else data={id:'50',state:'active',path:f.policy.stageWorkflow};
      const response=new Response(JSON.stringify(data),{status:200});Object.defineProperty(response,'url',{value:url});return response;
    }});
  const provider=createGithubProvider({identity:'hosted-authorized',transport,attempts:1});
  const provenance=createRescueProvenance({policy:f.policy,provider});
  const source=await provenance.verify('100','1');assert.equal(source.id,'100');assert.equal(source.jobs.length,1);
  assert.equal((await provenance.workflow('continuation')).id,'50');
  assert.equal((await provenance.timeout({...source,conclusion:'cancelled',jobs:source.jobs.map(j=>({...j,conclusion:'cancelled'}))})).kind,'provider-job-timeout');
  const from=Date.parse(f.sourceRun.created_at),window={from,to:from+3600000,maxRuns:10};
  assert.equal((await provenance.backfill(window)).length,1);
  assert.ok(calls.some(c=>c.url.includes('created=')));assert.ok(calls.every(c=>c.method==='GET'));
  pin='f'.repeat(40);await assert.rejects(provenance.verify('100','1'),/workflow-pin/);pin=f.policy.stageBlob;
  credentials.permissions.contents='none';await assert.rejects(provenance.verify('100','1'),/read/);credentials.permissions.contents='read';
  const count=calls.length,root='/repos/'+f.policy.repository;
  const query='?event=workflow_dispatch&status=completed&created='+encodeURIComponent(new Date(from).toISOString()+'..'+new Date(from+3600000).toISOString())+'&per_page=100';
  for(const endpoint of [root+'/contents/'+f.policy.stageWorkflow+'?ref=untrusted',root+'/contents/'+f.policy.stageWorkflow+'?ref=main&ref=main',
    root+'/actions/workflows/nibfin-stage.yml/runs'+query+'&token=secret',root+'/actions/workflows/nibfin-stage.yml/runs'+query+'&page=3',
    root+'/actions/workflows/nibfin-stage.yml/runs'+query.replace('workflow_dispatch','pull_request'),
    root+'/actions/workflows/nibfin-stage.yml/runs'+query.replace(encodeURIComponent(new Date(from+3600000).toISOString()),encodeURIComponent(new Date(from+86400001).toISOString())),
    '/repos/foreign/core/contents/'+f.policy.stageWorkflow+'?ref=main']) {
    assert.notEqual((await provider.request({endpoint,target:'42',operation:'rescue-read',correlation:'negative'})).outcome,'read');
    assert.equal((await transport({method:'GET',endpoint})).status,403);
  }
  assert.equal(calls.length,count);
});

test('subscription during the final deadline read coalesces a refresh and cannot strand a newly retained case',async()=>{
  const f=rescueFixture();let reads=0,timers=0,injected=false,scheduled;
  const deadline=new Promise(done=>{scheduled=done;});
  const records={...f.records,read:async()=>{
    const snapshot=await f.records.read();
    if(++reads===2){injected=true;await f.register();} // commit after the final snapshot
    return snapshot;
  }};
  const notifier=await startRescueWakeups({records,controller:f.controller,receiver:{process:async()=>{}},now:f.now,
    setTimer:()=>{timers++;scheduled();return timers;},clearTimer:()=>{},onError:async()=>assert.fail('notifier failed')});
  try {
    let timeout;try{await Promise.race([deadline,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('case stranded')),2000);})]);}finally{clearTimeout(timeout);}
    assert.equal(injected,true);assert.equal(Object.keys(f.snapshot().cases).length,1);
    assert.equal(f.ops.size,1);assert.ok(timers>0);assert.deepEqual(f.snapshot().budgets,{});
  } finally {notifier.close();}
});
