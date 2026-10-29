import {executionPolicy,notificationPolicy} from './independent-transport.mjs';
import { binding, canonical, digest, plan } from './core.mjs';
import { childRuntime, issueLeaseId, unitId } from './dynamic.mjs';
import { Store } from './store.mjs';
import { requireDistinctActionRuns, requireFreshActionRun, verifyActionRun } from './action-provenance.mjs';
import { ActionOutbox } from './action-outbox.mjs';
import { assertRevisionExecution, revisionHash } from './requirement-revision.mjs';
import { eventSource, hasNativeProof, mutationCutoff, nativeAction, readInbox, verifyInboxSource } from './native-wakeup.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const stageBasis = state => digest({ binding: state.binding || null, issues: state.issues || {}, pending: state.pending || null, completion: state.completion || null });

// A verified mutation is necessary but does not prove delivery of its native
// event. These boundaries cannot silently become ordinary stage dispatches.
export function boundaryWakeup(policy, issue, state, source) {
  const previous = state.actionReceipts?.at(-1);
  const action = { 'publish-shape': 'labeled', close: 'closed', 'reopen-recovery': 'reopened' }[previous?.operation];
  if (!action) return null;
  if (source?.kind === 'public-issue-event' && source.repository === issue.repository && source.issueId === issue.id && source.event === 'issues' && source.action === action && hasNativeProof(source,previous))
    return { path: 'native', action, source, mutationReceiptHash: digest(previous) };
  const fallback = policy.actionEvents?.[issue.repository]?.equivalentWakeups?.[action];
  if (fallback?.approved === true && typeof fallback.reason === 'string' && fallback.reason.trim() && /^[a-f0-9]{64}$/.test(fallback.evidenceHash || '') &&
      ['stage-result', 'owner-reconcile'].includes(source?.kind))
    return { path: 'approved-dispatch', action, reason: fallback.reason, evidenceHash: fallback.evidenceHash, source, mutationReceiptHash: digest(previous) };
  return { path: 'waiting', action };
}

export async function recordedBoundarySource(runtime, grant, issue, state, inbox) {
  const previous = state.actionReceipts?.at(-1);
  const action = { 'publish-shape': 'labeled', close: 'closed', 'reopen-recovery': 'reopened' }[previous?.operation];
  const startedAt = mutationCutoff(previous);
  if (!action || !Number.isFinite(startedAt)) return null;
  for(const {payload:p} of Object.values(inbox.seen || {})) {
    if(!p || p.repository!==issue.repository || p.issueId!==issue.id || p.eventName!=='issues' || p.eventAction!==action)continue;
    const source=await verifyInboxSource(runtime,grant,issue,eventSource(p),inbox,{previous,state});
    if(source)return source;
  }
  return null;
}

export async function resolveBoundaryWakeup(runtime,grant,issue,state,source) {
  if(!nativeAction(state))return null;
  const inbox=await readInbox(runtime,grant);
  let verified=source?.kind==='public-issue-event'
    ? await verifyInboxSource(runtime,grant,issue,source,inbox,{previous:state.actionReceipts.at(-1),state}) : source;
  let boundary=boundaryWakeup(grant.policy,issue,state,verified);
  if(boundary?.path==='waiting') {
    verified=await recordedBoundarySource(runtime,grant,issue,state,inbox);
    if(verified)boundary=boundaryWakeup(grant.policy,issue,state,verified);
  }
  return boundary;
}

export async function withActionCapacity(root, grant, work) {
  const limit = grant.policy.maxParallel;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail('INVALID_PARALLELISM', 'Explicit bounded Actions capacity is required');
  for (let slot = 0; slot < limit; slot++) {
    let entered = false;
    try { return await new Store(root, `actions-capacity:${grant.policy.grantId}:${slot}`).lease(async () => { entered = true; return work(); }); }
    catch (error) { if (entered || error.code !== 'EEXIST') throw error; }
  }
  return { status: 'WAITING', code: 'ACTIONS_CAPACITY_BUSY' };
}

