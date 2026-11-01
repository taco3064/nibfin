import { deliveryStages } from './delivery-planner.mjs';
import { canonicalJSON } from './canonical.mjs';
import { contentIdentity } from './evidence.mjs';
import { verifyGrant } from './grants.mjs';
import { validateDeliveryEvidence } from './delivery-evidence.mjs';
import { createPreservedRoleContinuation } from './role-continuation.mjs';
import { retainedShapeEvidence, inspectRetainedShape } from './retained-shape.mjs';

export function handoverLabelsIdentity(labels) {
  if (
    !Array.isArray(labels) ||
    labels.length > 1000 ||
    labels.some(
      (label) =>
        !label ||
        typeof label.id !== 'string' ||
        !/^[1-9][0-9]*$/.test(label.id) ||
        typeof label.name !== 'string',
    ) ||
    new Set(labels.map((label) => label.id)).size !== labels.length ||
    new Set(labels.map((label) => label.name)).size !== labels.length
  )
    throw Error('unaccepted-handover:labels');
  return contentIdentity(
    labels
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

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

/** Reuse historical source and the same Writer, never historical authority or
 * acceptance. The current Owner separately approves a normal fresh Grant whose
 * record identity binds the entire donor proof. The Host supplies actual I/O.
 */
export function unacceptedHandoverPolicy({ original, current } = {}) {
  const need = (ok, reason) => {
    if (!ok) throw Error('unaccepted-handover:' + reason);
  };
  const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  need(
    original?.version === 1 &&
      original.kind === 'native-legacy-unaccepted-custody' &&
      original.status === 'UNACCEPTED' &&
      original.snapshot?.terminated === true &&
      original.workspaceSnapshot?.status === 'UNACCEPTED' &&
      ['archive', 'state', 'originalScope', 'originalShape', 'conversation'].every(
        (name) => hash(original[name]),
      ),
    'original-custody',
  );
  need(
    canonicalJSON(original.target) === canonicalJSON(current?.target) &&
      original.memberId === current.memberId &&
      hash(current.scopeHash) &&
      hash(current.core) &&
      hash(current.authority) &&
      hash(current.labels) &&
      current.workflow === 'shaped' &&
      typeof current.cycle === 'string' &&
      current.cycle.length > 0,
    'target',
  );
  need(
    Number.isSafeInteger(original.repairs) &&
      original.repairs >= 0 &&
      original.snapshot.role === 'deliver' &&
      original.snapshot.memberId === original.memberId &&
      original.snapshot.session === original.session &&
      original.snapshot.execution === original.execution &&
      original.workspaceSnapshot.execution.id === original.execution,
    'writer',
  );
  const { digest, terminated, ...snapshot } = original.snapshot;
  need(
    terminated === true &&
      contentIdentity(snapshot) === digest &&
      original.snapshot.adapter === 'codex' &&
      original.workspaceSnapshot.kind === 'native-unaccepted-workspace',
    'snapshot-integrity',
  );
  inspectRetainedShape(original);
  const identity = contentIdentity({
    kind: 'unaccepted-handover',
    original,
    current,
  });
  return {
    version: 1,
    identity,
    recordId: current.cycle + '-handover-' + identity,
    status: 'UNACCEPTED',
    role: 'deliver',
    session: original.session,
    repairs: original.repairs,
    requiresFreshShape: false,
    retainedStages: [...retainedStages],
    repeatedStages: [...repeatedStages],
    next: 'deliver',
    instructions: [
      'Retain the original Writer conversation and all unaccepted Candidate edits.',
      'Keep the published Shape and its original independent validation.',
      'Use the current Issue Scope; report any actual Shape conflict explicitly.',
      'Integrate retained changes with current main; preserve later improvements.',
      'Repeat all normal verification, independent Acceptance and merge gates.',
      'Historical results are data only. Do not reset the original repair count.',
    ],
  };
}

export function verifyUnacceptedHandover({ original, current, grant, context }) {
  const plan = unacceptedHandoverPolicy({ original, current });
  if (
    grant?.payload?.recordId !== plan.recordId ||
    grant.payload.policy.core !== current.core ||
    context?.expectedWork?.length !== 1 ||
    context.expectedWork[0].issueId !== current.target.issueId ||
    context.expectedWork[0].repository.name !== current.target.repository ||
    context.expectedWork[0].number !== current.target.number ||
    context.expectedWork[0].scope.hash !== current.scopeHash ||
    !verifyGrant(grant, context).ok
  )
    throw Error('unaccepted-handover:current-owner-approval');
  return plan;
}

export function createUnacceptedHandoverEvidence(input) {
  const plan = verifyUnacceptedHandover(input);
  return retainedShapeEvidence({ ...input, identity: plan.identity });
}

export function checkUnacceptedHandoverFrame(input, frame) {
  const retained = createUnacceptedHandoverEvidence(input);
  if (
    frame.scopeBody !== input.grant.payload.work[0].scope.body ||
    frame.shapeBody !== retained.shapeBody ||
    frame.cycle !== input.current.cycle
  )
    throw Error('unaccepted-handover:requirements-drift');
  for (const stage of retainedStages)
    if (
      canonicalJSON(frame.receipts[stage]) !==
        canonicalJSON(retained.receipts[stage]) ||
      canonicalJSON(frame.evidenceCurrent[stage]) !==
        canonicalJSON(retained.expectations[stage])
    )
      throw Error('unaccepted-handover:historical-rewrite');
  return retained;
}

export function createUnacceptedHandoverContinuation({
  original,
  current,
  grant,
  context,
  evidence,
  load,
  retain,
  prepare,
  now,
}) {
  const plan = verifyUnacceptedHandover({ original, current, grant, context });
  checkUnacceptedHandoverFrame({ original, current, grant, context }, evidence);
  const receipts = validateDeliveryEvidence(evidence);
  const binding = evidence.binding;
  if (
    !receipts.publication ||
    receipts.deliver ||
    binding.grant !== contentIdentity(grant) ||
    binding.policy !== contentIdentity(grant.payload.policy) ||
    binding.core !== current.core ||
    binding.scopeHash !== current.scopeHash ||
    binding.authority !== JSON.parse(context.expectedAuthority.body).identity ||
    binding.repositoryId !== context.request.repository.id ||
    binding.issueId !== current.target.issueId
  )
    throw Error('unaccepted-handover:retained-shape-required');
  const expected = {
    ...current.target,
    repositoryId: binding.repositoryId,
    cycle: current.cycle,
    execution: original.execution,
    role: 'deliver',
    memberId: current.memberId,
    session: original.session,
    adapter: 'codex',
    authority: binding.authority,
    scopeHash: current.scopeHash,
    requirements: current.scopeHash,
    shapeHash: binding.shapeHash,
    candidate: contentIdentity(original.workspaceSnapshot),
  };
  const continuation = createPreservedRoleContinuation({
    identityField: 'handoverId',
    validateTarget: (target) => {
      if (canonicalJSON(target) !== canonicalJSON(expected))
        throw Error('unaccepted-handover:original-role');
      return structuredClone(target);
    },
    load,
    retain,
    prepare,
    now,
  });
  return (request) => {
    if (request.handoverId !== plan.identity)
      throw Error('unaccepted-handover:approval-identity');
    return continuation(request);
  };
}
