import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeploymentProof, requireHealthyBaseline, validateDeploymentPolicy } from '../src/deployment.mjs';

const now = Date.parse('2026-10-22T00:01:00Z');
function fixture() {
  const policy = { mode: 'required', environment: 'production', stream: 'stable', maxAgeMs: 120000, statusActorIds: ['7'], trustedCheckAppIds: [15368], requiredChecks: ['health', 'functional'], workflow: { path: '.github/workflows/deploy.yml', blobSha: 'a'.repeat(40), checks: ['health', 'functional'] } };
  const expected = { deploymentId: '100', commit: 'b'.repeat(40), version: 'v1', issueId: 'I_B', grantId: 'g1' };
  const deployment = { id: 100, sha: expected.commit, environment: 'production', payload: { stream: 'stable', version: 'v1', issueId: 'I_B', grantId: 'g1' } };
  const statuses = [{ id: 200, creator: { id: 7 }, created_at: '2026-10-22T00:00:30Z', state: 'success', log_url: 'https://github.com/owner/app/actions/runs/300/attempts/2' }];
  const run = { id: 300, run_attempt: 2, head_sha: expected.commit, repository: { full_name: 'owner/app' }, path: policy.workflow.path, status: 'completed', conclusion: 'success' };
  const checks = policy.requiredChecks.map(name => ({ name, head: expected.commit, runId: '300', runAttempt: 2, conclusion: 'success', provenanceVerified: true, workflowBlobSha: policy.workflow.blobSha }));
  const gh = { api: async path => path.includes('/contents/') ? { sha: policy.workflow.blobSha } : path.includes('/actions/') ? run : deployment, list: async () => statuses, checks: async () => checks };
  return { policy, expected, deployment, statuses, run, checks, gh };
}
test('deployment proof binds actual merge, environment, release version and health/function run attempt', async () => {
  const f = fixture(), proof = await readDeploymentProof(f.gh, 'owner/app', f.policy, f.expected, now);
  assert.equal(proof.status, 'healthy'); assert.equal(proof.runAttempt, 2); assert.equal(proof.checks.length, 2);
  requireHealthyBaseline(f.policy, proof, { repository: 'owner/app', commit: f.expected.commit, version: 'v1' }, now);
  assert.throws(() => requireHealthyBaseline(f.policy, proof, { repository: 'owner/other', commit: f.expected.commit, version: 'v1' }, now), /baseline/);
});
test('no-deploy is explicit signed-policy intent; missing policy cannot silently waive deployment', async () => {
  assert.throws(() => validateDeploymentPolicy(undefined));
  assert.throws(() => validateDeploymentPolicy({ mode: 'not-applicable' }));
  const p = await readDeploymentProof({}, 'owner/app', { mode: 'not-applicable', reason: 'Library fixture: no publish or deployed service is authorized' }, {}, now);
  assert.equal(p.mode, 'not-applicable');
});
test('latest failed deployment cannot be replaced by older green status and remains attributable', async () => {
  const f = fixture(); f.statuses.unshift({ ...f.statuses[0], id: 201, state: 'failure' });
  const proof = await readDeploymentProof(f.gh, 'owner/app', f.policy, f.expected, now);
  assert.equal(proof.status, 'failed'); assert.equal(proof.issueId, 'I_B');
  assert.throws(() => requireHealthyBaseline(f.policy, proof, { repository: 'owner/app', commit: f.expected.commit, version: 'v1' }, now), { code: 'DEPLOYMENT_BASELINE_UNHEALTHY' });
});
test('wrong deployment, stale run, unknown writer, missing checks or fabricated provenance block delivery', async () => {
  const changes = [f => f.deployment.sha = 'c'.repeat(40), f => f.deployment.environment = 'staging',
    f => f.deployment.payload.version = 'v2', f => f.deployment.payload.stream = 'other',
    f => f.deployment.payload.issueId = 'I_random', f => f.deployment.payload.grantId = 'revoked',
    f => f.statuses[0].creator.id++, f => f.statuses[0].created_at = '2026-01-01T00:00:00Z',
    f => f.statuses[0].created_at = '2099-01-01T00:00:00Z', f => f.statuses[0].log_url = 'https://attacker.invalid/log',
    f => f.run.run_attempt++, f => f.run.head_sha = 'c'.repeat(40), f => f.checks.pop(),
    f => f.checks[0].provenanceVerified = false, f => f.checks[0].runAttempt = 1,
    f => f.checks[0].conclusion = 'failure', f => f.checks.push({ ...f.checks[0] })];
  for (const mutate of changes) { const f = fixture(); mutate(f); await assert.rejects(readDeploymentProof(f.gh, 'owner/app', f.policy, f.expected, now)); }
});
