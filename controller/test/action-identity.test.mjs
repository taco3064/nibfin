import test from 'node:test';
import assert from 'node:assert/strict';
import { currentActionJob, waitForActionIdentity } from '../src/action-identity.mjs';
import { GitHub } from '../src/github.mjs';
import { Runtime } from '../src/runtime.mjs';

const execution = { repository: 'owner/core', jobName: 'execute', runnerIds: [2] };
const env = { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'worker' };
const valid = { id: 9, name: 'execute', status: 'in_progress', runner_name: 'worker', runner_id: 2 };
test('missing and queued job readback recovers without replaying a stage; diagnostic fields are allowlisted', async () => {
  let calls = 0, clock = 0; const records = [];
  const gh = new GitHub('credential-must-not-appear', async () => new Response(JSON.stringify({ jobs: [[], [{ name: 'execute', status: 'queued' }], [{ ...valid, secret: 'secret-must-not-appear' }]][calls++] }), { headers: { 'x-github-request-id': 'trace-123' } }));
  const value = await waitForActionIdentity(() => gh.freshReadObservation(() => currentActionJob(gh, execution, env, {log:r=>records.push(r)})), {delay:async n=>{clock+=n;},now:()=>clock,log:r=>records.push(r)});
  assert.equal(value.id,9); assert.equal(calls,3);
  assert.deepEqual(records.filter(r=>r.kind==='action-identity-read').map(r=>r.matchingCount),[0,0,1]);
  assert.equal(records.find(r=>r.responses)?.responses[0].requestId,'trace-123');
  assert.doesNotMatch(JSON.stringify(records),/credential-must-not-appear|secret-must-not-appear/);
});
test('wrong runner, ambiguous job and completed job fail immediately without retry', async () => {
  for (const jobs of [[{...valid,runner_name:'intruder'}],[{...valid,runner_id:3}],[valid,valid],[{...valid,status:'completed'}]]) {
    let reads=0, waits=0;
    await assert.rejects(waitForActionIdentity(()=>currentActionJob({list:async()=>{reads++;return jobs;}},execution,env,{log:()=>{}}),{delay:async()=>{waits++;},log:()=>{}}),{code:'ACTION_PROVENANCE_INVALID'});
    assert.equal(reads,1);assert.equal(waits,0);
  }
});
test('identity readback timeout is bounded and explicitly diagnosed', async () => {
  let reads=0,clock=0;const records=[];
  await assert.rejects(waitForActionIdentity(async()=>{reads++;throw Object.assign(Error('pending'),{code:'ACTIONS_JOB_PENDING'});},{attempts:3,intervalMs:2000,delay:async n=>{clock+=n;},now:()=>clock,log:r=>records.push(r)}),{code:'ACTIONS_JOB_READBACK_TIMEOUT'});
  assert.equal(reads,3);assert.equal(clock,4000);assert.equal(records.at(-1).exhausted,true);
});
test('minute-scale provider readback delay recovers within the bounded default window',async()=>{
  let clock=0,reads=0;const records=[];
  const result=await waitForActionIdentity(async()=>{reads++;if(clock<125000)throw Object.assign(Error('queued'),{code:'ACTIONS_JOB_PENDING'});return 'verified';},{now:()=>clock,delay:async ms=>{clock+=ms;},log:r=>records.push(r)});
  assert.equal(result,'verified');assert.equal(reads,26);assert.equal(records.at(-1).elapsedMs,125000);
});
test('permission and provenance errors never get identity retries', async()=>{
  for(const code of ['ACTION_PROVENANCE_INVALID','GITHUB_RATE_LIMIT','OTHER'])await assert.rejects(waitForActionIdentity(async()=>{throw Object.assign(Error('denied'),{code});},{delay:async()=>assert.fail('unexpected retry')}),{code});
});
test('fresh admission rereads authority even inside an existing observation and preserves write prohibition',async()=>{
  let calls=0;
  const gh=new GitHub('test',async()=>new Response(JSON.stringify({revision:++calls}),{headers:{etag:'old'}}));
  await gh.readObservation(async()=>{
    assert.equal((await gh.api('/authority')).revision,1);
    await gh.freshReadObservation(async()=>{
      assert.equal((await gh.api('/authority')).revision,2);
    });
    assert.equal((await gh.api('/authority')).revision,3);
    await gh.freshReadObservation(async()=>{
      await assert.rejects(gh.api('/write','POST',{}),/Writes are forbidden/);
    });
  });
});
test('Runtime rechecks authority on retry and stops if it has been revoked',async()=>{
  let reads=0,fresh=0;
  const runtime=new Runtime({actionExecution:execution},'.',{freshReadObservation:async f=>{fresh++;return f();}},{});
  runtime.readGrant=async()=>{reads++;if(reads===1)throw Object.assign(Error('pending'),{code:'ACTIONS_JOB_PENDING'});throw Error('Grant revoked');};
  await assert.rejects(runtime.grant(),/Grant revoked/);assert.equal(reads,2);assert.equal(fresh,1);
});
