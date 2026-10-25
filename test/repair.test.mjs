import test from 'node:test';
import assert from 'node:assert/strict';
import {createRepairFlow,invalidateRepairEvidence,contentIdentity,verifyCompletion,createCompletion,
  importWorkspace,exportWorkspace} from '../src/index.mjs';
import {repairFixture} from '../tooling/repair-fixture.mjs';
import {chain,chainContext} from '../tooling/evidence-fixture.mjs';
import {dynamicFixture} from '../tooling/dynamic-fixture.mjs';

const use=async (t,fn)=>{const f=await repairFixture();t.after(f.close);return fn(f);};
test('AC1/3: independent Accept rejection preserves complete Candidate and history before handoff',t=>use(t,async f=>{
  const before=f.f.snapshot(), r=await f.flow.run(f.raw);
  assert.equal(r.disposition,'repair');assert.equal(r.outcome,'handoff');
  assert.equal(r.record.predecessor,'attempt-1');assert.equal(r.record.attempt,'attempt-2');
  assert.deepEqual(f.f.snapshot(),before);
  const bytes=f.saved[0].payloads.get('workspace.json');
  const recovered=importWorkspace(bytes,{expected:f.pin.workspace});
  assert.deepEqual(exportWorkspace(recovered),exportWorkspace(f.f.workspace));
  const transfer=JSON.parse(bytes);
  assert.equal(Buffer.from(transfer.sources.find(s=>s.kind==='artifact').data,'base64').toString(),'required ignored bytes');
  assert.match(Buffer.from(transfer.sources.find(s=>s.kind==='hook').data,'base64').toString(),/exit 0/);
  assert.deepEqual(JSON.parse(f.saved[0].payloads.get('history.json')),[]);
  assert.deepEqual(JSON.parse(f.saved[0].payloads.get('repair.json')),r.record);
  assert.equal(f.cf.calls.some(c=>c.upload),true);
  assert.ok(f.events.indexOf('retrieve')>f.events.indexOf('retain'));
  assert.ok(r.record.invalidation.invalidated.length>=2);
  assert.ok(r.requiredGates.includes('pre-commit-hooks'));
  assert.ok(['repair:replay','repair:attempt'].includes((await f.flow.run(f.raw)).finding));
}));
test('AC1: Final Review classified failure uses current independent collection',t=>use(t,async f=>{
  const {fixture,context}=await import('../tooling/evidence-fixture.mjs');
  const raw=fixture('shaper-review');raw.binding=f.pin.binding;raw.inputs.candidate=f.f.workspace.candidate;
  raw.execution.request='final-request';f.pin.source.kind='shaper-review';
  const expected=structuredClone(raw);f.caps.evidenceCurrent=()=>context(expected);
  raw.result=f.raw.result;
  assert.equal((await f.fresh().run(raw)).disposition,'repair');
}));
test('AC1/7: authority and external categories retain safe history without repair',t=>use(t,async f=>{
  for(const [failureClass,disposition] of [['authority_gap','replan'],['external_failure','wait']]) {
    f.raw.result={version:1,outcome:'blocked',failureClass,summary:'Unavailable prerequisite',conflicts:[]};
    const r=await f.fresh().run(f.raw);assert.equal(r.disposition,disposition);
    assert.ok(r.ref);assert.equal(r.record.disposition,disposition);
  }
  assert.ok(!f.events.includes('diagnosis-start'));
}));
test('AC1: malformed, stale, foreign, replayed and unsupported intake cannot repair',t=>use(t,async f=>{
  for(const change of [r=>r.binding.issueId='foreign',r=>r.binding.policy='b'.repeat(64),
    r=>r.inputs.candidate.tree='c'.repeat(40),r=>r.execution.id='writer',
    r=>r.stage='deliver',r=>r.result.authorized=true,r=>r.result.failureClass='none']) {
    const raw=structuredClone(f.raw);change(raw);
    assert.equal((await f.fresh().run(raw)).outcome,'blocked');
  }
  const original=f.caps.evidenceCurrent;
  f.caps.evidenceCurrent=async id=>({...await original(id),consumed:[f.raw.execution.result]});
  assert.equal((await f.fresh().run(f.raw)).outcome,'blocked');assert.equal(f.saved.length,0);
}));
test('AC1: trusted failed CI without independent defect proof waits; proven defect repairs',t=>use(t,async f=>{
  const observation={status:'failed',binding:f.pin.binding,candidate:f.pin.attempt.candidate,run:'local-fixture'};
  f.pin.source={kind:'ci',observation};
  assert.equal((await f.flow.run(observation)).disposition,'wait');
  assert.equal((await f.fresh().run({...observation,status:'success'})).outcome,'blocked');
  f.pin.source.classification=f.raw;
  assert.equal((await f.fresh().run(observation)).disposition,'repair');
}));
test('AC2: until-conformant continues beyond historical count; bounded charges only durable releases',t=>use(t,async f=>{
  for(let n=0;n<4;n++) {
    const r=await f.flow.run(f.raw);assert.equal(r.disposition,'repair');f.advance(r);
  }
  f.pin.policy.mode='bounded';f.pin.policy.maxRepairs=5;
  const last=await f.flow.run(f.raw);assert.equal(last.disposition,'repair');f.advance(last);
  assert.equal((await f.flow.run(f.raw)).finding,'repair:bounded');
  assert.equal(f.saved.length,5);
  const bytes=f.saved[4].payloads.get('history.json');assert.equal(JSON.parse(bytes).length,4);
}));
test('AC2: invalid policy, expiry, revocation, gates, operation denial and dependency loss block',t=>use(t,async f=>{
  const original=structuredClone(f.pin);
  for(const change of [()=>delete f.pin.policy,()=>f.pin.policy.mode='unknown',()=>f.pin.policy.identity='wrong',
    ()=>f.pin.policy.expiresAt=1000,()=>f.pin.policy.revoked=true,()=>f.pin.gates[0].status='failed',
    ()=>f.state.authorized=false,()=>f.state.dependencies='waiting',
    ()=>{f.pin.policy.mode='bounded';f.pin.policy.maxRepairs=-1;}]) {
    Object.assign(f.pin,structuredClone(original));f.state.authorized=true;f.state.dependencies='ready';change();
    assert.equal((await f.fresh().run(f.raw)).outcome,'blocked');
  }
  assert.equal(f.saved.length,0);
}));
test('AC2/7: checkpoints after retention stop changed authority without exposing backend errors',t=>use(t,async f=>{
  f.state.onRetain=()=>f.pin.policy.revoked=true;
  assert.equal((await f.flow.run(f.raw)).outcome,'blocked');
  assert.equal(f.saved.length,1);
  f.pin.policy.revoked=false;f.state.onRetain=null;f.state.retention='failed';
  const flow=f.fresh(), r=await flow.run(f.raw);
  assert.equal(r.disposition,'reconcile');assert.ok(!JSON.stringify(r).includes('SECRET'));
  f.state.retention='ok';assert.equal((await flow.run(f.raw)).disposition,'reconcile');
}));
test('AC3: missing/tampered custody and ambiguous old effects prevent replacement',t=>use(t,async f=>{
  for(const mode of ['missing','tampered']) {
    f.state.retention=mode;assert.equal((await f.fresh().run(f.raw)).disposition,'reconcile');
  }
  f.state.retention='ok';
  for(const key of ['execution','writes']) {
    const old=f.pin.effects[key];f.pin.effects[key]='unknown';const count=f.saved.length;
    assert.equal((await f.fresh().run(f.raw)).finding,'repair:effects');
    assert.equal(f.saved.length,count);f.pin.effects[key]=old;
  }
  f.pin.attempt.candidate.diff='b'.repeat(64);
  assert.equal((await f.fresh().run(f.raw)).outcome,'blocked');
}));
test('AC4: fresh read-only lifecycle diagnosis binds actual workspace and returns concrete corrections',t=>use(t,async f=>{
  f.concern();let task;
  f.state.onPrepare=x=>task=x.task;
  const r=await f.flow.run(f.raw);
  assert.equal(r.disposition,'repair');assert.equal(r.record.diagnosis.execution.role,'shape-diagnosis');
  assert.match(r.record.diagnosis.result.summary,/correct binary/);
  assert.deepEqual(task.attempt,f.pin.attempt);assert.deepEqual(task.workspace,JSON.parse(exportWorkspace(f.f.workspace)));
  assert.equal(task.scopeBody,f.pin.scopeBody);assert.equal(task.shapeBody,f.pin.shapeBody);
  assert.equal(r.record.diagnosis.execution.skill,'shape');
}));
test('AC4: independent identity, role, missing result and unresolved termination cannot release repair',t=>use(t,async f=>{
  f.concern();
  for(const change of [x=>x.input.execution.id=f.raw.execution.id,x=>x.input.execution.request=f.raw.execution.request,
    x=>x.input.execution.role='accept',x=>x.input.binding.issueId='other']) {
    f.state.onPrepare=change;assert.equal((await f.fresh().run(f.raw)).outcome,'blocked');
  }
  f.state.onPrepare=null;f.state.pending=true;f.state.termination='unknown';
  const flow=f.fresh();assert.equal((await flow.run(f.raw)).disposition,'reconcile');
  assert.equal((await flow.run(f.raw)).disposition,'reconcile');
  f.state.pending=false;f.state.termination='terminated';
  assert.equal((await flow.reconcile()).disposition,'repair');
}));
test('AC5: exact independent conflict permits pre-Merge recovery handoff, never a restoration effect',t=>use(t,async f=>{
  f.concern();f.state.diagnosis='shape_defect';
  const r=await f.flow.run(f.raw);assert.equal(r.disposition,'scope-recovery');assert.equal(r.scopeBody,f.pin.scopeBody);
  assert.equal(r.stopCycle,true);assert.ok(r.requiredGates.includes('shape-validator'));
  assert.equal(r.record.diagnosis.result.failureClass,'shape_defect');
  assert.ok(f.events.includes('invalidate-shape'));
  f.pin.merged=true;assert.equal((await f.fresh().run(f.raw)).finding,'repair:merged');
  f.pin.merged=false;f.pin.recovery.allowed=false;
  assert.equal((await f.fresh().run(f.raw)).finding,'repair:recovery-permission');
}));
test('AC5: independently vary conflict hashes, quotes, reference and attempt/role bindings',t=>use(t,async f=>{
  f.concern();f.state.diagnosis='shape_defect';
  for(const change of [r=>r.result.conflicts[0].scopeHash='b'.repeat(64),r=>r.result.conflicts[0].shapeHash='c'.repeat(64),
    r=>r.result.conflicts[0].scopeQuote='absent scope',r=>r.result.conflicts[0].shapeQuote='absent shape',
    r=>r.result.conflicts[0].evidenceReference='',r=>r.result.conflicts[0].evidenceReference='foreign:reference',
    r=>r.binding.issueId='foreign',
    r=>r.inputs.body='d'.repeat(64),r=>r.execution.role='accept']) {
    f.state.changeDiagnosis=change;const r=await f.fresh().run(f.raw);
    assert.equal(r.outcome,'blocked');assert.notEqual(r.disposition,'scope-recovery');
  }
  assert.equal(f.saved.length,0);
}));
test('AC6: connected evidence drift revokes completion and downstream eligibility; unrelated Issue stays valid',async()=>{
  const changes=[r=>r.deliver.inputs.candidate.base='e'.repeat(40),r=>r.deliver.inputs.candidate.tree='e'.repeat(40),
    r=>r.deliver.inputs.candidate.diff='e'.repeat(64),r=>r.deliver.inputs.candidate.artifacts[0].digest='e'.repeat(64),
    r=>r.deliver.inputs.candidate.hooks[0].digest='e'.repeat(64),r=>r.publication.binding.scopeHash='e'.repeat(64),
    r=>r.publication.binding.shapeHash='e'.repeat(64),r=>r.publication.binding.policy='e'.repeat(64)];
  for(const change of changes) {
    const a=chain(), b=chain(false,false,rs=>Object.values(rs).forEach(r=>r.binding.issueId='unrelated'));
    const fresh=chain(false,false,rs=>{
      Object.values(rs).forEach(r=>r.binding.policy='f'.repeat(64));rs.ci.inputs.policy='f'.repeat(64);
    });
    const ac=chainContext(a), bc=chainContext(b), fc=chainContext(fresh), completion=createCompletion(a,ac);
    const records=[...Object.values(a.receipts),...Object.values(b.receipts),...Object.values(fresh.receipts)];
    const current=Object.fromEntries(records.map(r=>[contentIdentity(r),{expected:structuredClone(r),consumed:[]}]));
    const changed=structuredClone(a.receipts);change(changed);
    for(const [stage,r] of Object.entries(a.receipts))current[contentIdentity(r)].expected=changed[stage];
    const inv=invalidateRepairEvidence({records,current});
    assert.ok(inv.invalidated.includes(contentIdentity(a.receipts.delivered)));
    for(const r of [...Object.values(b.receipts),...Object.values(fresh.receipts)])assert.deepEqual(inv.current[contentIdentity(r)].consumed,[]);
    assert.doesNotThrow(()=>verifyCompletion(createCompletion(fresh,fc),fc));
    const updated=Object.fromEntries(Object.entries(a.receipts).map(([s,r])=>[s,inv.current[contentIdentity(r)]]));
    assert.throws(()=>verifyCompletion(completion,updated));assert.doesNotThrow(()=>verifyCompletion(createCompletion(b,bc),bc));
    const d=dynamicFixture();d.edges.set('1',['2']);const n=d.nodes[1];
    const owned=chain(false,false,rs=>Object.values(rs).forEach(r=>{r.binding.repositoryId=n.repositoryId;r.binding.issueId=n.issueId;}));
    const ctx=chainContext(owned), proof=createCompletion(owned,ctx);
    d.receipts.set(n.issueId,proof);d.contexts.set(n.issueId,{expected:ctx,identity:proof.identity});
    assert.equal((await d.evaluate()).outcome,'ready');
    const revoked=invalidateRepairEvidence({records:Object.values(owned.receipts),
      current:Object.fromEntries(Object.entries(owned.receipts).map(([s,r])=>[contentIdentity(r),ctx[s]])),
      from:{repositoryId:n.repositoryId,issueId:n.issueId,stage:'deliver'}});
    for(const [s,r] of Object.entries(owned.receipts))ctx[s]=revoked.current[contentIdentity(r)];
    assert.notEqual((await d.evaluate()).outcome,'ready');
    assert.equal((await d.evaluate({}, {...d.input,target:d.nodes[2]})).outcome,'ready');
  }
});
test('AC7: no result-supplied capability is accepted; concurrent calls cannot release twice',t=>use(t,async f=>{
  f.raw.result.operations=['invalidate-shape'];
  assert.equal((await f.flow.run(f.raw)).outcome,'blocked');delete f.raw.result.operations;
  let release;const gate=new Promise(r=>release=r), old=f.caps.authorize;
  f.caps.authorize=async i=>{await gate;return old(i);};const flow=f.fresh();const first=flow.run(f.raw);
  assert.equal((await flow.run(f.raw)).disposition,'reconcile');release();
  assert.equal((await first).disposition,'repair');
  assert.throws(()=>createRepairFlow({}));
}));
test('AC2: signed repair selection and official authorization boundary reject policy drift and revoked grants',t=>use(t,async f=>{
  const {generateKeyPairSync}=await import('node:crypto');
  const {grantFixture,grantContext}=await import('../tooling/grant-fixture.mjs');
  const {bodyDigest,signGrant,createAuthorizationBoundary}=await import('../src/index.mjs');
  const payload=grantFixture(bodyDigest), repo={id:'42',name:f.pin.repository,visibility:'public'};
  payload.work=[{...payload.work[0],repository:repo,issueId:f.pin.binding.issueId,number:'97'}];
  payload.permissions=[{repository:repo,paths:['binary'],operations:['repair','diagnose-shape','invalidate-shape']}];
  payload.policy.repair={mode:'until-conformant',maxRepairs:null};
  const keys=generateKeyPairSync('ed25519'), privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'});
  const context=grantContext(payload,keys.publicKey.export({type:'spki',format:'pem'}));
  const grant=signGrant(payload,{keyId:'owner-1',privateKey});let operation='repair';
  const prefix='/repos/'+repo.name,calls=[];
  const boundary=createAuthorizationBoundary({identity:'hosted-authorized',maxCheckpointMs:50,now:()=>1100,
    getCheckpoint:()=>({request:{repository:repo,issueId:f.pin.binding.issueId,number:'97',path:'binary',operation},
      member:{id:'7',login:'member'},operator:{id:'app',kind:'service',source:'hosted-authorized',trusted:true},grant,grantContext:context}),
    transport:async r=>{calls.push(r);return {status:200,body:JSON.stringify(r.endpoint===prefix
      ?{id:'42',full_name:repo.name,private:false,visibility:'public',owner:{login:'owner',type:'User'}}
      :r.endpoint===prefix+'/issues/97'?{id:'97',node_id:f.pin.binding.issueId,number:'97',repository_url:'https://api.github.com'+prefix,assignees:[{id:'7',login:'member'}]}
      :r.endpoint.endsWith('/permission')?{user:{id:'7',login:'member'},permission:'write'}:{id:'7',login:'member'})};}});
  f.caps.authorize=async intent=>{
    operation=intent.operation;
    if(intent.repairPolicy.mode!==grant.payload.policy.repair.mode
      || intent.repairPolicy.identity!==f.pin.binding.policy)return {ok:false};
    return boundary.eligibility(intent);
  };
  assert.equal((await f.fresh().run(f.raw)).disposition,'repair');assert.ok(calls.length>=12);
  f.pin.policy.mode='bounded';f.pin.policy.maxRepairs=4;
  assert.equal((await f.fresh().run(f.raw)).finding,'repair:checkpoint');f.pin.policy.mode='until-conformant';
  context.revocation.revokedRecords=[payload.recordId];
  assert.equal((await f.fresh().run(f.raw)).finding,'repair:checkpoint');
  context.revocation.revokedRecords=[];payload.permissions[0].operations=['deliver'];
  const other=signGrant(payload,{keyId:'owner-1',privateKey});Object.assign(grant,other);
  assert.equal((await f.fresh().run(f.raw)).finding,'repair:checkpoint');
  for(const repair of [{mode:'bounded',maxRepairs:-1},{mode:'until-conformant',maxRepairs:2},{mode:'unknown',maxRepairs:null}]) {
    payload.policy.repair=repair;assert.throws(()=>signGrant(payload,{keyId:'owner-1',privateKey}));
  }
  assert.ok(calls.every(r=>r.method==='GET'));
}));
test('AC2: pending history cannot hide a bounded reservation; duplicate attempt consumes no extra start',t=>use(t,async f=>{
  f.pin.policy.mode='bounded';f.pin.policy.maxRepairs=1;
  const r=await f.flow.run(f.raw);assert.equal(r.disposition,'repair');
  const again=await f.flow.run(f.raw);assert.equal(again.outcome,'blocked');
  f.advance(r);f.pin.history=[];
  assert.equal((await f.flow.run(f.raw)).finding,'repair:bounded');assert.equal(f.saved.length,1);
  f.pin.history=[{repositoryId:f.pin.binding.repositoryId,issueId:f.pin.binding.issueId,attempt:'malformed'}];
  assert.equal((await f.fresh().run(f.raw)).finding,'repair:history');
}));
