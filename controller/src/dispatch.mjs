import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { repoPath } from './github.mjs';
import { readBindings, verifyDispatch } from './runner-binding.mjs';
import { digest } from './core.mjs';
import { Store } from './store.mjs';
import { continueCohort, resumableWait, rateLimitedRead, waitForReadRetry } from './continuation.mjs';
import { setTimeout } from 'node:timers/promises';
import { verifyKairoOwner } from './owner-identity.mjs';

export const dispatchGrantIdentity = grant => digest({ policy: grant.policy, manifest: grant.manifest, recordId: grant.recordId ?? null, actor: grant.actor ?? null, actorGitHubUserId: grant.actorGitHubUserId ?? null });
export const transientDispatchRead = error => rateLimitedRead(error) || error.requestMethod === 'GET' && ([429, 502, 503, 504].includes(error.status) || error.name === 'TimeoutError' || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.cause?.code));

// Parse one small file in memory. Never extract attacker-controlled paths.
export function dispatchFromZip(bytes) {
  if (bytes.length > 65536) throw new Error('Dispatch archive too large');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== 1 || bytes.readUInt16LE(end + 10) !== 1) throw new Error('Invalid dispatch ZIP directory');
  const c = bytes.readUInt32LE(end + 16);
  if (c + 46 > end || bytes.readUInt32LE(c) !== 0x02014b50) throw new Error('Invalid ZIP entry');
  const size = bytes.readUInt32LE(c + 24), compressed = bytes.readUInt32LE(c + 20), method = bytes.readUInt16LE(c + 10), offset = bytes.readUInt32LE(c + 42);
  const name = bytes.subarray(c + 46, c + 46 + bytes.readUInt16LE(c + 28)).toString('utf8');
  if (name !== 'dispatch.json' || size > 8192 || compressed > 32768 || (bytes.readUInt16LE(c + 8) & 1) || ![0, 8].includes(method) || offset + 30 > c || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('Unsupported dispatch ZIP entry');
  const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
  if (start + compressed > c) throw new Error('Invalid ZIP bounds');
  const data = bytes.subarray(start, start + compressed);
  const decoded = method === 8 ? inflateRawSync(data, { maxOutputLength: 8192 }) : data;
  if (decoded.length !== size) throw new Error('Invalid dispatch size');
  return JSON.parse(decoded.toString('utf8'));
}

async function boundedBytes(response) {
  if (!response.ok || Number(response.headers.get('content-length')) > 65536) throw new Error('Artifact download refused');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) throw new Error('Artifact download exceeded size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function downloadDispatch(github, repository, artifact) {
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired || artifact.size_in_bytes > 65536) throw new Error('Invalid dispatch artifact');
  if (github.download) {
    const bytes = await github.download(`${repoPath(repository)}/actions/artifacts/${artifact.id}/zip`, 65536);
    if (artifact.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`) throw new Error('Artifact digest mismatch');
    return dispatchFromZip(bytes);
  }
  const response = await github.fetch(`https://api.github.com${repoPath(repository)}/actions/artifacts/${artifact.id}/zip`, {
    redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${github.token}`, 'X-GitHub-Api-Version': '2026-03-10' },
  });
  if (response.status !== 302) throw new Error('Artifact archive redirect unavailable');
  const url = new URL(response.headers.get('location'));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com'))) throw new Error('Untrusted artifact storage origin');
  // The GitHub credential must never follow the storage redirect.
  const bytes = await boundedBytes(await github.fetch(url.href, { redirect: 'error', signal: AbortSignal.timeout(30000) }));
  if (artifact.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`) throw new Error('Artifact digest mismatch');
  return dispatchFromZip(bytes);
}

