import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryBaseRevisionPolicy } from '../src/delivery-revision.mjs';
import { modelRoleStages } from '../src/delivery-planner.mjs';
import {
  protectedStageDiagnosisPlan,
  protectedStageDiagnosisResult,
} from '../src/protected-rescue-policy.mjs';
import { coreStages, nextDeliveryStage } from '../src/delivery-planner.mjs';

test('main integration preserves Shape and repeats Candidate gates', () => {
  const plan = deliveryBaseRevisionPolicy({ stage: 'pr', hasWorkspace: true });
  assert.equal(plan.outcome, 'inspect-base');
  assert.deepEqual(plan.retainedStages, ['shape', 'shape-validator', 'publication']);
  assert.deepEqual(plan.repeatedStages, [
    'deliver',
    'pre-accept-hooks',
    'accept',
    'pre-commit-hooks',
    'pr',
    'ci',
    'shaper-review',
    'merge',
    'final',
    'closure',
    'delivered',
  ]);
  assert.equal(plan.role, 'deliver');
  assert.equal(plan.status, 'UNACCEPTED');
  assert.equal(plan.repairBudget, 'unchanged');
  const receipts = Object.fromEntries(
    plan.retainedStages.map((stage) => [stage, { result: null }]),
  );
  assert.equal(nextDeliveryStage(receipts), 'deliver');
  assert.equal(
    deliveryBaseRevisionPolicy({ stage: 'pr', merged: true, hasWorkspace: true })
      .outcome,
    'not-applicable',
  );
  assert.equal(
    deliveryBaseRevisionPolicy({ prepared: true }).outcome,
    'resume-prepared',
  );
});

test('diagnosis retry preserves unknown writes and repair counts', () => {
  const base = {
    stage: 'pr',
    attemptPhase: 'unresolved',
    marker: { status: 'diagnosis-unavailable', attempts: 1 },
  };
  assert.deepEqual(protectedStageDiagnosisPlan(base), {
    outcome: 'retry',
    attempts: 2,
  });
  assert.equal(
    protectedStageDiagnosisPlan({ ...base, diagnosis: { attempted: true } }).reason,
    'original-diagnosis-reconciliation-required',
  );
  assert.equal(
    protectedStageDiagnosisPlan({
      ...base,
      marker: { status: 'notification-unresolved' },
    }).reason,
    'original-notification-readback-required',
  );
  assert.equal(
    protectedStageDiagnosisPlan({ ...base, marker: { ...base.marker, attempts: 3 } })
      .reason,
    'protected-diagnosis-retry-exhausted',
  );
  assert.equal(
    protectedStageDiagnosisPlan({ ...base, active: true }).outcome,
    'waiting',
  );
  const waiting = protectedStageDiagnosisPlan({ ...base, quota: { resetAt: 60000 } });
  assert.equal(waiting.outcome, 'waiting');
  assert.match(waiting.reason, /1970-01-01T00:01:00.000Z$/);
  assert.equal(base.marker.attempts, 1);
});

test('missing AI records are corrected; diagnosis alone does not resolve', () => {
  const base = {
    stage: 'merge',
    attemptPhase: 'unresolved',
    marker: { status: 'diagnosed', attempts: 1 },
  };
  assert.deepEqual(protectedStageDiagnosisPlan(base), {
    outcome: 'correct-marker',
    status: 'diagnosis-unavailable',
  });
  assert.equal(
    protectedStageDiagnosisPlan({
      ...base,
      diagnosis: { record: 'retained-ai-record' },
    }).outcome,
    'diagnosed',
  );
  const result = protectedStageDiagnosisResult({ code: 'AUTHORITY_UNAVAILABLE' });
  assert.equal(result.status, 'diagnosis-unavailable');
  assert.equal(result.code, 'AUTHORITY_UNAVAILABLE');
  const diagnosed = protectedStageDiagnosisResult({
    diagnosis: { record: 'ai-record' },
  });
  assert.equal(diagnosed.status, 'diagnosed');
  assert.equal(diagnosed.outcome, 'UNRESOLVED');
  assert.equal(diagnosed.nextCheckAt, null);
});

test('model recovery keeps its owner; unknown stages are rejected', () => {
  for (const stage of [...modelRoleStages, 'arbitrary-stage']) {
    assert.equal(
      protectedStageDiagnosisPlan({ stage, attemptPhase: 'unresolved' }).outcome,
      'not-applicable',
    );
  }
  for (const stage of coreStages.filter(
    (stage) => !modelRoleStages.includes(stage),
  )) {
    assert.equal(
      protectedStageDiagnosisPlan({ stage, attemptPhase: 'unresolved' }).outcome,
      'start',
    );
  }
});
