import { authorizeRequest } from './authority.mjs';
export { prepareGrant, signGrant, verifyGrant, authorizeOperation, validateGrant, serializeGrant, grantDraftDigest } from './authority.mjs';
import { validateRequirements, verifyRequirements } from './requirements.mjs';
export { validateSource, validateReference, validateSnapshot, captureSnapshot } from './requirements.mjs';
import { createHash } from 'node:crypto';

// Interface version 4 is deliberately smaller than a delivery runtime.
export const predecessors = Object.freeze({
  shape: null,
  'shape-validator': 'shape',
  deliver: 'shape-validator',
  accept: 'deliver'
});
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.length > 0;
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const exact = (x, keys) => object(x) && Object.keys(x).every(k => keys.includes(k));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireThat(ok, message) {
  if (!ok) throw new Error(message);
}
function source(x) {
  requireThat(exact(x, ['repositoryId', 'workflow', 'workflowDigest', 'runId', 'attempt']) &&
    text(x.repositoryId) && text(x.workflow) && hash(x.workflowDigest) && text(x.runId) &&
    Number.isSafeInteger(x.attempt) && x.attempt > 0, 'Invalid Actions source correlation.');
}
export function validateRequest(r) {
  requireThat(exact(r, ['schemaVersion', 'requestId', 'stage', 'repository', 'issue',
    'authority', 'scopeDigest', 'shapeDigest', 'candidateDigest', 'source', 'previous', 'components', 'requirements']),
  'Request must be an object with supported fields only.');
  requireThat(r.schemaVersion === 4, 'Unsupported request schema version.');
  requireThat(text(r.requestId) && text(r.stage) && Object.hasOwn(predecessors, r.stage), 'Invalid request identity or unsupported stage.');
  requireThat(exact(r.repository, ['id', 'name']) && text(r.repository.id) && text(r.repository.name) &&
    /^[^/\s]+\/[^/\s]+$/.test(r.repository.name), 'Invalid repository identity.');
  requireThat(exact(r.issue, ['id', 'number', 'repositoryId']) && text(r.issue.id) &&
    Number.isSafeInteger(r.issue.number) && r.issue.number > 0 &&
    r.issue.repositoryId === r.repository.id, 'Invalid Issue or repository correlation.');
  requireThat(exact(r.authority, ['grantId', 'digest']) && text(r.authority.grantId) &&
    hash(r.authority.digest) && hash(r.scopeDigest), 'Authority and Scope references are required.');
  validateRequirements(r.requirements);
  if (r.source !== undefined) {
    source(r.source);
    requireThat(r.source.repositoryId === r.repository.id, 'Actions source repository mismatch.');
  }
  if (['deliver', 'accept'].includes(r.stage)) requireThat(hash(r.shapeDigest), 'Shape reference is required.');
  if (r.stage === 'accept') requireThat(hash(r.candidateDigest), 'Candidate reference is required.');
  for (const key of ['shapeDigest', 'candidateDigest']) {
    if (r[key] !== undefined) requireThat(hash(r[key]), `Invalid ${key}.`);
  }
  if (r.components !== undefined) {
    requireThat(exact(r.components, ['action', 'workflow', 'cli', 'agent', 'platform']) &&
      Object.values(r.components).every(text), 'Invalid caller component metadata.');
  }
  const prior = predecessors[r.stage];
  if (!prior) requireThat(r.previous === undefined, 'Initial stage has no predecessor.');
  else {
    const p = r.previous;
    requireThat(exact(p, ['resultId', 'digest', 'stage', 'requestId', 'repositoryId', 'issueId', 'source']) &&
      text(p.resultId) && hash(p.digest) && p.stage === prior && text(p.requestId) &&
      p.requestId !== r.requestId && p.repositoryId === r.repository.id && p.issueId === r.issue.id,
    'Invalid required predecessor reference or correlation.');
    if (p.source !== undefined) {
      source(p.source);
      requireThat(p.source.repositoryId === r.repository.id, 'Predecessor source repository mismatch.');
    }
  }
  return r;
}

