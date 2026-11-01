import { createHash } from 'node:crypto';
import { canonicalJSON, bodyDigest } from './canonical.mjs';
import { githubId } from './identity.mjs';

const fail = (name) => {
  throw new TypeError(`evidence:${name}`);
};
const copy = (v) => JSON.parse(canonicalJSON(v));
const equal = (a, b) => {
  if (canonicalJSON(a) !== canonicalJSON(b)) fail('mismatch');
};
const string = (v) => {
  if (typeof v !== 'string' || !v.length || /[\x00-\x1f]/.test(v)) fail('string');
};
const hash = (v) => {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('sha256');
};
const git = (v) => {
  if (typeof v !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v))
    fail('git');
};
function fields(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype) fail('object');
  equal(Object.keys(v).sort(), keys.split(' ').filter(Boolean).sort());
}
function enumeration(v, values) {
  if (!values.includes(v)) fail('enum');
}
function list(v, check, empty = true) {
  if (!Array.isArray(v) || (!empty && !v.length)) fail('array');
  v.forEach(check);
  if (new Set(v.map(canonicalJSON)).size !== v.length) fail('duplicate');
}
function path(v) {
  string(v);
  if (
    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(v) ||
    v.split('/').some((p) => p === '.' || p === '..')
  )
    fail('path');
}
const ROLES = Object.freeze({
  shape: 'shape',
  'shape-validator': 'shape',
  'shape-diagnosis': 'shape',
  'shaper-review': 'shape',
  deliver: 'deliver',
  accept: 'accept',
});
const SUCCESS = Object.freeze({
  shape: 'ready',
  'shape-validator': 'approved',
  'shape-diagnosis': 'approved',
  'shaper-review': 'approved',
  deliver: 'ready',
  accept: 'accepted',
});
export const protectedSkills = Object.freeze(['shape', 'deliver', 'accept']);
export function skillForRole(role) {
  if (!Object.hasOwn(ROLES, role)) fail('role');
  return ROLES[role];
}
export function outcomesForRole(role) {
  skillForRole(role);
  return Object.freeze([
    SUCCESS[role],
    'changes_required',
    'blocked',
    'decision_required',
    'proposal_update_required',
  ]);
}
// A result carries no repository, role, source or permission claims.
export function parseStageResult(input) {
  const v = copy(typeof input === 'string' ? JSON.parse(input) : input);
  fields(v, 'version outcome failureClass summary conflicts');
  if (v.version !== 1) fail('version');
  enumeration(v.outcome, [
    ...Object.values(SUCCESS),
    'changes_required',
    'blocked',
    'decision_required',
    'proposal_update_required',
  ]);
  enumeration(v.failureClass, [
    'none',
    'implementation_defect',
    'shape_defect',
    'authority_gap',
    'external_failure',
  ]);
  string(v.summary);
  const success = Object.values(SUCCESS).includes(v.outcome);
  if (success !== (v.failureClass === 'none')) fail('failure');
  if (
    v.outcome === 'changes_required' &&
    !['implementation_defect', 'shape_defect'].includes(v.failureClass)
  )
    fail('failure');
  if (
    ['decision_required', 'proposal_update_required'].includes(v.outcome) &&
    v.failureClass !== 'authority_gap'
  )
    fail('failure');
  list(v.conflicts, (c) => {
    fields(c, 'scopeHash shapeHash scopeQuote shapeQuote evidenceReference');
    hash(c.scopeHash);
    hash(c.shapeHash);
    string(c.scopeQuote);
    string(c.shapeQuote);
    string(c.evidenceReference);
  });
  if ((v.failureClass === 'shape_defect') !== v.conflicts.length > 0)
    fail('conflicts');
  return v;
}
export function byteDigest(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('bytes');
  return createHash('sha256').update(bytes).digest('hex');
}
export function contentIdentity(value) {
  return createHash('sha256')
    .update('nibfin-content-v1\n' + canonicalJSON(value))
    .digest('hex');
}
function source(v) {
  if (v === null) return;
  fields(v, 'repositoryId workflow runId attempt');
  githubId(v.repositoryId);
  hash(v.workflow);
  githubId(v.runId);
  githubId(v.attempt);
}
function binding(v) {
  fields(
    v,
    'authority grant policy core runtime instructions ' +
      'repositoryId issueId scopeHash shapeHash',
  );
  for (const k of [
    'authority',
    'grant',
    'policy',
    'core',
    'runtime',
    'instructions',
    'scopeHash',
  ])
    hash(v[k]);
  if (v.shapeHash !== null) hash(v.shapeHash);
  githubId(v.repositoryId);
  string(v.issueId);
}
function execution(v) {
  const continued = v && Object.hasOwn(v, 'continuation');
  fields(
    v,
    'role skill id request result source' + (continued ? ' continuation' : ''),
  );
  if (continued) {
    fields(v.continuation, 'version amendment core');
    if (v.continuation.version !== 1) fail('continuation');
    hash(v.continuation.amendment);
    hash(v.continuation.core);
  }
  if (skillForRole(v.role) !== v.skill) fail('skill');
  for (const k of ['id', 'request', 'result']) string(v[k]);
  source(v.source);
}
function candidate(v) {
  fields(v, 'base tree diff paths artifacts hooks emptyHooksReason');
  git(v.base);
  git(v.tree);
  hash(v.diff);
  list(v.paths, path);
  list(v.artifacts, (a) => {
    fields(a, 'path digest');
    path(a.path);
    hash(a.digest);
  });
  list(v.hooks, (h) => {
    fields(h, 'path event digest');
    path(h.path);
    hash(h.digest);
    enumeration(h.event, ['pre-commit', 'prepare-commit-msg', 'commit-msg']);
  });
  if (
    new Set(v.artifacts.map((a) => a.path)).size !== v.artifacts.length ||
    new Set(v.hooks.map((h) => h.path + ':' + h.event)).size !== v.hooks.length
  )
    fail('duplicate');
  if (!v.hooks.length) string(v.emptyHooksReason);
  else if (v.emptyHooksReason !== null) fail('applicability');
}
function proof(v) {
  fields(v, 'mode identities reason');
  enumeration(v.mode, ['required', 'not-applicable']);
  list(v.identities, hash, v.mode !== 'required');
  if (v.mode === 'not-applicable') {
    if (v.identities.length) fail('proof');
    string(v.reason);
  } else if (v.reason !== null) fail('proof');
}
// Stage fields are complete, exact inputs, not optional bags of claims.
const STAGES = {
  shape: { body: hash },
  'shape-validator': { body: hash, author: string },
  'shape-diagnosis': { body: hash },
  publication: {
    body: hash,
    author: string,
    validator: string,
    validation: hash,
    readback: hash,
  },
  deliver: { publication: hash, candidate },
  'pre-accept-hooks': {
    candidate,
    phase: (v) => equal(v, 'pre-accept'),
    receipt: hash,
  },
  accept: { candidate, hooks: hash, deliver: string },
  'pre-commit-hooks': {
    candidate,
    phase: (v) => equal(v, 'pre-commit'),
    accept: hash,
    receipt: hash,
  },
  pr: { candidate, accept: hash, hooks: hash, head: git, base: git, readback: hash },
  ci: { pr: hash, head: git, base: git, policy: hash, checks: hash },
  'shaper-review': {
    candidate,
    pr: hash,
    ci: hash,
    head: git,
    base: git,
    author: string,
    validator: string,
    deliver: string,
    accept: string,
  },
  merge: { review: hash, head: git, base: git, commit: git, readback: hash },
  final: { merge: hash, commit: git, postMerge: proof, deployment: proof },
  closure: {
    final: hash,
    commit: git,
    state: (v) => equal(v, 'completed'),
    readback: hash,
  },
  delivered: { closure: hash, commit: git, readback: hash },
};
export const stageApplicability = Object.freeze(
  Object.fromEntries(
    Object.entries(STAGES).map(([k, v]) => [k, Object.freeze(Object.keys(v))]),
  ),
);
function independence(stage, id, inputs) {
  const keys =
    stage === 'shape-validator'
      ? ['author']
      : stage === 'accept'
        ? ['deliver']
        : stage === 'shaper-review'
          ? ['author', 'validator', 'deliver', 'accept']
          : [];
  if (keys.some((k) => id === inputs[k])) fail('independence');
}
export function validateStageResult(result, context) {
  const v = parseStageResult(result);
  execution(context.execution);
  binding(context.binding);
  enumeration(v.outcome, outcomesForRole(context.execution.role));
  if (v.failureClass === 'shape_defect') {
    if (
      bodyDigest(context.scopeBody) !== context.binding.scopeHash ||
      bodyDigest(context.shapeBody) !== context.binding.shapeHash
    )
      fail('body');
    for (const c of v.conflicts) {
      equal(c.scopeHash, context.binding.scopeHash);
      equal(c.shapeHash, context.binding.shapeHash);
      if (
        !context.scopeBody.includes(c.scopeQuote) ||
        !context.shapeBody.includes(c.shapeQuote)
      )
        fail('quote');
    }
  }
  return v;
}
function envelope(v) {
  const retained = Object.hasOwn(v, 'retained');
  fields(
    v,
    'version stage binding execution inputs result' + (retained ? ' retained' : ''),
  );
  if (retained) {
    fields(v.retained, 'version handover record scopeHash shapeHash');
    if (
      v.retained.version !== 1 ||
      !['shape', 'shape-validator', 'publication'].includes(v.stage)
    )
      fail('retained-stage');
    for (const key of ['handover', 'record', 'scopeHash', 'shapeHash'])
      hash(v.retained[key]);
    if (v.execution?.source !== null) fail('retained-attribution');
  }
  if (v.version !== 1 || !Object.hasOwn(STAGES, v.stage)) fail('version-stage');
  binding(v.binding);
  execution(v.execution);
  const checks = STAGES[v.stage];
  fields(v.inputs, Object.keys(checks).join(' '));
  for (const [key, check] of Object.entries(checks)) check(v.inputs[key]);
  if (Object.hasOwn(ROLES, v.stage)) {
    equal(v.execution.role, v.stage);
    if (v.result === null) fail('result');
    const result = parseStageResult(v.result);
    enumeration(result.outcome, outcomesForRole(v.stage));
    if (result.failureClass !== 'none') fail('unsuccessful');
  } else if (v.result !== null) fail('result');
  if (v.stage !== 'shape' && v.binding.shapeHash === null) fail('shape');
  independence(v.stage, v.execution.id, v.inputs);
  if (v.stage === 'publication' && v.inputs.author === v.inputs.validator)
    fail('independence');
  if (['shape-validator', 'shape-diagnosis', 'publication'].includes(v.stage))
    equal(v.inputs.body, v.binding.shapeHash);
}
export function compareEvidence(receipt, current) {
  const v = copy(receipt);
  envelope(v);
  // Current is supplied by Core, never recovered from the receipt or cache.
  fields(current, 'expected consumed');
  envelope(current.expected);
  list(current.consumed, string);
  if (current.consumed.includes(v.execution.result)) fail('replay');
  equal(v, current.expected);
  return v;
}
/** Collect a classified failure without treating it as successful stage evidence.
 * Core supplies both the expected successful envelope and exact body provenance.
 */
