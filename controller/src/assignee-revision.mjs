import { createPublicKey, verify } from 'node:crypto';
import { canonical, digest } from './core.mjs';
import { Store } from './store.mjs';

const verified = new WeakSet(), attached = new WeakMap(), retirements = new WeakSet(), coreRepairs = new WeakMap();
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const hash = x => /^[a-f0-9]{64}$/.test(x || '');
const same = (a, b) => canonical(a) === canonical(b);
const sorted = xs => [...xs].sort();
const frozen = x => { if (x && typeof x === 'object') { Object.values(x).forEach(frozen); Object.freeze(x); } return x; };
const bound = issue => issue.repository === 'taco3064/nibfin' && [28, 31].includes(issue.number);
export const assigneeRevisionStore = (root, grant) => new Store(root, `assignee-requirement-revision:${grant.recordId}`);
const find = (grant, n) => grant.manifest.issues.find(i => i.repository === 'taco3064/nibfin' && i.number === n);
export const assigneeRevisionFor = (grant, issue) => {
  const r = attached.get(grant), s = r?.subjects.find(s => s.issueId === issue.id);
  return s ? { ...s, revisionHash: r.revisionHash } : null;
};

// A separate signed delta: never replace the previous six-subject revision.
export function verifyAssigneeRevision(bundle, grant, publicKey, priorRevisionHash) {
  const p = bundle?.payload, key = createPublicKey(publicKey);
  need(p && key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(p)), key,
    Buffer.from(bundle.signature || '', 'base64')), 'ASSIGNEE_REVISION_SIGNATURE_INVALID');
  need(p.schemaVersion === 1 && p.kind === 'owner-assignee-requirement-revision' &&
    p.profile === 'nibfin-assignee-api-order-v0.12.0' && p.ordering === 'fresh-github-assignees-array' &&
    p.completionPolicy === 'exclude-retired-not-delivered' &&
    grant.approval?.verified === true && p.parentRecordId === grant.recordId && p.parentManifestHash === digest(grant.manifest) &&
    p.parentPolicyHash === digest(grant.policy) && p.parentPayloadHash === digest(Object.fromEntries(
      Object.entries(grant).filter(([k]) => k !== 'approval'))) && hash(priorRevisionHash) &&
    p.priorRequirementRevisionHash === priorRevisionHash && grant.policy.controlMode === 'owner-project', 'ASSIGNEE_REVISION_PARENT_INVALID');
  need(hash(p.planHash) && hash(p.requiredCoreDigest) && typeof p.proposal === 'string' && p.proposal.trim() &&
    digest(p.proposal) === p.proposalHash && p.proposalRevision === 'v0.12.0' &&
    [p.recordId, p.freezeRevision, p.cycleRevision].every(x => typeof x === 'string' && x.trim()) &&
    p.recordId !== grant.recordId && p.freezeRevision !== grant.manifest.freezeRevision &&
    p.cycleRevision !== grant.policy.revision, 'ASSIGNEE_REVISION_AUTHORITY_INVALID');
  const original = [find(grant, 28), find(grant, 31)];
  need(original.every(Boolean) && Array.isArray(p.subjects) && p.subjects.length === 2 &&
    same(sorted(p.subjects.map(s => s.issueId)), sorted(original.map(i => i.id))), 'ASSIGNEE_REVISION_SUBJECTS_INVALID');
  for (const s of p.subjects) {
    const old = original.find(i => i.id === s.issueId);
    need(old && s.repository === old.repository && s.repositoryId === old.repositoryId && s.number === old.number &&
      s.oldScopeHash === old.scopeHash && s.oldBodyHash === old.scopeHash && hash(s.oldStateHash) &&
      s.oldShapeHash === null && s.oldMetadata?.state === 'open' && s.oldStateReason === null &&
      s.metadataHash === digest(s.oldMetadata) && !s.oldMetadata.labels.some(l => ['shaped', 'delivered'].includes(l)) &&
      Array.isArray(s.blockedBy) && Array.isArray(s.blocking) &&
      new Set(s.blockedBy).size === s.blockedBy.length && new Set(s.blocking).size === s.blocking.length,
    'ASSIGNEE_REVISION_SCOPE_INVALID');
    need(s.number === 28 ? s.disposition === 'retire-not-planned' && s.newScopeBody === null && s.newScopeHash === null :
      s.disposition === 'replace-scope' && typeof s.newScopeBody === 'string' && s.newScopeBody.trim() &&
      s.newScopeHash === digest(s.newScopeBody) && s.newScopeHash !== s.oldScopeHash, 'ASSIGNEE_REVISION_DISPOSITION_INVALID');
  }
  const a = p.subjects.find(s => s.number === 28), b = p.subjects.find(s => s.number === 31);
  need([2, 5, 30, 32].every(n => find(grant, n)) && same(sorted(a.blockedBy), [find(grant, 2).id]) &&
    same(a.blocking, [b.issueId]) && same(sorted(b.blockedBy), sorted([a.issueId, find(grant, 5).id, find(grant, 30).id])) &&
    same(b.blocking, [find(grant, 32).id]) && Number.isSafeInteger(p.retiredDatabaseId) && p.retiredDatabaseId > 0 &&
    same(p.operations, ['replace-31-body', 'remove-28-blocks-31', 'close-28-not-planned']), 'ASSIGNEE_REVISION_EDGES_INVALID');
  const pairs = [[find(grant, 5).id, b.issueId], [find(grant, 30).id, b.issueId], [b.issueId, find(grant, 32).id]];
  const effective = id => id === b.issueId ? b.newScopeHash : grant.manifest.issues.find(i => i.id === id)?.scopeHash;
  need(Array.isArray(p.compatibility) && p.compatibility.length === 3 &&
    new Set(p.compatibility.map(e => `${e.producer}:${e.consumer}`)).size === 3 &&
    p.compatibility.every(e => pairs.some(([x, y]) => x === e.producer && y === e.consumer) &&
      e.producerScopeHash === effective(e.producer) && e.consumerScopeHash === effective(e.consumer)), 'ASSIGNEE_REVISION_COMPATIBILITY_INVALID');
  need(Array.isArray(p.unaffected) && p.unaffected.length === grant.manifest.issues.length - 2 &&
    same(sorted(p.unaffected.map(s => s.issueId)), sorted(grant.manifest.issues.filter(i => !original.includes(i)).map(i => i.id))) &&
    p.unaffected.every(s => hash(s.stateHash) && hash(s.projectionHash) && typeof s.unitId === 'string') &&
    p.unaffectedHash === digest(p.unaffected), 'ASSIGNEE_REVISION_UNAFFECTED_INVALID');
  const result = frozen({ ...structuredClone(p), revisionHash: digest(bundle) }); verified.add(result); return result;
}
export function attachAssigneeCoreRepair(bundle,grant,key,installedDigest) {
  const r=attached.get(grant),p=bundle?.payload,k=createPublicKey(key);
  need(r&&p&&k.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(p)),k,Buffer.from(bundle.signature||'','base64')),'ASSIGNEE_CORE_REPAIR_SIGNATURE_INVALID');
  need(p.schemaVersion===1&&p.kind==='owner-assignee-core-repair'&&p.parentRecordId===grant.recordId&&p.parentManifestHash===digest(grant.manifest)&&p.parentPolicyHash===digest(grant.policy)&&p.runtimeHash===grant.policy.runtimeHash&&
    p.assigneeRevisionHash===r.revisionHash&&p.fromCoreDigest===r.requiredCoreDigest&&p.toCoreDigest===installedDigest&&hash(installedDigest)&&installedDigest!==p.fromCoreDigest&&hash(p.retainedJournalHash)&&/^[a-f0-9]{40}$/.test(p.sourceCommit||'')&&
    same(p.allowedEffects,['preserve-existing-assignee-cycles'])&&typeof p.reason==='string'&&p.reason.trim(),'ASSIGNEE_CORE_REPAIR_INVALID');
  const result=frozen({...structuredClone(p),amendmentHash:digest(bundle)});coreRepairs.set(grant,result);return result;
}
export function assigneeCoreAllowed(grant,installedDigest){return attached.get(grant)?.requiredCoreDigest===installedDigest||coreRepairs.get(grant)?.toCoreDigest===installedDigest;}
export function attachAssigneeRevision(grant, record) {
  need(verified.has(record), 'ASSIGNEE_REVISION_UNVERIFIED');
  attached.set(grant, record); return grant;
}
export function assigneeRevisionProjection(grant, issue) {
  const s = assigneeRevisionFor(grant, issue), r = attached.get(grant);
  if (!s || s.disposition !== 'replace-scope') return null;
  return { issue: { ...issue, scopeBody: s.newScopeBody, scopeHash: s.newScopeHash }, recordId: r.recordId,
    cycleRevision: r.cycleRevision, freezeRevision: r.freezeRevision, proposalRevision: r.proposalRevision,
    proposalHash: r.proposalHash, proposal: r.proposal, revisionHash: r.revisionHash };
}
function active(state, record) {
  need(record && state.phase === 'active' && state.revisionHash === record.revisionHash &&
    same(state.subjects, record.subjects.map(s => s.issueId)) && state.activation?.revisionHash === record.revisionHash &&
    Number.isFinite(Date.parse(state.activation.at)) && state.activation.archivesHash === digest(state.archives) &&
    state.activation.operationsHash === digest(state.operations) && state.operations.every(o => o.status === 'matching') &&
    same(state.operations.map(o => o.id), record.operations) && state.archives.length === 2, 'ASSIGNEE_MIGRATION_HELD');
}
export async function assigneeRevisionBoundary(runtime, grant, issue) {
  if (!bound(issue)) return null;
  const r = attached.get(grant), state = await assigneeRevisionStore(runtime.config.stateDirectory, grant).read();
  if (!r && !state.revisionHash) return null;
  const s = r?.subjects.find(s => s.issueId === issue.id);
  need(s, 'ASSIGNEE_MIGRATION_HELD'); active(state, r);
  const repair=coreRepairs.get(grant);if(repair)need(repair.retainedJournalHash===digest(state),'ASSIGNEE_RETAINED_JOURNAL_CHANGED');
  need(s.disposition !== 'retire-not-planned', 'REQUIREMENT_RETIRED_NOT_DELIVERED');
  return { revisionHash: r.revisionHash, activatedAt: Date.parse(state.activation.at), activationAt: state.activation.at };
}
export async function assertAssigneeRevision(runtime, grant, issue, requestedCycle) {
  const boundary = await assigneeRevisionBoundary(runtime, grant, issue); if (!boundary) return null;
  const r = attached.get(grant);
  need(assigneeCoreAllowed(grant,runtime.installedCoreDigest), 'ASSIGNEE_CORE_NOT_INSTALLED');
  if (requestedCycle !== undefined) need(requestedCycle === r.revisionHash, 'STALE_ASSIGNEE_REQUEST');
  need(runtime.actionIdentity?.runId, 'ASSIGNEE_FRESH_ACTION_REQUIRED');
  const run = await runtime.github.api(`/repos/${grant.policy.actionExecution.repository}/actions/runs/${runtime.actionIdentity.runId}`);
  need(String(run.id) === String(runtime.actionIdentity.runId) && Date.parse(run.created_at) >= boundary.activatedAt, 'STALE_ASSIGNEE_RUN');
  return r.revisionHash;
}
export async function assigneeRevisionDependency(runtime, grant, producer, consumer) {
  if (!bound(producer) && !bound(consumer)) return null;
  const r = attached.get(grant), state = await assigneeRevisionStore(runtime.config.stateDirectory, grant).read();
  if (!r && !state.revisionHash) return null;
  active(state, r);
  need(![producer, consumer].some(i => i.repository === 'taco3064/nibfin' && i.number === 28), 'RETIRED_REQUIREMENT_DEPENDENCY');
  need(r.compatibility.some(e => e.producer === producer.id && e.consumer === consumer.id &&
    e.producerScopeHash === (assigneeRevisionProjection(grant, producer)?.issue.scopeHash || producer.scopeHash) &&
    e.consumerScopeHash === (assigneeRevisionProjection(grant, consumer)?.issue.scopeHash || consumer.scopeHash)), 'ASSIGNEE_CROSS_CYCLE_DENIED');
  return true; // Actual upstream completion is still checked by the caller.
}
export const isAssigneeRetirement = result => retirements.has(result);
export async function assigneeRetirement(runtime, grant, issue) {
  if (!bound(issue) || issue.number !== 28) return null;
  const r = attached.get(grant), state = await assigneeRevisionStore(runtime.config.stateDirectory, grant).read();
  if (!r && !state.revisionHash) return null;
  active(state, r); const repair=coreRepairs.get(grant);if(repair)need(repair.retainedJournalHash===digest(state),'ASSIGNEE_RETAINED_JOURNAL_CHANGED'); need(assigneeCoreAllowed(grant,runtime.installedCoreDigest), 'ASSIGNEE_CORE_NOT_INSTALLED');
  const s = r.subjects.find(s => s.issueId === issue.id), remote = await runtime.github.issue(issue);
  need(s?.disposition === 'retire-not-planned' && remote.node_id === issue.id && remote.id === r.retiredDatabaseId &&
    digest(remote.body) === s.oldBodyHash && remote.state === 'closed' && remote.state_reason === 'not_planned' &&
    !remote.labels.some(l => l.name === 'delivered'), 'ASSIGNEE_RETIREMENT_UNVERIFIED');
  const outgoing = await runtime.github.list(`/repos/${issue.repository}/issues/${issue.number}/dependencies/blocking`);
  need(Array.isArray(outgoing) && outgoing.length === 0, 'RETIRED_REQUIREMENT_DEPENDENCY');
  const result = { status: 'RETIRED', disposition: 'superseded-not-passed', revisionHash: r.revisionHash,
    retirementHash: digest({ revisionHash: r.revisionHash, issueId: issue.id, scopeHash: s.oldScopeHash, activation: state.activation }),
    completed: false };
  retirements.add(result); return result;
}
function observations(record, done) {
  return record.subjects.map(s => ({ complete: true, issueId: s.issueId, repositoryId: s.repositoryId,
    databaseId: s.number === 28 ? record.retiredDatabaseId : undefined,
    bodyHash: s.number === 31 && done.has('replace-31-body') ? s.newScopeHash : s.oldBodyHash,
    metadata: { ...s.oldMetadata, state: s.number === 28 && done.has('close-28-not-planned') ? 'closed' : 'open' },
    stateReason: s.number === 28 && done.has('close-28-not-planned') ? 'not_planned' : null,
    blockedBy: s.blockedBy.filter(id => !(s.number === 31 && done.has('remove-28-blocks-31') && id === record.subjects.find(x => x.number === 28).issueId)),
    blocking: s.number === 28 && done.has('remove-28-blocks-31') ? [] : s.blocking }));
}
async function readback(host, record, done) {
  const evidence = [];
  for (const expected of observations(record, done)) {
    const o = await host.observe(record.subjects.find(s => s.issueId === expected.issueId));
    need(o?.complete === true && o.issueId === expected.issueId && o.repositoryId === expected.repositoryId &&
      o.bodyHash === expected.bodyHash && same(o.metadata, expected.metadata) && o.metadataHash === digest(o.metadata) &&
      o.stateReason === expected.stateReason && (expected.databaseId === undefined || o.databaseId === expected.databaseId) &&
      same(sorted(o.blockedBy), sorted(expected.blockedBy)) && same(sorted(o.blocking), sorted(expected.blocking)) &&
      Array.isArray(o.evidence) && o.evidence.length > 0, 'ASSIGNEE_PROVIDER_DRIFT'); evidence.push(...o.evidence);
  }
  return evidence;
}
export async function migrateAssigneeRequirements(record, host) {
  need(verified.has(record), 'ASSIGNEE_REVISION_UNVERIFIED');
  need(host.installedCoreDigest === record.requiredCoreDigest, 'ASSIGNEE_CORE_NOT_INSTALLED');
  return host.store.lease(() => host.withSubjectLeases(record.subjects, async () => {
    let state = await host.store.read();
    const save = async fields => { state = await host.store.transaction(state.revision, s => ({ ...s, ...fields })); await host.syncJournal(); };
    const validate = async () => { await host.authorize(record); await host.verifyUnaffected(record.unaffected); };
    await validate();
    if (!state.revisionHash) {
      await readback(host, record, new Set()); const archives = [];
      for (const s of record.subjects) {
        const h = await host.history(s);
        need(h.stateHash === s.oldStateHash && h.pending === null && !h.candidate && !h.completed && h.shapeHash === null && h.quiescent === true,
          'ASSIGNEE_OLD_CYCLE_NOT_QUIESCENT');
        const a = await host.archive(s, h); need(a.issueId === s.issueId && hash(a.digest) && a.verified === true, 'ASSIGNEE_ARCHIVE_UNVERIFIED'); archives.push(a);
      }
      await save({ revisionHash: record.revisionHash, subjects: record.subjects.map(s => s.issueId), phase: 'fenced', archives,
        operations: record.operations.map(id => ({ id, status: 'intent' })) });
    }
    need(state.revisionHash === record.revisionHash && same(state.subjects, record.subjects.map(s => s.issueId)) &&
      same(state.operations?.map(o => o.id), record.operations) && state.archives?.length === 2 &&
      state.operations.every(o => ['intent', 'attempted', 'unknown', 'matching'].includes(o.status)) &&
      ['fenced', 'active'].includes(state.phase), 'ASSIGNEE_JOURNAL_INVALID');
    let frontier = false, uncertain = false;
    for (const op of state.operations) {
      if (op.status === 'matching') need(!frontier && Array.isArray(op.evidence) && op.evidence.length > 0, 'ASSIGNEE_JOURNAL_INVALID');
      else if (op.status === 'intent') frontier = true;
      else { need(!frontier && !uncertain, 'ASSIGNEE_JOURNAL_INVALID'); frontier = true; uncertain = true; }
    }
    await host.verifyArchives(state.archives);
    if (state.phase === 'active') { active(state, record); await readback(host, record, new Set(record.operations)); await validate(); return { status: 'ACTIVE', revisionHash: record.revisionHash }; }
    for (const id of record.operations) {
      let op = state.operations.find(o => o.id === id);
      if (op.status === 'matching') continue; // Read the entire current prefix at the uncertain frontier.
      const done = new Set(state.operations.filter(o => o.status === 'matching').map(o => o.id));
      const update = async fields => { await save({ operations: state.operations.map(o => o.id === id ? { ...o, ...fields } : o) }); op = state.operations.find(o => o.id === id); };
      if (op.status === 'intent') {
        await readback(host, record, done); await validate(); await host.verifyArchives(state.archives);
        await update({ status: 'attempted' });
        try { await host.mutate(id, record); }
        catch { await update({ status: 'unknown' }); throw Object.assign(new Error('ASSIGNEE_WRITE_OUTCOME_UNKNOWN'), { code: 'ASSIGNEE_WRITE_OUTCOME_UNKNOWN' }); }
      }
      // Attempted/unknown operations are only observed; never resubmitted.
      done.add(id); const evidence = await readback(host, record, done);
      await update({ status: 'matching', evidence });
    }
    await validate(); await host.verifyArchives(state.archives); await readback(host, record, new Set(record.operations));
    await save({ phase: 'active', activation: { revisionHash: record.revisionHash, at: new Date().toISOString(),
      archivesHash: digest(state.archives), operationsHash: digest(state.operations) } });
    return { status: 'ACTIVE', revisionHash: record.revisionHash };
  }));
}