function matchEvidence(r, e) {
  const p = r.previous;
  requireThat(object(e) && e.schemaVersion === 4 && e.resultId === p.resultId &&
    digest(e) === p.digest && e.stage === p.stage && e.requestId === p.requestId &&
    same(e.repository, r.repository) && same(e.issue, r.issue) &&
    same(e.requirements, r.requirements) && same(e.source, p.source) && same(e.authority, r.authority) &&
    e.scopeDigest === r.scopeDigest && e.status === 'succeeded',
  'Predecessor content, correlation or completion mismatch.');
  if (r.stage === 'accept') {
    requireThat(e.shapeDigest === r.shapeDigest && e.candidateDigest === r.candidateDigest,
      'Predecessor candidate or Shape mismatch.');
  }
  if (r.stage === 'deliver') requireThat(e.shapeDigest === r.shapeDigest, 'Predecessor Shape mismatch.');
}

// Adapters are trusted code injected by the owning Core, never selected by request data.
// Verification must establish fresh permission AND authentic successful evidence.
export async function invoke(request, adapters = {}) {
  let r;
  try {
    r = structuredClone(request);
    validateRequest(r);
  } catch (error) {
    return { schemaVersion: 4, status: 'rejected', error: error.message };
  }
  const result = (status, error) => ({
    schemaVersion: 4, resultId: `${r.requestId}:result`, requestId: r.requestId,
    stage: r.stage, repository: r.repository, issue: r.issue, authority: r.authority,
    requirements: structuredClone(r.requirements), scopeDigest: r.scopeDigest, ...(r.shapeDigest && { shapeDigest: r.shapeDigest }),
    ...(r.candidateDigest && { candidateDigest: r.candidateDigest }),
    ...(r.source && { source: r.source }), components: r.components ?? null,
    status, ...(error && { error })
  });
  if (typeof adapters.verify !== 'function' || typeof adapters.execute !== 'function') {
    return result('blocked', 'Trusted verification and execution are unavailable.');
  }
  try {
    await authorizeRequest(r, adapters.authorization);
    // A separate clone prevents verifier mutation from changing execution inputs.
    const proof = await adapters.verify(structuredClone(r));
    requireThat(proof?.permission === 'verified', 'Fresh execution permission is unverified.');
    await verifyRequirements(structuredClone(r), adapters.requirements);
    if (r.previous) {
      requireThat(proof.previousAuthenticity === 'verified', 'Predecessor authenticity is unverified.');
      matchEvidence(r, proof.previousResult);
    }
  } catch {
    return result('blocked', 'Trusted verification failed or required evidence is invalid.');
  }
  try {
    const executed = await adapters.execute(structuredClone(r));
    requireThat(executed?.status === 'succeeded', 'Executor did not confirm completion.');
    return result('succeeded');
  } catch {
    // Unknown side effects require reconciliation by Core; this boundary never retries.
    return result('blocked', 'Execution failed or completion is unknown; Core reconciliation is required.');
  }
}

// Protected schema 5 is explicit; no legacy request is implicitly promoted.
export { roles, failureClasses, skillForRole, instructionApproval, resolveInstructions,
  validateBinding, validateProtectedRequest, validateRoleResult, validateLifecycle,
  invokeProtected } from './protected.mjs';

export { validateEnvironments, validateLogin, validateCleanup, createAgentAdapter } from './agent.mjs';

export { prepareWorkspace, captureCandidate, reconstructCandidate, verifyCandidate,
  candidateEvidence, compareCandidateEvidence } from './workspace.mjs';

export { scopeInstructions, publicationPlanDigest, verifyScopePlan, verifyScopeHandoff,
  auditScope } from './scope.mjs';

export { parseCandidateInventory, validateCandidateObligations } from './obligations.mjs';
