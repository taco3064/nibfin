import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withActionCapacity, boundaryWakeup, recordedBoundarySource } from '../src/action-stage.mjs';
import { plan, digest } from '../src/core.mjs';
import { deploymentProofHash } from '../src/deployment.mjs';
import { fixture, shape, deliver, envelope, NOW } from './fixtures.mjs';
import { nativeFixture } from './native-wakeup-fixture.mjs';

test('an early native wakeup is retained for writer completion; earlier cycles and foreign hints cannot substitute', async () => {
  const f=nativeFixture('unused');
  const source=f.add();
  assert.equal((await recordedBoundarySource(f.runtime,f.grant,f.issue,f.state,f.inbox)).runId,source.runId);
  for(const patch of [{issuedAt:1},{issueId:'I_OTHER'},{repository:'other/repo'},{eventName:'workflow_dispatch'},{action:'edited'}]) {
    const bad=nativeFixture('unused');bad.add(patch);
    assert.equal(await recordedBoundarySource(bad.runtime,bad.grant,bad.issue,bad.state,bad.inbox),null);
  }
});

test('Issue mutation boundaries wait for native event unless an exact fallback constraint was approved', () => {
  const issue = { id: 'I_A', repository: 'example/one' }, policy = { actionEvents: {} };
  for (const [operation, action] of [['publish-shape', 'labeled'], ['close', 'closed'], ['reopen-recovery', 'reopened']]) {
    const state = { actionReceipts: [{ operation, action: { runId: '12' } }] };
    assert.equal(boundaryWakeup(policy, issue, state, { kind: 'stage-result' }).path, 'waiting');
    assert.equal(boundaryWakeup(policy, issue, state, { kind: 'owner-reconcile' }).path, 'waiting');
    const source = { kind: 'public-issue-event', repository: issue.repository, issueId: issue.id, event: 'issues', action };
    assert.equal(boundaryWakeup(policy, issue, state, source).path, 'waiting','Unverified matching fields are not proof');
    assert.equal(boundaryWakeup(policy, issue, state, { ...source, issueId: 'I_OTHER' }).path, 'waiting');
    assert.equal(boundaryWakeup(policy, issue, state, { ...source, event: 'workflow_dispatch' }).path, 'waiting');
    policy.actionEvents[issue.repository] = { equivalentWakeups: { [action]: { approved: true, reason: 'Approved token recursion constraint', evidenceHash: 'a'.repeat(64) } } };
    const fallback = boundaryWakeup(policy, issue, state, { kind: 'stage-result' });
    assert.equal(fallback.path, 'approved-dispatch'); assert.equal(fallback.mutationReceiptHash, digest(state.actionReceipts[0]));
    delete policy.actionEvents[issue.repository];
  }
});

test('independent action capacity is bounded and never retries a nested partial execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-capacity-')); t.after(() => rm(root, { recursive: true }));
  const grant = { policy: { grantId: 'g1', maxParallel: 2 } };
  let releaseA, releaseB;
  const a = withActionCapacity(root, grant, () => new Promise(resolve => releaseA = resolve));
  while (!releaseA) await new Promise(resolve => setImmediate(resolve));
  const b = withActionCapacity(root, grant, () => new Promise(resolve => releaseB = resolve));
  while (!releaseB) await new Promise(resolve => setImmediate(resolve));
  let called = false;
  assert.equal((await withActionCapacity(root, grant, () => { called = true; })).code, 'ACTIONS_CAPACITY_BUSY');
  assert.equal(called, false); releaseA('a'); releaseB('b'); assert.equal(await a, 'a'); assert.equal(await b, 'b');
  let attempts = 0;
  await assert.rejects(withActionCapacity(root, grant, () => { attempts++; throw Object.assign(new Error('nested write lock conflict'), { code: 'EEXIST' }); }));
  assert.equal(attempts, 1);
});

function actionsFixture() {
  const f = fixture(); f.policy.executionMode = 'actions-v1';
  f.policy.operations.push('pre-accept-hooks', 'post-accept-hooks');
  const hash = digest(f.policy); f.snapshot.policyHash = hash; f.snapshot.approval.policyHash = hash;
  f.snapshot.runtime.actionStage = { kind: 'github-action-stage', identityHash: 'verified-by-provider-adapter' };
  for (const i of f.manifest.issues) shape(f, i.id);
  return f;
}
test('Actions mode cannot use ordinary local execution and requests distinct Hook gates before Accept/PR', () => {
  const f = actionsFixture();
  delete f.snapshot.runtime.actionStage;
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'ACTIONS_STAGE_REQUIRED');
  f.snapshot.runtime.actionStage = { kind: 'github-action-stage', identityHash: 'verified-by-provider-adapter' };
  deliver(f, 'I_A'); const live = f.snapshot.issues.I_A;
  delete live.hookEvidence; delete live.preCommitHooks; delete live.accept; delete live.pr;
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'pre-accept-hooks');
  deliver(f, 'I_A'); delete live.preCommitHooks; delete live.pr;
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'post-accept-hooks');
});

