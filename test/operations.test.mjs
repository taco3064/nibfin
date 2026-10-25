import test from 'node:test';
import assert from 'node:assert/strict';
import {controlledIntent, createControlledOperations, contentIdentity} from '../src/index.mjs';
import {operationsFixture, operationInput} from '../tooling/operations-fixture.mjs';

for (const kind of ['dispatch', 'pr', 'merge', 'close', 'label']) {
  test(`${kind}: durable intent precedes mutation; independent effect and recovery`, async () => {
    const f = operationsFixture(operationInput(kind));
    const requests = {
      dispatch: ['POST', '/repos/example-org/core/actions/workflows/50/dispatches', {ref:'b'.repeat(40),inputs:{nibfin_correlation:'request-1'}}],
      pr: ['POST', '/repos/example-org/core/pulls', {title:'Candidate',body:'Candidate\n<!-- nibfin-operation:request-1 -->',head:'nibfin/101',base:'main'}],
      merge: ['PUT', '/repos/example-org/core/pulls/102/merge', {sha:'b'.repeat(40),merge_method:'rebase'}],
      close: ['PATCH', '/repos/example-org/core/issues/101', {state:'closed',state_reason:'completed'}],
      label: ['POST', '/repos/example-org/core/issues/101/labels', {labels:['delivered']}]
    };
    f.state.beforeWrite = r => {
      assert.ok(f.records.size >= 2);
      assert.ok(f.calls.some(c => c.endpoint?.includes('/artifacts/900/zip')) === false); // binary reads use custody's archive capability
      assert.ok(f.calls.some(c => c.endpoint === '/repos/example-org/core/actions/artifacts/900'));
      assert.equal(r.method, requests[kind][0]); assert.equal(r.endpoint, requests[kind][1]);
      assert.deepEqual(JSON.parse(r.body), requests[kind][2]);
    };
    const r = await f.fresh().execute(f.input);
    assert.equal(r.outcome, 'confirmed-success'); assert.equal(r.continuation, true);
    assert.equal(f.writes().length, 1);
    f.state.allowed = false;
    const recovered = await f.fresh().execute(f.input);
    assert.equal(recovered.outcome, 'confirmed-success'); assert.equal(f.writes().length, 1);
    assert.deepEqual(recovered.refs.intent, r.refs.intent);
    assert.equal(recovered.observation.id, r.observation.id);
  });
  test(`${kind}: lost response reconciles fixture effect without retry`, async () => {
    const f = operationsFixture(operationInput(kind)); f.state.lost = true;
    assert.equal((await f.fresh().execute(f.input)).outcome, 'confirmed-success');
    assert.equal(f.writes().length, 1);
    assert.equal((await f.fresh().execute(f.input)).outcome, 'confirmed-success');
    assert.equal(f.writes().length, 1);
  });
  test(`${kind}: acknowledgment, missing/conflicting/read failure and pagination never prove effect`, async () => {
    for (const scenario of ['absent', 'wrong', 'failed', 'unchanged', 'pagination']) {
      const f = operationsFixture(operationInput(kind));
      if (scenario === 'absent') f.state.onWrite = () => {f.state.effect = false;};
      if (scenario === 'wrong') f.state.mutate = d => ({...d, id: '99', workflow_id: '99', repository_url: 'wrong', base: {repo:{id:'99'}}});
      if (scenario === 'failed') f.state.failRead = true;
      if (scenario === 'unchanged') f.state.mutate = d => ({...d, state:'open',state_reason:null,merged:false,display_title:'unrelated',body:'unrelated'});
      if (scenario === 'pagination') {
        if (['close','merge'].includes(kind)) f.state.failRead = true;
        else f.state.incomplete = true;
      }
      // Label success is exact requested label presence, independent of unrelated Issue edits.
      if (kind === 'label' && scenario === 'unchanged') f.state.onWrite = () => {f.state.effect = false;};
      const r = await f.fresh().execute(f.input);
      assert.equal(r.outcome, 'unknown', scenario); assert.equal(r.continuation, false);
      assert.equal(f.writes().length, 1);
      await f.fresh().execute(f.input); assert.equal(f.writes().length, 1);
    }
  });
  test(`${kind}: affirmative local authorization rejection proves no submission; retry rechecks`, async () => {
    const f = operationsFixture(operationInput(kind)); f.state.allowed = false;
    const denied = await f.fresh().execute(f.input);
    assert.equal(denied.outcome, 'confirmed-no-effect'); assert.equal(denied.continuation, false);
    assert.equal(f.writes().length, 0);
    assert.equal((await f.fresh().execute(f.input, {retryAfterNoEffect:true})).outcome, 'confirmed-no-effect');
    assert.equal(f.writes().length, 0);
    f.state.allowed = true;
    assert.equal((await f.fresh().execute(f.input, {retryAfterNoEffect:true})).outcome, 'confirmed-success');
    assert.equal(f.writes().length, 1);
  });
}
test('invalid identity or retention uncertainty prevents all mutation', async () => {
  assert.throws(() => createControlledOperations({}));
  for (const change of [x => x.version=2, x => x.binding.repositoryId='01', x => x.source.attempt='0',
    x => x.binding.head='bad', x => x.payload.state='open', x => x.target.number='102']) {
    const f = operationsFixture(); change(f.input);
    assert.throws(() => controlledIntent(f.input));
    assert.equal((await f.fresh().execute(f.input)).outcome, 'unknown'); assert.equal(f.writes().length, 0);
  }
  for (const mode of ['retainFail', 'expired', 'corrupt']) {
    const f = operationsFixture(); f.state[mode] = true;
    assert.equal((await f.fresh().execute(f.input)).outcome, 'unknown'); assert.equal(f.writes().length, 0);
  }
});
test('fresh recovery rejects changed independent expected identities and conflicting correlation reuse', async () => {
  const f = operationsFixture(); const initial = await f.fresh().execute(f.input);
  assert.equal(initial.outcome, 'confirmed-success');
  for (const change of [x => x.binding.repository='another/core', x => x.binding.repositoryId='43',
    x => x.binding.issueId='I_OTHER', x => x.binding.cycle='cycle-2', x => x.binding.authorization='e'.repeat(64),
    x => x.binding.scopeHash='e'.repeat(64), x => x.binding.shapeHash='e'.repeat(64),
    x => x.binding.candidate='e'.repeat(64), x => x.binding.base='e'.repeat(40), x => x.binding.head='e'.repeat(40),
    x => x.binding.runId='101', x => x.binding.attempt='2', x => x.source.request='different',
    x => x.payload.state_reason='not_planned', x => x.target.id='62']) {
    const changed = structuredClone(f.input); change(changed);
    assert.equal((await f.fresh().execute(changed)).outcome, 'unknown');
    assert.equal(f.writes().length, 1);
  }
  for (const mode of ['expired','corrupt']) {
    f.state[mode] = true;
    assert.equal((await f.fresh().execute(f.input)).outcome, 'unknown'); f.state[mode] = false;
  }
  f.records.clear();
  assert.equal((await f.fresh().execute(f.input)).outcome, 'unknown'); assert.equal(f.writes().length, 1);
});
test('interruption before intent, during write and during result retention remains recoverable', async () => {
  {
    const f = operationsFixture(), controller = new AbortController(); controller.abort();
    assert.equal((await f.fresh().execute(f.input,{signal:controller.signal})).outcome,'unknown');
    assert.equal(f.writes().length,0);
  }
  {
    const f = operationsFixture(), controller = new AbortController(); let finish;
    f.state.onWrite = () => new Promise(resolve => {finish=resolve; controller.abort();});
    const r = await f.fresh().execute(f.input,{signal:controller.signal});
    assert.equal(r.outcome,'unknown'); assert.equal(f.writes().length,1);
    finish();
    assert.equal((await f.fresh().execute(f.input)).outcome,'confirmed-success'); assert.equal(f.writes().length,1);
  }
  {
    const f = operationsFixture(); f.state.retainFail = 'result';
    const r = await f.fresh().execute(f.input);
    assert.equal(r.outcome,'unknown'); assert.ok(r.refs.intent); assert.equal(f.writes().length,1);
    f.state.retainFail = false;
    assert.equal((await f.fresh().execute(f.input)).outcome,'confirmed-success'); assert.equal(f.writes().length,1);
  }
});
test('retained intent with no result is potentially attempted, never replayed', async () => {
  const f = operationsFixture(); f.state.allowed=false;
  await f.fresh().execute(f.input);
  delete f.history.get('request-1').result;
  f.state.allowed=true;
  assert.equal((await f.fresh().execute(f.input,{retryAfterNoEffect:true})).outcome,'unknown');
  assert.equal((await f.fresh().execute(f.input)).outcome,'unknown'); assert.equal(f.writes().length,0);
});
test('caller predicates and submission assertions cannot create confirmed success', async () => {
  const f = operationsFixture(); f.state.onWrite=()=>{f.state.effect=false;};
  const r = await f.fresh().execute({...f.input, matches:()=>true});
  assert.equal(r.outcome,'unknown'); assert.equal(f.writes().length,0);
  assert.ok(contentIdentity(f.input));
});
test('fresh independent Run recovers original provenance and retains new readback at its own source', async () => {
  const f=operationsFixture(); const original=await f.fresh().execute(f.input);
  const recovered=await f.fresh({runId:'200',attempt:'2'}).execute(f.input);
  assert.equal(recovered.outcome,'confirmed-success'); assert.equal(f.writes().length,1);
  assert.deepEqual(recovered.refs.intent,original.refs.intent);
  assert.equal(recovered.refs.result.ref.runId,'200'); assert.equal(recovered.refs.result.source.attempt,'2');
  f.history.get('request-1').result.source.attempt='3';
  assert.equal((await f.fresh().execute(f.input)).outcome,'unknown'); assert.equal(f.writes().length,1);
});
test('interrupted retry cannot reuse a preceding no-effect receipt', async () => {
  const f=operationsFixture(); f.state.allowed=false;
  assert.equal((await f.fresh().execute(f.input)).outcome,'confirmed-no-effect');
  f.state.allowed=true; f.state.retainFail='result'; f.state.onWrite=()=>{f.state.effect=false;};
  assert.equal((await f.fresh().execute(f.input,{retryAfterNoEffect:true})).outcome,'unknown');
  assert.equal(f.writes().length,1);
  f.state.retainFail=false;
  assert.equal((await f.fresh().execute(f.input,{retryAfterNoEffect:true})).outcome,'unknown');
  assert.equal(f.writes().length,1);
});
test('cancellation at intent/attempt/result retention preserves uncertainty and forbids replay', async () => {
  for (const phase of ['intent','attempt','result']) {
    const f=operationsFixture(), controller=new AbortController();
    f.state.onPublish=current=>{if(current===phase) controller.abort();};
    const result=await f.fresh().execute(f.input,{signal:controller.signal});
    assert.equal(result.outcome,'unknown'); assert.equal(f.writes().length,phase==='result'?1:0);
    f.state.onPublish=null;
    // Allow a canceled artifact upload to settle; cancellation did not revoke its effect.
    await new Promise(resolve=>setTimeout(resolve,15));
    const recovered=await f.fresh().execute(f.input);
    assert.equal(recovered.outcome,phase==='result'?'confirmed-success':'unknown');
    assert.equal(f.writes().length,phase==='result'?1:0);
  }
});

