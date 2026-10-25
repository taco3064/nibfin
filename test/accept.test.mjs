import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {acceptFixture} from '../tooling/accept-fixture.mjs';
import {compareEvidence,importWorkspace,canonicalJSON,bodyDigest} from '../src/index.mjs';

// These tests exercise actual Git capture, source transfer, local processes and
// hook contract composition; recording adapters do not certify native isolation.
test('AC1/2/5: complete binary/artifact/hook intake, fixed read-only independent role, two hook passes',async()=>{
  for(const ownership of ['personal','organization']){
    const f=await acceptFixture({ownership});try{
      const before=f.snapshot(), head=f.git('rev-parse','HEAD').toString();
      const result=await f.flow.run();assert.equal(result.outcome,'accepted',JSON.stringify(result));
      assert.deepEqual(compareEvidence(result.evidence,f.evidenceCurrent(result.evidence.execution.id)),result.evidence);
      const {input,task,role,skill}=f.records[0];
      assert.equal(role,'accept');assert.equal(skill,'accept');
      assert.equal(input.workspace.access,'read');assert.equal(input.workspace.path,f.root);
      assert.deepEqual(input.processEnvironment,{});assert.equal(input.executionIdentity.role,'accept');
      assert.notEqual(input.executionIdentity.id,f.pin.deliver.execution.id);
      assert.equal(input.instructions.identity,f.pin.binding.instructions);
      assert.equal(bodyDigest(input.instructions.content),input.instructions.identity);
      assert.equal(task.scopeBody,f.pin.scopeBody);assert.equal(task.shapeBody,f.pin.shapeBody);
      assert.deepEqual(task.decisions,f.pin.decisions);
      const transferred=importWorkspace(Buffer.from(canonicalJSON(task.workspace)),{expected:task.expected});
      assert(transferred.diff.toString().includes('GIT binary patch'));
      assert.equal(transferred.sources.find(s=>s.kind==='artifact').bytes.toString(),'required ignored bytes');
      assert.equal(transferred.sources.find(s=>s.kind==='hook').bytes.toString(),'#!/bin/sh\nexit 0\n');
      assert.deepEqual(task.deliver,f.pin.deliver);assert.deepEqual(task.hooks,f.pin.hooks);
      assert.equal((await f.second(result.evidence)).ok,true);
      assert.deepEqual(f.events,['first-pass','accept-start','accept-collect','second-pass']);
      assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.recapture().expected,f.pin.workspace);
      assert.equal(f.git('rev-parse','HEAD').toString(),head);
      const stale=structuredClone(result.evidence);stale.inputs.candidate.base='b'.repeat(40);
      await assert.rejects(()=>f.second(stale));
    }finally{f.close();}
  }
});
test('AC1/2: explicit empty hooks and rejection before successful reviewer start',async()=>{
  const f=await acceptFixture({empty:true});try{
    const r=await f.flow.run();assert.equal(r.outcome,'accepted');assert.equal(f.pin.hooks.receipt.status,'not-applicable');
    assert.equal((await f.second(r.evidence)).ok,true);
  }finally{f.close();}
  for(const fault of ['self','role','instructions','private','read','isolation']){
    const f=await acceptFixture({empty:true});try{
      if(fault==='private')f.pin.visibility='private';
      else if(fault==='read')f.state.read='unsupported';
      else if(fault==='isolation')f.state.isolation='unverified';
      else f.state.fault=fault;
      assert.equal((await f.flow.run()).outcome,'blocked',fault);assert.equal(f.records.length,0,fault);
    }finally{f.close();}
  }
});
test('AC3/5: validated failures retain classifications, never accepted evidence or mutation',async()=>{
  for(const [outcome,failureClass] of [['changes_required','implementation_defect'],['changes_required','shape_defect'],
    ['decision_required','authority_gap'],['blocked','external_failure']]){
    const f=await acceptFixture({empty:true});try{
      const before=f.snapshot();
      f.state.result={version:1,outcome,failureClass,summary:'Classified fixture rejection',conflicts:failureClass==='shape_defect'?[{
        scopeHash:f.pin.binding.scopeHash,shapeHash:f.pin.binding.shapeHash,scopeQuote:'exact candidate',shapeQuote:'fixture payload',evidenceReference:'local fixture'}]:[]};
      const r=await f.flow.run();assert.equal(r.outcome,'rejected',JSON.stringify(r));
      assert.equal(r.result.failureClass,failureClass);assert.equal(r.evidence,undefined);
      const id=r.execution.id, rejected={...f.expected.get(id),result:r.result};
      assert.throws(()=>compareEvidence(rejected,f.evidenceCurrent(id)));
      await assert.rejects(()=>f.second(rejected));assert.deepEqual(f.snapshot(),before);
      assert.deepEqual(f.recapture().expected,f.pin.workspace);
    }finally{f.close();}
  }
});
test('AC3: malformed, absent, nonzero, foreign, replay and permission claims reject with safe diagnostics',async()=>{
  for(const fault of ['malformed','absent','nonzero','foreign','replay','authority','bad-quote']){
    const f=await acceptFixture({empty:true});try{
      f.state.fault=fault;
      if(fault==='nonzero')f.state.exitCode=1;
      if(fault==='bad-quote')f.state.result={version:1,outcome:'changes_required',failureClass:'shape_defect',summary:'private credential sentinel',conflicts:[{
        scopeHash:f.pin.binding.scopeHash,shapeHash:f.pin.binding.shapeHash,scopeQuote:'nonexistent',shapeQuote:'fixture payload',evidenceReference:'fixture'}]};
      const r=await f.flow.run();assert.equal(r.outcome,'blocked',fault);
      assert(!JSON.stringify(r).includes('private credential sentinel'));assert.equal(r.evidence,undefined);
    }finally{f.close();}
  }
});
const mutations=[
  p=>delete p.hooks.receipt,p=>delete p.hooks.stage,p=>delete p.deliver,
  p=>p.workspace.candidate.artifacts=[],p=>p.workspace.candidate.hooks=[],
  p=>p.workspace.candidate.base='b'.repeat(40),p=>p.workspace.candidate.tree='c'.repeat(40),
  p=>p.workspace.candidate.diff='b'.repeat(64),p=>p.workspace.candidate.paths.push('foreign'),
  p=>p.workspace.candidate.artifacts[0].digest='b'.repeat(64),p=>p.workspace.candidate.hooks[0].digest='b'.repeat(64),
  p=>p.hooks.receipt.comparisons.index=false,p=>p.hooks.stage.inputs.receipt='b'.repeat(64),
  p=>p.obligations.requiredArtifacts=[],p=>p.scopeBody+=' drift',p=>p.shapeBody+=' drift',
  p=>p.instructions.shared={accept:{mode:'override',content:'unauthorized'}},p=>p.binding.policy='b'.repeat(64),
  p=>p.deliver.inputs.candidate.tree='b'.repeat(40),p=>p.hooks.receiptCurrent.consumed.push(p.hooks.receipt.identity),
  p=>p.obligations.hookObservation.hooks[0].prerequisites.push({name:'network',status:'unsupported',evidenceReference:'fixture'})];
