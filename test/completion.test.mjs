import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {completionFixture} from '../tooling/completion-fixture.mjs';
import {chain,chainContext,h} from '../tooling/evidence-fixture.mjs';
import {dynamicFixture} from '../tooling/dynamic-fixture.mjs';
import {verifyCompletion,createCompletion,verifyEvidenceChain,contentIdentity,canonicalJSON,observeClosure} from '../src/index.mjs';
const blocked=r=>assert.equal(r.outcome,'blocked');
const close=async f=>assert.equal((await f.fresh().close()).outcome,'closed');

test('first Completion creates its own delivered stage/receipt, round trips custody and reuses canonical v1',async()=>{
  const f=await completionFixture();
  assert.equal(f.state.history.has('receipt'),false);assert.equal(f.label.state.effect,false);
  await close(f);assert.equal(f.state.history.has('receipt'),false);
  const result=await f.fresh().complete();assert.equal(result.outcome,'completed');assert.equal(result.reused,false);
  assert.deepEqual(f.state.mutations,['close-start','close','closure','label','delivered','receipt-intent','receipt']);
  const current=chainContext(result.receipt.payload);
  assert.deepEqual(verifyCompletion(result.receipt,current),result.receipt);
  assert.deepEqual(createCompletion(result.receipt.payload,current),result.receipt);
  const retry=await f.fresh().complete();assert.equal(retry.outcome,'completed');assert.equal(retry.reused,true);
  assert.equal(retry.receipt.identity,result.receipt.identity);
  assert.equal(f.close.writes().length,1);assert.equal(f.label.writes().length,1);
  assert.equal(f.state.mutations.filter(x=>x==='receipt').length,1);
});

test('prefix validation retains chain links and unchanged canonical identities without a delivered stage',()=>{
  const payload=chain(),current=chainContext(payload),original=createCompletion(payload,current);
  const before=canonicalJSON(original);
  for(const through of ['closure','final']) {
    const partial=structuredClone(payload),expectations=structuredClone(current);
    delete partial.receipts.delivered;delete expectations.delivered;
    if(through==='final'){delete partial.receipts.closure;delete expectations.closure;}
    assert.deepEqual(verifyEvidenceChain(partial,expectations,through),partial);
    const wrong=structuredClone(partial);wrong.receipts.final.inputs.merge=h('9');
    expectations.final.expected=wrong.receipts.final;
    assert.throws(()=>verifyEvidenceChain(wrong,expectations,through));
    assert.throws(()=>createCompletion(partial,expectations));
  }
  assert.equal(canonicalJSON(createCompletion(payload,current)),before);
});

test('final receipt is consumed by the existing synthetic native dependency evaluator',async()=>{
  const f=await completionFixture();await close(f);const r=await f.fresh().complete();assert.equal(r.outcome,'completed');
  const d=dynamicFixture();
  Object.assign(d.nodes[1],f.pin.target);
  d.edges.set('1',['101']);
  d.contexts.set('I_101',{identity:r.receipt.identity,expected:chainContext(r.receipt.payload)});
  d.receipts.set('I_101',r.receipt);
  const accepted=await d.evaluate();assert.equal(accepted.outcome,'ready');
  assert.deepEqual(accepted.completions.map(c=>c.identity),[r.receipt.identity]);
  d.receipts.set('I_101',{labels:['delivered']});
  assert.equal((await d.evaluate()).outcome,'blocked');
});

for(const [name,change] of Object.entries({
  'missing final':f=>{delete f.pin.receipts.final;},
  'stale merge link':f=>{f.pin.receipts.final.inputs.merge=h('9');f.pin.contexts.final.expected=f.pin.receipts.final;},
  'missing post-merge':f=>{f.state.postMerge=false;},
  'required deployment missing':f=>{f.pin.deployment={mode:'required'};},
  'missing applicability reason':f=>{f.pin.deployment={mode:'not-applicable',reason:''};},
  'repair-health exception':f=>{f.pin.deployment={mode:'repair-health-exception'};},
  'wrong merge commit':f=>{f.state.commit='e'.repeat(40);},
  'revoked grant':f=>{f.state.auth=false;},
  'unmet dependencies':f=>{f.state.dependencies=false;},
  'private target':f=>{f.state.private=true;},
  'wrong scope':f=>{f.pin.scopeBody='agent substituted scope';},
  'wrong shape':f=>{f.pin.shapeBody='agent substituted shape';},
  'untrusted authorization claim':f=>{f.state.auth=false;f.pin.authorized=true;},
  'manual closure':f=>{f.state.closed=true;},
  'provider 401':f=>{f.state.failed=401;},
  'provider 403':f=>{f.state.failed=403;}
}))test('zero mutation before invalid Close: '+name,async()=>{
  const f=await completionFixture();change(f);blocked(await f.fresh().close());
  assert.equal(f.close.writes().length,0);assert.equal(f.label.writes().length,0);
  assert.equal(f.state.history.has('receipt'),false);
});