export async function verifyOrigin(github, entry, envelope, { allowExpired = false, now = Date.now() } = {}) {
  const p = verifyDispatch(envelope, entry, now, true);
  const ownerId = await verifyKairoOwner(github, { kairoOwnerGitHubUserId: entry.kairoOwnerGitHubUserId });
  const b = entry.binding, repository = await github.repository(b.repository);
  if (b.ownerId !== ownerId || repository.private || repository.owner?.type !== 'User' || String(repository.id) !== b.repositoryId || String(repository.owner?.id) !== ownerId) throw new Error('Public repository identity or owner changed');
  const run = await github.api(`${repoPath(b.repository)}/actions/runs/${p.runId}`);
  // Legacy notifications cannot claim Issue provenance. New notifications bind
  // the event and Issue identity in the HMAC from the exact pinned hosted code.
  const events = p.schemaVersion === 2 ? ['issues', 'workflow_dispatch', 'schedule'] : ['workflow_dispatch', 'schedule'];
  if (!events.includes(run.event) || p.schemaVersion === 2 && p.eventName !== run.event || run.status !== 'completed' || run.conclusion !== 'success' || run.run_attempt !== p.runAttempt ||
      String(run.repository?.id) !== b.repositoryId || String(run.head_repository?.id) !== b.repositoryId || run.head_branch !== repository.default_branch || run.path !== b.workflowPath ||
      String(run.actor?.id) !== b.ownerId || String(run.triggering_actor?.id) !== b.ownerId) throw new Error('Untrusted public workflow origin');
  const workflow = await github.api(`${repoPath(b.repository)}/contents/${b.workflowPath}?ref=${run.head_sha}`);
  const current = await github.api(`${repoPath(b.repository)}/contents/${b.workflowPath}?ref=${encodeURIComponent(repository.default_branch)}`);
  if (workflow.sha !== b.workflowBlob || current.sha !== b.workflowBlob) throw new Error('Public workflow pin changed');
  if (run.event === 'issues') {
    const issue = await github.api(`${repoPath(b.repository)}/issues/${p.issueNumber}`);
    if (issue.pull_request || issue.node_id !== p.issueId || issue.number !== p.issueNumber || String(issue.user?.id) !== ownerId) throw new Error('Untrusted public Issue identity or creator');
  }
  const jobs = await github.list(`${repoPath(b.repository)}/actions/runs/${p.runId}/attempts/${p.runAttempt}/jobs`, 'jobs');
  if (jobs.length !== 1 || jobs[0].name !== 'preflight' || jobs[0].status !== 'completed' || jobs[0].conclusion !== 'success' || !jobs[0].labels?.includes('ubuntu-latest') || jobs[0].labels?.includes('self-hosted')) throw new Error('Public caller must use the hosted preflight only');
  // Normal expiry is classified only after all independent authority/provenance
  // checks succeed. Tampering must never be downgraded to a renewable timeout.
  if (!allowExpired && p.expiresAt <= now) throw Object.assign(new Error('Dispatch expired; await renewal'), { code: 'DISPATCH_EXPIRED' });
  return p;
}

