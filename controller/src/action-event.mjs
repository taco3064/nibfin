import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonical, digest } from './core.mjs';
import { Store } from './store.mjs';
import { repoPath } from './github.mjs';
import { verifyupstreamOwner } from './owner-identity.mjs';

const fail = reason => { throw Object.assign(new Error(reason), { code: 'ACTION_EVENT_INVALID' }); };
const fields = ['schemaVersion', 'repository', 'repositoryId', 'runnerId', 'bindingId', 'runId', 'runAttempt', 'nonce', 'issuedAt', 'expiresAt', 'eventName', 'eventAction', 'issueId', 'issueNumber', 'relatedRunId'];
export const issueActivities = ['opened', 'edited', 'labeled', 'unlabeled', 'reopened', 'closed', 'assigned', 'unassigned', 'milestoned', 'demilestoned'];

// A private, integrity-checked relay receipt proves timely reception. Recheck
// HMAC, current binding, workflow and provider provenance at execution, while
// checking the envelope's time window at its recorded reception time.
export async function verifyQueuedActionEvent(github, entry, envelope, policy, stateDirectory) {
  const p=envelope?.payload;
  if(!p)fail('Missing queued event');
  const id=digest({repositoryId:p.repositoryId,runId:p.runId,attempt:p.runAttempt});
  const receipt=await new Store(stateDirectory,`event-relay:${id}`).read();
  let at=Date.now(),version='fresh-direct';
  if(receipt.attempted){
    if(receipt.envelopeHash!==digest(envelope))fail('Queued event differs from received notification');
    if(receipt.reception){
      const r=receipt.reception;
      if(r.schemaVersion!==1||r.bindingHash!==digest(entry.binding)||r.policyHash!==digest(policy)||
          !Number.isSafeInteger(r.receivedAt))fail('Queued event enrollment differs from reception');
      at=r.receivedAt;version='durable-reception-v1';
    }else{
      // Before reception-v1 the relay recorded this timestamp only AFTER full
      // verification and a successful dispatch. Never infer it from public logs.
      if(receipt.accepted!==true)fail('Legacy dispatch has no confirmed reception');
      at=Date.parse(receipt.attemptedAt);version='legacy-confirmed-relay';
      if(!Number.isSafeInteger(at))fail('Legacy reception timestamp missing');
    }
    if(at>Date.now()||at<p.issuedAt||at>=p.expiresAt)fail('Event was not received within its validity window');
  }
  const payload=await verifyActionEvent(github,entry,envelope,policy,at);
  console.error(JSON.stringify({kind:'action-event-consumed',id,repository:payload.repository,sourceRunId:payload.runId,
    reception:version,receivedAt:at,queueAgeMs:Math.max(0,Date.now()-at)}));
  return payload;
}

export function verifyActionEnvelope(envelope, entry, now = Date.now()) {
  const p = envelope?.payload, b = entry.binding;
  if (!p || Object.keys(p).sort().join(',') !== [...fields].sort().join(',') || p.schemaVersion !== 3 ||
      !['issues', 'workflow_dispatch', 'workflow_run'].includes(p.eventName) ||
      !['repository', 'repositoryId', 'runnerId', 'bindingId'].every(k => p[k] === b[k]) ||
      !/^[1-9]\d*$/.test(p.runId || '') || !Number.isSafeInteger(p.runAttempt) || p.runAttempt < 1 ||
      !/^[a-f0-9]{32}$/.test(p.nonce || '') || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) ||
      p.issuedAt > now || p.expiresAt <= now || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > 600000)
    fail('Invalid, foreign or expired event envelope');
  if (p.eventName === 'issues') {
    if (!issueActivities.includes(p.eventAction) || !/^[\w-]+$/.test(p.issueId || '') || !Number.isSafeInteger(p.issueNumber) || p.issueNumber < 1 || p.relatedRunId !== null) fail('Invalid Issue lifecycle hint');
  } else if (p.eventName === 'workflow_run') {
    if (p.eventAction !== 'completed' || !/^[1-9]\d*$/.test(p.relatedRunId || '') || p.issueId !== null || p.issueNumber !== null) fail('Invalid workflow completion hint');
  } else if (p.eventAction !== null || p.relatedRunId !== null || p.issueId !== null && !/^[\w-]+$/.test(p.issueId) || p.issueNumber !== null) fail('Invalid explicit reconciliation hint');
  const actual = Buffer.from(envelope.signature || '', 'hex');
  const expected = createHmac('sha256', Buffer.from(entry.secret, 'hex')).update(canonical(p)).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('Event HMAC differs');
  return p;
}

