import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubProvider, parseGithubJson } from '../src/index.mjs';
import { completionFixture } from '../tooling/completion-fixture.mjs';

// Observed REST event shape. This is a parser contract, not live completion proof.
const commit = 'c4402fa3a99415d451ba888f5c4eaed3232e7483';
const event = {
  id: 34774229531,
  event: 'referenced',
  commit_id: commit,
  actor: { id: 127829492 },
  created_at: '2026-10-31T13:47:29Z',
};

test('Issue event Git object IDs remain distinct from numeric resource IDs', () => {
  const [value] = parseGithubJson(JSON.stringify([event]));
  assert.equal(value.commit_id, commit);
  assert.equal(value.id, '34774229531');
  assert.equal(value.actor.id, '127829492');
  assert.equal(parseGithubJson('{"commit_id":null}').commit_id, null);
  assert.equal(parseGithubJson('{"id":9007199254740993}').id, '9007199254740993');
});

test('referenced events traverse the authenticated collection boundary', async () => {
  const provider = createGithubProvider({
    attempts: 1,
    transport: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify([event]),
    }),
  });
  const endpoint = '/repos/example/core/issues/76/events';
  const result = await provider.collection({
    endpoint: endpoint + '?per_page=100',
    target: '42',
    operation: 'completion-read',
    correlation: 'event-contract',
    allowPage: (p) => p.split('?')[0] === endpoint,
  });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.data[0].commit_id, commit);
});

for (const value of [42, '42', '', 'g'.repeat(40), 'a'.repeat(39), true, {}])
  test('invalid Git object ID remains rejected: ' + JSON.stringify(value), () => {
    assert.throws(() => parseGithubJson(JSON.stringify({ commit_id: value })));
  });

test('Git hash support never broadens numeric resource ID acceptance', () => {
  for (const key of ['id', 'repository_id', 'check_suite_id'])
    assert.throws(() => parseGithubJson(JSON.stringify({ [key]: commit })));
});

test('completion retains bounded field diagnostics without response values', async () => {
  const f = await completionFixture();
  f.state.events = [{ ...event, commit_id: 'sensitive-invalid-response-value' }];
  const result = await f.fresh().close();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.finding, 'completion:events');
  assert.equal(result.observation.diagnostic.dataField, 'commit_id');
  assert.equal(result.observation.diagnostic.expectedData, 'git-object-id');
  assert.equal(result.observation.diagnostic.status, 200);
  assert(!JSON.stringify(result).includes('sensitive-invalid-response-value'));
  assert.equal(f.state.closed, false);
  assert.deepEqual(f.state.mutations, []);
});