test('readback tolerates changing Run status and extra detail fields, but rejects changed effect or missing list entries', async () => {
  for(const kind of ['dispatch','pr']) {
    const f=operationsFixture(operationInput(kind));
    f.state.detail=d=>({...d,status:'in_progress',extra:'detail-only'});
    assert.equal((await f.fresh().execute(f.input)).outcome,'confirmed-success');
    f.state.detail=d=>({...d,display_title:'wrong',body:'wrong'});
    assert.equal((await f.fresh().execute(f.input)).outcome,'unknown'); assert.equal(f.writes().length,1);
  }
  const f=operationsFixture(operationInput('dispatch')); f.state.total=2;
  assert.equal((await f.fresh().execute(f.input)).outcome,'unknown'); assert.equal(f.writes().length,1);
});
test('Merge independently binds destination branch and exact Base through initial and recovered readback', async () => {
  const control=operationsFixture(operationInput('merge'));
  const success=await control.fresh().execute(control.input);
  assert.equal(success.outcome,'confirmed-success'); assert.equal(success.continuation,true);
  assert.equal(success.observation.baseRef,'main'); assert.equal(success.observation.base,'c'.repeat(40));
  assert.equal(control.writes().length,1);
  const conflicts=[
    {ref:'unintended-branch',sha:'e'.repeat(40),repo:{id:'42'}},
    {ref:'unintended-branch',sha:'c'.repeat(40),repo:{id:'42'}},
    {ref:'main',sha:'e'.repeat(40),repo:{id:'42'}},
    {sha:'c'.repeat(40),repo:{id:'42'}}, {ref:'main',repo:{id:'42'}}
  ];
  for(const base of conflicts) {
    const f=operationsFixture(operationInput('merge')); f.state.mutate=d=>({...d,base});
    const result=await f.fresh().execute(f.input);
    assert.equal(result.outcome,'unknown'); assert.equal(result.continuation,false); assert.equal(f.writes().length,1);
    assert.equal((await f.fresh().execute(f.input)).outcome,'unknown'); assert.equal(f.writes().length,1);
    control.state.mutate=d=>({...d,base});
    const recovered=await control.fresh().execute(control.input);
    assert.equal(recovered.outcome,'unknown'); assert.equal(recovered.continuation,false); assert.equal(control.writes().length,1);
  }
  const changed=structuredClone(control.input); changed.binding.baseRef='unintended-branch';
  assert.equal((await control.fresh().execute(changed)).outcome,'unknown'); assert.equal(control.writes().length,1);
  for(const baseRef of [undefined,'../main','/main','main/','${{ inputs.branch }}']) {
    const f=operationsFixture(operationInput('merge'));
    if(baseRef===undefined) delete f.input.binding.baseRef; else f.input.binding.baseRef=baseRef;
    assert.throws(()=>controlledIntent(f.input));
    assert.equal((await f.fresh().execute(f.input)).outcome,'unknown'); assert.equal(f.writes().length,0);
  }
});

