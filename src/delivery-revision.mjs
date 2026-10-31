import { deliveryStages } from './delivery-planner.mjs';

const revisionStages = deliveryStages.slice(
  deliveryStages.indexOf('pre-commit-hooks'),
  deliveryStages.indexOf('merge') + 1,
);
const writerIndex = deliveryStages.indexOf('deliver');
const retainedStages = Object.freeze(deliveryStages.slice(0, writerIndex));
const repeatedStages = Object.freeze(deliveryStages.slice(writerIndex));
const instructions = Object.freeze([
  'Continue the original Writer conversation and preserve every retained Candidate ' +
    'change. The trusted Host applies a three-way merge onto the current main.',
  'Resolve conflicts in the original changed paths, preserving authorized work and ' +
    'current main. Remove conflict markers and unmerged entries; preserve Git metadata.',
  'Refresh source and applicable checks on the rebased bytes. Old Acceptance is ' +
    'historical. Repeat Candidate, both hooks, independent Accept, CI on the new head, ' +
    'final review and protected merge.',
]);

// Host supplies observations and owns I/O. Core decides applicability and which
// evidence must be repeated; a normal base advance never spends a rescue budget.
export function deliveryBaseRevisionPolicy({
  stage,
  prepared = false,
  hasWorkspace = false,
  merged = false,
} = {}) {
  if (!prepared && (!revisionStages.includes(stage) || !hasWorkspace || merged)) {
    return { outcome: 'not-applicable' };
  }
  return {
    outcome: prepared ? 'resume-prepared' : 'inspect-base',
    retainedStages,
    repeatedStages,
    instructions,
    role: 'deliver',
    status: 'UNACCEPTED',
    repairBudget: 'unchanged',
  };
}
