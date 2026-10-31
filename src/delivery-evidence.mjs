import { bodyDigest, canonicalJSON } from './grants.mjs';
import { contentIdentity, compareEvidence, verifyCompletion } from './evidence.mjs';
import { modelRoleStages, deliveryStages } from './delivery-planner.mjs';
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const need = (ok, reason) => {
  if (!ok) throw Error('core:' + reason);
};
const sequence = deliveryStages;
const links = {
  deliver: { publication: 'publication' },
  accept: { hooks: 'pre-accept-hooks' },
  'pre-commit-hooks': { accept: 'accept' },
  pr: { accept: 'accept', hooks: 'pre-commit-hooks' },
  ci: { pr: 'pr' },
  'shaper-review': { pr: 'pr', ci: 'ci' },
  merge: { review: 'shaper-review' },
  final: { merge: 'merge' },
  closure: { final: 'final' },
  delivered: { closure: 'closure' },
};
const shared = [
  'authority',
  'grant',
  'policy',
  'core',
  'runtime',
  'repositoryId',
  'issueId',
  'scopeHash',
];

export function validateDeliveryEvidence(p) {
  need(
    bodyDigest(p.scopeBody) === p.binding.scopeHash &&
      p.binding.repositoryId === p.target.repositoryId &&
      p.binding.issueId === p.target.issueId,
    'scope',
  );
  need(
    p.shapeBody === null
      ? p.binding.shapeHash === null
      : bodyDigest(p.shapeBody) === p.binding.shapeHash,
    'shape',
  );
  const receipts = {},
    ids = new Set();
  need(p.receipts && p.evidenceCurrent, 'evidence');
  need(
    p.transition === null || ['recovery', 'repair'].includes(p.transition),
    'transition',
  );
  let gap = false;
  for (const stage of p.transition ? [] : sequence) {
    const submitted = p.receipts[stage];
    if (!submitted) {
      gap = true;
      continue;
    }
    need(!gap, 'evidence-gap');
    const e = compareEvidence(submitted, p.evidenceCurrent[stage]);
    need(e.stage === stage, 'stage');
    for (const k of shared) need(e.binding[k] === p.binding[k], 'evidence-binding');
    if (stage !== 'shape')
      need(e.binding.shapeHash === p.binding.shapeHash, 'evidence-binding');
    if (modelRoleStages.includes(stage)) {
      for (const k of ['id', 'request', 'result'])
        need(!ids.has(e.execution[k]), 'independence');
      for (const k of ['id', 'request', 'result']) ids.add(e.execution[k]);
    }
    if (stage === 'shape') need(e.inputs.body === p.binding.shapeHash, 'shape');
    if (stage === 'shape-validator')
      need(e.inputs.author === receipts.shape.execution.id, 'author');
    if (stage === 'publication')
      need(
        e.inputs.author === receipts.shape.execution.id &&
          e.inputs.validator === receipts['shape-validator'].execution.id,
        'validator',
      );
    for (const [key, upstream] of Object.entries(links[stage] ?? {}))
      need(e.inputs[key] === contentIdentity(receipts[upstream]), 'evidence-link');
    if (e.inputs.candidate) {
      need(same(e.inputs.candidate, p.candidate), 'candidate');
      if (stage !== 'deliver')
        need(
          same(e.inputs.candidate, receipts.deliver.inputs.candidate),
          'candidate',
        );
    }
    if (['pr', 'ci', 'shaper-review', 'merge'].includes(stage))
      need(e.inputs.base === p.base && e.inputs.head === p.head, 'head');
    if (stage === 'pr') need(e.inputs.base === p.candidate.base, 'base');
    if (stage === 'ci') need(e.inputs.policy === p.binding.policy, 'ci');
    if (stage === 'accept')
      need(e.inputs.deliver === receipts.deliver.execution.id, 'deliver');
    if (stage === 'shaper-review')
      for (const [key, s] of Object.entries({
        author: 'shape',
        validator: 'shape-validator',
        deliver: 'deliver',
        accept: 'accept',
      }))
        need(e.inputs[key] === receipts[s].execution.id, 'review');
    if (['final', 'closure', 'delivered'].includes(stage))
      need(e.inputs.commit === receipts.merge.inputs.commit, 'commit');
    receipts[stage] = e;
  }
  if (p.completion) verifyCompletion(p.completion, p.completionCurrent);
  return receipts;
}
export { shared, links };
