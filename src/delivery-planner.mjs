export const coreStages = Object.freeze([
  'shape',
  'shape-validator',
  'publication',
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
  'fanout',
  'recovery',
  'repair',
]);
export const deliveryStages = Object.freeze(
  coreStages.slice(0, coreStages.indexOf('fanout')),
);
// Adapted from the retired donor core.mjs at
// d1b47d5e073cf15bdcdc1fbbec098401649878d9.
// Nibfin's authorization/dependency/routing owners validate the public member
// boundary before execution. This module owns delivery progression only: one
// Issue, no cohort scheduler, owner-only identity or global Shape barrier.
export class Blocked extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
}
export function reviewOutcome(result) {
  const defect = ['implementation_defect', 'shape_defect'].includes(
    result.failureClass,
  );
  if (defect && ['blocked', 'changes_required'].includes(result.outcome))
    return 'changes_required';
  if (defect && !['blocked', 'changes_required'].includes(result.outcome))
    throw new Blocked('INVALID_RESULT', 'Successful result contains a defect');
  if (
    result.outcome === 'changes_required' &&
    ['authority_gap', 'external_failure'].includes(result.failureClass)
  )
    throw new Blocked(
      'INVALID_RESULT',
      'Unavailable authority or evidence is not a repair finding',
    );
  return result.outcome;
}

const requireThat = (ok, code, detail) => {
  if (!ok) throw new Blocked(code, detail);
};
// This is the donor's per-Issue operation progression, projected onto Nibfin's
// versioned receipt names. Receipt authentication and custody remain in evidence
// and workspace; a caller must supply the already independently checked receipts.
// An observed failed result never serves as a successful prerequisite.
export function nextDeliveryStage(receipts, transition = null) {
  if (transition !== null) {
    requireThat(
      ['repair', 'recovery'].includes(transition),
      'INVALID_TRANSITION',
      'Unknown recovery handoff',
    );
    return transition;
  }
  const has = (stage) => {
    const e = receipts[stage];
    if (!e) return false;
    if (e.result === null) return true;
    const outcome = reviewOutcome(e.result);
    requireThat(
      ![
        'blocked',
        'changes_required',
        'failed',
        'rejected',
        'unknown',
        'cancelled',
      ].includes(outcome),
      'STAGE_BLOCKED',
      stage + ': ' + outcome,
    );
    return true;
  };
  // CI observation remains distinct from final review and merge policy.
  for (const stage of deliveryStages) if (!has(stage)) return stage;
  return 'fanout';
}

export const modelRoleStages = Object.freeze([
  'shape',
  'shape-validator',
  'deliver',
  'accept',
  'shaper-review',
]);