test('missing deployment baseline blocks Deliver while an explicitly non-deployable stream remains eligible', () => {
  const f = actionsFixture(), target = f.policy.repositories['example/one'];
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'DEPLOYMENT_POLICY_MISSING');
  target.deployment = { mode: 'not-applicable', reason: 'Library work with no publishing obligation in this grant' };
  f.snapshot.policyHash = digest(f.policy); f.snapshot.approval.policyHash = digest(f.policy);
  for (const i of f.manifest.issues) shape(f, i.id);
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'deliver');
});

test('deployment verification is its own Action and a manually closed Issue cannot create completion', () => {
  const f = actionsFixture(); f.policy.operations.push('verify-deployment');
  f.policy.repositories['example/one'].deployment = { mode: 'not-applicable', reason: 'No deployment obligation' };
  f.snapshot.policyHash = digest(f.policy); f.snapshot.approval.policyHash = digest(f.policy);
  for (const i of f.manifest.issues) shape(f, i.id);
  deliver(f, 'I_A', true); const live = f.snapshot.issues.I_A;
  live.deploymentObservation = { mode: 'not-applicable', reason: 'No deployment obligation', policyHash: digest(f.policy.repositories['example/one'].deployment) };
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'verify-deployment');
  live.deploymentVerification = { proofHash: deploymentProofHash(live.deploymentObservation) };
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'CLOSURE_UNVERIFIED');
});

function failureFixture(closed = false) {
  const f = actionsFixture();
  f.policy.operations.push('verify-deployment', 'record-recovery-comment', 'reopen-recovery', 'verify-recovery', 'diagnose-deployment', 'post-merge-repair');
  f.policy.postMergeRecovery = { issueIds: ['I_A'], environments: ['production'], streams: ['stable'], maxCycles: 2, allowClosedRepair: true };
  f.snapshot.policyHash = digest(f.policy); f.snapshot.approval.policyHash = digest(f.policy);
  for (const i of f.manifest.issues) shape(f, i.id);
  deliver(f, 'I_A', true); const live = f.snapshot.issues.I_A;
  live.deploymentObservation = { status: 'failed', issueId: 'I_A', commit: live.merge.commit, environment: 'production', stream: 'stable' };
  live.deploymentFailure = { ...live.deploymentObservation, failureProofHash: deploymentProofHash(live.deploymentObservation) };
  if (!closed) { live.state = 'open'; delete live.delivered; }
  return { f, live };
}
test('open post-merge deployment failure goes directly to independent diagnosis, never Reopen or Closure', () => {
  const { f, live } = failureFixture();
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'diagnose-deployment');
  live.deploymentDiagnosis = { ...envelope(f, 'I_A', 'deployment-diagnosis', 'changes_required', { candidateHash: digest(live.candidate), failureProofHash: live.deploymentFailure.failureProofHash }),
    failureClass: 'implementation_defect', blockingFindings: ['The deployed route returns an incorrect value for the required input.'] };
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'REPAIR_AUTHORITY_MISSING');
  live.repairAuthorization = { verified: true, issueId: 'I_A', failureProofHash: live.deploymentFailure.failureProofHash,
    validFrom: f.policy.validFrom, expiresAt: f.policy.expiresAt, maxCycles: 1 };
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'post-merge-repair');
  live.repairs = f.policy.maxRepairs;
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'REPAIR_BUDGET_EXHAUSTED');
});
test('closed regression requires Comment, Reopen and provider-backed Recovery before independent diagnosis', () => {
  const { f, live } = failureFixture(true);
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'record-recovery-comment');
  live.recoveryComment = { commentHash: 'actual-saved-comment' };
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'reopen-recovery');
  live.state = 'open'; live.reopenedReceipt = { eventId: 'actual-provider-event' };
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'verify-recovery');
  live.recoverySource = { sourceHash: 'provider-verified-source' };
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'diagnose-deployment');
});
test('unknown responsibility, stale failure, self-diagnosis and missing Owner repair permission fail closed', () => {
  let { f, live } = failureFixture(); live.deploymentFailure.issueId = 'I_random';
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'RECOVERY_ATTRIBUTION_INVALID');
  ({ f, live } = failureFixture()); live.deploymentObservation.status = 'healthy';
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'DEPLOYMENT_FAILURE_STALE');
  ({ f, live } = failureFixture());
  live.deploymentDiagnosis = { ...envelope(f, 'I_A', 'deployment-diagnosis', 'changes_required', { candidateHash: digest(live.candidate), failureProofHash: live.deploymentFailure.failureProofHash }), failureClass: 'implementation_defect', blockingFindings: ['Proven failure.'], executionId: live.delivery.executionId };
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'NOT_INDEPENDENT');
  live.deploymentDiagnosis.executionId = 'fresh-independent-diagnosis';
  f.policy.postMergeRecovery.maxCycles = 0;
  f.snapshot.policyHash = digest(f.policy); f.snapshot.approval.policyHash = digest(f.policy);
  // Rebind only the synthetic diagnosis fixture after changing test policy.
  live.deploymentDiagnosis.policyHash = digest(f.policy);
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'REPAIR_AUTHORITY_MISSING');
});
