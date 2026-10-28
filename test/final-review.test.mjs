import test from 'node:test';
import assert from 'node:assert/strict';
import {createFinalReview,createProtectedMerge,contentIdentity} from '../src/index.mjs';
import {finalReviewFixture} from '../tooling/final-review-fixture.mjs';
import {operationsFixture,operationInput} from '../tooling/operations-fixture.mjs';
const fixture=async(fn,options)=>{const f=await finalReviewFixture(options);try{await fn(f);}finally{f.close();}};
test('complete published producer chain reaches fixed independent read-only review and protected rebase',()=>fixture(async f=>{
  assert.equal((await f.approve()).outcome,'approved');
  const {request,actual}=f.records[0],task=JSON.parse(JSON.stringify(request.task));
  assert.equal(request.role,'shaper-review');assert.equal(request.skill,'shape');assert.equal(actual.workspace.access,'read');
  assert.equal(task.scopeBody,f.pin.scopeBody);assert.equal(task.shapeBody,f.pin.shapeBody);assert.deepEqual(task.decisions,f.pin.decisions);
  assert.ok(Buffer.from(task.workspace.diff,'base64').toString().includes('GIT binary patch'));
  assert.ok(task.workspace.sources.some(s=>s.path==='ignored'&&Buffer.from(s.data,'base64').toString()==='required ignored bytes'));
  assert.deepEqual(task.hooks.first,f.pin.hooks.first);assert.deepEqual(task.hooks.receipt,f.pin.hooks.receipt);
  assert.deepEqual(task.evidence.accept,f.pin.evidence.accept);assert.deepEqual(task.observation,f.pin.observation);
  const r=await f.merge();assert.equal(r.outcome,'merged');assert.equal(r.evidence.stage,'merge');
  assert.equal(r.evidence.inputs.base,f.pin.workspace.candidate.base);assert.notEqual(r.evidence.inputs.commit,r.evidence.inputs.head);
  assert.deepEqual(JSON.parse(f.ops.writes()[0].body),{sha:r.evidence.inputs.head,merge_method:'rebase'});
  assert.equal(f.ops.writes().length,1);assert.equal((await f.merge()).outcome,'merged');assert.equal(f.ops.writes().length,1);
}));
test('organization ownership and squash/merge are separate from Runner registration',async()=>{
  for(const method of ['squash','merge'])await fixture(async f=>{
    assert.equal((await f.approve()).outcome,'approved');assert.equal((await f.merge()).outcome,'merged');
    assert.equal(JSON.parse(f.ops.writes()[0].body).merge_method,method);
  },{ownership:'organization',method});
});
test('missing and independently mutated intake blocks before invocation',async()=>{
  const changes=[p=>delete p.scopeBody,p=>p.scopeBody+='altered',p=>p.shapeBody+='altered',p=>delete p.decisions,
    p=>delete p.evidence.author,p=>delete p.evidence.validator,p=>delete p.evidence.publication,p=>delete p.evidence.deliver,
    p=>delete p.evidence.accept,p=>delete p.evidence.secondStage,p=>delete p.evidence.pr,p=>delete p.evidence.ci,
    p=>p.evidence.accept.value.binding.issueId='foreign',p=>p.evidence.pr.value.inputs.head='a'.repeat(40),
    p=>p.evidence.deliver.current.consumed.push(p.evidence.deliver.value.execution.result),
    p=>p.workspace.binding.cycle='other',p=>p.binding.grant='f'.repeat(64),p=>p.workspace.binding.policy='f'.repeat(64),
    p=>p.hooks.first.identity='f'.repeat(64),p=>p.hooks.receipt.identity='f'.repeat(64),p=>p.publication.tree='a'.repeat(40),
    p=>p.publication.commit='a'.repeat(40),p=>p.observation.tree='a'.repeat(40),p=>p.visibility='private'];
  for(const change of changes)await fixture(async f=>{
    change(f.pin);assert.equal((await f.review.run()).outcome,'blocked',change.toString());
    assert.equal(f.records.length,0);assert.equal(f.ops.writes().length,0);
  });
  await fixture(async f=>{
    const workspace=structuredClone(f.a.workspace);workspace.sources=workspace.sources.filter(x=>x.path!=='ignored');
    const flow=createFinalReview({...f.capabilities,workspace:()=>workspace});
    assert.equal((await flow.run()).outcome,'blocked');assert.equal(f.records.length,0);
  });
});
test('all upstream execution identifiers, reused review, invalid/replayed/failed output and unresolved process reject',async()=>{
  for(const name of ['author','validator','deliver','accept'])for(const key of ['id','request','result'])await fixture(async f=>{
    f.state.fault=`reuse:${name}:${key}`;assert.equal((await f.review.run()).outcome,'blocked');assert.equal(f.records.length,0);
  });
  for(const fault of ['foreign','invalid','replay','absent','exit','running','pending','transport','truncated'])await fixture(async f=>{
    f.state.fault=fault;
    if(fault==='exit')f.state.exitCode=1;
    if(fault==='running')f.state.termination='running';
    if(fault==='pending')f.state.pending=true;
    if(fault==='transport')f.capabilities.prepareRole=async()=>{throw Error('unsupported complete task channel');};
    const flow=createFinalReview(f.capabilities),r=await flow.run();assert.equal(r.outcome,'blocked');assert.equal(f.ops.writes().length,0);
    if(fault==='pending'){assert.ok(r.reconciliationRequired);assert.equal((await flow.run()).outcome,'blocked');
      f.state.pending=false;assert.equal((await flow.reconcile()).outcome,'approved');}
  });
  await fixture(async f=>{assert.equal((await f.review.run()).outcome,'approved');f.state.fault='repeat';
    assert.equal((await f.review.run()).outcome,'blocked');assert.equal(f.records.length,1);});
});
test('validated rejection retains classification and cannot supply merge approval',()=>fixture(async f=>{
  f.state.result={version:1,outcome:'changes_required',failureClass:'implementation_defect',summary:'Contract fixture rejection',conflicts:[]};
  const r=await f.approve();assert.equal(r.outcome,'rejected');assert.equal(r.result.failureClass,'implementation_defect');
  assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,0);
}));
test('pending native CI allows fidelity review, never claims CI success; native rejection remains unconfirmed',()=>fixture(async f=>{
  f.native.checks[0].status='in_progress';f.native.checks[0].conclusion=null;
  f.pin.observation=await f.observe();f.pin.evidence.ci.value.inputs.checks=contentIdentity(f.pin.observation.ci);
  f.pin.evidence.ci.current.expected=structuredClone(f.pin.evidence.ci.value);
  // Recreate expectation producer inputs after the changed observation.
  const original=f.capabilities.prepareRole;f.capabilities.prepareRole=async request=>{
    const r=await original(request);return r;
  };
  const flow=createFinalReview(f.capabilities);const r=await flow.run();assert.equal(r.outcome,'approved');
  assert.equal(f.pin.observation.ci.status,'pending');assert.equal(f.pin.observation.ci.qualifies,false);
  f.pin.review={value:r.evidence,current:{expected:r.evidence,consumed:[]},context:r.context};
  f.ops.state.onWrite=()=>{f.ops.state.effect=false;};assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,1);
}));
test('native policy/permission/method/identity rejection never writes',async()=>{
  for(const change of [n=>n.repo.permissions.push=false,n=>n.protected=false,n=>n.repo.private=true,n=>n.repo.allow_rebase_merge=false,
    n=>n.protection.enforce_admins.enabled=false,n=>n.protection.required_status_checks.strict=false,n=>n.protection=null,n=>n.pr.mergeable=null,
    n=>n.pr.base.ref='other',n=>n.pr.head.sha='a'.repeat(40),n=>n.pr.base.sha='a'.repeat(40),
    n=>n.tree='a'.repeat(40),n=>n.rules=[{type:'unknown'}]])await fixture(async f=>{
      f.pin.ciMode='signed';change(f.native);
      try {f.pin.observation=await f.observe();f.pin.evidence.ci.value.inputs.checks=contentIdentity(f.pin.observation.ci);
        f.pin.evidence.ci.current.expected=structuredClone(f.pin.evidence.ci.value);await f.approve();}catch {/* Unreadable observation is itself blocking. */}
      const merged=await f.merge();assert.equal(merged.outcome,'blocked');assert.equal(f.ops.writes().length,0);
      if(f.pin.review&&f.pin.observation.directEnforced===false)assert.match(merged.finding,/direct-protection-bypass-or-unsupported/);
  });
  for(const kind of ['permission','dependencies','signed'])await fixture(async f=>{
    assert.equal((await f.approve()).outcome,'approved');
    if(kind==='permission')f.ops.state.allowed=false;
    if(kind==='dependencies')f.state.dependencyDenied=true;
    if(kind==='signed')f.pin.ciMode='unknown';
    assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,0);
  });
});
test('required native queue is explicitly unsupported before mutation for all queue states/methods',async()=>{
  for(const queueState of ['pending','removed','failed'])await fixture(async f=>{
    f.native.rules=[{type:'merge_queue',ruleset_id:'1',ruleset_source:'example-org/core',ruleset_source_type:'Repository',
      parameters:{merge_method:queueState==='failed'?'SQUASH':'REBASE'}}];
    f.pin.observation=await f.observe();f.pin.evidence.ci.value.inputs.checks=contentIdentity(f.pin.observation.ci);
    f.pin.evidence.ci.current.expected=structuredClone(f.pin.evidence.ci.value);
    const r=await f.approve();assert.equal(r.outcome,'approved');const merged=await f.merge();
    assert.equal(merged.outcome,'blocked');assert.match(merged.finding,/unsupported-required-merge-queue/);assert.equal(f.ops.writes().length,0);
  });
});
test('asynchronous drift during review collection and mutation authorization forbids stale submission',async()=>{
  const changes=[p=>p.scopeBody+='drift',p=>p.shapeBody+='drift',p=>p.binding.policy='f'.repeat(64),
    p=>p.workspace.identity='f'.repeat(64),p=>p.hooks.receipt.identity='f'.repeat(64),p=>p.target.cycle='other'];
  for(const change of changes)await fixture(async f=>{
    f.state.onCollect=()=>change(f.pin);assert.equal((await f.approve()).outcome,'blocked');assert.equal(f.ops.writes().length,0);
  });
  for(const phase of ['authorization','dependencies','native'])await fixture(async f=>{
    assert.equal((await f.approve()).outcome,'approved');let mutated=false;
    const drift=()=>{if(!mutated){mutated=true;f.pin.decisions.push('changed');}};
    if(phase==='authorization')f.ops.state.onAuthorizationRead=drift;
    if(phase==='dependencies')f.state.onDependency=drift;
    if(phase==='native')f.state.onNative=drift;
    assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,0,phase);
  });
  await fixture(async f=>{assert.equal((await f.approve()).outcome,'approved');
    f.ops.state.onAuthorizationRead=()=>{f.native.pr.head.sha='a'.repeat(40);};
    assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,0);});
});
test('lost response, interrupted retention and fresh-instance recovery use original attempt without replay',async()=>{
  for(const mode of ['lost','retainFail','historyUnavailable'])await fixture(async f=>{
    assert.equal((await f.approve()).outcome,'approved');f.ops.state[mode]=mode==='retainFail'?'result':true;
    const r=await f.merge();assert.equal(r.outcome,mode==='lost'?'merged':'blocked');
    f.ops.state[mode]=false;assert.equal((await f.merge()).outcome,'merged');assert.equal(f.ops.writes().length,1);
  });
});
test('merge readback requires actual commit and independent destination membership, including later tip',async()=>{
  const f=operationsFixture(operationInput('merge'));f.state.tip='e'.repeat(40);
  f.state.mutate=d=>({...d,base:{...d.base,sha:f.state.tip}});
  assert.equal((await f.fresh().execute(f.input)).outcome,'confirmed-success');
  for(const membership of [{status:'behind'},{status:'diverged'},{status:'ahead',behind_by:1},
    {status:'ahead',behind_by:0,ahead_by:1,base_commit:{sha:'d'.repeat(40)},merge_base_commit:{sha:'f'.repeat(40)}}]){
    f.state.membership=membership;assert.equal((await f.fresh().execute(f.input)).outcome,'unknown');assert.equal(f.writes().length,1);
  }
  f.state.membership=null;f.state.destination={name:'other',commit:{sha:'e'.repeat(40)}};
  assert.equal((await f.fresh().execute(f.input)).outcome,'unknown');
});

