import test from 'node:test';
import assert from 'node:assert/strict';
import {shapeFixture} from '../tooling/shape-fixture.mjs';
import {bodyDigest,createDependencyEvaluator} from '../src/index.mjs';
import {dynamicFixture} from '../tooling/dynamic-fixture.mjs';

test('AC1/2/5: exact original, independent lifecycle invocations, controlled publication',async()=>{
  const f=shapeFixture();const c=await f.flow.propose();assert.equal(c.outcome,'validated',c.finding);
  assert.equal(f.records.length,2);
  const [a,v]=f.records;
  assert.notEqual(a.input.executionIdentity.id,v.input.executionIdentity.id);
  for(const r of f.records){
    assert.equal(r.input.executionIdentity.skill,'shape');assert.equal(r.input.workspace.access,'read');
    assert.deepEqual(r.task.original,f.pin.original);assert.deepEqual(r.task.target,f.pin.target);
    assert.equal(r.input.binding.instructions,bodyDigest(r.input.instructions.content));
    assert.deepEqual(r.input.processEnvironment,{});
  }
  assert.equal(a.input.executionIdentity.role,'shape');assert.equal(v.input.executionIdentity.role,'shape-validator');
  assert.equal(v.task.proposedBody,c.author.body);
  const p=await f.flow.publish(c);assert.equal(p.outcome,'published',JSON.stringify(p));
  assert.equal(f.state.concurrency.group,'nibfin-v1-42-repository-write');
  assert.equal(f.state.concurrency['cancel-in-progress'],false);
  assert.equal(f.writes().length,2);assert.deepEqual(f.writes().map(r=>r.method),['PATCH','POST']);
  assert.equal(f.state.body,f.body);assert.deepEqual(f.state.labels,['scope','shaped']);
  assert.equal(p.publication.original.body,f.pin.original.body);assert.equal(p.publication.shapeHash,bodyDigest(f.body));
  for(const store of f.stores.values()) assert.ok(store.history.size);
});

test('AC1: raw provenance, identity and authority failures never invoke a role',async()=>{
  for(const mutate of [f=>f.pin.original.kind='published-shape',f=>f.pin.original.body+='changed',
    f=>f.pin.target.repositoryId='99',f=>f.pin.target.issueId='foreign',f=>f.pin.binding.authority=null,
    f=>f.state.labels.push('shaped'),f=>f.state.body='published Shape']){
    const f=shapeFixture();mutate(f);assert.equal((await f.flow.propose()).outcome,'blocked');
    assert.equal(f.records.length,0);assert.equal(f.writes().length,0);
  }
});

test('AC2/4: invalid and unknown execution blocks; corrected same Issue gets fresh executions',async()=>{
  for(const fault of ['foreign','role','instructions','rejected','unknown']){
    const f=shapeFixture();f.state.roleFault=fault;
    assert.equal((await f.flow.propose()).outcome,'blocked',fault);assert.equal(f.writes().length,0);
    f.state.roleFault=null;
    const c=await f.flow.propose();assert.equal(c.outcome,'validated',c.finding);
    assert.equal((await f.flow.publish(c)).outcome,'published');
  }
});

test('AC3: independent inventory reconciliation overrides approval',async()=>{
  const invalid=['missing','```nibfin-candidate\n{}\n```',
    '```nibfin-candidate\n{"artifacts":[],"hooks":[]}\n```'];
  const base=shapeFixture().body;
  invalid.push(base+'\n```nibfin-candidate\n{"artifacts":[],"hooks":[]}\n```');
  for(const body of invalid){const f=shapeFixture();f.state.proposal=body;
    assert.equal((await f.flow.propose()).outcome,'blocked');assert.equal(f.writes().length,0);}
  const f=shapeFixture();f.observation.requiredArtifacts=[{path:'ignored.bin',purpose:'required',evidenceReference:'scope'}];
  assert.equal((await f.flow.propose()).outcome,'blocked');
  for(const hooks of [[{path:'hooks/commit',event:'commit-msg',evidenceReference:'config',applicability:'required',prerequisites:[]}],
    [{path:'hooks/pre',event:'pre-commit',evidenceReference:'config',applicability:'required',prerequisites:[{name:'network',status:'unsupported',evidenceReference:'config'}]}]]){
    const g=shapeFixture();g.observation.hookObservation.hooks=hooks;
    assert.equal((await g.flow.propose()).outcome,'blocked');assert.equal(g.writes().length,0);
  }
});

test('AC4/6: old approval, replay, changed authority/instructions and manual labels reject',async()=>{
  for(const mutate of [f=>f.state.replay=true,f=>f.pin.binding.policy='b'.repeat(64),
    f=>f.pin.instructions={repository:{shape:{mode:'override',content:'unapproved'}}},
    f=>f.state.body='foreign edit',f=>f.state.labels.push('shaped'),f=>f.state.historyMissing=true,
    f=>f.state.denied=true,f=>f.state.failRead=true]){
    const f=shapeFixture();const c=await f.flow.propose();mutate(f);
    assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,0);
  }
  const f=shapeFixture(),c=await f.flow.propose();c.author.body+=' revised';
  assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,0);
});

