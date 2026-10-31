import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJSON,
  contentIdentity,
  verifyMergedContinuation,
  prepareMergedContinuationRepair,
} from '../src/index.mjs';
import { plan, ownerEvidence } from '../src/core-contract.mjs';
import {
  mergedContinuationRepairFixture,
} from '../tooling/merged-continuation-repair-fixture.mjs';

test('runtime repair preserves final, failed attempt and bounded original policy', () => {
  const f = mergedContinuationRepairFixture();
  const before = canonicalJSON(f.parent);
  const checked = verifyMergedContinuation(f.approval, f);
  assert.deepEqual(checked.remaining, ['closure', 'delivered']);
  assert.equal(checked.execution.core, f.execution.core);
  assert.equal(checked.execution.amendment, contentIdentity(f.approval));
  assert.equal(plan(f.plan).stage, 'closure');
  assert.equal(f.repair.retained.attempt.phase, 'unresolved');
  assert.deepEqual(f.draft.policy.repair, f.parent.policy.repair);
  assert(!f.draft.permissions[0].operations.includes('repair'));
  assert(!f.draft.permissions[0].operations.includes('final'));
  assert(f.draft.permissions[0].operations.includes('close'));
  assert(f.draft.permissions[0].operations.includes('label'));
  assert.equal(canonicalJSON(f.parent), before);
});

for (const [name, change] of Object.entries({
  'changed original parent': (f) => {
    f.parent.archive = 'a'.repeat(64);
  },
  'same execution Core': (f) => {
    f.execution.core = f.repair.previous.execution.core;
  },
  'expanded validity': (f) => {
    f.execution.expiresAt = 2000;
  },
  'wrong signing Owner': (f) => {
    f.execution.keyId = 'other-owner';
  },
  'unknown write': (f) => {
    f.repair.retained.failure.disposition = 'unresolved';
  },
  'wrong failed request': (f) => {
    f.repair.retained.failure.request = 'other';
  },
  'wrong failed Run': (f) => {
    f.repair.retained.observation.originalRun.id = '301';
  },
  'failed final Run': (f) => {
    f.repair.retained.observation.finalRun.conclusion = 'failure';
  },
  'closed requirement': (f) => {
    f.repair.retained.observation.issue = 'closed';
  },
  'unobserved effect': (f) => {
    f.repair.retained.observation.operations.close = 'unknown';
  },
  'existing delivery': (f) => {
    f.repair.retained.observation.delivered = true;
  },
  'live original execution': (f) => {
    f.repair.retained.observation.terminated = false;
  },
  'new lifecycle occurrence': (f) => {
    f.repair.retained.observation.lifecycleSinceFailure.push('501');
  },
  'modified old execution': (f) => {
    f.repair.retained.receipts.final.execution.continuation.core = 'a'.repeat(64);
  },
  'missing final evidence': (f) => {
    delete f.repair.retained.receipts.final;
  },
  'revoked previous approval': (f) => {
    f.context.revocation.revokedRecords.push(
      f.repair.previous.approval.payload.recordId,
    );
  },
}))
  test('runtime repair rejects ' + name, () => {
    const f = mergedContinuationRepairFixture();
    change(f);
    f.repair.retained.observation.failure = contentIdentity(
      f.repair.retained.failure,
    );
    assert.throws(() =>
      prepareMergedContinuationRepair(f.parent, f.execution, f.repair, f.context),
    );
    assert.throws(() => verifyMergedContinuation(f.approval, f));
  });

test('a retained final cannot be rewritten after maintenance approval', () => {
  const f = mergedContinuationRepairFixture();
  f.plan.receipts.final.result = { verdict: 'forged' };
  f.plan.evidenceCurrent.final.expected = structuredClone(f.plan.receipts.final);
  assert.throws(() => plan(f.plan));
});

test('new closure evidence identifies the corrected execution Core', () => {
  const f = mergedContinuationRepairFixture();
  const checked = verifyMergedContinuation(f.approval, f);
  const closure = structuredClone(f.all.closure);
  closure.inputs.final = contentIdentity(f.plan.receipts.final);
  closure.execution.continuation = checked.execution;
  ownerEvidence(closure, f.plan, 'closure');
  closure.execution.continuation =
    f.repair.retained.receipts.final.execution.continuation;
  assert.throws(() => ownerEvidence(closure, f.plan, 'closure'));
});
