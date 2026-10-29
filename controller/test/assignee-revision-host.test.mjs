import test from 'node:test';
import assert from 'node:assert/strict';
import { readAssigneeRevisionIssue } from '../src/assignee-revision-host.mjs';

function fixture(fault) {
  const subject = { repository: 'taco3064/nibfin', repositoryId: '1', number: 28, issueId: 'I_28' };
  const remote = { node_id: 'I_28', id: 1028, body: 'Original body', title: 'Historical ordering', state: 'open', state_reason: null,
    labels: [{ name: 'scope' }], assignees: [], milestone: null };
  let reads = 0; const calls = [];
  const github = { issue: async () => { reads++; return { ...structuredClone(remote), ...(fault === 'raced-body' && reads > 1 ? { body: 'Changed' } : {}) }; },
    repository: async () => ({ id: 1 }), dependencies: async () => [{ node_id: 'I_2' }], list: async () => [{ node_id: 'I_31' }],
    api: async (path, method, payload) => { calls.push({ path, method, payload });
      if (fault === 'projects-permission') throw Error('Forbidden');
      const id = fault === 'wrong-node' ? 'I_other' : 'I_28';
      return { data: { node: { id, projectItems: { nodes: fault === 'duplicate-project' ? [{ id: 'P1' }, { id: 'P1' }] : [{ id: 'P1' }],
        pageInfo: { hasNextPage: fault === 'bad-pagination', endCursor: null } } } } };
    } };
  if (fault === 'identity') remote.node_id = 'I_other';
  if (fault === 'database-id') remote.id = undefined;
  return { subject, github, calls };
}
test('native readback preserves Projects, both dependency directions and the REST database ID without mutations', async () => {
  const f = fixture(), o = await readAssigneeRevisionIssue(f.github, f.subject);
  assert.deepEqual(o.metadata.projects, ['P1']); assert.deepEqual(o.blockedBy, ['I_2']); assert.deepEqual(o.blocking, ['I_31']);
  assert.equal(o.stateReason, null); assert.equal(o.databaseId, 1028);
  assert.ok(f.calls.every(c => c.path === '/graphql' && c.payload.query.startsWith('query(')));
});
for (const fault of ['projects-permission', 'wrong-node', 'duplicate-project', 'bad-pagination', 'raced-body', 'identity', 'database-id'])
  test(`native readback refuses ${fault} rather than assuming empty metadata`, async () => {
    const f = fixture(fault); await assert.rejects(readAssigneeRevisionIssue(f.github, f.subject));
  });