// One admitted Issue transition, never a cohort loop. The caller must validate
// its source event or provider-backed predecessor before creating the intent.
export async function reconcileActionIssue(runtime, grant, issue, source) {
  if (grant.policy.executionMode !== 'actions-v1' || !runtime.actionIdentity) fail('ACTIONS_STAGE_REQUIRED', 'Reconciliation requires a signed Actions-mode grant and verified execution Run');
  // child.grant performs the live dependency check itself.
  const child = childRuntime(runtime, grant, issue), projected = await child.grant();
  const state = await new Store(runtime.config.stateDirectory, unitId(grant, issue)).read();
  // The native event can overtake the writer's job/result readback. Its verified
  // inbox hint is durable; don't enqueue another copy of the pending mutation.
  if (state.pending && source?.kind === 'public-issue-event') return { status: 'WAITING', code: 'ISSUE_STAGE_IN_PROGRESS', issueId: issue.id };
  const snapshot = await child.observe(projected, state), fresh = plan(projected.manifest, projected.policy, snapshot);
  const decision = state.pending || fresh;
  if (decision.status === 'COMPLETE') {
    const receipt = state.actionReceipts?.findLast(r => r.operation === 'mark-delivered' || grant.policy.controlMode === 'owner-project' && r.operation === 'close' && grant.policy.repositories[issue.repository].deployment?.mode === 'not-applicable');
    if (!receipt || state.completion && (state.completion.completionHash !== fresh.completionHash || state.completion.receiptHash !== digest(receipt)))
      fail('COMPLETION_UNVERIFIED', 'Completion retry must revalidate the stored certificate and its exact publication receipt');
    const completion = state.completion || { ...fresh, action: receipt.action, receiptHash: digest(receipt) };
    if (!state.completion) {
      // Recover only the local certificate gap after a verified publication;
      // never write another label or accept an untracked manual delivered label.
      const store = new Store(runtime.config.stateDirectory, unitId(grant, issue));
      await store.transaction(state.revision, s => ({ ...s, completion }));
    }
    return { ...fresh, issueId: issue.id, completion, revalidatedBy: runtime.actionIdentity };
  }
  if (decision.status !== 'READY') return decision;
  const wakeup = await resolveBoundaryWakeup(runtime, grant, issue, state, source);
  if(wakeup?.source)source=wakeup.source;
  if (!state.pending && wakeup?.path === 'waiting') return { status: 'WAITING', code: 'NATIVE_ISSUE_EVENT_REQUIRED', issueId: issue.id, action: wakeup.action };
  const outbox = new ActionOutbox(runtime.config.stateDirectory, runtime.github, executionPolicy(runtime,grant),grant.manifest.issues);
  const id = await outbox.enqueue({ schemaVersion: 1, issueId: issue.id, repository: issue.repository,
    authority: binding(grant.manifest, grant.policy), operation: decision.operation, artifacts: decision.artifacts,
    basis: stageBasis(state), source, wakeup, predecessor: runtime.actionIdentity,
    ...(revisionHash(grant,issue)?{requirementRevisionHash:revisionHash(grant,issue)}:{}) });
  return { status: 'READY', operation: decision.operation, issueId: issue.id, requestId: id };
}

export async function fanoutActionCompletion(runtime, grant, issue, completion) {
  if (completion.status !== 'COMPLETE' || !completion.receiptHash) fail('COMPLETION_UNVERIFIED', 'Only a verified completion receipt can wake downstream work');
  const rows = await runtime.github.list(`/repos/${issue.repository}/issues/${issue.number}/dependencies/blocking`);
  const requests = [];
  for (const remote of rows) {
    const target = grant.manifest.issues.find(i => i.id === remote.node_id);
    if (!target) continue; // Discovery never extends fixed signed membership.
    const entry = runtime.publicBindings[target.repository];
    if (!entry) fail('FANOUT_TARGET_NOT_ENROLLED', 'Dependent repository has no enrolled caller');
    const execution = { kind: 'participant', repository: target.repository, repositoryId: entry.binding.repositoryId,
      workflowPath: entry.binding.workflowPath, ref: 'main', actorIds: notificationPolicy(runtime,grant).actionEvents[target.repository].actorIds };
    const outbox = new ActionOutbox(runtime.config.stateDirectory, runtime.github, execution,grant.manifest.issues);
    const id = await outbox.enqueue({ issueId: target.id, repository: target.repository, authority: binding(grant.manifest, grant.policy),
      sourceIssueId: issue.id, completionHash: completion.completionHash, completionReceiptHash: completion.receiptHash });
    const handoff = await outbox.prepareHandoff(id); if (handoff) requests.push(handoff);
  }
  return requests;
}