test('AC6: edits between effects and before final readback preserve partial failure',async()=>{
  for(const where of ['issue-body','label']){
    const f=shapeFixture(),c=await f.flow.propose();f.state.onWrite=(kind,state)=>{if(kind===where)state.body='concurrent edit';};
    const p=await f.flow.publish(c);assert.equal(p.outcome,'blocked');
    assert.equal(f.writes().length,where==='issue-body'?1:2);
    assert.equal(f.state.body,'concurrent edit');
    assert.equal((await f.flow.publish(c)).outcome,'blocked');
    assert.equal(f.writes().length,where==='issue-body'?1:2);
  }
});

test('AC6: lost transport responses reconcile exact effects without resubmission',async()=>{
  const f=shapeFixture(),c=await f.flow.propose();f.state.lost=true;
  assert.equal((await f.flow.publish(c)).outcome,'published');assert.equal(f.writes().length,2);
  assert.equal((await f.flow.publish(c)).outcome,'published');assert.equal(f.writes().length,2);
  f.stores.get('issue-body').state.corrupt=true;
  assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,2);
});

test('AC7: real native evaluator waits on current upstream, Markdown cannot unlock',async()=>{
  const d=dynamicFixture();assert.equal((await d.evaluate()).outcome,'ready');d.edges.set('1',['2']);
  assert.equal((await d.evaluate()).outcome,'waiting');
  for(const outcome of ['waiting','blocked','unavailable']){
    const f=shapeFixture();f.state.dependency=outcome;
    assert.equal((await f.flow.propose()).outcome,'blocked');assert.equal(f.records.length,0);
    f.state.dependency='ready';const c=await f.flow.propose();f.state.dependency=outcome;
    assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,0);
  }
});

test('AC2: same Author/Validator execution cannot be substituted in approved evidence',async()=>{
  const f=shapeFixture(),c=await f.flow.propose();
  c.validator.receipt.execution.id=c.author.receipt.execution.id;
  assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,0);
});

test('AC3: reordered configured hooks reject even with ready/approved results',async()=>{
  const f=shapeFixture();
  const hooks=[{path:'hooks/pre',event:'pre-commit'},{path:'hooks/msg',event:'commit-msg'}];
  f.state.proposal='Candidate artifacts applicability: None needed.\n```nibfin-candidate\n'+
    JSON.stringify({artifacts:[],hooks:hooks.toReversed()})+'\n```';
  f.observation.hookObservation.hooks=hooks.map(h=>({...h,evidenceReference:'fixture',applicability:'required',prerequisites:[]}));
  assert.equal((await f.flow.propose()).outcome,'blocked');assert.equal(f.writes().length,0);
});

test('AC6: interruption after effects resumes retained history; no attempt cannot create provenance',async()=>{
  for(const kind of ['issue-body','label']){
    const f=shapeFixture(),c=await f.flow.propose();
    f.state.onWrite=(k)=>{if(k===kind){
      const store=f.stores.get(k);store.state.retainFail='result';
    }};
    const first=await f.flow.publish(c);assert.equal(first.outcome,'blocked');
    assert.equal(f.writes().length,kind==='issue-body'?1:2);
    f.state.onWrite=null;for(const store of f.stores.values())store.state.retainFail=false;
    assert.equal((await f.flow.publish(c)).outcome,'published');assert.equal(f.writes().length,2);
  }
  const f=shapeFixture(),c=await f.flow.propose();assert.equal((await f.flow.publish(c)).outcome,'published');
  const history=f.stores.get('issue-body').history;
  const refs=history.values().next().value;delete refs.attempt;
  assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,2);
});

test('AC6: scope/decision drift and edits during intent retention stop before transport',async()=>{
  const f=shapeFixture(),c=await f.flow.propose();
  f.pin.decision=null;
  assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,0);
  const g=shapeFixture(),candidate=await g.flow.propose();
  g.state.onRetain=(phase)=>{if(phase==='attempt')g.state.body='late concurrent edit';};
  assert.equal((await g.flow.publish(candidate)).outcome,'blocked');assert.equal(g.writes().length,0);
});


test('AC7: flow checkpoints consume the real dependency evaluator with native edges',async()=>{
  const f=shapeFixture(),d=dynamicFixture();Object.assign(d.nodes[0],f.pin.target);
  f.state.evaluate=()=>d.evaluate();
  const c=await f.flow.propose();assert.equal(c.outcome,'validated',c.finding);
  d.edges.set('101',['2']);
  assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,0);
  assert.ok(d.calls.some(r=>r.endpoint.includes('/dependencies/blocked_by')));
  d.edges.clear();assert.equal((await f.flow.publish(c)).outcome,'published');
});