for(const [name,change] of Object.entries({
  'not planned':f=>{f.state.reason='not_planned';},
  'pre-merge closure':f=>{f.state.at='2026-10-24T10:00:00Z';},
  'other actor':f=>{f.state.actor='8';},
  'reopened':f=>{f.state.closed=false;},
  'same-time reclose':f=>{f.state.event='201';},
  'missing custody':f=>{f.state.records.clear();},
  'corrupt custody':f=>{f.state.corrupt=true;},
  'wrong decision':f=>{f.pin.decision='decision-2';f.state.missingHistory=true;},
  'changed proof':f=>{f.state.postMerge=false;},
  'permission revoked':f=>{f.state.auth=false;}
}))test('Completion rejects current closure/proof drift: '+name,async()=>{
  const f=await completionFixture();await close(f);change(f);blocked(await f.fresh().complete());
  assert.equal(f.label.writes().length,0);assert.equal(f.state.history.has('receipt'),false);
});

for(const phase of ['close-start','closure','delivered','receipt-intent','receipt'])test('fresh instance reconciles lost '+phase+' publication response without another confirmed upload',async()=>{
  const f=await completionFixture();f.state.lostPublish=phase;
  if(['close-start','closure'].includes(phase)) {
    blocked(await f.fresh().close());f.state.lostPublish=null;await close(f);
  }else{await close(f);blocked(await f.fresh().complete());f.state.lostPublish=null;}
  const r=await f.fresh().complete();assert.equal(r.outcome,'completed');
  assert.equal(f.state.mutations.filter(x=>x===phase).length,1);
  assert.equal(f.close.writes().length,1);assert.equal(f.label.writes().length,1);
});

test('lost Close and label responses reconcile independent readback, including fresh instances',async()=>{
  const f=await completionFixture();f.close.state.lost=true;f.label.state.lost=true;
  await close(f);assert.equal((await f.fresh().complete()).outcome,'completed');
  assert.equal((await f.fresh().complete()).outcome,'completed');
  assert.equal(f.close.writes().length,1);assert.equal(f.label.writes().length,1);
});

test('interruption after label effect blocks success and re-observes instead of resubmitting',async()=>{
  const f=await completionFixture();await close(f);
  f.label.state.onWrite=()=>{f.state.mutations.push('label');f.label.state.failRead=true;};
  blocked(await f.fresh().complete());assert.equal(f.state.history.has('receipt'),false);
  f.label.state.failRead=false;
  assert.equal((await f.fresh().complete()).outcome,'completed');assert.equal(f.label.writes().length,1);
});

test('unknown close without retained submission remains blocked, never inferred from closed state',async()=>{
  const f=await completionFixture();f.close.state.retainFail='submission';
  blocked(await f.fresh().close());assert.equal(f.close.writes().length,1);
  f.close.state.retainFail=false;blocked(await f.fresh().close());
  assert.equal(f.close.writes().length,1);assert.equal(f.state.history.has('receipt'),false);
});

test('missing original publication custody never becomes a new operation',async()=>{
  const f=await completionFixture();f.state.missingHistory=true;
  blocked(await f.fresh().close());assert.equal(f.close.writes().length,0);
});

test('authorization checkpoint drift is caught again immediately before close transport',async()=>{
  const f=await completionFixture();
  f.close.state.onAuthorizationRead=()=>{f.pin.decision='changed-during-auth';};
  blocked(await f.fresh().close());assert.equal(f.close.writes().length,0);
});

test('authorization checkpoint drift is caught again immediately before label transport',async()=>{
  const f=await completionFixture();await close(f);
  f.label.state.onAuthorizationRead=()=>{f.pin.binding.grant=h('9');};
  blocked(await f.fresh().complete());assert.equal(f.label.writes().length,0);
});