export async function executeActionStage(runtime, requestId) {
  const grant = await runtime.grant();
  if (grant.policy.executionMode !== 'actions-v1' || !runtime.actionIdentity) fail('ACTIONS_STAGE_REQUIRED', 'A verified Actions execution is required');
  const outbox = new ActionOutbox(runtime.config.stateDirectory, runtime.github, executionPolicy(runtime,grant),grant.manifest.issues);
  const item = await outbox.read(requestId), request = item.request;
  if (canonical(request.authority) !== canonical(binding(grant.manifest, grant.policy))) fail('STALE_AUTHORITY', 'Stage dispatch belongs to another signed authority');
  const issue = grant.manifest.issues.find(i => i.id === request.issueId && i.repository === request.repository);
  if (!issue) fail('OUT_OF_SCOPE', 'Stage target is outside the approved original Issue set');
  await assertRevisionExecution(runtime,grant,issue,request.requirementRevisionHash || null);
  const source = await verifyActionRun(runtime.github, runtime.actionExecutionPolicy?.(grant) || grant.policy.actionExecution, {
    runId: request.predecessor.runId, attempt: request.predecessor.runAttempt, jobId: request.predecessor.jobId,
  }, { completed: true });
  if (source.identityHash !== request.predecessor.identityHash) fail('STALE_ACTION_SOURCE', 'Predecessor identity changed');
  requireDistinctActionRuns([source, runtime.actionIdentity]);
  const result = await withActionCapacity(runtime.config.stateDirectory, grant, () => new Store(runtime.config.stateDirectory, issueLeaseId(issue)).lease(async () => {
    // Both local Runner registrations must use this same signed coordination
    // directory. A Run queued for an occupied Issue never steals its lease.
    const store = new Store(runtime.config.stateDirectory, unitId(grant, issue));
    let state = await store.read();
    if (state.actionRequests?.[requestId]) return { status: 'DUPLICATE', receipt: state.actionRequests[requestId] };
    if (stageBasis(state) !== request.basis && state.pending?.actionRequestId !== requestId) return { status: 'WAITING', code: 'STAGE_BASIS_CHANGED', issueId: issue.id };
    const wakeup=await resolveBoundaryWakeup(runtime,grant,issue,state,request.source);
    if(wakeup?.path==='waiting')return {status:'WAITING',code:'NATIVE_ISSUE_EVENT_REQUIRED',issueId:issue.id,action:wakeup.action};
    // child.resume obtains its grant and checks live dependencies before work.
    const child = childRuntime(runtime, grant, issue); child.actionInvocation = true;
    const save = child.save.bind(child);
    child.save = async (targetStore, current) => {
      const transition = current.events.at(-1);
      if (!current.pending && transition?.operation === request.operation && transition.completedAt && !current.actionRequests?.[requestId]) {
        const receipt = { schemaVersion: 1, requestId, issueId: issue.id, operation: request.operation,
          authority: request.authority,...(request.requirementRevisionHash?{requirementRevisionHash:request.requirementRevisionHash}:{}), action: runtime.actionIdentity, wakeup: wakeup || null, transition, completedAt: transition.completedAt };
        current.actionReceipts = [...(current.actionReceipts || []), receipt];
        current.actionRequests = { ...current.actionRequests, [requestId]: receipt };
      }
      // Agent/write result, transition event and Actions receipt commit in ONE
      // durable Store transaction. There is no untracked-stage crash window.
      return save(targetStore, current);
    };
    const execute = child.execute.bind(child);
    child.execute = async (g, s, snapshot, decision, targetStore) => {
      if (decision.operation !== request.operation || canonical(decision.artifacts) !== canonical(request.artifacts)) {
        const detail = { kind: 'stage-decision-changed', at: new Date().toISOString(), requestId,
          issueId: issue.id, runId: runtime.actionIdentity.runId,
          expected: { operation: request.operation, artifacts: request.artifacts }, actual: decision,
          writeAttempted: s.pending?.writeAttempted === true };
        console.error(JSON.stringify(detail));
        s.events.push(detail);
        // resume persists the replacement intent; only a distinct Run may execute it.
        throw Object.assign(new Error('Fresh planner superseded the dispatched operation'), {
          code: 'STAGE_DECISION_CHANGED', detail, safeToReconcile: !detail.writeAttempted });
      }
      if (s.pending) s.pending.actionRequestId = requestId;
      requireFreshActionRun((s.actionReceipts || []).map(r => r.action), runtime.actionIdentity, grant.policy);
      return execute(g, s, snapshot, decision, targetStore);
    };
    try { await child.resume({ maxSteps: 1 }); }
    catch (error) {
      if (error.code !== 'STAGE_DECISION_CHANGED' || error.safeToReconcile !== true) throw error;
      return { status: 'SUPERSEDED', issueId: issue.id, detail: error.detail };
    }
    state = await store.read();
    if (state.pending) return { status: 'WAITING', code: 'WRITE_READBACK_PENDING', issueId: issue.id };
    const event = state.events.at(-1);
    if (event?.operation !== request.operation || !event.completedAt) return { status: 'WAITING', code: 'STAGE_NOT_COMPLETED', issueId: issue.id };
    const receipt = state.actionRequests?.[requestId];
    if (!receipt) fail('ACTION_RECEIPT_MISSING', 'Transition cannot progress without its atomically persisted Actions receipt');
    // runActionLifecycle immediately reconciles ordinary results with a fresh
    // observation. Do not observe once here and repeat it there. Completion is
    // different: its certificate and fanout require verification in this call.
    const finalization = request.operation === 'mark-delivered' || request.operation === 'close' && grant.policy.controlMode === 'owner-project' && grant.policy.repositories[issue.repository].deployment?.mode === 'not-applicable';
    if (!finalization) return { status: 'STAGE_COMPLETE', issueId: issue.id, receiptHash: digest(receipt) };
    const projected = await child.grant(), observed = child.finalizationObservation || await child.observe(projected, state);
    const next = plan(projected.manifest, projected.policy, observed);
    if (finalization && next.status === 'COMPLETE') {
      const completion = { ...next, action: runtime.actionIdentity, receiptHash: digest(receipt) };
      await store.transaction(state.revision, s => ({ ...s, completion }));
      const deployment = grant.policy.repositories[issue.repository].deployment;
      const proof = state.issues[issue.id].deploymentVerification?.proof;
      if (deployment?.mode === 'required' && proof?.status === 'healthy') {
        const rows = await runtime.github.list(`/repos/${issue.repository}/deployments?environment=${encodeURIComponent(deployment.environment)}`);
        const latest = rows.find(d => d.environment === deployment.environment && d.payload?.stream === deployment.stream);
        if (String(latest?.id) === proof.deploymentId) {
          const stream = new Store(runtime.config.stateDirectory, `deployment-stream:${issue.repository}:${deployment.environment}:${deployment.stream}`);
          await stream.lease(async () => { const current = await stream.read(); await stream.transaction(current.revision, s => ({ ...s,
            baseline: { deploymentId: proof.deploymentId, commit: proof.commit, version: proof.version, issueId: issue.id, grantId: proof.grantId }, completionHash: completion.completionHash })); });
        }
      }
      return { status: 'COMPLETE', issueId: issue.id, completion };
    }
    return { status: 'STAGE_COMPLETE', issueId: issue.id, receiptHash: digest(receipt), next: next.status, code: next.code || null, reason: next.reason || null };
  }));
  return { ...result, issueId: issue.id };
}
