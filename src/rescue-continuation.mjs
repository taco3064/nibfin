import { contentIdentity } from './evidence.mjs';
import { validateBudget } from './verification-runner.mjs';
import {
  rescueNeed as need,
  rescueSame as same,
  rescueHash,
} from './rescue-policy.mjs';
import { validateRescueTarget } from './rescue-ai.mjs';
import { createPreservedRoleContinuation } from './role-continuation.mjs';
/** Adapted from upstream verificationContinuation: only the LAST receipt can
 * explain interruption. Earlier exhaustion never conceals a later failure. */
export function verificationRescueContinuation({
  target,
  blocked,
  budget,
  receipts,
  enabled,
  source,
}) {
  const t = validateRescueTarget(target);
  validateBudget(budget);
  need(
    blocked?.outcome === 'blocked' &&
      blocked.failureClass === 'external_failure' &&
      blocked.execution === t.execution &&
      blocked.role === t.role &&
      Array.isArray(blocked.contractConflicts) &&
      !blocked.contractConflicts.length &&
      same(blocked.target, t) &&
      source.status === 'completed' &&
      source.conclusion !== 'cancelled' &&
      String(source.id) === t.source.runId &&
      String(source.run_attempt) === t.source.attempt,
    'continuation',
  );
  need(
    budget.startedAt >=
      Date.parse(source.run_started_at ?? source.created_at) - 60000,
    'source-time',
  );
  need(
    Array.isArray(receipts) &&
      receipts.length > 0 &&
      receipts.length <= 200 &&
      new Set(receipts.map((r) => r.id)).size === receipts.length,
    'receipts',
  );
  for (const r of receipts)
    need(
      r.schemaVersion === 1 &&
        r.execution === t.execution &&
        rescueHash(r.logDigest) &&
        r.deadlineAt === budget.stopVerificationAt &&
        Number.isSafeInteger(r.startedAt) &&
        Number.isSafeInteger(r.finishedAt) &&
        r.startedAt >= budget.startedAt &&
        r.finishedAt >= r.startedAt &&
        r.finishedAt <= budget.deadlineAt + 30000 &&
        r.finishedAt <= Date.parse(source.updated_at) + 60000,
      'receipt',
    );
  const sorted = [...receipts].sort((a, b) => b.finishedAt - a.finishedAt);
  need(
    sorted.length === 1 || sorted[0].finishedAt > sorted[1].finishedAt,
    'ambiguous-receipt',
  );
  const last = sorted[0],
    kind =
      last.status === 'budget_exhausted' && last.exitCode === 124
        ? 'verification-budget'
        : last.status === 'output_error' &&
            last.exitCode === 74 &&
            last.errorCode === 'EPIPE'
          ? 'verification-io'
          : null;
  need(kind && enabled.includes(kind), 'unsupported-continuation');
  return {
    kind,
    target: contentIdentity(t),
    receipt: last.id,
    proof: contentIdentity({ blocked, budget, receipts }),
    freshVerification: true,
  };
}
export function ciRescueContinuation({
  target,
  blocked,
  previous,
  current,
  pr,
  enabled,
}) {
  const t = validateRescueTarget(target);
  need(
    enabled.includes('ci-change') &&
      blocked?.outcome === 'blocked' &&
      blocked.failureClass === 'external_failure' &&
      blocked.resumeOn === 'ci-change' &&
      blocked.execution === t.execution &&
      same(blocked.target, t) &&
      rescueHash(previous) &&
      contentIdentity(current) !== previous &&
      pr?.state === 'open' &&
      pr.merged === false &&
      pr.draft === false &&
      pr.head === blocked.head &&
      /^[a-f0-9]{40}$/.test(pr.head) &&
      pr.candidate === t.candidate,
    'ci-change',
  );
  return {
    kind: 'ci-change',
    target: contentIdentity(t),
    head: pr.head,
    checks: contentIdentity(current),
    freshVerification: true,
  };
}
/** A retained repair input, never an accepted Candidate or a passing receipt.
 * The normal role owner must import the preserved bytes and resume the exact
 * member/session while allocating a different execution/verification budget. */
export function createRescueContinuation({ load, retain, prepare, now = Date.now }) {
  return createPreservedRoleContinuation({
    validateTarget: validateRescueTarget,
    identityField: 'caseId',
    load,
    retain,
    prepare,
    now,
  });
}
