import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJSON,
  contentIdentity,
  prepareMergedContinuation,
  verifyMergedContinuation,
} from '../src/index.mjs';
import { plan, ownerEvidence } from '../src/core-contract.mjs';
import { mergedContinuationFixture } from '../tooling/merged-continuation-fixture.mjs';

test('fresh Owner permits only post-merge continuation and preserves the parent', () => {
  const f = mergedContinuationFixture();
  const before = canonicalJSON(f.parent);
  const approval = f.approve();
  const result = verifyMergedContinuation(approval, f);
  assert.deepEqual(result.remaining, ['final', 'closure', 'delivered']);
  assert.equal(result.execution.core, f.execution.core);
  assert.equal(result.execution.amendment, contentIdentity(approval));
  assert.equal(f.draft.policy.repair.maxRepairs, 3);
  assert(!f.draft.permissions[0].operations.includes('deliver'));
  assert(!f.draft.permissions[0].operations.includes('repair'));
  assert.equal(f.draft.work.length, 1);
  assert.equal(canonicalJSON(f.parent), before);
  assert.notEqual(f.draft.recordId, f.parent.grant.payload.recordId);
});

for (const [name, change] of Object.entries({
  'archive changed': (f) => {
    f.parent.archive = '9'.repeat(64);
  },
  'state changed': (f) => {
    f.parent.state = '9'.repeat(64);
  },
  'execution Core changed': (f) => {
    f.execution.core = '9'.repeat(64);
  },
  'activation changed': (f) => {
    f.execution.activation = '9'.repeat(64);
  },
  'different Member': (f) => {
    f.execution.memberId = '8';
  },
  'old authority reused': (f) => {
    f.execution.keyId = f.parent.ownerKey.id;
  },
  'historical revoke': (f) => {
    f.parent.revocation.revokedRecords.push(f.parent.grant.payload.recordId);
  },
  'current revoke': (f) => {
    f.context.revocation.revokedRecords.push(f.draft.recordId);
  },
  'expired approval': (f) => {
    f.context.now = f.execution.expiresAt;
  },
  'unknown current revocation': (f) => {
    f.context.revocation.available = false;
  },
  'Scope changed': (f) => {
    f.parent.scopeBody += '\nchanged';
  },
  'Acceptance missing': (f) => {
    delete f.parent.receipts.accept;
  },
  'historical link changed': (f) => {
    f.parent.receipts.merge.inputs.review = '9'.repeat(64);
    f.parent.expectations.merge.expected = structuredClone(f.parent.receipts.merge);
  },
  'expectation replaced': (f) => {
    f.parent.expectations.accept.expected.execution.result = 'replaced';
  },
}))
  test('continuation rejects ' + name, () => {
    const f = mergedContinuationFixture(),
      approval = f.approve();
    change(f);
    assert.throws(() => verifyMergedContinuation(approval, f));
  });

test('fresh signing cannot expand permissions, repair or validity', () => {
  const f = mergedContinuationFixture();
  for (const change of [
    (p) => p.permissions[0].operations.push('deliver'),
    (p) => {
      p.policy.repair.maxRepairs = 99;
    },
    (p) => {
      p.expiresAt = 2500;
    },
  ]) {
    const draft = structuredClone(f.draft);
    change(draft);
    assert.throws(() => verifyMergedContinuation(f.approve(draft), f));
  }
  const changed = { ...f.execution, expiresAt: 2500 };
  assert.throws(() => prepareMergedContinuation(f.parent, changed));
});

test('plans bind later execution to the new Core and retain old receipts', () => {
  const f = mergedContinuationFixture();
  const approval = f.approve(),
    checked = verifyMergedContinuation(approval, f);
  f.plan.continuation = {
    approval,
    parent: f.parent,
    execution: f.execution,
    context: f.context,
  };
  assert.equal(plan(f.plan).stage, 'final');
  const final = structuredClone(f.all.final);
  final.execution.continuation = structuredClone(checked.execution);
  ownerEvidence(final, f.plan, 'final');
  const missingProvenance = structuredClone(final);
  delete missingProvenance.execution.continuation;
  assert.throws(() => ownerEvidence(missingProvenance, f.plan, 'final'));
  f.plan.receipts.final = final;
  f.plan.evidenceCurrent.final = { expected: structuredClone(final), consumed: [] };
  assert.equal(plan(f.plan).stage, 'closure');
  assert.equal(plan(f.plan).inputs.continuation, contentIdentity(approval));
  f.plan.transition = 'repair';
  assert.throws(() => plan(f.plan), /completion-only/);
  f.plan.transition = null;
  final.execution.continuation.core = '9'.repeat(64);
  f.plan.evidenceCurrent.final.expected = structuredClone(final);
  assert.throws(() => plan(f.plan), /execution-provenance/);
  final.execution.continuation.core = checked.execution.core;
  f.plan.evidenceCurrent.final.expected = structuredClone(final);
  delete f.plan.continuation;
  assert.throws(() => plan(f.plan), /unapproved-continuation/);
});