// This verifies the completed hosted signer job, not a guessed eventual status
// of its still-running relay job. The relay can start a private Actions Run
// directly; no background artifact collector is involved.
export async function verifyActionEvent(github, entry, envelope, policy, now = Date.now()) {
  const p = verifyActionEnvelope(envelope, entry, now);
  await verifyPublicEventRun(github, entry, p, policy);
  return p;
}

// Only for a freshly authenticated envelope or a payload already committed by
// that verifier to the private inbox. This is not an envelope authentication API.
export async function verifyPublicEventRun(github, entry, p, policy) {
  const b = entry.binding, root = repoPath(b.repository);
  const ownerId = await verifyupstreamOwner(github, { nibfinOwnerGitHubUserId: entry.nibfinOwnerGitHubUserId });
  const repo = await github.repository(b.repository);
  if (repo.private || String(repo.id) !== b.repositoryId || String(repo.owner?.id) !== ownerId || b.ownerId !== ownerId) fail('Public participant identity differs');
  const run = await github.api(`${root}/actions/runs/${p.runId}/attempts/${p.runAttempt}`);
  if (String(run.id) !== p.runId || run.run_attempt !== p.runAttempt || run.event !== p.eventName ||
      run.path !== b.workflowPath || String(run.repository?.id) !== b.repositoryId || String(run.head_repository?.id) !== b.repositoryId ||
      run.head_branch !== repo.default_branch || !policy.actorIds.map(String).includes(String(run.actor?.id)) ||
      !policy.actorIds.map(String).includes(String(run.triggering_actor?.id))) fail('Event run actor, attempt, repository or event differs');
  for (const ref of [run.head_sha, repo.default_branch]) {
    const file = await github.api(`${root}/contents/${b.workflowPath}?ref=${encodeURIComponent(ref)}`);
    if (file.sha !== b.workflowBlob) fail('Public event caller pin changed');
  }
  // Explicitly approved local-gh mode trusts the bounded HMAC hint and pinned
  // caller; needs: sign-event already gates relay execution. No Job polling.
  if (policy.signerVerification !== 'hmac-workflow-pin') {
  const jobs = await github.list(`${root}/actions/runs/${p.runId}/attempts/${p.runAttempt}/jobs`, 'jobs');
  const signers = jobs.filter(j => j.name === 'sign-event');
  // Only safe provider fields are logged; never the envelope, HMAC or credentials.
  const safeFields = ['id', 'name', 'status', 'conclusion', 'runner_id', 'runner_name', 'started_at', 'completed_at'];
  console.error(JSON.stringify({ kind: 'action-event-signer-read', at: new Date().toISOString(), repository: b.repository,
    runId: p.runId, runAttempt: p.runAttempt, signerCount: signers.length, jobCount: jobs.length,
    jobs: jobs.slice(0,100).map(j => ({ ...Object.fromEntries(safeFields.map(k => [k, typeof j[k] === 'string' ? j[k].slice(0,256) : typeof j[k] === 'number' ? j[k] : null])),
      labels: (j.labels || []).filter(x => typeof x === 'string').slice(0,20).map(x => x.slice(0,100)) })),
    responses: github.jobReadResponses?.filter(r => r.path.startsWith(`${root}/actions/runs/${p.runId}/attempts/${p.runAttempt}/jobs?`)) || [] }));
  if (!signers.length || signers.length === 1 && ['queued','waiting','pending','in_progress'].includes(signers[0].status) &&
      !signers[0].conclusion && !signers[0].labels?.includes('self-hosted'))
    throw Object.assign(new Error('GitHub-hosted signer completion is not visible yet'), { code: 'ACTION_EVENT_SIGNER_PENDING' });
  if (signers.length !== 1 || signers[0].status !== 'completed' || signers[0].conclusion !== 'success' ||
      !signers[0].labels?.includes('ubuntu-latest') || signers[0].labels.includes('self-hosted')) fail('Missing successful GitHub-hosted event signer');
  }
  if (p.eventName === 'issues') {
    const issue = await github.api(`${root}/issues/${p.issueNumber}`);
    if (issue.pull_request || issue.node_id !== p.issueId || String(issue.user?.id) !== ownerId) fail('Issue is not the original Owner-created Issue');
  }
  if (p.eventName === 'workflow_run') {
    const related = await github.api(`${root}/actions/runs/${p.relatedRunId}`);
    if (related.repository?.full_name !== b.repository || related.head_repository?.full_name !== b.repository ||
        related.status !== 'completed' || !policy.reconcileWorkflowPaths.includes(related.path) || related.path === b.workflowPath)
      fail('Unknown completion hint or recursive caller event');
  }
  return run;
}
