import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical,digest } from '../src/core.mjs';
import { signGrant } from '../src/authority.mjs';
import { projectUnit,unitId } from '../src/dynamic.mjs';
import { revisionFixture } from './requirement-revision-fixture.mjs';
import { attachRequirementRevision,attachRevisionCoreRepair,migrateRequirements,assertRevisionExecution } from '../src/requirement-revision.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'nibfin-core-repair-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const f=await revisionFixture(root);attachRequirementRevision(f.grant,f.record);await migrateRequirements(f.record,f.host);
  f.runtime.installedCoreDigest=digest('repaired-core');
  const payload={schemaVersion:1,kind:'owner-revision-core-repair',parentRecordId:f.grant.recordId,
    parentManifestHash:digest(f.grant.manifest),parentPolicyHash:digest(f.grant.policy),runtimeHash:f.grant.policy.runtimeHash,
    requirementRevisionHash:f.record.revisionHash,fromCoreDigest:f.record.requiredCoreDigest,toCoreDigest:f.runtime.installedCoreDigest,
    sourceCommit:'a'.repeat(40),recoveryPlanHash:digest('reviewed-exact-plan'),
    subjectsHash:digest(f.record.subjects.map(s=>({issueId:s.issueId,scopeHash:s.newScopeHash}))),
    allowedEffects:['execute-existing-six-cycles'],eventRepair:'provider-native-cycle-boundary-v1',reason:'Owner reviewed scoped event-boundary repair'};
  payload.legacyPublicationBounds=[];
  return {...f,payload};
}

test('unsigned upgrade still refuses execution; exact separate amendment preserves all 76 identities and bindings',async t=>{
  const f=await fixture(t),issue=f.grant.manifest.issues[0],before=f.grant.manifest.issues.map(i=>({id:unitId(f.grant,i),view:canonical(projectUnit(f.grant,i))})),grant=canonical(f.grant),states=canonical(f.data.states);
  await assert.rejects(assertRevisionExecution(f.runtime,f.grant,issue),{code:'REVISION_CORE_NOT_INSTALLED'});
  const repair=attachRevisionCoreRepair(signGrant(f.payload,f.data.privateKey),f.grant,f.data.publicKey,f.runtime.installedCoreDigest);
  assert.equal(repair.verified,undefined,'Only private attachment is authoritative');
  await assertRevisionExecution(f.runtime,f.grant,issue);
  f.grant.manifest.issues.forEach((i,n)=>{assert.equal(unitId(f.grant,i),before[n].id);assert.equal(canonical(projectUnit(f.grant,i)),before[n].view);});
  assert.equal(canonical(f.grant),grant);assert.equal(canonical(f.data.states),states);
  const journal=await f.host.store.read();await f.host.store.transaction(journal.revision,s=>({...s,phase:'fenced'}));
  await assert.rejects(assertRevisionExecution(f.runtime,f.grant,issue),{code:'REQUIREMENT_MIGRATION_HELD'});
  await assertRevisionExecution(f.runtime,f.grant,f.grant.manifest.issues[9]);
});

for(const field of ['parentRecordId','parentManifestHash','parentPolicyHash','runtimeHash','requirementRevisionHash','fromCoreDigest','toCoreDigest','subjectsHash','sourceCommit','recoveryPlanHash','eventRepair','allowedEffects'])
test(`signed but altered ${field} cannot relax the exact revision pin`,async t=>{
  const f=await fixture(t),p=structuredClone(f.payload);p[field]=field==='allowedEffects'?['merge','release-fence']:'other';
  assert.throws(()=>attachRevisionCoreRepair(signGrant(p,f.data.privateKey),f.grant,f.data.publicKey,f.runtime.installedCoreDigest));
  await assert.rejects(assertRevisionExecution(f.runtime,f.grant,f.grant.manifest.issues[0]),{code:'REVISION_CORE_NOT_INSTALLED'});
});

test('foreign signer and serialized verified flags have no authority; amended execution does not authorize raw Scope migration',async t=>{
  const f=await fixture(t),keys=generateKeyPairSync('ed25519');
  const forged={...signGrant(f.payload,keys.privateKey),verified:true};
  assert.throws(()=>attachRevisionCoreRepair(forged,f.grant,f.data.publicKey,f.runtime.installedCoreDigest),{code:'REVISION_CORE_REPAIR_SIGNATURE_INVALID'});
  attachRevisionCoreRepair(signGrant(f.payload,f.data.privateKey),f.grant,f.data.publicKey,f.runtime.installedCoreDigest);
  f.host.installedCoreDigest=f.runtime.installedCoreDigest;
  await assert.rejects(migrateRequirements(f.record,f.host),{code:'REVISION_CORE_NOT_INSTALLED'});
  assert.equal(f.data.writes.length,7);
});

