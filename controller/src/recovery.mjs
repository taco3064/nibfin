import { binding, canonical, digest } from './core.mjs';
import { repoPath } from './github.mjs';
import { redactCredentials } from './credential-output.mjs';
import { createHash } from 'node:crypto';

const fail = (code, reason) => { throw Object.assign(new Error(reason), { code }); };
const id = value => /^[1-9]\d*$/.test(String(value));
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const fields = ['issueId', 'repository', 'previousCompletionHash', 'previousGrantId', 'environment', 'stream',
  'deploymentId', 'version', 'commit', 'prNumber', 'runId', 'runAttempt', 'jobId', 'logUrl', 'observation', 'attribution', 'failureProofHash'];

export async function readRecoveryLog(github, repository, jobId, secrets = []) {
  if (!id(jobId)) fail('RECOVERY_LOG_INVALID', 'Invalid job log identity');
  if (github.download) {
    const bytes = await github.download(`${repoPath(repository)}/actions/jobs/${jobId}/logs`, 2 * 1024 * 1024);
    if (!bytes.length) fail('RECOVERY_LOG_UNAVAILABLE', 'Empty job log cannot establish diagnosis');
    return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, text: redactCredentials(bytes.toString('utf8'), secrets.filter(Boolean)) };
  }
  const response = await github.fetch(`https://api.github.com${repoPath(repository)}/actions/jobs/${jobId}/logs`, {
    redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${github.token}`, 'X-GitHub-Api-Version': '2026-03-10' },
  });
  if (response.status !== 302) fail('RECOVERY_LOG_UNAVAILABLE', 'Provider did not supply the actual job log');
  const url = new URL(response.headers.get('location'));
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com')))
    fail('RECOVERY_LOG_INVALID', 'Untrusted log storage destination');
  const log = await github.fetch(url.href, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!log.ok || Number(log.headers.get('content-length')) > 2 * 1024 * 1024) fail('RECOVERY_LOG_UNAVAILABLE', 'Recovery log is missing or exceeds the size limit');
  const chunks = []; let size = 0;
  for await (const chunk of log.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) fail('RECOVERY_LOG_UNAVAILABLE', 'Recovery log exceeds the size limit');
    chunks.push(chunk);
  }
  if (!size) fail('RECOVERY_LOG_UNAVAILABLE', 'Empty job log cannot establish diagnosis');
  const bytes = Buffer.concat(chunks);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size, text: redactCredentials(bytes.toString('utf8'), [github.token, ...secrets].filter(Boolean)) };
}

export async function readDeploymentFailureLog(github, proof, policy) {
  if (proof?.status !== 'failed' || !id(proof.runId) || !id(proof.runAttempt) || !sha(proof.commit)) fail('RECOVERY_ATTRIBUTION_INVALID', 'Only provider-attributed deployment failure can enter diagnosis');
  const root = repoPath(proof.repository);
  const run = await github.api(`${root}/actions/runs/${proof.runId}/attempts/${proof.runAttempt}`);
  const jobs = await github.list(`${root}/actions/runs/${proof.runId}/attempts/${proof.runAttempt}/jobs`, 'jobs');
  if (String(run.id) !== proof.runId || run.run_attempt !== proof.runAttempt || run.head_sha !== proof.commit || run.path !== policy.workflow.path ||
      run.status !== 'completed' || !['failure', 'timed_out'].includes(run.conclusion)) fail('RECOVERY_LOG_INVALID', 'Deployment failure lacks its exact completed failed Actions run');
  const failures = jobs.filter(j => j.head_sha === proof.commit && j.status === 'completed' && ['failure', 'timed_out'].includes(j.conclusion) && policy.requiredChecks.includes(j.name));
  if (!failures.length) fail('RECOVERY_LOG_INVALID', 'No failed required health/function job establishes attribution');
  const job = failures.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  return { jobId: String(job.id), logUrl: `https://github.com/${proof.repository}/actions/runs/${proof.runId}/attempts/${proof.runAttempt}/job/${job.id}`, log: await readRecoveryLog(github, proof.repository, job.id) };
}

export function recoveryComment(record, secrets = []) {
  if (!record || Object.keys(record).some(k => !fields.includes(k)) || !fields.every(k => Object.hasOwn(record, k)) ||
      !/^[\w.-]+\/[\w.-]+$/.test(record.repository || '') || !hash(record.previousCompletionHash) || !hash(record.failureProofHash) ||
      !sha(record.commit) || !['deploymentId', 'prNumber', 'runId', 'runAttempt', 'jobId'].every(k => id(record[k])) ||
      !['issueId', 'previousGrantId', 'environment', 'stream', 'version', 'observation', 'attribution'].every(k => typeof record[k] === 'string' && record[k].trim() && record[k].length <= 2000))
    fail('RECOVERY_RECORD_INVALID', 'Recovery requires complete structured, attributable evidence');
  const logUrl = `https://github.com/${record.repository}/actions/runs/${record.runId}/attempts/${record.runAttempt}/job/${record.jobId}`;
  if (record.logUrl !== logUrl) fail('RECOVERY_LOG_INVALID', 'Recovery log URL must identify the exact repository/run/attempt/job');
  let json = JSON.stringify(record, null, 2);
  json = redactCredentials(json, secrets);
  // A public diagnostic is allowlisted structured metadata, never arbitrary
  // Agent transcripts or authenticated job output. Reject likely auth material.
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[\w]+|gh[pousr]_[\w]{20,}|(?:authorization|bearer)\s*[: ]\s*\S{10,}/i.test(json)) fail('RECOVERY_PUBLIC_UNSAFE', 'Recovery record contains possible authentication material');
  return '# Kairo deployment recovery\n\nDiagnostic evidence only; this comment does not authorize repair.\n\n```kairo-recovery\n' + json + '\n```\n';
}

