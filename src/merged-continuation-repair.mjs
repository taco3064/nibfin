import { canonicalJSON } from './canonical.mjs';
import { prepareGrant, verifyGrant } from './grants.mjs';
import { contentIdentity } from './evidence.mjs';
import { validateDeliveryEvidence, shared } from './delivery-evidence.mjs';
import { deliveryStages } from './delivery-planner.mjs';
import {
  prepareMergedContinuation,
  verifyMergedContinuation,
  checkMergedContinuation,
  checkMergedContinuationFrame,
  mergedContinuationFrame,
} from './merged-continuation.mjs';

const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const need = (ok, reason) => {
  if (!ok) throw Error('continuation-repair:' + reason);
};
const fields = (value, names) =>
  need(value && same(Object.keys(value).sort(), names.split(' ').sort()), 'schema');
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const frozen = deliveryStages.slice(0, deliveryStages.indexOf('closure'));
const future = deliveryStages.slice(deliveryStages.indexOf('closure'));

function validateRepair(parent, execution, repair, context, depth) {
  need(depth < 16, 'compatibility-chain-depth');
  fields(repair, 'version previous retained');
  need(repair.version === 1, 'version');
  const previous = repair.previous;
  fields(previous, 'approval parent execution' + (previous.repair ? ' repair' : ''));
  need(same(previous.parent, parent), 'original-parent');
  need(
    execution.core !== previous.execution.core &&
      execution.keyId === previous.execution.keyId &&
      execution.validFrom >= previous.execution.validFrom &&
      execution.expiresAt <= previous.execution.expiresAt,
    'execution-only-change',
  );
  const priorContext = {
    ...context,
    expectedPolicy: { ...parent.policy, core: previous.execution.core },
    expectedWork: previous.approval.payload.work,
  };
  const prior = { ...previous, context: priorContext };
  const retained = repair.retained;
  fields(retained, 'state stage receipts expectations attempt failure observation');
  need(hash(retained.state) && retained.stage === 'closure', 'stopped-boundary');
  need(
    same(Object.keys(retained.receipts).sort(), [...frozen].sort()) &&
      same(Object.keys(retained.expectations).sort(), [...frozen].sort()),
    'retained-prefix',
  );
  const frame = mergedContinuationFrame(
    parent,
    retained.receipts,
    retained.expectations,
  );
  validateDeliveryEvidence(frame);
  checkMergedContinuation(prior, frame, depth + 1);
  const checked = verifyMergedContinuation(previous.approval, prior, depth + 1);
  const failure = retained.failure;
  const attempt = retained.attempt;
  need(
    attempt.phase === 'unresolved' &&
      attempt.source.repositoryId === parent.target.repositoryId &&
      hash(attempt.source.workflow) &&
      failure.disposition === 'blocked' &&
      same(failure.target, parent.target) &&
      failure.cycle === parent.cycle &&
      failure.executed === 'closure' &&
      failure.request === attempt.request &&
      failure.run.id === attempt.source.runId &&
      failure.run.attempt === attempt.source.attempt &&
      failure.inputs.continuation === checked.identity &&
      shared.every((key) => same(failure.inputs.binding[key], checked.binding[key])),
    'failure-binding',
  );
  need(
    failure.owner.outcome === 'blocked' && failure.owner.output.outcome === 'blocked',
    'original-failure',
  );
  const observation = retained.observation;
  fields(
    observation,
    'version state failure issue delivered lifecycleSinceFailure operations ' +
      'originalRun finalRun terminated',
  );
  need(
    observation.version === 1 &&
      observation.state === retained.state &&
      observation.failure === contentIdentity(failure) &&
      observation.issue === 'open' &&
      observation.delivered === false &&
      observation.terminated === true &&
      same(observation.lifecycleSinceFailure, []) &&
      same(observation.operations, {
        close: 'not-submitted',
        label: 'not-submitted',
      }),
    'no-effect-required',
  );
  const run = observation.originalRun;
  need(
    run.id === attempt.source.runId &&
      run.attempt === attempt.source.attempt &&
      run.repositoryId === parent.target.repositoryId &&
      run.conclusion === 'failure',
    'original-run',
  );
  const final = observation.finalRun;
  need(
    final.id === retained.receipts.final.execution.source.runId &&
      final.attempt === retained.receipts.final.execution.source.attempt &&
      final.repositoryId === parent.target.repositoryId &&
      final.conclusion === 'success',
    'retained-final-run',
  );
  return checked;
}

/** Execution compatibility only, at a stopped no-write closure boundary. The
 * host independently observes Runs, native operation custody and termination.
 * All original attempts, budgets and the successful final remain historical.
 */
export function prepareMergedContinuationRepair(
  parent,
  execution,
  repair,
  context,
  depth = 0,
) {
  validateRepair(parent, execution, repair, context, depth);
  const prepared = prepareMergedContinuation(parent, execution);
  const draft = {
    ...prepared.draft,
    recordId: 'continue-fix-' + contentIdentity({ parent, execution, repair }),
    revision: '2',
    permissions: prepared.draft.permissions.map((p) => ({
      ...p,
      operations: p.operations.filter((op) => op !== 'final'),
    })),
  };
  return prepareGrant(draft);
}

export function verifyMergedContinuationRepair(approval, input, depth = 0) {
  const { parent, execution, repair, context } = input;
  const { draft } = prepareMergedContinuationRepair(
    parent,
    execution,
    repair,
    context,
    depth,
  );
  need(
    approval.keyId === execution.keyId &&
      same(approval.payload, draft) &&
      verifyGrant(approval, context).ok,
    'fresh-approval',
  );
  const identity = contentIdentity(approval);
  return {
    identity,
    binding: structuredClone(parent.receipts.publication.binding),
    execution: { version: 1, amendment: identity, core: execution.core },
    remaining: [...future],
    repair: { identity: contentIdentity(repair), stage: 'closure' },
  };
}

export function checkMergedContinuationRepair(input, plan, depth = 0) {
  const checked = verifyMergedContinuationRepair(input.approval, input, depth);
  checkMergedContinuationFrame(input, plan);
  const retained = input.repair.retained;
  need(
    same(plan.receipts.final, retained.receipts.final) &&
      same(plan.evidenceCurrent.final, retained.expectations.final),
    'retained-final-rewrite',
  );
  for (const stage of future)
    if (plan.receipts[stage])
      need(
        same(plan.receipts[stage].execution.continuation, checked.execution),
        'execution-provenance',
      );
  return checked;
}
