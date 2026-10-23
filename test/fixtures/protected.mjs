import { bindings, requirementAdapters } from './request.mjs';
import { digest, roles, resolveInstructions } from '../../src/index.mjs';
export const h = 'a'.repeat(64);
export function fixture(role = 'shape', priorRoles = null) {
  priorRoles ??= { shape: [], 'shape-validator': ['shape'], 'shape-diagnosis': ['shape'], deliver: ['shape-validator'], accept: ['deliver'], 'shaper-review': ['shape', 'shape-validator', 'deliver', 'accept'] }[role];
  const configuration = { repository: {}, shared: {}, approved: [] };
  const binding = { requestId: 'current-request', resultId: 'current-result', sessionId: 'current-session',
    role, skill: roles[role], repository: { id: 'repo', name: 'example/project' },
    issue: { id: 'issue', number: 6, repositoryId: 'repo' }, authority: { grantId: 'grant', digest: h },
    requirements: bindings(), scopeDigest: h, shapeDigest: h, candidateDigest: h, deliveryCycle: 'delivery-1', repairCycle: 'repair-1',
    incidentId: 'incident-1', source: { repositoryId: 'source-repo', workflow: '.github/workflows/stage.yml',
      workflowDigest: h, runId: 'new-run', attempt: 1 },
    versions: { core: h, runtime: h, adapter: h, skill: h }, instructionDigest: h, instructionSelectionDigest: h, previousDigest: digest([]) };
  const instructionContext = { repository: binding.repository, authority: binding.authority, versions: binding.versions, requirements: binding.requirements };
  const selected = resolveInstructions(role, configuration, instructionContext);
  binding.instructionDigest = selected.contentDigest; binding.instructionSelectionDigest = selected.selectionDigest;
  const prior = priorRoles.map((pr, i) => {
    const pb = structuredClone(binding);
    Object.assign(pb, { role: pr, skill: roles[pr], requestId: `prior-request-${i}`,
      resultId: `prior-result-${i}`, sessionId: `prior-session-${i}` });
    pb.source.runId = `prior-run-${i}`;
    const selection = resolveInstructions(pr, configuration, instructionContext);
    pb.instructionDigest = selection.contentDigest; pb.instructionSelectionDigest = selection.selectionDigest;
    const result = roleResult(pb);
    return { reference: { binding: pb, digest: digest(result) }, result, authenticity: 'verified',
      completion: 'authenticated-result', conflicts: [] };
  });
  binding.previousDigest = digest(prior.map(p => p.reference));
  const request = { schemaVersion: 3, binding, previous: prior.map(p => structuredClone(p.reference)) };
  const proof = { permission: 'verified', assignment: structuredClone(binding), configuration, instructionContext,
    relationships: [{ sourceRepositoryId: 'source-repo', targetRepositoryId: 'repo' }], prior,
    lifecycle: [], lifecyclePolicy: {}, conflicts: [] };
  let calls = 0;
  const adapters = { requirements: requirementAdapters(), verify: async () => proof, execute: async r => { calls++; return roleResult(r.binding); } };
  return { request, proof, adapters, calls: () => calls };
}
export function roleResult(binding, changes = {}) {
  const outcomes = { shape: 'proposal', 'shape-validator': 'approved', deliver: 'candidate', accept: 'accepted',
    'shape-diagnosis': 'not-confirmed', 'shaper-review': 'approved' };
  return { schemaVersion: 3, binding: structuredClone(binding), outcome: outcomes[binding.role],
    failureClass: 'none', references: ['immutable:artifact'], conflicts: [], ...changes };
}
export function lifecycle(kind = 'deployment', state = 'healthy') {
  return { kind, repositoryId: 'repo', issueId: 'issue', deliveryCycle: 'delivery-1', repairCycle: 'repair-1',
    incidentId: 'incident-1', mergeSha: 'a'.repeat(40), version: 'release-1', environment: 'production',
    source: { repositoryId: 'source-repo', workflow: '.github/workflows/deploy.yml', workflowDigest: h,
      runId: 'deployment-run', attempt: 1 }, state, references: ['immutable:deployment-proof'], reason: null };
}