export async function verifyRecoverySource(github, issue, expected, policy) {
  const root = repoPath(issue.repository);
  if (!id(expected.commentId) || !hash(expected.commentHash) || !Array.isArray(policy.writerIds) || !policy.writerIds.length) fail('RECOVERY_AUTHORITY_MISSING', 'Recovery must identify a saved comment and enrolled writer');
  const comment = await github.api(`${root}/issues/comments/${expected.commentId}`);
  if (!policy.writerIds.map(String).includes(String(comment.user?.id)) || digest(comment.body) !== expected.commentHash ||
      comment.issue_url !== `https://api.github.com${root}/issues/${issue.number}`) fail('RECOVERY_COMMENT_INVALID', 'Recovery comment actor, Issue or body changed');
  const match = comment.body.match(/```kairo-recovery\n([\s\S]*?)\n```/);
  if (!match) fail('RECOVERY_COMMENT_INVALID', 'Missing structured recovery evidence');
  const record = JSON.parse(match[1]);
  recoveryComment(record); // Same strict allowlist, lengths and URL binding.
  if (record.issueId !== issue.id || record.repository !== issue.repository ||
      record.previousCompletionHash !== expected.previousCompletionHash || record.previousGrantId !== expected.previousGrantId ||
      record.failureProofHash !== expected.failureProofHash || record.commit !== expected.commit ||
      record.environment !== expected.environment || record.stream !== expected.stream || record.deploymentId !== expected.deploymentId)
    fail('RECOVERY_ATTRIBUTION_INVALID', 'Recovery source does not identify the verified responsible delivery');
  const [run, jobs] = await Promise.all([
    github.api(`${root}/actions/runs/${record.runId}/attempts/${record.runAttempt}`),
    github.list(`${root}/actions/runs/${record.runId}/attempts/${record.runAttempt}/jobs`, 'jobs'),
  ]);
  const job = jobs.filter(j => String(j.id) === String(record.jobId));
  if (String(run.id) !== String(record.runId) || run.run_attempt !== Number(record.runAttempt) ||
      run.repository?.full_name !== issue.repository || run.head_sha !== record.commit || run.path !== policy.workflow.path ||
      run.status !== 'completed' || !['failure', 'timed_out'].includes(run.conclusion) || job.length !== 1 ||
      job[0].head_sha !== record.commit || job[0].status !== 'completed' || !['failure', 'timed_out'].includes(job[0].conclusion))
    fail('RECOVERY_LOG_INVALID', 'Provider does not confirm the exact failed deployment run/attempt/job');
  const file = await github.api(`${root}/contents/${policy.workflow.path}?ref=${record.commit}`);
  if (file.sha !== policy.workflow.blobSha) fail('RECOVERY_LOG_INVALID', 'Failure workflow is not the enrolled deployment workflow');
  const log = await readRecoveryLog(github, issue.repository, job[0].id);
  return { record, commentId: String(comment.id), commentHash: expected.commentHash,
    runId: String(run.id), runAttempt: run.run_attempt, jobId: String(job[0].id), sourceHash: digest(record), log };
}

export function requireRepairAuthorization(grant, issue, failure, now = Date.now(), parent = null) {
  const permission = grant.policy.recovery;
  if (!grant.approval?.verified || !permission || permission.issueId !== issue.id ||
      permission.failureProofHash !== failure.failureProofHash || permission.previousCompletionHash !== failure.previousCompletionHash ||
      !grant.policy.operations.includes('post-merge-repair') || !Number.isSafeInteger(permission.maxCycles) || permission.maxCycles < 1 ||
      !(Date.parse(grant.policy.validFrom) <= now && now < Date.parse(grant.policy.expiresAt)))
    fail('REPAIR_AUTHORITY_MISSING', 'Reopen, comment and failed deployment never supply repair authority');
  if (parent) {
    const authority = parent.policy.dynamicParent || { recordId: parent.recordId, ...binding(parent.manifest, parent.policy) };
    const frozen = grant.manifest.issues.find(i => i.id === issue.id && i.repository === issue.repository);
    if (grant.recordId === parent.recordId || grant.policy.grantId === parent.policy.grantId ||
        grant.actorGitHubUserId !== parent.actorGitHubUserId || !permission.parentAuthority || canonical(permission.parentAuthority) !== canonical(authority) ||
        digest(grant.manifest) !== authority.manifestHash || !frozen || canonical({ ...frozen, dependencies: issue.dependencies }) !== canonical(issue) || permission.environment !== failure.environment || permission.stream !== failure.stream ||
        permission.mergedCommit !== failure.commit || !Number.isFinite(Date.parse(failure.statusAt)) || Date.parse(grant.policy.validFrom) < Date.parse(failure.statusAt) ||
        !parent.policy.operations.every(op => grant.policy.operations.includes(op)))
      fail('REPAIR_AUTHORITY_MISSING', 'Repair needs a fresh independently signed Owner Grant for this exact failure, frozen Issue and parent authority');
  }
  return permission;
}
