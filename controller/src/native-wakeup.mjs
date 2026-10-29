import {notificationPolicy} from './independent-transport.mjs';
import { digest } from './core.mjs';
import { Store } from './store.mjs';
import { verifyPublicEventRun } from './action-event.mjs';
import { revisionEventBoundary, revisionPublicationCutoff } from './requirement-revision.mjs';

const proofs = new WeakMap();
export const nativeAction = state => ({'publish-shape':'labeled',close:'closed','reopen-recovery':'reopened'})[state.actionReceipts?.at(-1)?.operation];
// Legacy receipts dropped intent time. Preserve them and use completion as a
// conservative lower bound; do not fabricate an earlier publication interval.
export const mutationCutoff = previous => Date.parse(previous?.transition?.writeStartedAt || previous?.transition?.startedAt || previous?.transition?.completedAt || previous?.completedAt);
export const eventSource = p => ({kind:'public-issue-event',repository:p.repository,issueId:p.issueId,
  runId:p.runId,event:p.eventName,action:p.eventAction,runAttempt:p.runAttempt,issuedAt:p.issuedAt});
// Preserve the old deduplication identity; added timing fields must not replay
// every consumed event after an upgrade, including the unaffected 70 subjects.
export const wakeupKey = s => digest(s?.kind==='public-issue-event'
  ? {kind:s.kind,repository:s.repository,issueId:s.issueId,runId:s.runId,event:s.event,action:s.action} : s);
export const hasNativeProof = (source, previous) => {
  const proof=source && proofs.get(source);
  return proof?.sourceHash===digest(source) && proof.mutationReceiptHash===digest(previous);
};
export const readInbox = (runtime,grant) => new Store(runtime.config.stateDirectory,`actions-inbox:${grant.policy.grantId}`).read();

// A public Run and its HMAC envelope authenticate a hint, not permission to
// reuse it across a cycle or a later mutation. Never trust a serialized proof.
export async function verifyInboxSource(runtime,grant,issue,source,inbox,{previous=null,state=null}={}) {
  if(source?.kind!=='public-issue-event')return null;
  const row=Object.values(inbox.seen || {}).find(r=>r.payload && wakeupKey(eventSource(r.payload))===wakeupKey(source));
  const p=row?.payload, entry=p && runtime.publicBindings?.[p.repository], policy=p && notificationPolicy(runtime,grant).actionEvents?.[p.repository];
  const reject=reason=>{console.error(JSON.stringify({kind:'native-wakeup-rejected',issueId:issue.id,
    sourceRunId:source.runId,sourceAttempt:p?.runAttempt ?? null,reason,
    mutationReceiptHash:previous?digest(previous):null}));return null;};
  if(!p || !entry || !policy)return reject('VERIFIED_INBOX_SOURCE_REQUIRED');
  if(runtime.transport && p.bindingId!==entry.binding.bindingId)return reject('RETIRED_NOTIFICATION_BINDING');
  if(source.runAttempt!==undefined && source.runAttempt!==p.runAttempt || source.issuedAt!==undefined && source.issuedAt!==p.issuedAt)
    return reject('INBOX_SOURCE_DIFFERS');
  if(p.repository!==issue.repository || !(p.issueId===issue.id || row.targetIds?.includes(issue.id)))return reject('FOREIGN_EVENT_TARGET');
  const cycle=await revisionEventBoundary(runtime,grant,issue);
  const legacyBound=previous && state?revisionPublicationCutoff(grant,issue,state,previous):null;
  const started=legacyBound?.at ?? (previous?mutationCutoff(previous):0);
  if(previous && (!Number.isFinite(started) || p.eventName!=='issues' || p.issueId!==issue.id || p.eventAction!==nativeAction({actionReceipts:[previous]})))
    return reject('MUTATION_SOURCE_DIFFERS');
  const cutoff=Math.max(cycle?.activatedAt || 0,started);
  if(!Number.isSafeInteger(p.issuedAt) || p.issuedAt<cutoff || p.issuedAt>Date.now())return reject('STALE_EVENT_ENVELOPE');
  // Recheck provider identity/pins for the authenticated stored payload. Errors
  // (401, missing fields, drift, unknown outcome) propagate; never infer absence.
  await verifyPublicEventRun(runtime.github,entry,p,policy);
  const run=await runtime.github.api(`/repos/${p.repository}/actions/runs/${p.runId}`);
  const created=Date.parse(run.created_at);
  if(String(run.id)!==p.runId || String(run.repository?.id)!==p.repositoryId ||
      run.event!==p.eventName || run.path!==entry.binding.workflowPath || !Number.isFinite(created))
    throw Object.assign(Error('Native source original Run identity/time unavailable'),{code:'NATIVE_SOURCE_UNVERIFIED'});
  // created_at is the original Run timestamp, never attempt/start time. Strict
  // comparison intentionally refuses a same-second ambiguous boundary.
  if(created<cutoff || created>p.issuedAt)return reject('STALE_OR_AMBIGUOUS_PUBLIC_RUN');
  const result={...eventSource(p),provenance:{createdAt:run.created_at,payloadHash:digest(p),
    requirementRevisionHash:cycle?.revisionHash || null,activationAt:cycle?.activationAt || null,
    ...(legacyBound?{legacyPublicationBound:legacyBound}:{}),
    ...(previous?{mutationReceiptHash:digest(previous)}:{})}};
  if(previous)proofs.set(result,{sourceHash:digest(result),mutationReceiptHash:digest(previous)});
  console.error(JSON.stringify({kind:'native-wakeup-verified',issueId:issue.id,sourceRunId:p.runId,
    sourceAttempt:p.runAttempt,createdAt:run.created_at,cutoff:new Date(cutoff).toISOString(),
    requirementRevisionHash:cycle?.revisionHash || null,mutationReceiptHash:previous?digest(previous):null}));
  return result;
}

export async function nextInboxSource(runtime,grant,issue,state,inbox) {
  for(const row of Object.values(inbox.seen || {})) {
    if(!row.payload || !(row.targetIds?.includes(issue.id) || row.payload.issueId===issue.id && row.payload.repository===issue.repository))continue;
    const source=eventSource(row.payload);
    if(state.ownerWakeups?.[wakeupKey(source)])continue;
    const verified=await verifyInboxSource(runtime,grant,issue,source,inbox,
      {previous:nativeAction(state)?state.actionReceipts.at(-1):null,state});
    if(verified)return verified;
  }
  return null;
}
