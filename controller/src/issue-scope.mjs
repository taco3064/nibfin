import { digest } from './core.mjs';
import { Store } from './store.mjs';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { candidateContract } from './candidate-contract.mjs';

export async function preserveScopeImplementation(runtime, issue, oldUnitId, old, previous) {
  const stored=old.issues?.[issue.id];
  // Completed source is already on main. A pending execution must first be
  // reconciled, never snapshotted while an Agent may still be changing bytes.
  if (stored?.merge || old.completion || old.pending) return null;
  const path=join(runtime.config.stateDirectory,'workspaces',digest(oldUnitId),digest({id:issue.id,repository:issue.repository}),`attempt-${stored?.repairs||0}`);
  const source=runtime.workspaceFactory(path,issue);
  try { await lstat(source.work); }
  catch(error) { if(error.code==='ENOENT')return previous?.priorImplementation || null;throw error; }
  if(!stored?.shape)return previous?.priorImplementation || null;
  const base=stored.candidate?.base||stored.shape.base||JSON.parse(await readFile(join(path,'workspace-base.json'),'utf8')).base;
  const seed=await source.snapshotRepair(base,candidateContract(stored.shape.body));
  if(!seed.candidate.paths.length&&!seed.candidate.artifacts.length&&!seed.candidate.hookSources.length)return previous?.priorImplementation || null;
  return {...seed,sourceUnitId:oldUnitId,sourceAttempt:stored.repairs||0,
    sourceScopeHash:previous?.issue.scopeHash||issue.scopeHash,sourceShapeHash:stored.shape.bodyHash};
}

const views = new WeakMap();
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
export const issueScopeStore = (runtime, grant, issue) => new Store(runtime.config.stateDirectory,
  `live-issue-scope:${grant.recordId}:${issue.repositoryId}:${issue.id}`);
export const liveIssueScopes = grant => views.has(grant);
export const issueScopeProjection = (grant, issue) => views.get(grant)?.get(issue.id) || null;

// This switch comes from the signed installation amendment. Membership,
// repository identity and operational permissions still come from the grant.
export async function loadIssueScopes(runtime, grant) {
  if (grant.policy.controlMode !== 'owner-project' || grant.manifest.schemaVersion !== 2)
    fail('ISSUE_SCOPE_MODE_INVALID', 'Live Issue scope requires owner-project dynamic work');
  const map = new Map();
  for (const issue of grant.manifest.issues) {
    const s = await issueScopeStore(runtime, grant, issue).read();
    if (s.current) map.set(issue.id, s.current);
  }
  views.set(grant, map);
}

export function matchesIssueBody(issue, state, remote, live = false) {
  const stored = state.issues?.[issue.id], hash = digest(remote.body || '');
  if (hash === issue.scopeHash) return true;
  if (live) return false; // New cycles never replace the requirements with Shape.
  return hash === stored?.shape?.publication?.bodyHash ||
    state.pending?.operation === 'publish-shape' && state.pending.issueId === issue.id && hash === stored?.shape?.bodyHash;
}

export async function assertIssueScope(runtime, grant, issue, state) {
  if (!liveIssueScopes(grant)) return;
  const cursor = await issueScopeStore(runtime, grant, issue).read();
  const expected = issueScopeProjection(grant, issue);
  if ((cursor.current?.revisionHash || null) !== (expected?.revisionHash || null))
    fail('ISSUE_SCOPE_CHANGED', 'A newer Issue requirements cycle superseded this execution');
  const read = () => runtime.github.issue(issue);
  const remote = await (runtime.github.freshReadObservation ? runtime.github.freshReadObservation(read) : read());
  const effective = expected?.issue || issue;
  if (!matchesIssueBody(effective, state, remote, Boolean(expected)) ||
      remote.node_id !== issue.id || !remote.labels.some(l => l.name === 'scope'))
    fail('ISSUE_SCOPE_CHANGED', 'Issue requirements changed; discard old results and reconcile the latest Issue');
}