export function compareStageCollection(receipt, current, bodies = {}) {
  const v = copy(receipt);
  const result = validateStageResult(v.result, {
    ...bodies,
    execution: v.execution,
    binding: v.binding,
  });
  if (result.failureClass === 'none')
    return { status: 'valid', evidence: compareEvidence(v, current) };
  // Validate every envelope field, stage input, independence and replay binding
  // with the protected successful result, then retain the separately checked failure.
  compareEvidence({ ...v, result: current.expected.result }, current);
  return { status: 'rejected', collection: v };
}
export function createEvidence(current) {
  return compareEvidence(current.expected, current);
}
const CHAIN = [
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
];
export function verifyEvidenceChain(input, current, through = 'delivered') {
  if (!['merge', 'final', 'closure', 'delivered'].includes(through)) fail('through');
  const stages = CHAIN.slice(0, CHAIN.indexOf(through) + 1);
  fields(input, 'version receipts');
  if (input.version !== 1) fail('version');
  fields(input.receipts, stages.join(' '));
  fields(current, stages.join(' '));
  const r = {};
  for (const stage of stages) {
    r[stage] = compareEvidence(input.receipts[stage], current[stage]);
    equal(r[stage].stage, stage);
    // Instructions belong to each execution; compareEvidence binds them to Core's
    // stage-specific expectation. Only these identities are shared by the chain.
    for (const key of [
      'authority',
      'grant',
      'policy',
      'core',
      'runtime',
      'repositoryId',
      'issueId',
      'scopeHash',
      'shapeHash',
    ]) {
      equal(r[stage].binding[key], r.publication.binding[key]);
    }
  }
  const i = (stage) => r[stage].inputs;
  const ref = (stage, key, upstream) => {
    if (r[stage]) equal(i(stage)[key], contentIdentity(r[upstream]));
  };
  ref('deliver', 'publication', 'publication');
  for (const s of [
    'pre-accept-hooks',
    'accept',
    'pre-commit-hooks',
    'pr',
    'shaper-review',
  ]) {
    equal(i(s).candidate, i('deliver').candidate);
  }
  ref('accept', 'hooks', 'pre-accept-hooks');
  ref('pre-commit-hooks', 'accept', 'accept');
  ref('pr', 'accept', 'accept');
  ref('pr', 'hooks', 'pre-commit-hooks');
  ref('ci', 'pr', 'pr');
  ref('shaper-review', 'pr', 'pr');
  ref('shaper-review', 'ci', 'ci');
  ref('merge', 'review', 'shaper-review');
  ref('final', 'merge', 'merge');
  ref('closure', 'final', 'final');
  ref('delivered', 'closure', 'closure');
  equal(i('accept').deliver, r.deliver.execution.id);
  for (const key of ['author', 'validator'])
    equal(i('shaper-review')[key], i('publication')[key]);
  equal(i('shaper-review').deliver, r.deliver.execution.id);
  equal(i('shaper-review').accept, r.accept.execution.id);
  for (const s of ['ci', 'shaper-review', 'merge']) {
    equal(i(s).head, i('pr').head);
    equal(i(s).base, i('pr').base);
  }
  equal(i('pr').base, i('deliver').candidate.base);
  equal(i('ci').policy, r.ci.binding.policy);
  for (const s of ['final', 'closure', 'delivered'].filter((s) => r[s]))
    equal(i(s).commit, i('merge').commit);
  return copy(input);
}
export function createCompletion(input, current) {
  const payload = verifyEvidenceChain(input, current);
  return {
    version: 1,
    payload,
    identity: contentIdentity({ kind: 'nibfin-completion-v1', payload }),
  };
}
export function verifyCompletion(receipt, current) {
  fields(receipt, 'version payload identity');
  equal(receipt, createCompletion(receipt.payload, current));
  return copy(receipt);
}
export function validateCompatibility(input) {
  const v = copy(input);
  fields(
    v,
    'version content agent host guest authentication isolation runner ' +
      'visibility ownership capability status evidence limitations',
  );
  if (v.version !== 1) fail('version');
  fields(v.content, 'core skills action workflow cli');
  for (const k of ['core', 'action', 'workflow', 'cli']) hash(v.content[k]);
  fields(v.content.skills, 'shape deliver accept');
  Object.values(v.content.skills).forEach(hash);
  fields(v.agent, 'name version');
  string(v.agent.name);
  string(v.agent.version);
  for (const platform of [v.host, v.guest]) {
    fields(platform, 'os architecture');
    string(platform.os);
    string(platform.architecture);
  }
  string(v.authentication);
  string(v.isolation);
  fields(v.runner, 'registration automatic');
  enumeration(v.runner.registration, ['repository', 'organization']);
  if (typeof v.runner.automatic !== 'boolean') fail('boolean');
  enumeration(v.visibility, ['public', 'private']);
  enumeration(v.ownership, ['personal', 'organization']);
  string(v.capability);
  enumeration(v.status, ['Implemented', 'Unverified', 'Unsupported', 'Supported']);
  list(v.limitations, string);
  list(
    v.evidence,
    (e) => {
      fields(e, 'kind location digest');
      enumeration(e.kind, [
        'research',
        'source-tested',
        'real-execution',
        'product-e2e',
      ]);
      string(e.location);
      hash(e.digest);
    },
    false,
  );
  if (v.visibility === 'private' && v.status !== 'Unsupported') fail('private');
  if (
    v.status === 'Supported' &&
    (v.agent.version === 'unknown' ||
      !v.evidence.some((e) => ['real-execution', 'product-e2e'].includes(e.kind)))
  )
    fail('support');
  if (
    v.status === 'Implemented' &&
    !v.evidence.some((e) => e.kind === 'source-tested')
  )
    fail('implementation');
  if (['Unsupported', 'Unverified'].includes(v.status) && !v.limitations.length)
    fail('limitations');
  return v;
}
export function compareCompatibility(receipt, expected) {
  const v = validateCompatibility(receipt);
  equal(v, validateCompatibility(expected));
  return v;
}
