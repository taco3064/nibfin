import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionTargets } from '../src/action-lifecycle.mjs';
import { unitId } from '../src/dynamic.mjs';
import { Store } from '../src/store.mjs';
import { ActionOutbox } from '../src/action-outbox.mjs';

test('four CI completions route only matching Issues and dispatch two reviews; stale and merged heads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-routing-')); t.after(() => rm(root, { recursive: true }));
  const issues = ['A','B','C','D'].map(id => ({ id, repository: 'owner/repo', repositoryId: '1', scopeHash: id }));
  const grant = { policy: { grantId: 'g', revision: 1 }, manifest: { issues } };
  for (const [index, issue] of issues.slice(0,2).entries()) {
    await new Store(root, unitId(grant, issue)).transaction(0, s => ({ ...s, issues: { [issue.id]: { prNumber: index + 10 } } }));
  }
  let head = 'A', merged = false;
  const runtime = { config: { stateDirectory: root }, github: { api: async path => {
    if (path.includes('/actions/runs/')) return { head_sha: head };
    const id = path.endsWith('/10') ? 'A' : 'B';
    return { head: { sha: id, repo: { full_name: 'owner/repo' } }, merged_at: merged ? 'now' : null, merge_commit_sha: 'merged-' + id };
  } } };
  const box = new ActionOutbox(root, {}, { repositoryId: 'core', repository: 'owner/core', workflowPath: 'stage.yml', ref: 'main' });
  const handoffs = [];
  for (const [n,h] of ['A','A','B','B'].entries()) {
    head = h;
    const targets = await completionTargets(runtime, grant, { repository: 'owner/repo', relatedRunId: String(n) });
    assert.deepEqual(targets.map(i => i.id), [h]);
    for (const issue of targets) {
      const id = await box.enqueue({ schemaVersion: 1, authority: { revision: 1 }, repository: issue.repository, issueId: issue.id, operation: 'shaper-review', basis: issue.id, artifacts: { head }, source: { runId: n }, predecessor: { runId: n } });
      const handoff = await box.prepareHandoff(id); if (handoff) handoffs.push(handoff);
    }
  }
  assert.equal(handoffs.length, 2);
  head = 'old'; assert.deepEqual(await completionTargets(runtime, grant, { repository: 'owner/repo', relatedRunId: '5' }), []);
  head = 'merged-A'; assert.deepEqual(await completionTargets(runtime, grant, { repository: 'owner/repo', relatedRunId: '6' }), []);
  merged = true; assert.deepEqual((await completionTargets(runtime, grant, { repository: 'owner/repo', relatedRunId: '7' })).map(i => i.id), ['A']);
});
