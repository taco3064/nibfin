import { websiteRevisionFor, websiteRevisionProjection, websiteRevisionBoundary, assertWebsiteRevision, websiteRevisionDependency } from './website-revision.mjs';
import { createPublicKey, verify } from 'node:crypto';
import { canonical, digest } from './core.mjs';
import { Store } from './store.mjs';
import { issueScopeProjection } from './issue-scope.mjs';
import { assigneeRevisionFor, assigneeRevisionProjection, assigneeRevisionBoundary,
  assertAssigneeRevision, assigneeRevisionDependency } from './assignee-revision.mjs';

const views = new WeakMap(), authentic = new WeakSet(), admitted = new WeakMap(), coreRepairs = new WeakMap();
const hash = x => /^[a-f0-9]{64}$/.test(x || '');
const same = (a,b) => canonical(a) === canonical(b);
const freeze=value=>{if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const subjects = ['taco3064/nibfin#10','taco3064/nibfin#11','taco3064/nibfin#13',
  'taco3064/nibfin#42','taco3064/nibfin#53','taco3064/gh-nibfin#11'];
export const revisionStore = (root, grant) => new Store(root, `requirement-revision:${grant.recordId}`);
export const revisionFor = (grant, issue) => websiteRevisionFor(grant,issue) || assigneeRevisionFor(grant,issue) || views.get(grant)?.subjects.find(s => s.issueId === issue.id) || null;
export const revisionHash = (grant, issue) => revisionFor(grant, issue)?.revisionHash || null;

// A separately signed execution-only compatibility append. Do not edit/re-sign
// the requirement record: its hash binds the existing six unit identities.
export function attachRevisionCoreRepair(bundle,grant,publicKey,installedDigest) {
  const record=views.get(grant),p=bundle?.payload,key=createPublicKey(publicKey);
  need(record && p && key.asymmetricKeyType==='ed25519' && verify(null,Buffer.from(canonical(p)),key,
    Buffer.from(bundle.signature || '', 'base64')), 'REVISION_CORE_REPAIR_SIGNATURE_INVALID');
  need(p.schemaVersion===1 && p.kind==='owner-revision-core-repair' && p.parentRecordId===grant.recordId &&
    p.parentManifestHash===digest(grant.manifest) && p.parentPolicyHash===digest(grant.policy) && p.runtimeHash===grant.policy.runtimeHash &&
    p.requirementRevisionHash===record.revisionHash && p.fromCoreDigest===record.requiredCoreDigest &&
    hash(p.toCoreDigest) && p.toCoreDigest===installedDigest && p.toCoreDigest!==p.fromCoreDigest &&
    /^[a-f0-9]{40}$/.test(p.sourceCommit || '') && hash(p.recoveryPlanHash) &&
    p.subjectsHash===digest(record.subjects.map(s=>({issueId:s.issueId,scopeHash:s.newScopeHash}))) &&
    same(p.allowedEffects,['execute-existing-six-cycles']) && p.eventRepair==='provider-native-cycle-boundary-v1' &&
    typeof p.reason==='string' && p.reason.trim(), 'REVISION_CORE_REPAIR_AUTHORITY_INVALID');
  need(p.retainedRecoveryHash===undefined || hash(p.retainedRecoveryHash), 'REVISION_RETAINED_RECOVERY_INVALID');
  need(Array.isArray(p.legacyPublicationBounds) && p.legacyPublicationBounds.length<=3 &&
    new Set(p.legacyPublicationBounds.map(b=>b.issueId)).size===p.legacyPublicationBounds.length &&
    p.legacyPublicationBounds.every(b=>record.subjects.some(s=>s.issueId===b.issueId && s.repository==='taco3064/nibfin' && [10,11,13].includes(s.number)) &&
      hash(b.mutationReceiptHash) && hash(b.evidenceHash) && Number.isFinite(Date.parse(b.notBefore))), 'REVISION_LEGACY_BOUND_INVALID');
  const result=freeze({...structuredClone(p),amendmentHash:digest(bundle)});
  coreRepairs.set(grant,result);return result;
}

export function revisionPublicationCutoff(grant,issue,state,previous) {
  if(previous?.operation!=='publish-shape' || previous.transition?.writeStartedAt || previous.transition?.startedAt)return null;
  const bound=coreRepairs.get(grant)?.legacyPublicationBounds.find(b=>b.issueId===issue.id && b.mutationReceiptHash===digest(previous));
  if(!bound)return null;
  const index=state.actionReceipts.indexOf(previous),validator=state.actionReceipts.slice(0,index).findLast(r=>r.operation==='validate-shape');
  const at=Date.parse(bound.notBefore),validatedAt=Date.parse(validator?.completedAt),completedAt=Date.parse(previous.completedAt);
  need(Number.isFinite(validatedAt) && Number.isFinite(completedAt) && at>=validatedAt && at<=completedAt, 'REVISION_LEGACY_BOUND_INVALID');
  return {at,evidenceHash:bound.evidenceHash,amendmentHash:coreRepairs.get(grant).amendmentHash};
}

export async function revisionEventBoundary(runtime,grant,issue) {
  const website=await websiteRevisionBoundary(runtime,grant,issue);if(website)return website;
  const assignee=await assigneeRevisionBoundary(runtime,grant,issue);if(assignee)return assignee;
  const selected=revisionFor(grant,issue);
  if(!selected)return null;
  const state=await revisionStore(runtime.config.stateDirectory,grant).read();
  need(state.phase==='active' && state.revisionHash===selected.revisionHash && state.subjects?.includes(issue.id), 'REQUIREMENT_MIGRATION_HELD');
  const activatedAt=Date.parse(state.activation?.at);
  need(Number.isFinite(activatedAt) && state.activation.revisionHash===selected.revisionHash &&
    state.activation.archivesHash===digest(state.archives) && state.activation.operationsHash===digest(state.operations), 'REVISION_ACTIVATION_INVALID');
  return {revisionHash:selected.revisionHash,activatedAt,activationAt:state.activation.at};
}

// A signed requirement delta, not a replacement of the 76-subject parent.
// Only this bounded profile is supported; permissions and native edges cannot grow.
export function verifyRequirementRevision(bundle, grant, publicKey) {
  const p=bundle?.payload, key=createPublicKey(publicKey);
  need(p && key.asymmetricKeyType==='ed25519' && verify(null,Buffer.from(canonical(p)),key,
    Buffer.from(bundle.signature || '', 'base64')), 'REVISION_SIGNATURE_INVALID');
  need(p.schemaVersion===1 && p.kind==='owner-requirement-revision' &&
    p.profile==='nibfin-p1-six-subjects-20261024' && typeof p.recordId==='string' && p.recordId!==grant.recordId &&
    p.parentRecordId===grant.recordId && p.parentManifestHash===digest(grant.manifest) &&
    p.parentPolicyHash===digest(grant.policy) && p.parentPayloadHash===digest(Object.fromEntries(
      Object.entries(grant).filter(([k])=>k!=='approval'))) && grant.policy.controlMode==='owner-project', 'REVISION_PARENT_INVALID');
  need(hash(p.planHash) && hash(p.requiredCoreDigest) && typeof p.proposal==='string' &&
    digest(p.proposal)===p.proposalHash && [p.freezeRevision,p.cycleRevision,p.proposalRevision].every(x=>typeof x==='string'&&x.trim()) &&
    p.freezeRevision!==grant.manifest.freezeRevision && p.cycleRevision!==grant.policy.revision &&
    p.approvedOperations && same(p.approvedOperations,['fence-six','archive-six','retire-gemini-shape','replace-six-raw-scopes','activate-six']), 'REVISION_AUTHORITY_INVALID');
  need(Array.isArray(p.retiredHoldHashes) && p.retiredHoldHashes.every(hash) &&
    new Set(p.retiredHoldHashes).size===p.retiredHoldHashes.length, 'REVISION_HOLD_BOUNDARY_INVALID');
  need(Array.isArray(p.subjects) && p.subjects.length===6 &&
    same(p.subjects.map(s=>`${s.repository}#${s.number}`).sort(),[...subjects].sort()) &&
    new Set(p.subjects.map(s=>s.issueId)).size===6, 'REVISION_SUBJECT_SET_INVALID');
  for(const s of p.subjects){
    const old=grant.manifest.issues.find(i=>i.id===s.issueId);
    need(old && /^[\w-]+$/.test(s.issueId) && old.repository===s.repository && old.repositoryId===s.repositoryId && old.number===s.number &&
      old.scopeHash===s.oldScopeHash && hash(s.oldStateHash) && hash(s.oldBodyHash) && hash(s.metadataHash) &&
      typeof s.newScopeBody==='string' && digest(s.newScopeBody)===s.newScopeHash && s.newScopeHash!==s.oldScopeHash &&
      Array.isArray(s.blockedBy) && Array.isArray(s.blocking) && new Set(s.blockedBy).size===s.blockedBy.length &&
      new Set(s.blocking).size===s.blocking.length, 'REVISION_SCOPE_INVALID');
    const gemini=s.repository==='taco3064/nibfin' && s.number===11;
    need(gemini ? hash(s.oldShapeHash) && s.oldBodyHash===s.oldShapeHash && hash(s.retiredMetadataHash) :
      s.oldShapeHash===null && s.oldBodyHash===s.oldScopeHash && s.retiredMetadataHash===s.metadataHash, 'REVISION_SHAPE_BOUNDARY_INVALID');
  }
  need(Array.isArray(p.compatibility) && new Set(p.compatibility.map(e=>`${e.producer}:${e.consumer}`)).size===p.compatibility.length,
    'REVISION_COMPATIBILITY_INVALID');
  const effective=id=>p.subjects.find(s=>s.issueId===id)?.newScopeHash || grant.manifest.issues.find(i=>i.id===id)?.scopeHash;
  const pairs=new Set(p.subjects.flatMap(s=>[...s.blockedBy.map(id=>`${id}:${s.issueId}`),...s.blocking.map(id=>`${s.issueId}:${id}`)]));
  need(p.compatibility.length===pairs.size && p.compatibility.every(e=>hash(e.producerScopeHash) && hash(e.consumerScopeHash) && pairs.has(`${e.producer}:${e.consumer}`) &&
    e.producerScopeHash===effective(e.producer) && e.consumerScopeHash===effective(e.consumer)), 'REVISION_COMPATIBILITY_INVALID');
  const result=freeze({...structuredClone(p),revisionHash:digest(bundle)});
  authentic.add(result); return result;
}
export function attachRequirementRevision(grant, record) {
  need(authentic.has(record),'REVISION_UNVERIFIED');
  views.set(grant,{...record,subjects:record.subjects.map(s=>({...s,revisionHash:record.revisionHash,
    cycleRevision:record.cycleRevision,freezeRevision:record.freezeRevision,proposalRevision:record.proposalRevision,
    proposalHash:record.proposalHash,proposal:record.proposal}))});
  return grant;
}
export function verifyRevisionHolds(record,holds){
  need(same([...record.retiredHoldHashes].sort(),holds.filter(h=>record.subjects.some(s=>s.issueId===h.issueId)).map(h=>h.holdHash).sort()),
    'REVISION_HOLD_BOUNDARY_INVALID');
}
export function revisionRetiresHold(runtime,issue,hold){
  return admitted.get(runtime)?.get(issue.id)?.includes(hold.holdHash)===true;
}
export function revisionProjection(grant, issue) {
  const live=issueScopeProjection(grant,issue);if(live)return live;
  const website=websiteRevisionProjection(grant,issue);if(website)return website;
  const assignee=assigneeRevisionProjection(grant,issue);if(assignee)return assignee;
  const s=views.get(grant)?.subjects.find(s=>s.issueId===issue.id);
  return s ? {issue:{...issue,scopeBody:s.newScopeBody,scopeHash:s.newScopeHash},
    recordId:views.get(grant).recordId,cycleRevision:s.cycleRevision,freezeRevision:s.freezeRevision,proposalRevision:s.proposalRevision,
    proposalHash:s.proposalHash,proposal:s.proposal,revisionHash:s.revisionHash} : null;
}

// Always reread the local fence, even if the caller cached the old signed grant.
// Operator fencing and Issue execution use the same stable Issue leases.
export async function assertRevisionExecution(runtime, grant, issue, requestedCycle) {
  const website=await assertWebsiteRevision(runtime,grant,issue,requestedCycle);if(website)return website;
  const assignee=await assertAssigneeRevision(runtime,grant,issue,requestedCycle);if(assignee)return assignee;
  admitted.get(runtime)?.delete(issue.id);
  const state=await revisionStore(runtime.config.stateDirectory,grant).read();
  const fenced=state.subjects?.includes(issue.id), selected=revisionFor(grant,issue);
  if(!fenced && !selected) return null;
  need(fenced && selected && state.revisionHash===selected.revisionHash && state.phase==='active', 'REQUIREMENT_MIGRATION_HELD');
  need(runtime.installedCoreDigest===views.get(grant).requiredCoreDigest ||
    coreRepairs.get(grant)?.toCoreDigest===runtime.installedCoreDigest,'REVISION_CORE_NOT_INSTALLED');
  need(state.activation && state.activation.revisionHash===state.revisionHash &&
    Number.isFinite(Date.parse(state.activation.at)) && state.activation.archivesHash===digest(state.archives) &&
    state.activation.operationsHash===digest(state.operations), 'REVISION_ACTIVATION_INVALID');
  let runNotBefore=Date.parse(state.activation.at);
  if(state.runtimeRecovery) {
    const recovery=state.runtimeRecovery,repair=coreRepairs.get(grant),at=Date.parse(recovery.resumedAt);
    need(repair && recovery.revisionHash===selected.revisionHash &&
      (recovery.coreDigest===runtime.installedCoreDigest || repair.retainedRecoveryHash===digest(recovery)) &&
      recovery.recoveryPlanHash===repair.recoveryPlanHash && Number.isFinite(at) && at>=runNotBefore && !state.operatorHold,
      'REVISION_RUNTIME_RECOVERY_INVALID');
    runNotBefore=at;
  }
  if(requestedCycle!==undefined) need(requestedCycle===selected.revisionHash,'STALE_REQUIREMENT_REQUEST');
  // Provider creation time, not a new attempt/start time: an old queued Run or
  // rerun cannot acquire the replacement cycle simply because it starts later.
  need(runtime.actionIdentity?.runId,'REVISION_FRESH_ACTION_REQUIRED');
  const run=await runtime.github.api(`/repos/${grant.policy.actionExecution.repository}/actions/runs/${runtime.actionIdentity.runId}`);
  need(String(run.id)===String(runtime.actionIdentity.runId) &&
    Date.parse(run.created_at)>=runNotBefore,'STALE_REQUIREMENT_RUN');
  if(!admitted.has(runtime))admitted.set(runtime,new Map());
  admitted.get(runtime).set(issue.id,views.get(grant).retiredHoldHashes);
  return selected.revisionHash;
}
export async function revisionDependency(runtime,grant,producer,consumer) {
  const website=await websiteRevisionDependency(runtime,grant,producer,consumer);if(website!==null)return website;
  const assignee=await assigneeRevisionDependency(runtime,grant,producer,consumer);if(assignee!==null)return assignee;
  const state=await revisionStore(runtime.config.stateDirectory,grant).read();
  if(!state.subjects?.some(id=>id===producer.id || id===consumer.id) &&
    !revisionFor(grant,producer) && !revisionFor(grant,consumer)) return false;
  const record=views.get(grant);
  need(record && state.revisionHash===record.revisionHash && state.phase==='active','CROSS_CYCLE_REVISION_UNAVAILABLE');
  need(record.compatibility.some(e=>e.producer===producer.id && e.consumer===consumer.id &&
    e.producerScopeHash===(revisionFor(grant,producer)?.newScopeHash || producer.scopeHash) &&
    e.consumerScopeHash===(revisionFor(grant,consumer)?.newScopeHash || consumer.scopeHash)), 'CROSS_CYCLE_COMPATIBILITY_DENIED');
  return true; // Caller must additionally revalidate the producer's actual Core completion.
}

const operations = record => record.subjects.flatMap(s=>[
  ...(s.oldShapeHash?[{id:`retire-shape:${s.issueId}`,kind:'retire-shape',issueId:s.issueId}]:[]),
  {id:`replace-scope:${s.issueId}`,kind:'replace-scope',issueId:s.issueId}
]);
const needObservation = (o,s,bodyHash,retired) => {
  need(o?.complete===true && o.issueId===s.issueId && o.repositoryId===s.repositoryId &&
    o.bodyHash===bodyHash && o.metadataHash===(retired?s.retiredMetadataHash:s.metadataHash) &&
    same([...o.blockedBy].sort(),[...s.blockedBy].sort()) && same([...o.blocking].sort(),[...s.blocking].sort()) &&
    Array.isArray(o.evidence) && o.evidence.length>0, 'REVISION_PROVIDER_DRIFT');
};
// No arbitrary callback/configuration comes from the Issue body. The native
// operator adapter is trusted installed code and the signed plan fixes all writes.
export async function migrateRequirements(record,host) {
  need(authentic.has(record),'REVISION_UNVERIFIED');
  need(host.installedCoreDigest===record.requiredCoreDigest,'REVISION_CORE_NOT_INSTALLED');
  const store=host.store, ops=operations(record);
  return store.lease(()=>host.withSubjectLeases(record.subjects,async()=>{
    let state=await store.read();
    const save=async fields=>{state=await store.transaction(state.revision,s=>({...s,...fields}));await host.syncJournal();};
    await host.authorize(record); // Fresh signed parent, record and operator identity.
    if(!state.revisionHash){
      const archives=[];
      for(const s of record.subjects){
        const history=await host.history(s);
        need(history.stateHash===s.oldStateHash && history.pending===null && !history.candidate && !history.completed &&
          history.shapeHash===s.oldShapeHash && history.quiescent===true, 'REVISION_OLD_CYCLE_NOT_QUIESCENT');
        needObservation(await host.observe(s),s,s.oldBodyHash,false);
        const archive=await host.archive(s,history);
        need(hash(archive.digest) && archive.verified===true && archive.issueId===s.issueId,'REVISION_ARCHIVE_UNVERIFIED'); archives.push(archive);
      }
      // Persist the deny fence for all six before any external or new-cycle write.
      await save({revisionHash:record.revisionHash,subjects:record.subjects.map(s=>s.issueId),phase:'fenced',archives,
        oldShapeRetirement:record.subjects.filter(s=>s.oldShapeHash).map(s=>({issueId:s.issueId,shapeHash:s.oldShapeHash,
          status:'superseded-not-passed',authority:record.revisionHash})),
        operations:ops.map(o=>({...o,status:'intent'}))});
    }
    need(state.revisionHash===record.revisionHash && same(state.subjects,record.subjects.map(s=>s.issueId)) &&
      state.archives?.length===6 && same(state.operations.map(({status,evidence,...o})=>o),ops) &&
      state.operations.every(o=>['intent','attempted','matching','unknown'].includes(o.status)) &&
      ['fenced','active'].includes(state.phase),'REVISION_JOURNAL_INVALID');
    await host.verifyArchives(state.archives);
    if(state.phase==='active'){
      need(state.operations.every(o=>o.status==='matching') && state.activation?.revisionHash===record.revisionHash &&
        state.activation.archivesHash===digest(state.archives) && state.activation.operationsHash===digest(state.operations), 'REVISION_ACTIVATION_INVALID');
      for(const s of record.subjects) needObservation(await host.observe(s),s,s.newScopeHash,!!s.oldShapeHash);
      return {status:'ACTIVE',revisionHash:record.revisionHash,activation:state.activation};
    }
    for(const spec of ops){
      let operation=state.operations.find(o=>o.id===spec.id);
      const update=async fields=>{await save({operations:state.operations.map(o=>o.id===spec.id?{...o,...fields}:o)});
        operation=state.operations.find(o=>o.id===spec.id);};
      const subject=record.subjects.find(s=>s.issueId===operation.issueId);
      const observeAll=async()=>{
        for(const s of record.subjects){
          const own=state.operations.filter(o=>o.issueId===s.issueId);
          const replaced=own.find(o=>o.kind==='replace-scope')?.status==='matching';
          const retired=!!s.oldShapeHash && own.find(o=>o.kind==='retire-shape')?.status==='matching';
          const expected=replaced?s.newScopeHash:s.oldBodyHash;
          needObservation(await host.observe(s),s,expected,retired);
        }
      };
      const retired=!!subject.oldShapeHash;
      const expectedBody=operation.kind==='replace-scope'?subject.newScopeHash:subject.oldBodyHash;
      if(['attempted','unknown','matching'].includes(operation.status)){
        // An attempted write is NEVER resubmitted, even when old content remains.
        needObservation(await host.observe(subject),subject,expectedBody,retired);
      }else{
        await observeAll(); await host.authorize(record); await host.verifyArchives(state.archives);
        await update({status:'attempted'});
        try { await host.mutate(operation,subject); }
        catch {
          await update({status:'unknown'});
          throw Object.assign(new Error('REVISION_WRITE_OUTCOME_UNKNOWN'),{code:'REVISION_WRITE_OUTCOME_UNKNOWN'});
        }
        needObservation(await host.observe(subject),subject,expectedBody,retired);
      }
      const observed=await host.observe(subject); needObservation(observed,subject,expectedBody,retired);
      await update({status:'matching',evidence:observed.evidence});
    }
    // Activation is one durable local commit after complete readback; old files
    // and old states remain untouched. No dispatch or new Shape is run here.
    await host.authorize(record); await host.verifyArchives(state.archives);
    for(const s of record.subjects) needObservation(await host.observe(s),s,s.newScopeHash,!!s.oldShapeHash);
    if(state.phase!=='active') await save({phase:'active',activation:{revisionHash:record.revisionHash,at:new Date().toISOString(),
      archivesHash:digest(state.archives),operationsHash:digest(state.operations)}});
    return {status:'ACTIVE',revisionHash:record.revisionHash,activation:state.activation};
  }));
}
