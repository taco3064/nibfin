import { setTimeout } from 'node:timers/promises';

export const resumableWait = result => result.status === 'PAUSED' || (result.status === 'BLOCKED' && ['CI_PENDING_OR_FAILED', 'FINAL_PROOF_MISSING', 'MERGE_PROTECTED', 'ACTIONS_JOB_PENDING', 'GITHUB_READ_UNAVAILABLE', 'MERGE_READBACK_PENDING', 'GITHUB_RATE_LIMIT'].includes(result.code));
export const rateLimitedRead = error => error.requestMethod === 'GET' && error.code === 'GITHUB_RATE_LIMIT' && Number.isSafeInteger(error.retryAt);
export async function waitForReadRetry(retryAt, intervalMs, delay, now = Date.now) {
  if (!Number.isSafeInteger(retryAt) || retryAt <= now()) return delay(intervalMs);
  while (retryAt > now()) await delay(Math.min(60000, retryAt - now()));
}

// Events wake the same durable cohort. Only external evidence waits are polled;
// decision, scope, policy, authentication and repair-budget stops are returned.
export async function continueCohort(runtime, { maxPasses = 360, intervalMs = 30000, delay = setTimeout, now = Date.now, onProgress = () => {} } = {}) {
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 360 || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error('Invalid bounded continuation settings');
  for (let pass = 0; pass < maxPasses; pass++) {
    let result;
    try { result = await runtime.resume({ onProgress }); }
    catch (error) {
      if (rateLimitedRead(error)) result = { status: 'BLOCKED', code: error.code, reason: error.message, retryAt: error.retryAt };
      else if (['ACTIONS_JOB_PENDING', 'MERGE_READBACK_PENDING'].includes(error.code)) result = { status: 'BLOCKED', code: error.code, reason: error.message };
      else if (error.requestMethod === 'GET' && [502, 503, 504].includes(error.status)) result = { status: 'BLOCKED', code: 'GITHUB_READ_UNAVAILABLE', reason: error.message };
      else throw error;
      onProgress(result);
    }
    if (!resumableWait(result)) return result;
    if (pass + 1 === maxPasses) return { ...result, continuation: 'bounded-wait-exhausted' };
    await waitForReadRetry(result.retryAt, intervalMs, delay, now);
  }
}
