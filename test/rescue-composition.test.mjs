import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from '../tooling/completion-fixture.mjs';
import {fanoutFixture} from '../tooling/fanout-fixture.mjs';
import {rescueFixture} from '../tooling/rescue-fixture.mjs';
import {chainContext} from '../tooling/evidence-fixture.mjs';
import {createRescueController,contentIdentity,verifyCompletion} from '../src/index.mjs';
test('actual Nibfin source-only completion/readback wakes native C/D consumers only with current completion',async()=>{
  const completed=await completionFixture(),flow=completed.fresh();
  assert.equal((await flow.close()).outcome,'closed');
  const result=await flow.complete();assert.equal(result.outcome,'completed');
  const receipt=result.receipt,contexts=Object.fromEntries(Object.entries(receipt.payload.receipts).map(([stage,r])=>[stage,{expected:r,consumed:[]}]));
  verifyCompletion(receipt,contexts);
  const fan=fanoutFixture(completed.pin.target);fan.completions.set(fan.b.issueId,receipt);fan.contexts.set(fan.b.issueId,contexts);
  // The source fixture and fanout use the same actual provider Issue identities.
  const r=await fan.fresh().wake(fan.input);assert.equal(r.outcome,'discovered');assert.equal(r.outcomes.length,2);
  assert.ok(r.outcomes.every(o=>o.outcome==='confirmed-success'));
  fan.complete(fan.e); // C has another current native prerequisite.
  const c=[...fan.requests.values()].find(r=>r.target.issueId===fan.c.issueId),d=[...fan.requests.values()].find(r=>r.target.issueId===fan.d.issueId);
  assert.equal((await fan.consumer(c,fan.c)).outcome,'ready');assert.equal((await fan.consumer(d,fan.d)).outcome,'ready');
  fan.state.denied.add(fan.c.issueId);assert.equal((await fan.consumer(c,fan.c)).outcome,'blocked');assert.equal((await fan.consumer(d,fan.d)).outcome,'ready');
  fan.completions.get(fan.b.issueId).identity='f'.repeat(64);assert.notEqual((await fan.consumer(d,fan.d)).outcome,'ready');
});
test('Rescue resolution requires independently current completion, and external completion is not automatic repair',async()=>{
  const completed=await completionFixture();await completed.fresh().close();const result=await completed.fresh().complete();
  assert.equal(result.outcome,'completed');const receipt=result.receipt;
  const expected=Object.fromEntries(Object.entries(receipt.payload.receipts).map(([s,r])=>[s,{expected:r,consumed:[]}]));
  const f=rescueFixture(),b=receipt.payload.receipts.publication.binding;
  f.target.scopeHash=b.scopeHash;f.target.shapeHash=b.shapeHash;f.blocked.target=structuredClone(f.target);f.setState({...f.state(),target:structuredClone(f.target)});
  const id=await f.register();f.flags.final={receipt,expected,cycle:f.target.cycle,caseId:null,continuation:null};
  const r=await f.controller.verify(id);assert.equal(r.outcome,'RESOLVED');assert.equal(r.resolution,'external');
  assert.equal((await f.controller.report()).verifiedAutomaticResolutions,0);
  f.flags.final={...f.flags.final,cycle:'stale'};
  await assert.rejects(f.controller.verify(id));
});
test('a successful continuation only establishes STAGE_RECOVERED with a validated exact-attempt stage receipt',async()=>{
  const {fixture}=await import('../tooling/evidence-fixture.mjs');
  const f=rescueFixture(),id=await f.register();assert.equal((await f.controller.run(id)).outcome,'PENDING_VERIFICATION');
  const original=f.flags.mutateRead;f.flags.mutateRead=(data,r)=>r.endpoint.includes('/runs/70/')?{...f.sourceRun,id:'70',conclusion:'success'}:data;
  const receipt=fixture('deliver');Object.assign(receipt.binding,{repositoryId:'42',issueId:'I_101',scopeHash:f.target.scopeHash,shapeHash:f.target.shapeHash,authority:f.target.authority});
  receipt.execution.source={...receipt.execution.source,runId:'70',attempt:'1'};
  f.flags.stageReceipt={caseId:id,receipt,expected:{expected:structuredClone(receipt),consumed:[]}};
  const r=await f.controller.verify(id);assert.equal(r.outcome,'STAGE_RECOVERED');assert.equal(r.conclusion,'neutral');
  f.flags.stageReceipt.receipt.execution.source.attempt='2';await assert.rejects(f.controller.verify(id));
  assert.equal((await f.controller.report()).verifiedAutomaticResolutions,0);
});
test('completion verification can accept the fresh repair Candidate but stops changed requirements/cycle',async()=>{
  const completed=await completionFixture();await completed.fresh().close();const {receipt}=await completed.fresh().complete();
  const expected=Object.fromEntries(Object.entries(receipt.payload.receipts).map(([s,r])=>[s,{expected:r,consumed:[]}]));
  const f=rescueFixture(),b=receipt.payload.receipts.publication.binding;
  Object.assign(f.target,{scopeHash:b.scopeHash,shapeHash:b.shapeHash});f.blocked.target=structuredClone(f.target);f.setState({...f.state(),target:structuredClone(f.target)});
  const id=await f.register();f.state().target.candidate='f'.repeat(64);f.state().target.execution='fresh-successful-execution';
  f.flags.final={receipt,expected,cycle:f.target.cycle,caseId:null,continuation:null};
  assert.equal((await f.controller.verify(id)).outcome,'RESOLVED');
  f.state().target.requirements='e'.repeat(64);await assert.rejects(f.controller.verify(id));
});
