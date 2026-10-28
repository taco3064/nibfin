// Adapted from src/core.mjs, taco3064/kairo@d1b47d5e073cf15bdcdc1fbbec098401649878d9.
// Nibfin's authorization/dependency/routing owners validate the public member
// boundary before execution. This module owns delivery progression only: one
// Issue, no cohort scheduler, owner-only identity or global Shape barrier.
export class Blocked extends Error {
  constructor(code, detail) {super(detail);this.code=code;}
}
export function reviewOutcome(result) {
  const defect = ['implementation_defect', 'shape_defect'].includes(result.failureClass);
  if (defect && ['blocked', 'changes_required'].includes(result.outcome)) return 'changes_required';
  if (defect && !['blocked', 'changes_required'].includes(result.outcome)) throw new Blocked('INVALID_RESULT', 'Successful result contains a defect');
  if (result.outcome === 'changes_required' && ['authority_gap', 'external_failure'].includes(result.failureClass)) throw new Blocked('INVALID_RESULT', 'Unavailable authority or evidence is not a repair finding');
  return result.outcome;
}

const requireThat=(ok,code,detail)=>{if(!ok)throw new Blocked(code,detail);};
// This is the donor's per-Issue operation progression, projected onto Nibfin's
// versioned receipt names. Receipt authentication and custody remain in evidence
// and workspace; a caller must supply the already independently checked receipts.
// An observed failed result never serves as a successful prerequisite.
export function nextDeliveryStage(receipts, transition=null) {
  if(transition!==null) {
    requireThat(['repair','recovery'].includes(transition),'INVALID_TRANSITION','Unknown recovery handoff');
    return transition;
  }
  const has=stage=> {
    const e=receipts[stage];
    if(!e)return false;
    if(e.result===null)return true;
    const outcome=reviewOutcome(e.result);
    requireThat(!['blocked','changes_required','failed','rejected','unknown','cancelled'].includes(outcome),
      'STAGE_BLOCKED',stage+': '+outcome);
    return true;
  };
  if(!has('shape'))return 'shape';
  if(!has('shape-validator'))return 'shape-validator';
  if(!has('publication'))return 'publication';
  if(!has('deliver'))return 'deliver';
  if(!has('pre-accept-hooks'))return 'pre-accept-hooks';
  if(!has('accept'))return 'accept';
  if(!has('pre-commit-hooks'))return 'pre-commit-hooks';
  if(!has('pr'))return 'pr';
  // Nibfin persists a distinct observation stage; it never upgrades pending
  // repository-enforced CI to passed. Final review and Merge own its policy.
  if(!has('ci'))return 'ci';
  if(!has('shaper-review'))return 'shaper-review';
  if(!has('merge'))return 'merge';
  // Unlike the donor owner-project shortcut, deployment disposition, Close and
  // completion publication are independent, read-back-bound Nibfin operations.
  if(!has('final'))return 'final';
  if(!has('closure'))return 'closure';
  if(!has('delivered'))return 'delivered';
  return 'fanout';
}
