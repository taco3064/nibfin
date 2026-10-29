import test from 'node:test';
import assert from 'node:assert/strict';
import { binding, digest } from '../src/core.mjs';
import { recoveryComment, readRecoveryLog, verifyRecoverySource, requireRepairAuthorization } from '../src/recovery.mjs';

function fixture() {
  const record = { issueId: 'I_B', repository: 'owner/app', previousCompletionHash: 'a'.repeat(64), previousGrantId: 'g1',
    environment: 'production', stream: 'stable', deploymentId: '10', version: 'v1', commit: 'b'.repeat(40), prNumber: 2,
    runId: '30', runAttempt: 2, jobId: '40', logUrl: 'https://github.com/owner/app/actions/runs/30/attempts/2/job/40',
    observation: 'The pinned functional check failed.', attribution: 'Exact deployed commit maps to the recorded merged PR and original Issue.', failureProofHash: 'c'.repeat(64) };
  const body = recoveryComment(record), comment = { id: 50, body, user: { id: 7 }, issue_url: 'https://api.github.com/repos/owner/app/issues/1' };
  const run = { id: 30, run_attempt: 2, repository: { full_name: 'owner/app' }, head_sha: record.commit, path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'failure' };
  const jobs = [{ id: 40, head_sha: record.commit, status: 'completed', conclusion: 'failure' }];
  const policy = { writerIds: ['7'], workflow: { path: run.path, blobSha: 'd'.repeat(40) } };
  const expected = { commentId: '50', commentHash: digest(body), previousCompletionHash: record.previousCompletionHash, previousGrantId: 'g1', failureProofHash: record.failureProofHash, commit: record.commit, environment: record.environment, stream: record.stream, deploymentId: record.deploymentId };
  let requests = [];
  const gh = { token: 'private-controller-token-for-test-only', api: async path => path.includes('/issues/comments/') ? comment : path.includes('/contents/') ? { sha: policy.workflow.blobSha } : run,
    list: async () => jobs,
    fetch: async (url, options) => { requests.push({ url, options }); return url.includes('api.github.com') ? new Response(null, { status: 302, headers: { location: 'https://results.actions.githubusercontent.com/log' } }) : new Response('Observed failure; private-controller-token-for-test-only', { status: 200 }); } };
  return { record, comment, run, jobs, policy, expected, gh, requests, issue: { id: 'I_B', repository: 'owner/app', number: 1 } };
}
test('Recovery comment is bounded public metadata; unknown transcript fields and auth material are rejected', () => {
  const f = fixture(); assert.match(f.comment.body, /does not authorize repair/);
  assert.throws(() => recoveryComment({ ...f.record, transcript: 'private Core instructions' }));
  assert.throws(() => recoveryComment({ ...f.record, observation: 'github_pat_' + 'x'.repeat(30) }));
  assert.throws(() => recoveryComment({ ...f.record, logUrl: 'https://attacker.invalid/log' }));
  const sensitive = 'known-private-value-to-redact';
  assert.ok(!recoveryComment({ ...f.record, observation: sensitive }, [sensitive]).includes(sensitive));
});
test('Recovery reads exact failed provider Run/Attempt/job and actual log; storage never receives controller token', async () => {
  const f = fixture(), result = await verifyRecoverySource(f.gh, f.issue, f.expected, f.policy);
  assert.equal(result.runAttempt, 2); assert.equal(result.jobId, '40'); assert.ok(result.log.sha256);
  assert.ok(!result.log.text.includes(f.gh.token)); assert.equal(f.requests[0].options.redirect, 'manual');
  assert.equal(f.requests[0].options.headers.Authorization, 'Bearer ' + f.gh.token);
  assert.equal(f.requests[1].options.headers, undefined); assert.equal(f.requests[1].options.redirect, 'error');
});
test('foreign comment, stale completion, wrong attempt, green job or missing logs cannot authorize recovery', async () => {
  const changes = [f => f.comment.user.id++, f => f.comment.body += 'tampered', f => f.expected.previousCompletionHash = 'e'.repeat(64),
    f => f.run.run_attempt = 1, f => f.run.head_sha = 'e'.repeat(40), f => f.jobs[0].conclusion = 'success',
    f => f.gh.fetch = async () => new Response(null, { status: 404 })];
  for (const mutate of changes) { const f = fixture(); mutate(f); await assert.rejects(verifyRecoverySource(f.gh, f.issue, f.expected, f.policy)); }
});
test('log redirects cannot leak authentication or turn into arbitrary network access', async () => {
  const f = fixture(); let requests = 0;
  f.gh.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/metadata' } }); };
  await assert.rejects(readRecoveryLog(f.gh, 'owner/app', 40), /Untrusted/); assert.equal(requests, 1);
});
test('reopening or a valid diagnostic comment never supplies a new Owner repair grant', () => {
  const f = fixture();
  assert.throws(() => requireRepairAuthorization({ policy: { operations: [] } }, f.issue, f.expected));
  const grant = { approval: { verified: true }, policy: { validFrom: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', operations: ['post-merge-repair'], recovery: { issueId: 'I_B', failureProofHash: f.expected.failureProofHash, previousCompletionHash: f.expected.previousCompletionHash, maxCycles: 1 } } };
  assert.equal(requireRepairAuthorization(grant, f.issue, f.expected, Date.parse('2026-10-22')).maxCycles, 1);
  assert.throws(() => requireRepairAuthorization(grant, f.issue, { ...f.expected, failureProofHash: 'f'.repeat(64) }, Date.parse('2026-10-22')));
});

test('failure-specific repair authority cannot reuse the old grant, change frozen work or predate the failure', () => {
  const issue = { id: 'I_B', repository: 'owner/app', dependencies: [], scopeHash: digest('fixed') };
  const parent = { recordId: 'old-record', actorGitHubUserId: '7', manifest: { id: 'frozen', proposalRevision: 1, freezeRevision: 1, issues: [issue] }, policy: { revision: 1, grantId: 'old', operations: ['deliver', 'accept', 'post-merge-repair'] } };
  const failure = { failureProofHash: 'a'.repeat(64), previousCompletionHash: null, environment: 'production', stream: 'stable', commit: 'b'.repeat(40), statusAt: '2026-10-22T09:00:00Z' };
  const repair = { recordId: 'new-record', actorGitHubUserId: '7', approval: { verified: true }, manifest: structuredClone(parent.manifest),
    policy: { grantId: 'new', validFrom: '2026-10-22T09:05:00Z', expiresAt: '2026-10-22T12:00:00Z', operations: [...parent.policy.operations],
      recovery: { issueId: issue.id, failureProofHash: failure.failureProofHash, previousCompletionHash: null, environment: failure.environment, stream: failure.stream,
        mergedCommit: failure.commit, maxCycles: 1, parentAuthority: { recordId: parent.recordId, ...binding(parent.manifest, parent.policy) } } } };
  const now = Date.parse('2026-10-22T10:00:00Z');
  assert.equal(requireRepairAuthorization(repair, issue, failure, now, parent).maxCycles, 1);
  for (const mutate of [r => r.recordId = parent.recordId, r => r.policy.grantId = parent.policy.grantId,
    r => r.policy.validFrom = '2026-10-22T08:00:00Z', r => r.actorGitHubUserId = '8',
    r => r.policy.recovery.parentAuthority = null, r => r.policy.recovery.stream = 'another',
    r => r.manifest.issues[0].scopeHash = digest('changed'), r => r.policy.operations = ['post-merge-repair']]) {
    const copy = structuredClone(repair); mutate(copy);
    assert.throws(() => requireRepairAuthorization(copy, issue, failure, now, parent), { code: 'REPAIR_AUTHORITY_MISSING' });
  }
});