export async function pollDispatch(runtime, { continuationOptions } = {}) {
  if (runtime.environment.GITHUB_REPOSITORY) throw new Error('Public dispatch controller must run outside repository Actions');
  const grant = await runtime.grant();
  const entries = await readBindings(runtime.config, grant.policy);
  const grantHash = dispatchGrantIdentity(grant);
  const store = new Store(runtime.config.stateDirectory, `dispatch:${grant.policy.publicRunner.rootId}`);
  return store.lease(async () => {
    let state = await store.read();
    if (state.renewalGrantHash && state.renewalGrantHash !== grantHash) throw new Error('Renewal authority changed; explicit revalidation required');
    if (state.active) {
      if (state.active.grantHash !== grantHash) throw new Error('Dispatch grant changed; operator revalidation required');
      let expired = false;
      for (const [repository, entry] of Object.entries(entries)) {
        const p = await verifyOrigin(runtime.github, entry, state.active.envelopes?.[repository], { allowExpired: true });
        if (p.expiresAt <= Date.now()) expired = true;
      }
      if (expired) state = await store.transaction(state.revision, s => ({ ...s, active: null, renewalGrantHash: grantHash, pendingGrantHash: grantHash, pendingDispatches: {}, lastResult: { status: 'WAITING', code: 'DISPATCH_EXPIRED' } }));
    }
    if (!state.active) {
      if (state.pendingGrantHash !== grantHash) state = await store.transaction(state.revision, s => ({ ...s, pendingGrantHash: grantHash, pendingDispatches: {} }));
      for (const [repository, entry] of Object.entries(entries)) {
        if (state.pendingDispatches?.[repository]) {
          try { await verifyOrigin(runtime.github, entry, state.pendingDispatches[repository]); continue; }
          catch (error) {
            if (error.code !== 'DISPATCH_EXPIRED') throw error;
            state = await store.transaction(state.revision, s => { delete s.pendingDispatches[repository]; return s; });
          }
        }
        const artifacts = await runtime.github.list(`${repoPath(repository)}/actions/artifacts?name=kairo-dispatch`, 'artifacts');
        for (const artifact of artifacts) {
          if (artifact.name !== 'kairo-dispatch' || artifact.expired) continue;
          let envelope, p;
          try {
            envelope = await downloadDispatch(runtime.github, repository, artifact);
            p = await verifyOrigin(runtime.github, entry, envelope);
            if (String(artifact.workflow_run?.id) !== p.runId || String(artifact.workflow_run?.repository_id) !== p.repositoryId || String(artifact.workflow_run?.head_repository_id) !== p.repositoryId) continue;
          } catch { continue; } // Invalid messages never invoke Core or Agent.
          const replayId = digest({ bindingId: p.bindingId, nonce: p.nonce });
          const runId = digest({ repositoryId: p.repositoryId, runId: p.runId, runAttempt: p.runAttempt });
          if (state.seen?.includes(replayId) || state.seen?.includes(runId)) continue;
          state = await store.transaction(state.revision, s => ({ ...s, seen: [...(s.seen || []), replayId, runId], pendingDispatches: { ...s.pendingDispatches, [repository]: envelope } }));
          break;
        }
      }
      if (Object.keys(entries).length && Object.keys(entries).every(repository => state.pendingDispatches?.[repository])) state = await store.transaction(state.revision, s => ({ ...s, active: { envelopes: s.pendingDispatches, grantHash }, pendingDispatches: {}, renewalGrantHash: null }));
    }
    if (!state.active) return { status: 'WAITING', reason: 'No valid unconsumed dispatch for this runner and grant' };
    if (state.active.grantHash !== grantHash) throw new Error('Dispatch grant changed; operator revalidation required');
    runtime.publicDispatch = state.active;
    try {
      const result = await continueCohort(runtime, continuationOptions);
      // Retain activation only for explicitly resumable waits. Every new poll
      // revalidates the grant, bindings and origin before resuming the cohort.
      if (result.continuation === 'bounded-wait-exhausted' && resumableWait(result)) return { ...result, status: 'WAITING' };
      if (result.status === 'COMPLETE' || result.status === 'BLOCKED') {
        await store.transaction(state.revision, s => ({ ...s, active: null, lastResult: result }));
      }
      return result;
    } catch (error) {
      if (error.code !== 'DISPATCH_EXPIRED') throw error;
      // Keep the activation until next poll validates every binding and origin;
      // renewal changes no cohort state, Candidate, acceptance or CI evidence.
      return { status: 'WAITING', code: 'DISPATCH_EXPIRED', reason: 'Awaiting same-authority dispatch renewal' };
    } finally { runtime.publicDispatch = null; }
  });
}
export async function watchDispatch(runtime, { maxPolls = 360, delay = setTimeout, now = Date.now, continuationOptions } = {}) {
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 360) throw new Error('Invalid dispatch polling limit');
  for (let i = 0; i < maxPolls; i++) {
    let result;
    try { result = await pollDispatch(runtime, { continuationOptions }); }
    catch (error) {
      if (!transientDispatchRead(error)) throw error;
      result = rateLimitedRead(error) ? { status: 'WAITING', code: error.code, retryAt: error.retryAt } : { status: 'WAITING', code: 'GITHUB_READ_UNAVAILABLE' };
    }
    if (result.status !== 'WAITING') return result;
    if (i + 1 < maxPolls) await waitForReadRetry(result.retryAt, 30000, delay, now);
  }
  return { status: 'WAITING', reason: 'Bounded polling complete; designated runner only' };
}
