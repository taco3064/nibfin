import { digest } from './core.mjs';
import { repoPath } from './github.mjs';

const stop = (code, reason) => { throw Object.assign(new Error(reason), { code }); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
// This field is introduced only in a verified, Issue-specific projection. Keep
// the repository deployment policy intact: source-only is not a health waiver.
export function issueDeploymentDisposition(policy, issue) {
  const d=policy?.issueDeployment;if(!d)return null;
  const expected=issue.number===46?'source-only':issue.number===52?'required':null;
  const id=issue.number===46?'I_kwDOVRsWxs8AAAABZBxG0A':'I_kwDOVRsWxs8AAAABZBxTsw';
  if(issue.repository!=='taco3064/nibfin'||issue.repositoryId!=='1427838662'||issue.id!==id||d.issueId!==issue.id||d.mode!==expected||!expected||
    d.baseline!=='preserve-repository'||!/^[a-f0-9]{64}$/.test(d.revisionHash||''))stop('ISSUE_DEPLOYMENT_DISPOSITION_INVALID','Source/deployment responsibility must match the exact protected website Issue');
  return d.mode;
}
export function deploymentProofHash(proof) {
  const { observedAt, ...identity } = proof;
  return digest(identity);
}
export function validateDeploymentPolicy(policy) {
  if (policy?.mode === 'not-applicable' && text(policy.reason)) return policy;
  if (policy?.mode !== 'required' || !text(policy.environment) || !text(policy.stream) ||
      !Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs < 1000 ||
      !Array.isArray(policy.statusActorIds) || !policy.statusActorIds.length ||
      !policy.statusActorIds.every(id => /^[1-9]\d*$/.test(String(id))) ||
      !Array.isArray(policy.trustedCheckAppIds) || !policy.trustedCheckAppIds.length ||
      !Array.isArray(policy.requiredChecks) || !policy.requiredChecks.length || !policy.requiredChecks.every(text) ||
      !policy.workflow || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(policy.workflow.path || '') ||
      !sha(policy.workflow.blobSha) || !Array.isArray(policy.workflow.checks) ||
      !policy.requiredChecks.every(name => policy.workflow.checks.includes(name))) stop('DEPLOYMENT_POLICY_MISSING', 'Explicit deploy/no-deploy policy with environment, stream, health/function checks and provenance is required');
  if (policy.bootstrap && (policy.bootstrap.mode !== 'first-deployment-only' ||
      !text(policy.bootstrap.authorizationId) || !/^[1-9]\d*$/.test(policy.bootstrap.repositoryId || '') ||
      !/^[\w-]+$/.test(policy.bootstrap.issueId || '')))
    stop('DEPLOYMENT_POLICY_MISSING', 'First deployment requires explicit signed repository and Issue enrollment');
  return policy;
}

// Read exact provider objects. A success boolean or supplied workflow URL is not
// sufficient. The check adapter proves run/attempt/App, workflow pin and job.
export async function readDeploymentProof(github, repository, policy, expected, now = Date.now()) {
  validateDeploymentPolicy(policy);
  if (policy.mode === 'not-applicable') return { mode: policy.mode, reason: policy.reason, policyHash: digest(policy) };
  if (!sha(expected?.commit) || !text(expected.version) || !text(expected.issueId) || !text(expected.grantId) ||
      !/^[1-9]\d*$/.test(String(expected.deploymentId))) stop('DEPLOYMENT_IDENTITY_MISSING', 'Exact deployment, version, commit, Issue and grant identities are required');
  const root = repoPath(repository);
  const deployment = await github.api(`${root}/deployments/${expected.deploymentId}`);
  if (String(deployment.id) !== String(expected.deploymentId) || deployment.sha !== expected.commit ||
      deployment.environment !== policy.environment || deployment.payload?.stream !== policy.stream ||
      deployment.payload?.version !== expected.version || deployment.payload?.issueId !== expected.issueId ||
      deployment.payload?.grantId !== expected.grantId) stop('DEPLOYMENT_IDENTITY_MISMATCH', 'Deployment is not bound to this merge/environment/version/Issue/authority');
  const statuses = await github.list(`${root}/deployments/${deployment.id}/statuses`);
  // Do not select an older green status from a failed/unknown latest deployment.
  const status = statuses[0];
  if (!status || !policy.statusActorIds.map(String).includes(String(status.creator?.id))) stop('DEPLOYMENT_PROVENANCE_INVALID', 'Latest deployment status lacks the enrolled writer');
  const when = Date.parse(status.created_at);
  if (!Number.isFinite(when) || when > now || now - when > policy.maxAgeMs) stop('DEPLOYMENT_STALE', 'Latest deployment observation is stale or invalid');
  const prefix = `https://github.com/${repository}/actions/runs/`;
  if (!status.log_url?.startsWith(prefix)) stop('DEPLOYMENT_PROVENANCE_INVALID', 'Deployment status must identify its actual Actions run');
  const match = status.log_url.slice(prefix.length).match(/^([1-9]\d*)(?:\/attempts\/([1-9]\d*))?(?:\/job\/([1-9]\d*))?$/);
  if (!match) stop('DEPLOYMENT_PROVENANCE_INVALID', 'Unrecognized deployment log identity');
  const run = await github.api(`${root}/actions/runs/${match[1]}`);
  if (String(run.id) !== match[1] || run.head_sha !== expected.commit || run.repository?.full_name !== repository || run.path !== policy.workflow.path ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || match[2] && Number(match[2]) !== run.run_attempt)
    stop('DEPLOYMENT_PROVENANCE_INVALID', 'Deployment log does not match the exact commit/workflow/attempt');
  const file = await github.api(`${root}/contents/${policy.workflow.path}?ref=${expected.commit}`);
  if (file.sha !== policy.workflow.blobSha) stop('DEPLOYMENT_PROVENANCE_INVALID', 'Deployment workflow pin differs');
  const base = { mode: 'required', repository, deploymentId: String(deployment.id), statusId: String(status.id),
    commit: expected.commit, environment: policy.environment, stream: policy.stream, version: expected.version,
    issueId: expected.issueId, grantId: expected.grantId, runId: String(run.id), runAttempt: run.run_attempt,
    logUrl: status.log_url, observedAt: new Date(now).toISOString(), statusAt: status.created_at, policyHash: digest(policy) };
  if (['failure', 'error'].includes(status.state)) return { ...base, status: 'failed' };
  if (status.state !== 'success' || run.status !== 'completed' || run.conclusion !== 'success') stop('DEPLOYMENT_PENDING', 'Deployment is not successfully complete');
  const checks = await github.checks(repository, expected.commit, policy.trustedCheckAppIds, [policy.workflow]);
  for (const name of policy.requiredChecks) {
    const matching = checks.filter(c => c.name === name && c.runId === String(run.id) && c.runAttempt === run.run_attempt);
    if (matching.length !== 1 || matching[0].head !== expected.commit || matching[0].conclusion !== 'success' ||
        matching[0].provenanceVerified !== true || matching[0].workflowBlobSha !== policy.workflow.blobSha)
      stop('DEPLOYMENT_CHECK_MISSING', `Missing actual exact-version deployment health/function check: ${name}`);
  }
  return { ...base, status: 'healthy', checks: checks.filter(c => policy.requiredChecks.includes(c.name)) };
}

export function requireHealthyBaseline(policy, proof, expected, now = Date.now()) {
  validateDeploymentPolicy(policy);
  if (policy.mode === 'not-applicable') return;
  if (proof?.status === 'bootstrap-empty') {
    const first = policy.bootstrap, observed = Date.parse(proof.observedAt);
    if (!first || first.mode !== 'first-deployment-only' || expected?.deploymentId ||
        proof.authorizationId !== first.authorizationId || proof.issueId !== first.issueId ||
        expected?.issueId !== first.issueId || proof.repositoryId !== first.repositoryId ||
        expected?.repositoryId !== first.repositoryId || proof.repository !== expected.repository ||
        proof.environment !== policy.environment || proof.stream !== policy.stream ||
        proof.policyHash !== digest(policy) || proof.completeList !== true || proof.deploymentCount !== 0 ||
        !Number.isFinite(observed) || observed > now || now - observed > policy.maxAgeMs)
      stop('DEPLOYMENT_BASELINE_UNHEALTHY', 'First-deployment enrollment or complete empty-environment readback differs');
    return; // Pre-Deliver only. Exact post-merge deployment proof is still required.
  }
  if (!proof || proof.status !== 'healthy' || proof.repository !== expected.repository ||
      proof.environment !== policy.environment || proof.stream !== policy.stream ||
      proof.commit !== expected.commit || proof.version !== expected.version || proof.policyHash !== digest(policy) ||
      !Number.isFinite(Date.parse(proof.statusAt)) || Date.parse(proof.statusAt) > now || now - Date.parse(proof.statusAt) > policy.maxAgeMs)
    stop('DEPLOYMENT_BASELINE_UNHEALTHY', 'Affected repository/environment/release baseline is failed, stale or unknown');
}

export async function observeMergedDeployment(github, repository, policy, issue, mergeCommit, grantId, now = Date.now()) {
  validateDeploymentPolicy(policy);
  if (policy.mode === 'not-applicable') return readDeploymentProof(github, repository, policy, {}, now);
  const deployments = await github.list(`${repoPath(repository)}/deployments?sha=${mergeCommit}&environment=${encodeURIComponent(policy.environment)}`);
  const relevant = deployments.filter(d => d.environment === policy.environment && d.payload?.stream === policy.stream);
  if (!relevant.length) return { status: 'pending', code: 'DEPLOYMENT_MISSING', commit: mergeCommit };
  const deployment = relevant[0];
  const version = policy.versionMode === 'merge-commit' ? mergeCommit : policy.expectedVersions?.[issue.id];
  if (!version) stop('DEPLOYMENT_POLICY_MISSING', 'Signed deployment policy must select exact version identity');
  return readDeploymentProof(github, repository, policy, { deploymentId: String(deployment.id), commit: mergeCommit,
    version, issueId: issue.id, grantId }, now);
}