for(const fault of ['seventh','duplicate','time','evidence','receipt'])test(`legacy publication recovery rejects ${fault} bound`,async t=>{
  const f=await fixture(t),bound={issueId:f.record.subjects[0].issueId,mutationReceiptHash:digest('receipt'),notBefore:'2026-10-24T00:00:00Z',evidenceHash:digest('log')};
  if(fault==='seventh')bound.issueId=f.grant.manifest.issues[6].id;
  if(fault==='time')bound.notBefore='unknown';
  if(fault==='evidence')bound.evidenceHash='unknown';
  if(fault==='receipt')bound.mutationReceiptHash='unknown';
  f.payload.legacyPublicationBounds=fault==='duplicate'?[bound,bound]:[bound];
  assert.throws(()=>attachRevisionCoreRepair(signGrant(f.payload,f.data.privateKey),f.grant,f.data.publicKey,f.runtime.installedCoreDigest),{code:'REVISION_LEGACY_BOUND_INVALID'});
});

test('recovery keeps public publication history but requires private Runs created after the exact repair activation',async t=>{
 const f=await fixture(t),issue=f.grant.manifest.issues[0];
 attachRevisionCoreRepair(signGrant(f.payload,f.data.privateKey),f.grant,f.data.publicKey,f.runtime.installedCoreDigest);
 const s=await f.host.store.read(),resumedAt=new Date(Date.parse(s.activation.at)+1000).toISOString();
 await f.host.store.transaction(s.revision,x=>({...x,runtimeRecovery:{revisionHash:f.record.revisionHash,
   coreDigest:f.runtime.installedCoreDigest,recoveryPlanHash:f.payload.recoveryPlanHash,resumedAt}}));
 f.runtime.github.api=async()=>({id:100,created_at:s.activation.at});
 await assert.rejects(assertRevisionExecution(f.runtime,f.grant,issue),{code:'STALE_REQUIREMENT_RUN'});
 f.runtime.github.api=async()=>({id:100,created_at:resumedAt});await assertRevisionExecution(f.runtime,f.grant,issue);
 const active=await f.host.store.read();await f.host.store.transaction(active.revision,x=>({...x,runtimeRecovery:{...x.runtimeRecovery,recoveryPlanHash:digest('other')}}));
 await assert.rejects(assertRevisionExecution(f.runtime,f.grant,issue),{code:'REVISION_RUNTIME_RECOVERY_INVALID'});
 await assertRevisionExecution(f.runtime,f.grant,f.grant.manifest.issues[9]);
});

test('a separately signed exact retained recovery permits a Core-only upgrade without rewriting six old cycles',async t=>{
 const f=await fixture(t),issue=f.grant.manifest.issues[0],s=await f.host.store.read();
 const recovery={revisionHash:f.record.revisionHash,coreDigest:digest('previous-installed-core'),
   recoveryPlanHash:f.payload.recoveryPlanHash,resumedAt:s.activation.at};
 await f.host.store.transaction(s.revision,x=>({...x,runtimeRecovery:recovery}));
 attachRevisionCoreRepair(signGrant(f.payload,f.data.privateKey),f.grant,f.data.publicKey,f.runtime.installedCoreDigest);
 await assert.rejects(assertRevisionExecution(f.runtime,f.grant,issue),{code:'REVISION_RUNTIME_RECOVERY_INVALID'});
 const before=canonical(await f.host.store.read());f.payload.retainedRecoveryHash=digest(recovery);
 attachRevisionCoreRepair(signGrant(f.payload,f.data.privateKey),f.grant,f.data.publicKey,f.runtime.installedCoreDigest);
 await assertRevisionExecution(f.runtime,f.grant,issue);assert.equal(canonical(await f.host.store.read()),before);
 const live=await f.host.store.read();await f.host.store.transaction(live.revision,x=>({...x,runtimeRecovery:{...recovery,resumedAt:new Date().toISOString()}}));
 await assert.rejects(assertRevisionExecution(f.runtime,f.grant,issue),{code:'REVISION_RUNTIME_RECOVERY_INVALID'});
});
