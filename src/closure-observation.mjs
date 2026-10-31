import { contentIdentity } from './evidence.mjs';
import { observeControlledOperation } from './operations.mjs';
import { publicDiagnostic } from './provider.mjs';
import {
  CompletionFailure,
  completionNeed as need,
  completionTime as time,
} from './completion-contract.mjs';

/** Official provider-shaped readback. Full lifecycle events distinguish a reclose
 * even when the Issue's timestamp has only second precision. No event grants writes.
 */
export async function observeClosure({ provider, target, mergeIntent, signal } = {}) {
  const root = `/repos/${target.repository}`;
  const read = async (path) => {
    const r = await provider.request({
      method: 'GET',
      endpoint: root + path,
      operation: 'completion-read',
      target: target.repositoryId,
      correlation: 'completion',
      signal,
    });
    need(r.outcome === 'read', 'readback');
    return r.data;
  };
  const repo = await read(''),
    issue = await read(`/issues/${target.number}`);
  need(
    repo.id === target.repositoryId &&
      repo.full_name?.toLowerCase() === target.repository &&
      repo.private === false &&
      repo.visibility === 'public' &&
      ['User', 'Organization'].includes(repo.owner?.type),
    'public',
  );
  need(
    issue.id === target.databaseId &&
      issue.node_id === target.issueId &&
      String(issue.number) === target.number &&
      issue.repository_url === `https://api.github.com${root}` &&
      !issue.pull_request,
    'issue',
  );
  const path = root + `/issues/${target.number}/events`;
  const events = await provider.collection({
    method: 'GET',
    endpoint: path + '?per_page=100',
    operation: 'completion-read',
    target: target.repositoryId,
    correlation: 'completion',
    signal,
    allowPage: (p) => p.split('?')[0] === path,
  });
  if (events.outcome !== 'complete' || !Array.isArray(events.data))
    throw new CompletionFailure('events', {
      source: 'github-issue-events',
      ...publicDiagnostic(events),
    });
  const lifecycle = events.data
    .filter((e) => ['closed', 'reopened'].includes(e.event))
    .map((e) => ({
      id: e.id,
      event: e.event,
      created_at: e.created_at,
      actorId: e.actor?.id ?? null,
    }));
  if (
    !lifecycle.every((e) => /^[1-9][0-9]*$/.test(e.id) && time(e.created_at)) ||
    new Set(lifecycle.map((e) => e.id)).size !== lifecycle.length
  )
    throw new CompletionFailure('events', {
      source: 'github-issue-events',
      outcome: 'invalid-lifecycle',
      diagnostic: { kind: 'lifecycle_identity_or_time' },
      events: events.data.length,
      lifecycle: lifecycle.length,
    });
  // IDs identify events; neither numeric magnitude nor collection order proves time.
  lifecycle.sort((a, b) => a.id.localeCompare(b.id));
  const matching = lifecycle.filter(
    (e) =>
      e.event === 'closed' &&
      Date.parse(e.created_at) === Date.parse(issue.closed_at),
  );
  need(issue.state !== 'closed' || matching.length === 1, 'ambiguous-closure');
  const last = issue.state === 'closed' ? matching[0] : null;
  const merge = await observeControlledOperation(provider, mergeIntent, signal);
  const pr = await read(`/pulls/${mergeIntent.target.number}`);
  need(time(pr.merged_at) && pr.merge_commit_sha === merge.mergeCommit, 'merge-time');
  return {
    issueIdentity: contentIdentity(issue),
    ownership: repo.owner.type === 'User' ? 'personal' : 'organization',
    merge,
    mergedAt: pr.merged_at,
    issue: {
      state: issue.state,
      reason: issue.state_reason,
      closedAt: issue.closed_at,
      lifecycle: contentIdentity(lifecycle),
      eventIds: lifecycle.map((e) => e.id),
      occurrence: last
        ? {
            id: last.id,
            event: last.event,
            at: last.created_at,
            actorId: last.actorId,
          }
        : null,
    },
  };
}
