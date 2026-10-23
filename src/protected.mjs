import { validateRequirements, verifyRequirements } from './requirements.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = x => typeof x === 'string' && x.length > 0;
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, message) => { if (!ok) throw Error(message); };
function fields(x, required, optional = []) {
  check(object(x) && required.every(k => Object.hasOwn(x, k)) &&
    Object.keys(x).every(k => [...required, ...optional].includes(k)), 'Unsupported or missing contract fields.');
}
export const roles = Object.freeze({ shape: 'shape', 'shape-validator': 'shape',
  'shape-diagnosis': 'shape', 'shaper-review': 'shape', deliver: 'deliver', accept: 'accept' });
export const failureClasses = Object.freeze(['none', 'implementation_defect', 'shape_defect', 'authority_gap', 'external_failure']);
const builtins = Object.freeze(Object.fromEntries(['shape', 'deliver', 'accept'].map(skill =>
  [skill, readFileSync(new URL(`./instructions/${skill}.md`, import.meta.url), 'utf8')])));
export function skillForRole(role) {
  check(text(role) && Object.hasOwn(roles, role), 'Unsupported protected execution role.');
  return roles[role];
}
export function instructionApproval(context, source, skill, entry) {
  return digest({ context, source, skill, mode: entry.mode, content: entry.content });
}
export function resolveInstructions(role, configuration, context) {
  const skill = skillForRole(role);
  fields(configuration, ['repository', 'shared', 'approved']);
  check(object(configuration.repository) && object(configuration.shared) &&
    Object.keys(configuration.repository).every(k => ['shape', 'deliver', 'accept'].includes(k)) &&
    Object.keys(configuration.shared).every(k => ['shape', 'deliver', 'accept'].includes(k)) &&
    Array.isArray(configuration.approved) && configuration.approved.every(hash), 'Invalid trusted instruction configuration.');
  let source = 'builtin';
  let entry = { mode: 'default', content: '' };
  for (const level of ['repository', 'shared']) {
    if (Object.hasOwn(configuration[level], skill)) { source = level; entry = configuration[level][skill]; break; }
  }
  fields(entry, ['mode', 'content']);
  check(['default', 'extend', 'override'].includes(entry.mode) && typeof entry.content === 'string' &&
    (entry.mode !== 'default' || entry.content === ''), 'Invalid instruction mode or content.');
  const approvalDigest = instructionApproval(context, source, skill, entry);
  check(source === 'builtin' || configuration.approved.includes(approvalDigest), 'Selected instructions are not approved.');
  const content = entry.mode === 'override' ? entry.content : builtins[skill] +
    (entry.mode === 'extend' ? `\n${entry.content}` : '');
  const contentDigest = digest(content);
  const selectionDigest = digest({ skill, source, mode: entry.mode, approvalDigest, contentDigest });
  return { skill, source, mode: entry.mode, approvalDigest, content, contentDigest, selectionDigest };
}
function source(x) {
  fields(x, ['repositoryId', 'workflow', 'workflowDigest', 'runId', 'attempt']);
  check(['repositoryId', 'workflow', 'runId'].every(k => text(x[k])) && hash(x.workflowDigest) &&
    Number.isSafeInteger(x.attempt) && x.attempt > 0, 'Invalid Actions source.');
}
const bindingKeys = ['requestId', 'resultId', 'sessionId', 'role', 'skill', 'repository', 'issue',
  'authority', 'requirements', 'scopeDigest', 'shapeDigest', 'candidateDigest', 'deliveryCycle', 'repairCycle',
  'incidentId', 'source', 'versions', 'instructionDigest', 'instructionSelectionDigest', 'previousDigest'];