test('AC5/6: transport authorization denial cannot become causal proof from matching bytes',async()=>{
  const f=shapeFixture(),c=await f.flow.propose();
  f.state.onRetain=(phase,kind)=>{if(phase==='attempt' && kind==='issue-body')f.stores.get(kind).state.allowed=false;};
  const denied=await f.flow.publish(c);
  assert.equal(denied.outcome,'blocked');assert.equal(denied.bodyResult.outcome,'confirmed-no-effect');
  assert.equal(f.writes().length,0);
  f.state.onRetain=null;f.state.body=f.body;f.state.labels.push('shaped');
  assert.equal((await f.flow.publish(c)).outcome,'blocked');assert.equal(f.writes().length,0);
});

test('AC5/6: guard rejection cannot become causal proof from externally matching bytes',async()=>{
  const f=shapeFixture(),c=await f.flow.propose();
  f.state.onRetain=phase=>{if(phase==='attempt')f.state.body='foreign edit';};
  assert.equal((await f.flow.publish(c)).outcome,'blocked');
  assert.equal(f.writes().length,0);
  f.state.onRetain=null;f.state.body=f.body;
  f.stores.get('issue-body').state.effect=true;
  const recovered=await f.flow.publish(c);
  assert.equal(recovered.outcome,'blocked');
  assert.equal(recovered.bodyResult.reason,'missing-submission');
  assert.equal(f.writes().length,0);
  assert.deepEqual(f.state.labels,['scope']);
});

test('AC6: absent or foreign-attempt submission receipts fail closed',async()=>{
  for(const fault of ['missing','attempt','retention']){
    const f=shapeFixture(),c=await f.flow.propose();
    if(fault==='retention')f.state.onRetain=(phase,kind)=>{
      if(phase==='submission' && kind==='issue-body')f.stores.get(kind).state.retainFail='submission';
    };
    const first=await f.flow.publish(c);
    if(fault==='retention')assert.equal(first.outcome,'blocked');
    else assert.equal(first.outcome,'published');
    const store=f.stores.get('issue-body'),refs=store.history.values().next().value;
    if(fault==='attempt')refs.attempt=refs.intent;
    else delete refs.submission;
    store.state.retainFail=false;f.state.onRetain=null;
    const count=f.writes().length;
    assert.equal((await f.flow.publish(c)).outcome,'blocked');
    assert.equal(f.writes().length,count);
  }
});

test('AC5/6: denied submission remains no-effect when result retention is interrupted',async()=>{
  const f=shapeFixture(),c=await f.flow.propose();
  f.state.onRetain=(phase,kind)=>{
    if(kind!=='issue-body')return;
    const store=f.stores.get(kind);
    if(phase==='attempt')store.state.allowed=false;
    if(phase==='result')store.state.retainFail='result';
  };
  assert.equal((await f.flow.publish(c)).outcome,'blocked');
  assert.equal(f.writes().length,0);
  f.state.onRetain=null;f.state.body=f.body;
  const store=f.stores.get('issue-body');store.state.retainFail=false;store.state.effect=true;
  assert.equal((await f.flow.publish(c)).outcome,'blocked');
  assert.equal(f.writes().length,0);
});

for(const kind of ['issue-body','label']) {
  test(`AC5/6: ${kind} denial or guard rejection cannot be replaced by manual effects`,async()=>{
    for(const failure of ['denied','denied-result-interrupted','guard','submission-interrupted']) {
      const f=shapeFixture(),c=await f.flow.propose();
      f.state.onRetain=(phase,k)=>{
        if(k!==kind)return;
        const store=f.stores.get(k);
        if(phase==='attempt') {
          if(failure.startsWith('denied'))store.state.allowed=false;
          if(failure==='guard')f.state.body='foreign edit';
        }
        if(phase==='result' && failure==='denied-result-interrupted')store.state.retainFail='result';
        if(phase==='submission' && failure==='submission-interrupted')store.state.retainFail='submission';
      };
      const first=await f.flow.publish(c);
      assert.equal(first.outcome,'blocked',failure);
      const expected=(kind==='label'?1:0)+(failure==='submission-interrupted'?1:0);
      assert.equal(f.writes().length,expected,failure);
      if(failure==='denied')assert.equal((kind==='label'?first.labelResult:first.bodyResult).outcome,'confirmed-no-effect');
      f.state.onRetain=null;f.state.body=f.body;f.state.labels=['scope','shaped'];
      const store=f.stores.get(kind);store.state.effect=true;store.state.retainFail=false;
      const recovered=await f.flow.publish(c);
      assert.equal(recovered.outcome,'blocked',failure);
      assert.equal(f.writes().length,expected,failure);
      if(kind==='label' && failure!=='submission-interrupted')assert.equal(f.writes().some(r=>r.endpoint.endsWith('/labels')),false);
    }
  });
}