test('signed CI, changed method/context, missing termination and altered task transfer stay blocked',async()=>{
  await fixture(async f=>{
    f.native.checks[0].status='in_progress';f.native.checks[0].conclusion=null;f.pin.ciMode='signed';
    f.pin.observation=await f.observe();f.pin.evidence.ci.value.inputs.checks=contentIdentity(f.pin.observation.ci);
    f.pin.evidence.ci.current.expected=structuredClone(f.pin.evidence.ci.value);
    assert.equal((await f.approve()).outcome,'approved');assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,0);
  });
  for(const change of [p=>p.method='squash',p=>p.decisions.push('new decision'),p=>p.review.context='f'.repeat(64)])await fixture(async f=>{
    assert.equal((await f.approve()).outcome,'approved');change(f.pin);
    assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,0);
  });
  await fixture(async f=>{f.state.termination=null;assert.equal((await f.approve()).outcome,'blocked');assert.equal(f.ops.writes().length,0);});
});
test('signed authorization rejects an enabled but unapproved merge method at transport boundary',async()=>{
  const f=operationsFixture(operationInput('merge'));
  const altered=structuredClone(f.input);altered.payload.merge_method='squash';
  assert.equal((await f.fresh().execute(altered)).outcome,'confirmed-no-effect');assert.equal(f.writes().length,0);
});
test('destination compare paths allow only SHA comparisons and keep traversal rejection',async()=>{
  const {createGithubProvider}=await import('../src/index.mjs');const calls=[];
  const provider=createGithubProvider({transport:async r=>{calls.push(r);return {status:200,body:'{}'};}});
  const root='/repos/example-org/core/compare/';
  assert.equal((await provider.request({endpoint:root+'a'.repeat(40)+'...'+'b'.repeat(40),operation:'read',target:'42',correlation:'test'})).outcome,'read');
  for(const endpoint of ['/repos/owner/../compare/'+ 'a'.repeat(40)+'...'+'b'.repeat(40),root+'main...branch',root+'../main',root+'a'.repeat(40)+'...'+ 'b'.repeat(40)+'?path=../secret'])
    assert.equal((await provider.request({endpoint,operation:'read',target:'42',correlation:'test'})).outcome,'failed');
  assert.equal(calls.length,1);
});

