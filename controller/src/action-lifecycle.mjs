import { unitId } from './dynamic.mjs';
import { digest } from './core.mjs';
import { Store } from './store.mjs';
import { verifyQueuedActionEvent } from './action-event.mjs';
import { ActionOutbox } from './action-outbox.mjs';
import { reconcileActionIssue, executeActionStage, fanoutActionCompletion } from './action-stage.mjs';
import { runOwnerIssueSession } from './owner-issue-session.mjs';
import { eventSource } from './native-wakeup.mjs';

const fail = (code, reason) => { throw Object.assign(new Error(reason), { code }); };
// Only called after verifyActionEvent authenticates the completion hint.
export async function completionTargets(runtime, grant, payload) {
  const related = await runtime.github.api('/repos/' + payload.repository + '/actions/runs/' + payload.relatedRunId);
  const targets = [];
  for (const issue of grant.manifest.issues.filter(i => i.repository === payload.repository)) {
    const state = await new Store(runtime.config.stateDirectory, unitId(grant, issue)).read();
    const stored = state.issues?.[issue.id];
    if (!stored?.prNumber) continue;
    const pr = await runtime.github.api('/repos/' + issue.repository + '/pulls/' + stored.prNumber);
    if (pr.head?.repo?.full_name !== issue.repository) continue;
    if (related.head_sha === pr.head.sha || pr.merged_at && related.head_sha === pr.merge_commit_sha) targets.push(issue);
  }
  return targets;
}

