import { setTimeout } from 'node:timers/promises';

const emit = record => console.error(JSON.stringify({ ...record, at: new Date().toISOString() }));
// Retry only admission reads, never an entire lifecycle or a possibly completed write.
export async function waitForActionIdentity(read, { delay = setTimeout, now = Date.now, log = emit, attempts = 45, budgetMs = 240000, intervalMs = 5000, context = {} } = {}) {
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await read(attempt);
      if (attempt > 1) log({ kind: 'action-identity-ready', ...context, attempt, elapsedMs: now() - started });
      return value;
    }
    catch (error) {
      if (error.code !== 'ACTIONS_JOB_PENDING') throw error;
      const elapsedMs = now() - started;
      const exhausted = attempt >= attempts || elapsedMs + intervalMs >= budgetMs;
      log({ kind: 'action-identity-wait', ...context, attempt, elapsedMs, exhausted, code: error.code });
      if (exhausted) throw Object.assign(new Error('Current execution job identity remained unavailable; this check authorizes no further work. Inspect action-identity-read records and reconcile the durable request in a new Run.'), { code: 'ACTIONS_JOB_READBACK_TIMEOUT' });
      await delay(intervalMs);
    }
  }
}

export async function currentActionJob(github, execution, env, { log = emit } = {}) {
  const path = `/repos/${execution.repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs`;
  const started = performance.now();
  let jobs;
  try { jobs = await github.list(path, 'jobs'); }
  catch (error) {
    log({ kind: 'action-identity-read', runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, elapsedMs: Math.round(performance.now() - started), code: error.code || 'READ_FAILED', status: error.status || null, responses: github.jobReadResponses?.filter(r => r.path.startsWith(path + '?')) || [] });
    throw error;
  }
  const matches = jobs.filter(j => j.runner_name === env.RUNNER_NAME && j.status === 'in_progress' && j.name === execution.jobName);
  const fields = ['id', 'name', 'status', 'conclusion', 'runner_id', 'runner_name', 'started_at', 'completed_at'];
  log({ kind: 'action-identity-read', runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    expected: { jobName: execution.jobName, runnerName: env.RUNNER_NAME }, matchingCount: matches.length,
    elapsedMs: Math.round(performance.now() - started), jobCount: jobs.length,
    jobs: jobs.slice(0, 100).map(j => Object.fromEntries(fields.map(k => [k, typeof j[k] === 'string' ? j[k].slice(0, 256) : typeof j[k] === 'number' ? j[k] : null]))),
    truncated: jobs.length > 100, responses: github.jobReadResponses?.filter(r => r.path.startsWith(path + '?')) || [] });
  const named = jobs.filter(j => j.name === execution.jobName);
  if (named.length > 1 || named.some(j => j.status === 'completed' || j.runner_name && j.runner_name !== env.RUNNER_NAME || j.runner_id && !execution.runnerIds.map(String).includes(String(j.runner_id))))
    throw Object.assign(new Error('Current execution job conflicts with enrolled identity or has already completed'), { code: 'ACTION_PROVENANCE_INVALID' });
  if (matches.length !== 1) throw Object.assign(new Error('Waiting for exact current execution job identity'), { code: 'ACTIONS_JOB_PENDING' });
  return matches[0];
}
