import { digest } from './core.mjs';
import { repoPath } from './github.mjs';

const deny = message => { throw Object.assign(new Error(message), { code: 'ACTION_PROVENANCE_INVALID' }); };
const positive = value => /^(?:[1-9]\d*)$/.test(String(value));

// Inputs are hints only. Resolve every identity from the provider, including the
// specific attempt and job. Never accept a caller-supplied verified flag.
export async function verifyActionRun(github, policy, identity, options = {}) {
  const work = () => verifyActionRunFresh(github, policy, identity, options);
  return github.measure ? github.measure('provenance', work) : work();
}
async function verifyActionRunFresh(github, policy, identity, { completed = false, conclusion = 'success' } = {}) {
  const local = policy?.identityMode === 'local-gh';
  if (!policy || !/^[\w.-]+\/[\w.-]+$/.test(policy.repository || '') || !positive(policy.repositoryId) ||
      !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(policy.workflowPath || '') ||
      !/^[a-f0-9]{40}$/.test(policy.workflowBlob || '') || !Array.isArray(policy.actorIds) || !policy.actorIds.length ||
      !Array.isArray(policy.runnerIds) || !policy.runnerIds.length || !policy.runnerIds.every(positive) ||
      !positive(identity?.runId) || !positive(identity?.attempt) || (!local && !positive(identity?.jobId))) deny('Missing explicit workflow, actor, runner or run/attempt/job identity');
  let operator;
  if (local) {
    operator = await github.api('/user');
    if (!positive(policy.ownerId) || operator.type !== 'User' || String(operator.id) !== policy.ownerId) deny('Local gh login is not the approved Owner');
  }
  const root = repoPath(policy.repository);
  const repository = await github.repository(policy.repository);
  if (String(repository.id) !== String(policy.repositoryId) || (repository.private !== true || policy.visibility==='private'&&String(repository.owner?.id)!==policy.ownerId)) deny('Stage execution must use the enrolled private repository');
  const run = await github.api(`${root}/actions/runs/${identity.runId}/attempts/${identity.attempt}`);
  const actors = policy.actorIds.map(String);
  if (String(run.id) !== String(identity.runId) || run.run_attempt !== Number(identity.attempt) ||
      String(run.repository?.id) !== String(policy.repositoryId) || run.repository?.full_name !== policy.repository ||
      run.path !== policy.workflowPath || run.event !== 'workflow_dispatch' ||
      !actors.includes(String(run.actor?.id)) || !actors.includes(String(run.triggering_actor?.id)) ||
      !/^[a-f0-9]{40}$/.test(run.head_sha || '')) deny('Run identity, event, workflow or actor does not match enrollment');
  const [atRun, current] = await Promise.all([
    github.api(`${root}/contents/${policy.workflowPath}?ref=${run.head_sha}`),
    github.api(`${root}/contents/${policy.workflowPath}?ref=${encodeURIComponent(repository.default_branch)}`),
  ]);
  const runPins = [policy.workflowBlob];
  if (policy.previousWorkflowBlob !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(policy.previousWorkflowBlob)) deny('Invalid historical workflow pin');
    runPins.push(policy.previousWorkflowBlob);
  }
  if(policy.originalWorkflowBlob!==undefined){
    if(!/^[a-f0-9]{40}$/.test(policy.originalWorkflowBlob))deny('Invalid original workflow pin');
    runPins.push(policy.originalWorkflowBlob);
  }
  if (!runPins.includes(atRun.sha) || current.sha !== policy.workflowBlob) deny('Workflow pin changed');
  if (local) {
    // The owner-approved local controller authenticates through gh. Run metadata
    // is an audit record, never a requirement to observe our own running Job.
    // Cross-stage readiness comes from the durable result/outbox plus needs:
    // execute in the pinned workflow, not an eventually visible Job status.
    const result = { kind: 'github-action-stage', authentication: 'local-gh', operatorId: String(operator.id),
      repository: policy.repository, repositoryId: String(repository.id), runId: String(run.id), runAttempt: run.run_attempt,
      jobKey: policy.jobName, jobId: null, runnerId: null, runnerName: policy.runnerName,
      workflowPath: run.path, workflowBlob: atRun.sha, head: run.head_sha,
      actorId: String(run.actor.id), triggeringActorId: String(run.triggering_actor.id),
      url: `https://github.com/${policy.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}` };
    return { ...result, identityHash: digest(result) };
  }
  const jobs = await github.list(`${root}/actions/runs/${identity.runId}/attempts/${identity.attempt}/jobs`, 'jobs');
  const matching = jobs.filter(j => String(j.id) === String(identity.jobId));
  if (matching.length !== 1) deny('Missing or ambiguous execution job');
  const job = matching[0];
  const worker = policy.workers ? policy.workers.some(w => String(w.id) === String(job.runner_id) && w.name === job.runner_name) : job.runner_name === policy.runnerName;
  if (job.head_sha !== run.head_sha || !policy.runnerIds.map(String).includes(String(job.runner_id)) ||
      !worker || (policy.jobName && job.name !== policy.jobName)) deny('Job is not on the enrolled coordination runner');
  const handoffOnly = policy.handoffJobName && jobs.some(j => j.name === policy.handoffJobName) &&
    jobs.filter(j => j.name !== policy.handoffJobName).every(j => j.status === 'completed' && j.conclusion === conclusion) &&
    ['in_progress', 'completed'].includes(run.status) && !['cancelled', 'timed_out', 'action_required', 'skipped'].includes(run.conclusion);
  const sourceComplete = job.status === 'completed' && job.conclusion === conclusion && (handoffOnly || run.status === 'completed' && run.conclusion === conclusion);
  if (completed && !sourceComplete && ['queued', 'waiting', 'in_progress'].includes(run.status) && ['queued', 'waiting', 'in_progress', 'completed'].includes(job.status) && (!job.conclusion || job.conclusion === 'success')) throw Object.assign(new Error('Verified predecessor has not completed provider readback yet'), { code: 'ACTION_PREDECESSOR_PENDING' });
  if (completed ? !sourceComplete : job.status !== 'in_progress') deny('Required current run/job status is absent');
  const result = { kind: 'github-action-stage', repository: policy.repository, repositoryId: String(repository.id),
    runId: String(run.id), runAttempt: run.run_attempt, jobId: String(job.id), runnerId: job.runner_id,
    runnerName: job.runner_name, workflowPath: run.path, workflowBlob: atRun.sha, head: run.head_sha,
    actorId: String(run.actor.id), triggeringActorId: String(run.triggering_actor.id),
    url: `https://github.com/${policy.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}` };
  return { ...result, identityHash: digest(result) };
}

export function requireDistinctActionRuns(receipts) {
  const seen = new Set();
  for (const receipt of receipts) {
    if (receipt?.kind !== 'github-action-stage' || !positive(receipt.runId) || !positive(receipt.runAttempt) || !receipt.identityHash) deny('Stage lacks an independently verified Actions identity');
    // A rerun attempt of the same Run cannot double as a different formal stage.
    const key = `${receipt.repository}:${receipt.runId}`;
    if (seen.has(key)) deny('Formal stages share an Actions Run');
    seen.add(key);
  }
}

// Owner Issue sessions deliberately group independent Agent stages in one Run.
// A later dispatched stage must use a new Run, without retrospectively treating
// those authorized historical groups as invalid per-stage execution.
export function requireFreshActionRun(history,current,policy) {
 if(policy.controlMode!=='owner-project')return requireDistinctActionRuns([...history,current]);
 requireDistinctActionRuns([current]);
 for(const previous of history)requireDistinctActionRuns([previous,current]);
}