export function validateBinding(b) {
  fields(b, bindingKeys);
  check(skillForRole(b.role) === b.skill, 'Role and protected Skill mismatch.');
  for (const k of ['requestId', 'resultId', 'sessionId']) check(text(b[k]), 'Missing execution identity.');
  fields(b.repository, ['id', 'name']);
  check(text(b.repository.id) && text(b.repository.name) && /^[^/\s]+\/[^/\s]+$/.test(b.repository.name), 'Invalid repository.');
  fields(b.issue, ['id', 'number', 'repositoryId']);
  check(text(b.issue.id) && Number.isSafeInteger(b.issue.number) && b.issue.number > 0 &&
    b.issue.repositoryId === b.repository.id, 'Invalid Issue binding.');
  validateRequirements(b.requirements);
  fields(b.authority, ['grantId', 'digest']);
  check(text(b.authority.grantId) && hash(b.authority.digest) && hash(b.scopeDigest) && hash(b.instructionDigest) && hash(b.instructionSelectionDigest) && hash(b.previousDigest), 'Invalid authority or content identity.');
  for (const k of ['shapeDigest', 'candidateDigest']) check(b[k] === null || hash(b[k]), 'Invalid artifact identity.');
  if (b.role !== 'shape') check(hash(b.shapeDigest), 'Current Shape identity is required.');
  if (['accept', 'shaper-review'].includes(b.role)) check(hash(b.candidateDigest), 'Candidate identity is required.');
  for (const k of ['deliveryCycle', 'repairCycle', 'incidentId']) check(b[k] === null || text(b[k]), 'Invalid work cycle.');
  if (['deliver', 'accept', 'shaper-review'].includes(b.role)) check(text(b.deliveryCycle), 'Delivery cycle is required.');
  if (b.repairCycle !== null) check(text(b.deliveryCycle), 'Repair requires a delivery cycle.');
  if (b.incidentId !== null) check(text(b.repairCycle), 'Incident requires a repair cycle.');
  source(b.source);
  fields(b.versions, ['core', 'runtime', 'adapter', 'skill']);
  check(Object.values(b.versions).every(hash), 'Pinned component digests are required.');
  return b;
}
export function validateProtectedRequest(r) {
  fields(r, ['schemaVersion', 'binding', 'previous']);
  check(r.schemaVersion === 3, 'Unsupported protected schema version.');
  validateBinding(r.binding);
  check(Array.isArray(r.previous), 'Prior references must be an array.');
  for (const p of r.previous) {
    fields(p, ['binding', 'digest']); validateBinding(p.binding); check(hash(p.digest), 'Invalid prior digest.');
  }
  check(new Set(r.previous.map(p => p.binding.resultId)).size === r.previous.length, 'Duplicate prior references.');
  return r;
}
const successes = Object.freeze({ shape: 'proposal', 'shape-validator': 'approved', deliver: 'candidate',
  accept: 'accepted', 'shape-diagnosis': 'not-confirmed', 'shaper-review': 'approved' });
