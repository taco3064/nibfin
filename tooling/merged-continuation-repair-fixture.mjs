// Synthetic signed maintenance proof; never live runtime or lifecycle evidence.
import { mergedContinuationFixture } from './merged-continuation-fixture.mjs';
import {
  contentIdentity,
  prepareMergedContinuationRepair,
  verifyMergedContinuation,
} from '../src/index.mjs';

export function mergedContinuationRepairFixture() {
  const f = mergedContinuationFixture();
  const previous = {
    parent: f.parent,
    execution: f.execution,
    approval: f.approve(),
  };
  const checked = verifyMergedContinuation(previous.approval, {
    ...previous,
    context: f.context,
  });
  const final = structuredClone(f.all.final);
  final.execution.continuation = checked.execution;
  const receipts = { ...f.parent.receipts, final };
  const expectations = {
    ...f.parent.expectations,
    final: { expected: structuredClone(final), consumed: [] },
  };
  const attempt = {
    request: 'original-closure',
    phase: 'unresolved',
    source: {
      repositoryId: f.parent.target.repositoryId,
      workflow: '7'.repeat(64),
      runId: '300',
      attempt: '1',
    },
  };
  const failure = {
    target: f.parent.target,
    cycle: f.parent.cycle,
    disposition: 'blocked',
    executed: 'closure',
    request: attempt.request,
    run: { id: '300', attempt: '1' },
    inputs: { continuation: checked.identity, binding: checked.binding },
    owner: {
      outcome: 'blocked',
      output: {
        outcome: 'blocked',
        finding: 'completion:events',
      },
    },
  };
  const state = '6'.repeat(64);
  const repair = {
    version: 1,
    previous,
    retained: {
      state,
      stage: 'closure',
      receipts,
      expectations,
      attempt,
      failure,
      observation: {
        version: 1,
        state,
        failure: contentIdentity(failure),
        issue: 'open',
        delivered: false,
        lifecycleSinceFailure: [],
        operations: { close: 'not-submitted', label: 'not-submitted' },
        originalRun: {
          id: '300',
          attempt: '1',
          repositoryId: f.parent.target.repositoryId,
          conclusion: 'failure',
        },
        finalRun: {
          id: final.execution.source.runId,
          attempt: final.execution.source.attempt,
          repositoryId: f.parent.target.repositoryId,
          conclusion: 'success',
        },
        terminated: true,
      },
    },
  };
  const execution = {
    ...f.execution,
    core: '8'.repeat(64),
    source: 'a'.repeat(40),
    activation: '9'.repeat(64),
    validFrom: 1300,
    expiresAt: 1800,
  };
  const context = {
    ...f.context,
    now: 1400,
    expectedPolicy: { ...f.parent.policy, core: execution.core },
  };
  const parent = f.parent;
  const { draft } = prepareMergedContinuationRepair(
    parent,
    execution,
    repair,
    context,
  );
  const approval = f.approve(draft);
  const plan = {
    ...f.plan,
    receipts: structuredClone(receipts),
    evidenceCurrent: structuredClone(expectations),
    continuation: { parent, execution, repair, context, approval },
  };
  return { ...f, parent, execution, repair, context, approval, draft, plan };
}