test('label: interrupted authorized retry reconciles latest submission rather than preceding denial',async()=>{
  const f=operationsFixture(operationInput('label'));f.state.allowed=false;
  assert.equal((await f.fresh().execute(f.input)).outcome,'confirmed-no-effect');
  f.state.allowed=true;f.state.retainFail='result';
  assert.equal((await f.fresh().execute(f.input,{retryAfterNoEffect:true})).outcome,'unknown');
  assert.equal(f.writes().length,1);
  f.state.retainFail=false;
  assert.equal((await f.fresh().execute(f.input)).outcome,'confirmed-success');
  assert.equal(f.writes().length,1);
});

test('label: submission receipt must bind the current valid attempt',async()=>{
  const f=operationsFixture(operationInput('label'));f.state.allowed=false;
  const denied=await f.fresh().execute(f.input);
  f.state.allowed=true;
  const submitted=await f.fresh().execute(f.input,{retryAfterNoEffect:true});
  assert.equal(submitted.outcome,'confirmed-success');
  // Both attempts are genuine custody records for this exact intent, but only
  // the later one was submitted. A receipt cannot attest another attempt.
  f.history.get(f.input.correlation).attempt=denied.refs.attempt;
  assert.equal((await f.fresh().execute(f.input)).outcome,'unknown');
  assert.equal(f.writes().length,1);
});