export function validateRoleResult(r, expected, conflicts = []) {
  fields(r, ['schemaVersion', 'binding', 'outcome', 'failureClass', 'references', 'conflicts']);
  check(r.schemaVersion === 3, 'Unsupported role result version.');
  validateBinding(r.binding); check(same(r.binding, expected), 'Result assignment mismatch.');
  check(failureClasses.includes(r.failureClass) && Array.isArray(r.references) && r.references.every(text) &&
    Array.isArray(r.conflicts), 'Invalid result classification or evidence references.');
  const role = expected.role;
  if (r.outcome === 'candidate') check(hash(expected.candidateDigest), 'Deliver success requires Candidate identity.');
  const success = r.outcome === successes[role] && r.failureClass === 'none';
  const concern = r.outcome === 'concern' && r.failureClass !== 'none';
  const rejection = ['shape-validator', 'accept', 'shaper-review'].includes(role) &&
    r.outcome === 'rejected' && r.failureClass !== 'none';
  const diagnosis = role === 'shape-diagnosis' && r.outcome === 'confirmed' && r.failureClass === 'shape_defect';
  check(success || concern || rejection || diagnosis, 'Contradictory role outcome or classification.');
  if (diagnosis) {
    check(r.conflicts.length > 0 && same(r.conflicts, conflicts), 'Shape diagnosis requires authenticated exact conflicts.');
    for (const c of r.conflicts) {
      fields(c, ['scopeHash', 'shapeHash', 'scopeQuote', 'shapeQuote', 'explanation', 'evidenceReference']);
      check(c.scopeHash === expected.scopeDigest && c.shapeHash === expected.shapeDigest &&
        ['scopeQuote', 'shapeQuote', 'explanation', 'evidenceReference'].every(k => text(c[k])), 'Invalid Scope/Shape conflict.');
    }
  } else check(r.conflicts.length === 0, 'Only confirmed diagnosis carries contract conflicts.');
  if (success || diagnosis) check(r.references.length > 0, 'Successful role result requires evidence references.');
  return r;
}
// These records describe authenticated existing lifecycle evidence, not operations.
export function validateLifecycle(e, expected, policy) {
  fields(policy, [], ['deploymentNotApplicableReason', 'requireValidCompletion']);
  if (Object.hasOwn(policy, 'deploymentNotApplicableReason')) check(text(policy.deploymentNotApplicableReason), 'Invalid deployment applicability reason.');
  if (Object.hasOwn(policy, 'requireValidCompletion')) check(typeof policy.requireValidCompletion === 'boolean', 'Invalid completion policy.');
  fields(e, ['kind', 'repositoryId', 'issueId', 'deliveryCycle', 'repairCycle', 'incidentId',
    'mergeSha', 'version', 'environment', 'source', 'state', 'references', 'reason']);
  check(same(e, expected), 'Lifecycle evidence differs from authenticated expectation.');
  check(['deployment', 'completion', 'recovery'].includes(e.kind) &&
    ['repositoryId', 'issueId', 'deliveryCycle', 'version', 'environment'].every(k => text(e[k])) &&
    typeof e.mergeSha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(e.mergeSha), 'Invalid lifecycle identity.');
  source(e.source);
  for (const k of ['repairCycle', 'incidentId']) check(e[k] === null || text(e[k]), 'Invalid lifecycle cycle.');
  check(Array.isArray(e.references) && e.references.every(text), 'Invalid lifecycle references.');
  const states = { deployment: ['healthy', 'failed', 'not-applicable'],
    completion: ['valid', 'invalidated', 'unknown'], recovery: ['open-failure', 'closed-incident'] };
  check(states[e.kind].includes(e.state), 'Invalid lifecycle state.');
  if (e.state === 'not-applicable') check(text(e.reason) && e.reason === policy.deploymentNotApplicableReason,
    'Deployment not-applicable requires explicit trusted policy reason.');
  else check(e.reason === null && e.references.length > 0, 'Required lifecycle proof is absent.');
  if (e.kind === 'recovery') check(text(e.repairCycle) && text(e.incidentId), 'Recovery identity is required.');
  if (e.kind === 'completion' && policy.requireValidCompletion) check(e.state === 'valid', 'Completion is not valid.');
  return e;
}
function permittedSource(binding, relationships) {
  check(Array.isArray(relationships) && relationships.some(x => x.sourceRepositoryId === binding.source.repositoryId &&
    x.targetRepositoryId === binding.repository.id), 'Actions source/target relationship is unapproved.');
}
export async function invokeProtected(request, adapters = {}) {
  let r;
  try { r = structuredClone(request); validateProtectedRequest(r); }
  catch { return { schemaVersion: 3, status: 'rejected', error: 'Invalid protected request.' }; }
  const blocked = () => ({ schemaVersion: 3, status: 'blocked', error: 'Protected execution or evidence is unverified; Core reconciliation is required.' });
  if (typeof adapters.verify !== 'function' || typeof adapters.execute !== 'function') return blocked();
  let instructions, proof;
  try {
    proof = structuredClone(await adapters.verify(structuredClone(r)));
    fields(proof, ['permission', 'assignment', 'configuration', 'instructionContext', 'relationships',
      'prior', 'lifecycle', 'lifecyclePolicy', 'conflicts']);
    check(proof.permission === 'verified', 'Fresh Core permission is required.');
    validateBinding(proof.assignment); check(same(r.binding, proof.assignment), 'Trusted assignment mismatch.');
    const b = r.binding;
    check(digest(r.previous) === b.previousDigest, 'Prior inventory identity mismatch.');
    check(Array.isArray(proof.conflicts), 'Invalid trusted conflict inventory.');
    for (const relationship of proof.relationships) {
      fields(relationship, ['sourceRepositoryId', 'targetRepositoryId']);
      check(Object.values(relationship).every(text), 'Invalid source relationship.');
    }
    check(same(proof.instructionContext, { repository: b.repository, authority: b.authority, versions: b.versions, requirements: b.requirements }), 'Instruction context mismatch.');
    await verifyRequirements({ requirements: b.requirements, authority: b.authority, repository: b.repository, issue: b.issue }, adapters.requirements);
    instructions = resolveInstructions(b.role, proof.configuration, proof.instructionContext);
    check(instructions.contentDigest === b.instructionDigest && instructions.selectionDigest === b.instructionSelectionDigest, 'Instruction identity mismatch.');
    permittedSource(b, proof.relationships);
    check(Array.isArray(proof.prior) && same(r.previous, proof.prior.map(p => p.reference)), 'Required prior inventory mismatch.');
    const requiredRoles = { shape: [], 'shape-validator': ['shape'], 'shape-diagnosis': ['shape'],
      deliver: ['shape-validator'], accept: ['deliver'], 'shaper-review': ['shape', 'shape-validator', 'deliver', 'accept'] }[b.role];
    check(requiredRoles.every(role => proof.prior.some(p => p.reference.binding.role === role)), 'Required role evidence is absent.');
    for (const p of proof.prior) {
      fields(p, ['reference', 'result', 'authenticity', 'completion', 'conflicts']);
      check(p.authenticity === 'verified' && p.reference.digest === digest(p.result), 'Prior evidence is unauthenticated.');
      validateRoleResult(p.result, p.reference.binding, p.conflicts);
      const pb = p.result.binding;
      permittedSource(pb, proof.relationships);
      for (const k of ['repository', 'issue', 'authority', 'requirements', 'scopeDigest']) {
        check(same(pb[k], b[k]), 'Prior context mismatch.');
      }
      for (const k of ['deliveryCycle', 'repairCycle', 'incidentId']) {
        if (pb[k] !== null || ['deliver', 'accept', 'shaper-review'].includes(pb.role)) check(pb[k] === b[k], 'Prior work cycle mismatch.');
      }
      check(pb.requestId !== b.requestId && pb.resultId !== b.resultId, 'Prior result cannot be current result.');
      for (const k of ['shapeDigest', 'candidateDigest']) if (pb[k] !== null) check(pb[k] === b[k], 'Prior artifact mismatch.');
      check(p.result.failureClass === 'none' && p.result.outcome === successes[pb.role], 'Prior role has not succeeded.');
      if (p.completion === 'same-workflow-needs') {
        check(same(pb.source, b.source), 'Native needs cannot cross Runs or workflows.');
      } else check(p.completion === 'authenticated-result', 'Source identity alone is not successful completion.');
      if (['shape-validator', 'accept', 'shaper-review', 'shape-diagnosis'].includes(b.role)) {
        check(pb.sessionId !== b.sessionId, 'Independent execution is required.');
      }
    }
    // Integration supplies operation-specific requirements; there is no inferred lifecycle table.
    check(Array.isArray(proof.lifecycle), 'Lifecycle evidence inventory is required.');
    for (const l of proof.lifecycle) {
      fields(l, ['evidence', 'expected', 'authenticity']);
      check(l.authenticity === 'verified', 'Lifecycle evidence is unauthenticated.');
      validateLifecycle(l.evidence, l.expected, proof.lifecyclePolicy);
      const e = l.evidence;
      check(e.repositoryId === b.repository.id && e.issueId === b.issue.id &&
        e.deliveryCycle === b.deliveryCycle && e.repairCycle === b.repairCycle && e.incidentId === b.incidentId,
      'Lifecycle work identity mismatch.');
      permittedSource({ repository: b.repository, source: e.source }, proof.relationships);
    }
  } catch { return blocked(); }
  try {
    const result = structuredClone(await adapters.execute(structuredClone(r), structuredClone(instructions)));
    validateRoleResult(result, r.binding, proof.conflicts);
    return { schemaVersion: 3, status: 'succeeded', result };
  } catch { return blocked(); }
}
