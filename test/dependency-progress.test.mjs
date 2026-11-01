import test from 'node:test';
import assert from 'node:assert/strict';
import { dynamicFixture } from '../tooling/dynamic-fixture.mjs';

const delivered = JSON.stringify([
  { name: 'scope' },
  { name: 'shaped' },
  { name: 'delivered' },
]);
const original = '[{"name":"delivered"}]';
function fixture() {
  const f = dynamicFixture();
  f.edges.set('1', ['2']);
  f.current = async () => {
    throw Error('Local completion must not decide GitHub workflow progress');
  };
  f.retrieve = f.current;
  f.changeResponse = (_request, response) => ({
    ...response,
    body: response.body.replaceAll(original, delivered),
  });
  return f;
}
const evaluate = (f) => f.evaluate({ progressSource: 'github-labels' });

test('fresh GitHub delivery markers need no private completion import', async () => {
  const f = fixture();
  const result = await evaluate(f);
  assert.equal(result.outcome, 'ready');
  assert.equal(result.completions.length, 0);
  assert.deepEqual(result.progress, [
    {
      issue: f.nodes[1],
      source: 'github-issue',
      state: 'delivered',
    },
  ]);
  assert.ok(f.calls.every((request) => request.method === 'GET'));
});

test('removed delivery marker waits even if an old local completion exists', async () => {
  const f = fixture();
  assert.equal((await evaluate(f)).outcome, 'ready');
  f.contexts.set(f.nodes[1].issueId, { identity: 'a'.repeat(64) });
  f.changeResponse = (_request, response) => ({
    ...response,
    body: response.body.replaceAll(original, '[{"name":"scope"}]'),
  });
  const result = await evaluate(f);
  assert.equal(result.outcome, 'waiting');
  assert.equal(result.findings[0].reason, 'workflow_not_delivered');
});

test('inconsistent or malformed live delivery state fails closed', async () => {
  for (const patch of [
    (body) => body.replaceAll('"state":"closed"', '"state":"open"'),
    (body) => body.replaceAll(delivered, '[{"name":"delivered"}]'),
    (body) => body.replaceAll(delivered, '[null]'),
    (body) => body.replaceAll(delivered, 'null'),
    (body) =>
      body.replaceAll(
        delivered,
        '[{"name":"scope"},{"name":"scope"},{"name":"delivered"}]',
      ),
    (body) =>
      body.replaceAll(
        '"state":"closed"',
        '"state":"closed","state_reason":"not_planned"',
      ),
  ]) {
    const f = fixture();
    f.changeResponse = (_request, response) => ({
      ...response,
      body: patch(response.body.replaceAll(original, delivered)),
    });
    const result = await evaluate(f);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.findings[0].reason, 'workflow_progress_invalid');
  }
});

test('every transitive prerequisite is live and still needs authorization', async () => {
  const f = fixture();
  f.edges.set('2', ['3']);
  assert.equal((await evaluate(f)).progress.length, 2);
  f.denied.add(f.nodes[2].issueId);
  const result = await evaluate(f);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.findings[0].reason, 'unauthorized');
});