test('drift while collecting independent merge expectations blocks continuation without denying the actual effect',()=>fixture(async f=>{
  assert.equal((await f.approve()).outcome,'approved');const original=f.mergeCaps.mergeCurrent;
  f.mergeCaps.mergeCurrent=async result=>{const expected=await original(result);f.pin.decisions.push('changed during readback');return expected;};
  assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,1);
  assert.equal(f.ops.state.effect,true);
}));

test('repository CI mode delegates enforcement to GitHub without requiring strict-base APIs or inventing CI success',()=>fixture(async f=>{
  f.native.protection=null;f.native.checks=[];
  f.pin.observation=await f.observe();f.pin.evidence.ci.value.inputs.checks=contentIdentity(f.pin.observation.ci);
  f.pin.evidence.ci.current.expected=structuredClone(f.pin.evidence.ci.value);
  assert.equal(f.pin.observation.ci.qualifies,false);assert.equal(f.pin.observation.ci.status,'pending');
  assert.equal((await f.approve()).outcome,'approved');
  f.ops.state.onWrite=()=>{f.ops.state.effect=false;};
  assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,1);
},{ciObservation:'github-repository'}));
test('repository CI observation rejects stale head/base, failed checks, and unreadable branch protection',async()=>{
  for(const fault of ['head','base','failed','protection'])await fixture(async f=>{
    if(fault==='head')f.native.pr.head.sha='f'.repeat(40);
    if(fault==='base')f.native.pr.base.sha='f'.repeat(40);
    if(fault==='failed'){f.native.checks[0].conclusion='failure';f.native.pr.mergeable_state='blocked';}
    if(fault==='protection')f.state.onNative=r=>{if(r.endpoint.endsWith('/branches/main'))throw Error('denied');};
    if(fault!=='failed'){await assert.rejects(f.observe());assert.equal(f.ops.writes().length,0);return;}
    f.pin.observation=await f.observe();f.pin.evidence.ci.value.inputs.checks=contentIdentity(f.pin.observation.ci);
    f.pin.evidence.ci.current.expected=structuredClone(f.pin.evidence.ci.value);
    assert.equal(f.pin.observation.ci.status,'failed');await f.approve();
    assert.equal((await f.merge()).outcome,'blocked');assert.equal(f.ops.writes().length,0);
  },{ciObservation:'github-repository'});
});
