import { validateDeliveryEvidence, shared, links } from './delivery-evidence.mjs';
import { checkMergedContinuation } from './merged-continuation.mjs';
import { bodyDigest, canonicalJSON } from './grants.mjs';
import { contentIdentity, compareEvidence } from './evidence.mjs';
import { githubId, repositoryCoordinates } from './identity.mjs';
import {
  coreStages,
  deliveryStages,
  nextDeliveryStage,
} from './delivery-planner.mjs';
import { checkUnacceptedHandoverFrame } from './delivery-revision.mjs';

const copy = structuredClone,
  same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const need = (ok, code) => {
  if (!ok) throw Error('core:' + code);
};
const text = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const fields = (v, names) =>
  need(v && same(Object.keys(v).sort(), names.split(' ').sort()), 'schema');
// Stage identifiers and dispatch are owned by Core, never an Issue or an event.
const operations = {
  publication: 'publish-shape',
  pr: 'commit-pr',
  ci: 'observe-ci',
  final: 'verify-deployment',
  closure: 'close',
  delivered: 'mark-delivered',
};
function identity(t) {
  fields(t, 'repository repositoryId issueId databaseId number');
  for (const k of ['repositoryId', 'databaseId', 'number']) githubId(t[k]);
  const [owner, repo, extra] = t.repository.split('/');
  need(
    !extra &&
      repositoryCoordinates(owner, repo).key === t.repository &&
      typeof t.issueId === 'string' &&
      /^[A-Za-z0-9_=-]{1,256}$/.test(t.issueId),
    'identity',
  );
}
function intake(r) {
  fields(r, 'version target cycle request run expected');
  need(r.version === 1 && text(r.cycle) && text(r.request), 'request');
  identity(r.target);
  fields(r.run, 'id attempt');
  githubId(r.run.id);
  githubId(r.run.attempt);
  fields(r.expected, 'stage decision');
  need(
    coreStages.includes(r.expected.stage) && hash(r.expected.decision),
    'decision',
  );
  return freeze(r);
}
function plan(p) {
  identity(p.target);
  need(
    text(p.cycle) &&
      p.visibility === 'public' &&
      ['personal', 'organization'].includes(p.ownership),
    'scope',
  );
  if (p.unacceptedHandover) checkUnacceptedHandoverFrame(p.unacceptedHandover, p);
  else
    need(
      !Object.values(p.receipts).some((r) => r.retained),
      'unapproved-retained-shape',
    );
  const receipts = validateDeliveryEvidence(p);
  const continuation = p.continuation
    ? checkMergedContinuation(p.continuation, p)
    : null;
  if (!continuation)
    need(
      !Object.values(receipts).some((r) => r.execution.continuation),
      'unapproved-continuation',
    );
  const stage = nextDeliveryStage(receipts, p.transition);
  // These inputs come from the recovery/repair owners' attributed, authorized handoffs.
  // Their respective run methods independently classify and recheck permission.
  const inputs = {
    ...(continuation ? { continuation: continuation.identity } : {}),
    ...(p.requirementRevision ? { requirementRevision: p.requirementRevision } : {}),
    ...(p.referenceInputApproval
      ? { referenceInputApproval: p.referenceInputApproval }
      : {}),
    binding: p.binding,
    scopeHash: p.binding.scopeHash,
    shapeHash: p.binding.shapeHash,
    candidate: p.candidate,
    base: p.base,
    head: p.head,
    ci: p.ciIdentity,
    cycle: p.cycle,
    receipts: Object.fromEntries(
      Object.entries(p.transition ? p.receipts : receipts).map(([s, e]) => [
        s,
        contentIdentity(e),
      ]),
    ),
    completion: p.completion?.identity ?? null,
    transition: p.transition,
    prior: contentIdentity(p.prior),
    operation: p.operationIdentity,
    stageInput: contentIdentity(p.stageInput),
    selection: contentIdentity(p.selectionInput),
    dependencies: contentIdentity(p.dependencyInput),
  };
  return {
    stage,
    identity: contentIdentity({ target: p.target, ...inputs }),
    inputs,
  };
}
// Bind owner-local verification to the decision being executed, not merely the
// same Issue/authority. Each owner still independently validates these inputs.
function ownerContext(value, p, name) {
  if (['accept', 'publication', 'review', 'merge'].includes(name))
    need(same(value.workspace?.candidate, p.candidate), 'owner-candidate');
  if (name === 'deliver') {
    need(value.capture?.base === p.base, 'owner-base');
    need(same(value.publication, p.receipts.publication), 'owner-publication');
  }
  const aliases = {
    author: 'shape',
    validator: 'shape-validator',
    firstStage: 'pre-accept-hooks',
    secondStage: 'pre-commit-hooks',
  };
  for (const [key, item] of Object.entries(value.evidence ?? {})) {
    const stage = aliases[key] ?? key;
    if (p.receipts[stage])
      need(same(item.value, p.receipts[stage]), 'owner-evidence');
  }
  if (name === 'completion')
    for (const stage of deliveryStages.slice(2, 12))
      need(same(value.receipts?.[stage], p.receipts[stage]), 'owner-evidence');
  if (name === 'accept')
    need(
      same(value.deliver, p.receipts.deliver) &&
        same(value.hooks?.stage, p.receipts['pre-accept-hooks']),
      'owner-evidence',
    );
  if (['review', 'merge'].includes(name))
    need(
      value.observation?.head === p.head && value.observation?.base === p.base,
      'owner-head',
    );
}
function ownerEvidence(e, p, stage) {
  need(e.stage === stage, 'owner-stage');
  if (p.continuation) {
    const checked = checkMergedContinuation(p.continuation, p);
    need(
      checked.remaining.includes(stage) &&
        same(e.execution.continuation, checked.execution),
      'owner-continuation',
    );
  } else need(!e.execution.continuation, 'unapproved-continuation');
  for (const k of [...shared, 'shapeHash'])
    if (!(stage === 'shape' && k === 'shapeHash'))
      need(e.binding[k] === p.binding[k], 'owner-binding');
  if (stage !== 'deliver' && e.inputs.candidate && p.candidate !== null)
    need(same(e.inputs.candidate, p.candidate), 'owner-candidate');
  for (const k of ['base', 'head'])
    if (k in e.inputs) need(e.inputs[k] === p[k], 'owner-head');
  for (const [key, upstream] of Object.entries(links[stage] ?? {}))
    need(e.inputs[key] === contentIdentity(p.receipts[upstream]), 'owner-evidence');
  if (stage === 'accept')
    need(e.inputs.deliver === p.receipts.deliver.execution.id, 'owner-evidence');
  if (stage === 'shape-validator')
    need(
      e.inputs.author === p.receipts.shape.execution.id &&
        e.inputs.body === p.binding.shapeHash,
      'owner-evidence',
    );
  if (stage === 'shaper-review')
    for (const [key, s] of Object.entries({
      author: 'shape',
      validator: 'shape-validator',
      deliver: 'deliver',
      accept: 'accept',
    }))
      need(e.inputs[key] === p.receipts[s].execution.id, 'owner-evidence');
}
function shapeChain(value, p, validated = false) {
  need(
    value.original?.kind === 'raw-scope' &&
      value.original.body === p.scopeBody &&
      value.original.hash === p.binding.scopeHash,
    'owner-scope',
  );
  need(
    value.author?.body === p.shapeBody &&
      same(value.author.receipt, p.receipts.shape),
    'owner-author',
  );
  if (validated)
    need(
      value.validator?.body === p.shapeBody &&
        same(value.validator.receipt, p.receipts['shape-validator']),
      'owner-validator',
    );
}
function shapeResult(value, p, stage) {
  if (stage === 'shape' && value.outcome === 'authored') {
    need(
      value.original?.body === p.scopeBody &&
        value.original.hash === p.binding.scopeHash,
      'owner-scope',
    );
    ownerEvidence(value.author.receipt, p, 'shape');
    need(
      value.author.receipt.inputs.body === bodyDigest(value.author.body),
      'owner-body',
    );
  }
  if (stage === 'shape-validator' && value.outcome === 'validated') {
    shapeChain(value, p);
    ownerEvidence(value.validator.receipt, p, stage);
    need(value.validator.body === p.shapeBody, 'owner-body');
  }
  if (stage === 'publication' && value.outcome === 'published') {
    const v = value.publication;
    need(
      v.original?.body === p.scopeBody &&
        v.original.hash === p.binding.scopeHash &&
        v.shapeHash === p.binding.shapeHash &&
        same(v.author, p.receipts.shape.execution) &&
        same(v.validator, p.receipts['shape-validator'].execution) &&
        v.validation === contentIdentity(p.receipts['shape-validator']),
      'owner-publication',
    );
    for (const k of [...shared, 'shapeHash'])
      need(v.binding[k] === p.binding[k], 'owner-binding');
  }
}

export {
  copy,
  same,
  need,
  hash,
  freeze,
  operations,
  shared,
  intake,
  plan,
  ownerContext,
  ownerEvidence,
  shapeChain,
  shapeResult,
};