test('AC2/4: each current input drift before start and after collection invalidates independently',async()=>{
  for(const mutate of mutations){
    for(const phase of ['before','after']){
      const f=await acceptFixture();try{
        if(phase==='before')mutate(f.pin);else f.state.onCollect=()=>mutate(f.pin);
        const r=await f.flow.run();assert.equal(r.outcome,'blocked',`${phase}: ${mutate}`);
        assert.equal(r.evidence,undefined);if(phase==='before')assert.equal(f.records.length,0);
      }finally{f.close();}
    }
  }
});
test('AC4: preparation and post-collection drift reject; ignored artifact recapture needs fresh independent evidence',async()=>{
  for(const event of ['onPrepare','onStart','onTermination']){
    const f=await acceptFixture({empty:true});try{
      f.state[event]=()=>f.pin.decisions.push('changed decision');
      assert.equal((await f.flow.run()).outcome,'blocked',event);
    }finally{f.close();}
  }
  const f=await acceptFixture({empty:true});try{
    const first=await f.flow.run();assert.equal(first.outcome,'accepted');
    writeFileSync(join(f.root,'ignored'),'new ignored content');
    const changed=f.recapture();assert.equal(changed.candidate.tree,first.evidence.inputs.candidate.tree);
    assert.notDeepEqual(changed.candidate.artifacts,first.evidence.inputs.candidate.artifacts);
    assert.equal((await f.flow.run()).outcome,'blocked');
    // Trusted Core renews Candidate, Deliver, first-pass receipt/stage and their expectations.
    f.pin.workspace=changed.expected;f.pin.deliver.inputs.candidate=changed.candidate;
    f.pin.deliverCurrent.expected=structuredClone(f.pin.deliver);
    const input={...f.hookInput,workspace:changed,expected:changed.expected};
    const hook=await f.runner.execute(input);assert.equal(hook.ok,true);
    f.pin.hooks.receipt=hook.receipt;f.pin.hooks.receiptCurrent={identity:hook.receipt.identity,consumed:[]};
    f.pin.hooks.stage.inputs={candidate:changed.candidate,phase:'pre-accept',receipt:hook.receipt.identity};
    f.pin.hooks.stageCurrent.expected=structuredClone(f.pin.hooks.stage);
    const next=await f.flow.run();assert.equal(next.outcome,'accepted',JSON.stringify(next));
    assert.notEqual(next.evidence.execution.id,first.evidence.execution.id);
    assert.throws(()=>compareEvidence(first.evidence,f.evidenceCurrent(next.evidence.execution.id)));
  }finally{f.close();}
});
test('AC5: unresolved execution reserves identity, reconciliation collects same invocation, stop is explicit',async()=>{
  for(const kind of ['start','pending','termination']){
    const f=await acceptFixture({empty:true});try{
      if(kind==='start')f.state.start='unknown';if(kind==='pending')f.state.pending=true;
      if(kind==='termination')f.state.termination='unknown';
      const r=await f.flow.run();assert.equal(r.outcome,'blocked');assert(r.reconciliationRequired);
      assert.equal((await f.flow.run()).finding,'accept:reconciliation-required');assert.equal(f.records.length,1);
      f.state.pending=false;f.state.termination='terminated';
      const resumed=kind==='pending'?await f.flow.stop():await f.flow.reconcile();
      // A valid result cannot be collected twice; unresolved termination retains its first collection.
      assert.equal(resumed.outcome,'accepted',JSON.stringify(resumed));assert.equal(f.records.length,1);
    }finally{f.close();}
  }
});
test('AC3/5: separate credential-free child serializes full task and rejects malformed/foreign results',async()=>{
  for(const fault of [null,'malformed','foreign']){
    const f=await acceptFixture({empty:true,child:true});try{
      f.state.fault=fault;const before=f.snapshot();
      assert.equal((await f.flow.run()).outcome,fault?'blocked':'accepted');
      assert(f.events.includes('child-serialized'));assert.deepEqual(f.snapshot(),before);
    }finally{f.close();}
  }
});