test('receipt byte drift/conflicts and expired references cannot be reused or overwritten',async()=>{
  const f=await completionFixture();await close(f);assert.equal((await f.fresh().complete()).outcome,'completed');
  const prior=f.state.mutations.length;
  const ref=f.state.history.get('receipt').ref;
  const record=f.state.records.get(ref.artifactId);record.bytes=Buffer.from('conflicting receipt bytes');
  blocked(await f.fresh().complete());assert.equal(f.state.mutations.length,prior);
  const e=await completionFixture();await close(e);assert.equal((await e.fresh().complete()).outcome,'completed');
  for(const r of e.state.records.values())r.metadata.expired=true;
  blocked(await e.fresh().complete());assert.equal(e.state.mutations.filter(x=>x==='receipt').length,1);
});

test('permission-denied label/receipt readbacks never produce premature success',async()=>{
  const f=await completionFixture();await close(f);f.label.state.allowed=false;
  blocked(await f.fresh().complete());assert.equal(f.state.history.has('receipt'),false);
  assert.equal(f.label.writes().length,0);
  const e=await completionFixture();await close(e);e.state.failPublish='receipt';
  blocked(await e.fresh().complete());assert.equal(e.state.history.has('receipt'),false);
  // Unknown upload: Core must positively reconcile history; missing locator is blocked.
  e.state.missingHistory=true;blocked(await e.fresh().complete());
});

test('both public ownership types follow equivalent gates; private product claims reject',async()=>{
  for(const [native,ownership] of [['User','personal'],['Organization','organization']]) {
    const f=await completionFixture();f.state.ownership=native;f.pin.ownership=ownership;
    await close(f);assert.equal((await f.fresh().complete()).outcome,'completed');
  }
  const f=await completionFixture();f.pin.visibility='private';blocked(await f.fresh().close());
});

test('closed-only, label-only, aggregate and partial PR claims cannot construct final evidence',()=>{
  for(const claim of [{closed:true},{labels:['delivered']},{status:'COMPLETE'},{pr:{merged:true}},
    {version:1,receipts:{}}])assert.throws(()=>createCompletion(claim,{}));
});


