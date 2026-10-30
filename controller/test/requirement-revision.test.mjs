import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical,digest,binding } from '../src/core.mjs';
import { signGrant } from '../src/authority.mjs';
import { unitId,projectUnit,ready } from '../src/dynamic.mjs';
import { attachRequirementRevision,verifyRequirementRevision,verifyRevisionHolds,migrateRequirements,assertRevisionExecution,
  revisionDependency,revisionHash } from '../src/requirement-revision.mjs';
import { revisionFixture,releaseFixtureCrashLocks } from './requirement-revision-fixture.mjs';
import { ownerHold } from '../src/owner-hold.mjs';
import { shape,deliver } from './fixtures.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'nibfin-revision-'));t.after(()=>rm(root,{recursive:true,force:true}));return revisionFixture(root);}
const child=(f,mode)=>spawnSync(process.execPath,[fileURLToPath(new URL('./requirement-revision-fixture.mjs',import.meta.url)),'--child',f.root,mode],{encoding:'utf8'});

test('all 70 unaffected projections, unit identities and historical states remain byte-identical',async t=>{
  const f=await fixture(t), original=canonical(f.grant), history=canonical(f.data.states);
  const before=f.grant.manifest.issues.map(i=>({unit:unitId(f.grant,i),projection:canonical(projectUnit(f.grant,i))}));
  attachRequirementRevision(f.grant,f.record);
  for(const [n,i]of f.grant.manifest.issues.entries()){
    const projected=projectUnit(f.grant,i);
    if(n<6){assert.notEqual(unitId(f.grant,i),before[n].unit);assert.notEqual(canonical(projected),before[n].projection);
      assert.equal(projected.manifest.freezeRevision,'new-freeze');assert.equal(projected.manifest.issues[0].scopeHash,f.record.subjects[n].newScopeHash);
      assert.equal(projected.recordId,f.record.recordId);assert.equal(projected.approval.recordId,f.record.recordId);
      assert.equal(projected.manifest.dynamicParent.recordId,f.grant.recordId);
    }else{assert.equal(unitId(f.grant,i),before[n].unit);assert.equal(canonical(projected),before[n].projection);}
  }
  assert.equal(canonical(f.grant),original);await migrateRequirements(f.record,f.host);
  assert.equal(canonical(f.data.states),history);assert.equal(canonical(f.grant),original);
  assert.equal(f.data.writes.length,7);assert.equal(new Set(f.data.writes).size,7);
  const state=await f.host.store.read();assert.equal(state.phase,'active');assert.equal(state.archives.length,6);
  assert.equal(state.oldShapeRetirement[0].status,'superseded-not-passed');
});
for(const fault of ['signature','parent','seventh-subject','scope','shape','compatibility','operations','core'])test(`signed revision rejects ${fault}`,async t=>{
  const f=await fixture(t), p=structuredClone(f.data.revisionBundle.payload);
  if(fault==='parent')p.parentManifestHash=digest('other');
  if(fault==='seventh-subject')p.subjects.push(p.subjects[0]);
  if(fault==='scope')p.subjects[0].newScopeHash=digest('wrong');
  if(fault==='shape')p.subjects[1].oldShapeHash=null;
  if(fault==='compatibility')p.compatibility=[];
  if(fault==='operations')p.approvedOperations.push('merge');
  if(fault==='core')p.requiredCoreDigest='floating';
  const bundle=signGrant(p,f.data.privateKey);if(fault==='signature')bundle.signature='bad';
  assert.throws(()=>verifyRequirementRevision(bundle,f.grant,f.data.publicKey));assert.equal(f.data.writes.length,0);
});
test('cached old authority cannot bypass a fence and an old queued Run cannot acquire the new cycle',async t=>{
  const f=await fixture(t),i=f.grant.manifest.issues[0];await migrateRequirements(f.record,f.host);
  await assert.rejects(assertRevisionExecution(f.runtime,f.grant,i),{code:'REQUIREMENT_MIGRATION_HELD'});
  attachRequirementRevision(f.grant,f.record);await assertRevisionExecution(f.runtime,f.grant,i);
  await assert.rejects(assertRevisionExecution(f.runtime,f.grant,i,null),{code:'STALE_REQUIREMENT_REQUEST'});
  await assertRevisionExecution(f.runtime,f.grant,i,revisionHash(f.grant,i));
  f.runtime.github.api=async()=>({id:100,created_at:'2020-01-01T00:00:00Z'});
  await assert.rejects(assertRevisionExecution(f.runtime,f.grant,i),{code:'STALE_REQUIREMENT_RUN'});
  await assertRevisionExecution(f.runtime,f.grant,f.grant.manifest.issues[9]);
});
test('lost successful response is independently reconciled, never written twice',async t=>{
  const f=await fixture(t),lost=await revisionFixture(f.root,{loseResponse:true});
  await assert.rejects(migrateRequirements(lost.record,lost.host),{code:'REVISION_WRITE_OUTCOME_UNKNOWN'});
  assert.equal(lost.data.writes.length,1);assert.equal((await lost.host.store.read()).operations[0].status,'unknown');
  const resumed=await revisionFixture(f.root);await migrateRequirements(resumed.record,resumed.host);
  assert.equal(resumed.data.writes.length,7);assert.equal(new Set(resumed.data.writes).size,7);
});
test('distinct process crash after provider success reconciles the attempted intent',async t=>{
  const f=await fixture(t),dead=child(f,'afterWriteExit');assert.equal(dead.status,24);
  await assert.rejects(migrateRequirements(f.record,f.host),{code:'EEXIST'});
  await releaseFixtureCrashLocks(f,dead);
  const resumed=await revisionFixture(f.root);await migrateRequirements(resumed.record,resumed.host);
  assert.equal(resumed.data.writes.length,7);assert.equal(new Set(resumed.data.writes).size,7);
});
test('distinct process dies before submission: attempted but absent remains blocked without blind replay',async t=>{
  const f=await fixture(t),dead=child(f,'beforeWriteExit');assert.equal(dead.status,23);
  await assert.rejects(migrateRequirements(f.record,f.host),{code:'EEXIST'});
  await releaseFixtureCrashLocks(f,dead);
  const resumed=await revisionFixture(f.root);await assert.rejects(migrateRequirements(resumed.record,resumed.host),{code:'REVISION_PROVIDER_DRIFT'});
  assert.equal(resumed.data.writes.length,0);assert.equal((await resumed.host.store.read()).phase,'fenced');
});
for(const fault of ['metadata','body','native-edge','pending','candidate','archive','core'])test(`preflight ${fault} blocks provider writes`,async t=>{
  const f=await fixture(t);
  if(fault==='metadata')f.data.observations.I_0.metadataHash=digest('changed');
  if(fault==='body')f.data.observations.I_0.bodyHash=digest('changed');
  if(fault==='native-edge')f.data.observations.I_0.blockedBy.push('outside');
  if(fault==='pending'||fault==='candidate'){const history=f.host.history;f.host.history=async s=>({...await history(s),[fault]:true});}
  if(fault==='archive')f.host.archive=async()=>({digest:digest('x'),verified:false});
  if(fault==='core')f.host.installedCoreDigest=digest('wrong');
  await assert.rejects(migrateRequirements(f.record,f.host));assert.equal(f.data.writes.length,0);
});
test('concurrent operators cannot duplicate writes',async t=>{
  const f=await fixture(t);const results=await Promise.allSettled([migrateRequirements(f.record,f.host),migrateRequirements(f.record,f.host)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.data.writes.length,7);
});
test('orphan journal operations and unavailable archives block recovery before further provider writes',async t=>{
  const f=await fixture(t);await migrateRequirements(f.record,f.host);
  const state=await f.host.store.read();await f.host.store.transaction(state.revision,s=>({...s,operations:[...s.operations,{id:'orphan',status:'intent'}]}));
  await assert.rejects(migrateRequirements(f.record,f.host),{code:'REVISION_JOURNAL_INVALID'});assert.equal(f.data.writes.length,7);
  const g=await fixture(t);const lost=await revisionFixture(g.root,{loseResponse:true});await assert.rejects(migrateRequirements(lost.record,lost.host));
  const resumed=await revisionFixture(g.root,{badArchive:true});await assert.rejects(migrateRequirements(resumed.record,resumed.host));assert.equal(resumed.data.writes.length,1);
});
test('failure to persist attempted intent makes zero provider calls',async t=>{
  const f=await fixture(t),transaction=f.host.store.transaction.bind(f.host.store);
  f.host.store.transaction=async(revision,fn)=>transaction(revision,s=>{const next=fn(s);if(next.operations?.some(o=>o.status==='attempted'))throw Error('disk failed');return next;});
  await assert.rejects(migrateRequirements(f.record,f.host));assert.equal(f.data.writes.length,0);
});
test('cross-cycle dependency needs an active signed compatibility edge; unchanged edges preserve existing behavior',async t=>{
  const f=await fixture(t), [a,,,release,,,,consumer]=f.grant.manifest.issues;attachRequirementRevision(f.grant,f.record);
  await assert.rejects(revisionDependency(f.runtime,f.grant,a,release),{code:'CROSS_CYCLE_REVISION_UNAVAILABLE'});
  await migrateRequirements(f.record,f.host);
  assert.equal(await revisionDependency(f.runtime,f.grant,a,release),true);
  assert.equal(await revisionDependency(f.runtime,f.grant,release,consumer),true);
  await assert.rejects(revisionDependency(f.runtime,f.grant,a,consumer),{code:'CROSS_CYCLE_COMPATIBILITY_DENIED'});
  assert.equal(await revisionDependency(f.runtime,f.grant,consumer,f.grant.manifest.issues[9]),false);
});
test('a delivered label alone cannot satisfy an approved cross-cycle prerequisite',async t=>{
  const f=await fixture(t);attachRequirementRevision(f.grant,f.record);await migrateRequirements(f.record,f.host);
  class IncompleteRuntime{
    constructor(config,root,github){this.config=config;this.root=root;this.github=github;}
    async execute(){throw Error('No execution allowed in dependency inspection');}
    async observe(){return {};}
  }
  const github={...f.runtime.github,repository:async repository=>({id:repository.includes('/gh-')?'2':'1'}),
    issue:async i=>({node_id:i.id,labels:[{name:'scope'},{name:'delivered'}]}),dependencies:async i=>i.dependencies.map(node_id=>({node_id}))};
  const runtime=new IncompleteRuntime(f.runtime.config,f.root,github);
  Object.assign(runtime,{grant:async()=>f.grant,installedCoreDigest:f.record.requiredCoreDigest,actionIdentity:f.runtime.actionIdentity});
  await assert.rejects(ready(runtime,f.grant,f.grant.manifest.issues[3]),{code:'CROSS_CYCLE_COMPLETION_UNVERIFIED'});
});
test('journal directory sync failure prevents the first external write',async t=>{
  const f=await fixture(t);f.host.syncJournal=async()=>{throw Error('Directory sync unavailable');};
  await assert.rejects(migrateRequirements(f.record,f.host));assert.equal(f.data.writes.length,0);
});
test('old signed negative holds are retained and become ineffective only for their explicitly approved active replacement cycle',async t=>{
  const f=await fixture(t),i=f.grant.manifest.issues[0],hold={issueId:i.id,repository:i.repository,holdHash:digest('old-hold'),reason:'Old cycle must not resume'};
  f.runtime.ownerExecutionHolds=[hold];const original=canonical(f.runtime.ownerExecutionHolds);
  const p=structuredClone(f.data.revisionBundle.payload);p.retiredHoldHashes=[hold.holdHash];
  f.data.revisionBundle=signGrant(p,f.data.privateKey);
  const record=verifyRequirementRevision(f.data.revisionBundle,f.grant,f.data.publicKey);
  verifyRevisionHolds(record,[hold]);assert.throws(()=>verifyRevisionHolds(record,[]));
  attachRequirementRevision(f.grant,record);assert.equal(ownerHold(f.runtime,i),hold);
  await migrateRequirements(record,f.host);assert.equal(ownerHold(f.runtime,i),hold);
  await assertRevisionExecution(f.runtime,f.grant,i);assert.equal(ownerHold(f.runtime,i),null);
  assert.equal(canonical(f.runtime.ownerExecutionHolds),original);
  const state=await f.host.store.read();await f.host.store.transaction(state.revision,s=>({...s,phase:'fenced'}));
  await assert.rejects(assertRevisionExecution(f.runtime,f.grant,i));assert.equal(ownerHold(f.runtime,i),hold);
});
test('fresh Core completion under each correct old/new binding admits approved cross-cycle prerequisites',async t=>{
  const f=await fixture(t);attachRequirementRevision(f.grant,f.record);await migrateRequirements(f.record,f.host);
  class ProvenRuntime{
    constructor(config,root,github){this.config=config;this.root=root;this.github=github;}
    async execute(){throw Error('Dependency reads cannot execute');}
    async observe(g){const i=g.manifest.issues[0],p=g.policy;
      const fixture={manifest:g.manifest,policy:p,snapshot:{manifestHash:digest(g.manifest),policyHash:digest(p),approval:g.approval,
        runtime:{trusted:true,isolated:true,coreDigest:p.coreDigest,runnerId:p.runnerId,agent:'codex-chatgpt',authenticated:true},
        issues:{[i.id]:{...i,visibility:'private',bodyHash:i.scopeHash,labels:['scope'],state:'open',defaultHead:'a'.repeat(40),repairs:0,sameRootCauseFailures:0}}}};
      shape(fixture,i.id);deliver(fixture,i.id,true);return fixture.snapshot;}
  }
  const github={...f.runtime.github,repository:async repository=>({id:repository.includes('/gh-')?'2':'1'}),
    issue:async i=>({node_id:i.id,labels:[{name:'scope'},{name:'delivered'}]}),dependencies:async i=>i.dependencies.map(node_id=>({node_id}))};
  const runtime=new ProvenRuntime(f.runtime.config,f.root,github);
  Object.assign(runtime,{grant:async()=>f.grant,installedCoreDigest:f.record.requiredCoreDigest,actionIdentity:f.runtime.actionIdentity});
  const result=await ready(runtime,f.grant,f.grant.manifest.issues[3]);
  assert.equal(result.issueId,'I_3');assert.equal(result.proofs.length,4);
  assert.ok(result.proofs.every(p=>/^[a-f0-9]{64}$/.test(p.completionHash)));
});
