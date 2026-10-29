import test from 'node:test';
import assert from 'node:assert/strict';
import { continueCohort } from '../src/continuation.mjs';
test('external evidence continues without another owner click and every pass reenters runtime gates',async()=>{
  let calls=0,waits=0;
  const result=await continueCohort({resume:async()=>++calls===3?{status:'COMPLETE'}:{status:'BLOCKED',code:'CI_PENDING_OR_FAILED'}},{delay:async()=>{waits++;}});
  assert.equal(result.status,'COMPLETE');assert.equal(calls,3);assert.equal(waits,2);
});
test('authority and product stops never poll or retry, and external waits are bounded',async()=>{
  for(const code of ['OWNER_DECISION_REQUIRED','REPAIR_BUDGET_EXHAUSTED','EXPIRED_OR_REVOKED','SCOPE_REVIEW_REQUIRED']) {
    let calls=0;
    const r=await continueCohort({resume:async()=>{calls++;return {status:'BLOCKED',code};}},{delay:async()=>assert.fail('must stop')});
    assert.equal(r.code,code);assert.equal(calls,1);
  }
  let calls=0;
  const r=await continueCohort({resume:async()=>{calls++;return {status:'BLOCKED',code:'FINAL_PROOF_MISSING'};}},{maxPasses:2,delay:async()=>{}});
  assert.equal(calls,2);assert.equal(r.continuation,'bounded-wait-exhausted');
});

test('job indexing and exhausted transient reads wait and reenter authorization; writes never retry here', async () => {
  for (const error of [Object.assign(new Error('job not yet assigned'),{code:'ACTIONS_JOB_PENDING'}),Object.assign(new Error('unavailable'),{status:502,requestMethod:'GET'})]) {
    let calls=0;
    const progress=[];
    const result=await continueCohort({resume:async()=>{if(++calls===1)throw error;return {status:'COMPLETE'};}},{delay:async()=>{},onProgress:e=>progress.push(e)});
    assert.equal(result.status,'COMPLETE');assert.equal(calls,2);assert.equal(progress[0].status,'BLOCKED');
  }
  for(const error of [Object.assign(new Error('ambiguous write'),{status:502,requestMethod:'PUT'}),Object.assign(new Error('denied'),{status:403,requestMethod:'GET'}),new Error('signature changed')]) {
    let calls=0;
    await assert.rejects(continueCohort({resume:async()=>{calls++;throw error;}},{delay:async()=>assert.fail('must not wait')}),e=>e===error);
    assert.equal(calls,1);
  }
});

test('authority revoked while waiting stops immediately and pending jobs cannot wait forever', async () => {
  let calls=0;
  const runtime={resume:async()=>{if(++calls===1)throw Object.assign(new Error('job pending'),{code:'ACTIONS_JOB_PENDING'});return {status:'BLOCKED',code:'EXPIRED_OR_REVOKED'};}};
  assert.equal((await continueCohort(runtime,{delay:async()=>{}})).code,'EXPIRED_OR_REVOKED');
  assert.equal(calls,2);
  const pending={resume:async()=>{throw Object.assign(new Error('job pending'),{code:'ACTIONS_JOB_PENDING'});}};
  assert.equal((await continueCohort(pending,{maxPasses:2,delay:async()=>{}})).continuation,'bounded-wait-exhausted');
});