export async function runActionLifecycle(runtime, event) {
  runtime.agentHealth = null;
  runtime.ownerGrant = null;
  const inputs = event?.inputs || {};
  if(inputs.issue_ref&&(!/^[\w.-]+(?:#[1-9]\d*(?:\+[1-9]\d*)*)?$/.test(inputs.issue_ref)||inputs.issue_ref.length>128))fail('INVALID_ACTION_INPUT','Invalid display-only Issue reference');
  if (Object.keys(inputs).some(k => !['request_id', 'event_envelope', 'issue_id','issue_ref'].includes(k)) ||
      [inputs.request_id, inputs.event_envelope, inputs.issue_id].filter(Boolean).length !== 1)
    fail('INVALID_ACTION_INPUT', 'Exactly one typed, bounded reconciliation source is required');
  let grant;
  try { grant = await runtime.grant(); }
  catch (error) { if (error.status === 404) return { status: 'WAITING', code: 'NO_VALID_GRANT', handoffs: [] }; throw error; }
  if (grant.policy.executionMode !== 'actions-v1' || !runtime.actionIdentity) fail('ACTIONS_STAGE_REQUIRED', 'This command cannot run an old cohort-mode grant');
  const outbox = new ActionOutbox(runtime.config.stateDirectory, runtime.github, grant.policy.actionExecution,grant.manifest.issues);
  const waiting = new Store(runtime.config.stateDirectory, `actions-capacity-wait:${grant.policy.grantId}`);
  const handoffs = [], results = [], wakeSources = new Map(); let targets = [], source;
  if (inputs.request_id) {
    let result;
    try { result = await executeActionStage(runtime, inputs.request_id); }
    catch (error) {
      if (!['DEPENDENCY_WAIT','MERGE_REQUIREMENTS_PENDING'].includes(error.code)) throw error;
      await outbox.deferDependency(inputs.request_id, error.dependency || null);
      await outbox.finish(inputs.request_id, 'DEPENDENCY_WAIT');
      return { status: 'WAITING', code: error.code, dependency: error.dependency, handoffs: await outbox.drainWrites() };
    }
    if (['COMPLETE', 'STAGE_COMPLETE', 'DUPLICATE', 'SUPERSEDED'].includes(result.status)) await outbox.finish(inputs.request_id, result.status);
    results.push(result);
    const issue = grant.manifest.issues.find(i => i.id === result.issueId);
    if (result.status === 'COMPLETE') handoffs.push(...await fanoutActionCompletion(runtime, grant, issue, result.completion));
    else if (result.status === 'SUPERSEDED') { targets = [issue]; source = { kind: 'stage-reconcile', runId: runtime.actionIdentity.runId, diagnosticHash: digest(result.detail) }; }
    else if (['STAGE_COMPLETE', 'DUPLICATE'].includes(result.status)) { targets = [issue]; source = { kind: 'stage-result', receiptHash: result.receiptHash || digest(result.receipt) }; }
    else if (result.code === 'ACTIONS_CAPACITY_BUSY') await waiting.metadataLease(async () => { const state = await waiting.read(); await waiting.transaction(state.revision, s => ({ ...s, targets: [...new Set([...(s.targets || []), issue.id])] })); });
    if (['COMPLETE', 'STAGE_COMPLETE'].includes(result.status)) {
      const state = await waiting.read();
      targets.push(...grant.manifest.issues.filter(i => state.targets?.includes(i.id) && !targets.some(t => t.id === i.id)));
      source ||= { kind: 'capacity-release', runId: runtime.actionIdentity.runId };
    }
  } else if (inputs.event_envelope) {
    if (Buffer.byteLength(inputs.event_envelope) > 8192) fail('INVALID_ACTION_INPUT', 'Oversized lifecycle envelope');
    const envelope = JSON.parse(inputs.event_envelope), repository = envelope?.payload?.repository;
    const entry = runtime.publicBindings?.[repository], policy = grant.policy.actionEvents?.[repository];
    if (!entry || !policy) fail('OUT_OF_SCOPE', 'Event repository is not enrolled under this signed policy');
    const p = await verifyQueuedActionEvent(runtime.github, entry, envelope, policy, runtime.config.stateDirectory);
    targets = p.eventName === 'workflow_run'
      ? await completionTargets(runtime, grant, p)
      : grant.manifest.issues.filter(i => i.repository === repository && (!p.issueId || i.id === p.issueId));
    const inbox = new Store(runtime.config.stateDirectory, `actions-inbox:${grant.policy.grantId}`);
    const eventId = digest({ repositoryId: p.repositoryId, runId: p.runId, attempt: p.runAttempt });
    const duplicate = await inbox.metadataLease(async () => {
      const state = await inbox.read();
      if (state.seen?.[eventId]) return true;
      await inbox.transaction(state.revision, s => ({ ...s, seen: { ...s.seen, [eventId]: { payload: p, targetIds:targets.map(i=>i.id), action: runtime.actionIdentity } } }));
      return false;
    });
    if (duplicate) return { status: 'DUPLICATE', handoffs: [] };
    source = eventSource(p);
  } else {
    // Grant-applied and dependency-backfill wakeups are explicit Owner Actions
    // runs. A relay App cannot bypass its source envelope by filling issue_id.
    if (runtime.actionIdentity.actorId !== runtime.config.nibfinOwnerGitHubUserId || runtime.actionIdentity.triggeringActorId !== runtime.config.nibfinOwnerGitHubUserId)
      fail('OWNER_RECONCILIATION_REQUIRED', 'Direct grant/backfill reconciliation requires the enrolled Owner');
    targets = grant.manifest.issues.filter(i => i.id === inputs.issue_id);
    if (!targets.length) return {status:'IGNORED',code:'ISSUE_NOT_IN_GRANT',handoffs:[]};
    source = { kind: 'owner-reconcile', runId: runtime.actionIdentity.runId };
  }
  for (const issue of targets) {
    try {
      const next = grant.policy.controlMode === 'owner-project'
        ? await runOwnerIssueSession(runtime,grant,issue,wakeSources.get(issue.id) || source)
        : await reconcileActionIssue(runtime, grant, issue, source);
      results.push(next);
      if (next.code === 'ACTIONS_CAPACITY_BUSY') await waiting.metadataLease(async () => {const state=await waiting.read();await waiting.transaction(state.revision,s=>({...s,targets:[...new Set([...(s.targets || []),issue.id])]}));});
      if (next.status === 'COMPLETE') handoffs.push(...await fanoutActionCompletion(runtime, grant, issue, next.completion));
      if (next.requestId) { const handoff = await outbox.prepareHandoff(next.requestId); if (handoff) handoffs.push(handoff); }
      if (next.requestId || next.status === 'COMPLETE') await waiting.metadataLease(async () => { const state = await waiting.read(); if (state.targets?.includes(issue.id)) await waiting.transaction(state.revision, s => ({ ...s, targets: s.targets.filter(id => id !== issue.id) })); });
      if (grant.policy.controlMode === 'owner-project' && next.code !== 'ACTIONS_CAPACITY_BUSY') await waiting.metadataLease(async () => {
        const state = await waiting.read(), ready = (state.targets || []).filter(id=>!targets.some(t=>t.id===id));
        for (const target of grant.manifest.issues.filter(i=>ready.includes(i.id))) {
          targets.push(target); wakeSources.set(target.id,{kind:'capacity-release',runId:runtime.actionIdentity.runId});
        }
        if (state.targets?.length) await waiting.transaction(state.revision,s=>({...s,targets:s.targets.filter(id=>id!==issue.id && !ready.includes(id))}));
      });
    } catch (error) {
      // A local dependency/capacity wait never grants work or stops unrelated
      // targets. Authority/provenance/read failures remain explicit hard stops.
      if (!['DEPENDENCY_WAIT', 'EEXIST', 'ACTION_PREDECESSOR_PENDING', 'OWNER_REAUTHORIZATION_REQUIRED'].includes(error.code)) throw error;
      results.push({ status: 'WAITING', issueId: issue.id, code: error.code, ...(error.dependency ? { dependency: error.dependency } : {}) });
    }
  }
  handoffs.push(...await outbox.drainWrites());
  return { status: 'ACTION_PROCESSED', results, handoffs };
}