test('required deployment consumes producer Final contract and rejects unrelated/failed/stale health before writes',async t=>{
  let health='healthy';
  const server=createServer((_q,r)=>{r.statusCode=health==='healthy'?200:503;r.end('ok');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}/`,checks=[{url,status:200,body:'ok'}];
  let clock=1000;
  const config={policy:{mode:'required',reason:'Synthetic release obligation',repositoryId:'42',commit:'d'.repeat(40),version:'1',
    environment:'production',deploymentId:'3',statusId:'4',baseline:'b1',source:{repositoryId:'42',workflow:'.github/workflows/deploy.yml',runId:'7',attempt:'2'},
    checks,maxAgeMs:100},health:{allowlist:[url],checks,timeoutMs:1000,maxBytes:32,maxRequests:1},now:()=>clock};
  const valid=await completionFixture(config);clock=1001;await close(valid);clock=1002;
  assert.equal((await valid.fresh().complete()).outcome,'completed');
  for(const [name,mutate] of Object.entries({
    unrelated:f=>{f.state.deploymentData['/deployments/3'].sha='e'.repeat(40);},
    environment:f=>{f.state.deploymentData['/deployments/3'].environment='other';},
    version:f=>{f.state.deploymentData['/deployments/3'].payload.version='other';},
    source:f=>{f.state.deploymentData['/actions/runs/7/attempts/2'].run_attempt=3;},
    failed:f=>{f.state.deploymentData['/deployments/3/statuses/4'].state='failure';},
    unhealthy:()=>{health='failed';},
    stale:f=>{f.state.hooks.read=async r=>{if(r.endpoint.includes('/issues/101/events'))clock+=101;};}
  })) {
    health='healthy';clock=1000;
    const f=await completionFixture(config);mutate(f);blocked(await f.fresh().close());
    assert.equal(f.close.writes().length,0,name);assert.equal(f.label.writes().length,0,name);
  }
});

test('closure drift during awaited proof verification is rejected before label submission',async()=>{
  const f=await completionFixture();await close(f);
  f.state.hooks.postMerge=()=>{f.state.event='201';};
  blocked(await f.fresh().complete());assert.equal(f.label.writes().length,0);
});


for(const [name,mutate] of Object.entries({
  Scope:f=>{f.pin.binding.scopeHash=h('9');},
  Shape:f=>{f.pin.binding.shapeHash=h('9');},
  Grant:f=>{f.pin.binding.grant=h('9');},
  dependencies:f=>{f.state.dependencies=false;},
  merge:f=>{f.state.commit='e'.repeat(40);},
  applicability:f=>{f.pin.deployment={mode:'required'};},
  closure:f=>{f.state.event='201';}
}))test('awaited checkpoint drift stops Completion before label: '+name,async()=>{
  const f=await completionFixture();await close(f);
  f.state.hooks.dependencies=()=>mutate(f);
  blocked(await f.fresh().complete());assert.equal(f.label.writes().length,0);
});

test('missing original close custody blocks an otherwise readable canonical receipt',async()=>{
  const f=await completionFixture();await close(f);assert.equal((await f.fresh().complete()).outcome,'completed');
  f.close.records.clear();blocked(await f.fresh().complete());
  assert.equal(f.close.writes().length,1);assert.equal(f.label.writes().length,1);
});

test('receipt drift at final readback and dependency drift at upload guard block success',async()=>{
  const f=await completionFixture();await close(f);
  f.state.hooks.locate=phase=>{if(phase==='receipt'&&f.state.history.has('receipt'))f.pin.binding.grant=h('9');};
  blocked(await f.fresh().complete());
  const e=await completionFixture();await close(e);
  e.state.hooks.locate=phase=>{if(phase==='receipt-intent')e.state.dependencies=false;};
  blocked(await e.fresh().complete());assert.equal(e.state.history.has('receipt'),false);
});

test('safe diagnostics contain reason and publication reference, never protected provider error text',async()=>{
  const f=await completionFixture();f.state.hooks.postMerge=()=>{throw Error('private-provider-secret');};
  const r=await f.fresh().close();blocked(r);
  assert.match(r.reference,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(r),/private-provider-secret/);
});


for(const [name,override] of Object.entries({
  'wrong Issue':{'/issues/101':{id:'62'}},
  'wrong repository':{'':{id:'43',full_name:'wrong/repo',private:false}},
  'missing issue readback':{'/issues/101':{}},
  'malformed event collection':{'/issues/101/events?per_page=100':{}},
  'wrong Merge PR':{'/pulls/102':{id:'61'}}
}))test('provider identity/readback rejection: '+name,async()=>{
  const f=await completionFixture();f.state.override=override;
  blocked(await f.fresh().close());assert.equal(f.close.writes().length,0);
});

test('ambiguous same-timestamp lifecycle events fail closed, without event ID temporal assumptions',async()=>{
  const f=await completionFixture();await close(f);
  f.state.events=[{id:'200',event:'closed',created_at:f.state.at,actor:{id:'7'}},
    {id:'199',event:'reopened',created_at:f.state.at,actor:{id:'7'}},
    {id:'198',event:'closed',created_at:f.state.at,actor:{id:'7'}}];
  blocked(await f.fresh().complete());assert.equal(f.label.writes().length,0);
});

test('unrelated Issue metadata updates preserve current causal closure',async()=>{
  const f=await completionFixture();await close(f);
  f.state.issueMetadata={updated_at:'2026-10-24T12:01:00Z',title:'Unrelated title change'};
  assert.equal((await f.fresh().complete()).outcome,'completed');
});


test('authenticated close writer is independent of the original triggering event actor',async()=>{
  const f=await completionFixture();f.pin.intents.close.source.actorId='8';
  // Reconstruct the controlled fixture with the changed source, preserving its grant checks.
  f.close.input.source.actorId='8';
  await close(f);assert.equal((await f.fresh().complete()).outcome,'completed');
});


test('Closure requires explicit causal transport mode before any mutation',async()=>{
  const f=await completionFixture();f.state.omitCausal=true;
  blocked(await f.fresh().close());assert.equal(f.close.writes().length,0);
});


test('an attempted artifact upload with missing custody cannot be rediscovered as new work',async()=>{
  const f=await completionFixture(),controller=new AbortController();let release;
  f.close.state.onPublish=phase=>{
    if(phase==='intent'){controller.abort();return new Promise(resolve=>{release=resolve;});}
  };
  blocked(await f.fresh().close({signal:controller.signal}));assert.equal(f.close.writes().length,0);
  blocked(await f.fresh().close());assert.equal(f.close.writes().length,0);
  f.close.state.onPublish=null;release();
  await new Promise(resolve=>setTimeout(resolve,20));
});


test('unconfirmed receipt upload is not retried from absent artifact history',async()=>{
  const f=await completionFixture();await close(f);f.state.failPublish='receipt';
  blocked(await f.fresh().complete());f.state.failPublish=null;
  blocked(await f.fresh().complete());assert.equal(f.state.mutations.filter(x=>x==='receipt').length,1);
});