// Caller owns the stable Issue lease. Retain old units, evidence, workspaces and
// conversations verbatim; a new generation cannot reuse A -> B -> A evidence.
export async function reconcileIssueScope(runtime, grant, issue, unitId) {
  if (!liveIssueScopes(grant)) return {changed:false};
  const cursor = issueScopeStore(runtime, grant, issue);
  let record = await cursor.read();
  if (record.current) views.get(grant).set(issue.id, record.current);
  else views.get(grant).delete(issue.id);
  const read = async () => ({remote:await runtime.github.issue(issue), repository:await runtime.github.repository(issue.repository)});
  const {remote,repository} = await (runtime.github.freshReadObservation ? runtime.github.freshReadObservation(read) : read());
  if (String(repository.id) !== issue.repositoryId || String(repository.owner?.id) !== runtime.config.kairoOwnerGitHubUserId ||
      remote.node_id !== issue.id || remote.number !== issue.number || remote.pull_request ||
      String(remote.user?.id) !== runtime.config.kairoOwnerGitHubUserId || !remote.labels.some(l=>l.name==='scope'))
    fail('ISSUE_SCOPE_IDENTITY_CHANGED', 'Live requirements must remain in the enrolled Owner repository and original Scope Issue');
  const oldUnitId = unitId(grant, issue), old = await new Store(runtime.config.stateDirectory, oldUnitId).read();
  const effective = record.current?.issue || issue;
  const matches = matchesIssueBody(effective, old, remote, Boolean(record.current));
  // Untouched completed/legacy cycles remain valid. New work uses the Issue body
  // directly; an existing legacy Shape is recognized only by its exact receipt.
  const migrate = !record.current && !old.issues?.[issue.id]?.shape && !old.completion;
  const reset = remote.state==='open' && Boolean(old.issues?.[issue.id]?.shape?.publication) && !remote.labels.some(l=>l.name==='shaped');
  if ((!matches || migrate || reset) && remote.state !== 'open')
    fail('ISSUE_REOPEN_REQUIRED', 'Reopen the edited Issue before starting a new requirements cycle');
  if (!matches || migrate || reset) {
    if (old.pending?.writeAttempted && !(record.current && old.pending.operation==='publish-shape') || old.pending?.recoveryRequired)
      fail('SCOPE_WRITE_RECONCILIATION_REQUIRED', 'Reconcile the prior uncertain write or Agent cleanup before changing cycles');
    const sequence = (record.current?.sequence || 0) + 1, scopeBody = remote.body || '', scopeHash = digest(scopeBody);
    const revisionHash = digest({parent:grant.recordId,issueId:issue.id,sequence,scopeHash});
    const priorImplementation=await preserveScopeImplementation(runtime,issue,oldUnitId,old,record.current);
    const current = {sequence,revisionHash,recordId:grant.recordId,liveIssueScope:true,
      cycleRevision:`${grant.policy.revision}:issue:${revisionHash}`,
      freezeRevision:`issue:${revisionHash}`,proposalRevision:grant.manifest.proposalRevision,
      proposalHash:grant.manifest.proposalHash,proposal:grant.proposal,
      issue:{...issue,scopeBody,scopeHash},observedAt:new Date().toISOString(),
      ...(priorImplementation?{priorImplementation}: {})};
    record = await cursor.transaction(record.revision, s=>({...s,current,cleanupPending:true,
      history:[...(s.history || []),{unitId:oldUnitId,scopeHash:effective.scopeHash,stateHash:digest(old),
        supersededBy:revisionHash,at:current.observedAt,oldRevision:s.current || null}],
      retiredPr:old.issues?.[issue.id]?.prNumber || null}));
    views.get(grant).set(issue.id,current);
    console.error(JSON.stringify({kind:'issue-scope-adopted',issueId:issue.id,scopeHash,revisionHash,sequence,oldUnitId}));
  }
  if (record.cleanupPending) {
    // Cleanup is replayable after a crash; no Issue body is ever restored.
    if (record.retiredPr) {
      const pr = await runtime.github.pull(issue.repository,record.retiredPr);
      if (!pr.merged && pr.state === 'open') await runtime.github.api(`/repos/${issue.repository}/pulls/${record.retiredPr}`,'PATCH',{state:'closed'});
    }
    await assertIssueScope(runtime,grant,issue,await new Store(runtime.config.stateDirectory,unitId(grant,issue)).read());
    for (const label of ['shaped','delivered']) await runtime.github.removeLabel(issue,label);
    await cursor.transaction(record.revision,s=>({...s,cleanupPending:false}));
  }
  return {changed:!matches || migrate || reset};
}
