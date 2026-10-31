import { canonicalJSON, bodyDigest } from './canonical.mjs';
import { prepareGrant, verifyGrant } from './grants.mjs';
import { authoritySnapshot, verifyAuthority } from './authority.mjs';
import { contentIdentity } from './evidence.mjs';
import { validateDeliveryEvidence } from './delivery-evidence.mjs';
import { deliveryStages } from './delivery-planner.mjs';

const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const need = (ok, reason) => {
  if (!ok) throw Error('continuation:' + reason);
};
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const prefix = deliveryStages.slice(0, deliveryStages.indexOf('merge') + 1);
const remaining = deliveryStages.slice(deliveryStages.indexOf('merge') + 1);
const operations = [
  ...remaining,
  'readiness',
  'verify-deployment',
  'close',
  'mark-delivered',
  'dispatch',
  'fanout',
];
const fields = (value, names) =>
  need(value && same(Object.keys(value).sort(), names.split(' ').sort()), 'schema');

// The original successful chain is immutable historical evidence. A fresh Owner
// Grant authorizes only its remaining completion work on a reviewed new Core.
// Neither the previous private key nor an imported label supplies permission.
function validateParent(parent, execution) {
  fields(
    parent,
    'state archive cycle target memberId ownerKey grant policy authority ' +
      'scopeBody shapeBody receipts expectations revocation',
  );
  fields(execution, 'core source activation memberId keyId validFrom expiresAt');
  need(
    hash(parent.state) &&
      hash(parent.archive) &&
      hash(execution.core) &&
      hash(execution.activation) &&
      /^[a-f0-9]{40}$/.test(execution.source),
    'provenance',
  );
  need(
    execution.memberId === parent.memberId &&
      typeof execution.keyId === 'string' &&
      execution.keyId !== parent.ownerKey.id,
    'fresh-owner',
  );
  need(
    Number.isSafeInteger(execution.validFrom) &&
      Number.isSafeInteger(execution.expiresAt) &&
      execution.validFrom < execution.expiresAt &&
      execution.expiresAt <= parent.grant.payload.expiresAt,
    'validity',
  );
  const payload = parent.grant.payload;
  const work = payload.work.find(
    (item) =>
      item.repository.id === parent.target.repositoryId &&
      item.issueId === parent.target.issueId &&
      item.number === parent.target.number,
  );
  need(
    work &&
      work.repository.name === parent.target.repository &&
      work.scope.body === parent.scopeBody &&
      same(payload.policy, parent.policy),
    'original-work',
  );
  const context = {
    now: execution.validFrom,
    trustedKeys: new Map([[parent.ownerKey.id, parent.ownerKey.publicKey]]),
    revocation: parent.revocation,
    expectedAuthority: authoritySnapshot(parent.authority),
    expectedPolicy: parent.policy,
    expectedWork: payload.work,
    request: {
      repository: work.repository,
      issueId: work.issueId,
      number: work.number,
      path: payload.permissions.find((p) => p.repository.id === work.repository.id)
        ?.paths[0],
      operation: 'verify-deployment',
    },
  };
  const authority = verifyAuthority(parent.authority, {
    grant: parent.grant,
    grantContext: context,
    expected: {
      source: parent.authority.source,
      revision: parent.authority.revision,
      approvalId: parent.authority.approvalId,
      cycle: parent.cycle,
    },
  });
  need(authority.ok, 'historical-authority');
  need(
    same(Object.keys(parent.receipts).sort(), [...prefix].sort()) &&
      same(Object.keys(parent.expectations).sort(), [...prefix].sort()),
    'merged-prefix',
  );
  const binding = parent.receipts.publication.binding;
  validateDeliveryEvidence({
    target: parent.target,
    binding,
    scopeBody: parent.scopeBody,
    shapeBody: parent.shapeBody,
    receipts: parent.receipts,
    evidenceCurrent: parent.expectations,
    candidate: parent.receipts.deliver.inputs.candidate,
    base: parent.receipts.pr.inputs.base,
    head: parent.receipts.pr.inputs.head,
    transition: null,
    completion: null,
  });
  need(
    binding.authority === authority.binding.identity &&
      binding.grant === contentIdentity(parent.grant) &&
      binding.policy === contentIdentity(parent.policy) &&
      binding.core === parent.policy.core &&
      binding.runtime === parent.policy.runtime &&
      binding.repositoryId === parent.target.repositoryId &&
      binding.issueId === parent.target.issueId &&
      binding.scopeHash === bodyDigest(parent.scopeBody) &&
      binding.shapeHash === bodyDigest(parent.shapeBody),
    'historical-binding',
  );
  return binding;
}

/** Pure draft. The host separately proves termination, exact archive bytes,
 * current Issue/Owner identity and the installed execution Core before signing.
 * The parent state hash also binds original attempts, repair counts and sessions.
 */
export function prepareMergedContinuation(parent, execution) {
  validateParent(parent, execution);
  const original = parent.grant.payload;
  const work = original.work.filter(
    (item) =>
      item.repository.id === parent.target.repositoryId &&
      item.issueId === parent.target.issueId,
  );
  const permissions = original.permissions
    .filter((p) => p.repository.id === parent.target.repositoryId)
    .map((p) => ({
      ...structuredClone(p),
      operations: p.operations.filter((op) => operations.includes(op)),
    }));
  const draft = {
    ...structuredClone(original),
    recordId: 'continuation-' + contentIdentity({ parent, execution }),
    revision: '1',
    revocationId: execution.keyId,
    validFrom: execution.validFrom,
    expiresAt: execution.expiresAt,
    work,
    permissions,
    policy: { ...structuredClone(parent.policy), core: execution.core },
  };
  return prepareGrant(draft);
}

/** A current independently supplied Owner context verifies the fresh Grant.
 * This does not re-sign old Acceptance, convert UNACCEPTED work, or grant repair.
 */
export function verifyMergedContinuation(approval, { parent, execution, context }) {
  const binding = validateParent(parent, execution);
  const { draft } = prepareMergedContinuation(parent, execution);
  need(
    approval.keyId === execution.keyId &&
      same(approval.payload, draft) &&
      verifyGrant(approval, context).ok,
    'fresh-approval',
  );
  const identity = contentIdentity(approval);
  return {
    identity,
    binding: structuredClone(binding),
    execution: { version: 1, amendment: identity, core: execution.core },
    remaining: [...remaining],
  };
}

// Called at every plan/checkpoint. Historical receipts must stay byte-identical;
// later receipts explicitly identify the new Core and continuation approval.
export function checkMergedContinuation(input, plan) {
  const checked = verifyMergedContinuation(input.approval, input);
  need(plan.transition === null, 'completion-only');
  need(
    plan.cycle === input.parent.cycle &&
      same(plan.target, input.parent.target) &&
      plan.scopeBody === input.parent.scopeBody &&
      plan.shapeBody === input.parent.shapeBody,
    'current-work',
  );
  for (const stage of prefix)
    need(
      same(plan.receipts[stage], input.parent.receipts[stage]) &&
        same(plan.evidenceCurrent[stage], input.parent.expectations[stage]),
      'historical-rewrite',
    );
  for (const stage of remaining)
    if (plan.receipts[stage])
      need(
        same(plan.receipts[stage].execution.continuation, checked.execution),
        'execution-provenance',
      );
  return checked;
}
