import test from 'node:test';
import assert from 'node:assert/strict';
import { invoke, digest, validateRequest } from '../src/index.mjs';
import { initial, h } from './fixtures/request.mjs';
import { runOneStage } from '../examples/action.mjs';
function adapters(proof = { permission: 'verified' }) {
  const calls = [];
  return { calls, verify: async () => proof,
    execute: async r => { calls.push(r); return { status: 'succeeded' }; } };
}
async function successor(stage = 'shape-validator') {
  const first = initial();
  if (stage === 'deliver') { first.stage = 'shape-validator'; first.shapeDigest = h; }
  if (stage === 'accept') { first.stage = 'deliver'; first.shapeDigest = h; first.candidateDigest = h; }
  // Fixture result is a deterministic signed-source stand-in, not real provenance.
  const evidence = { ...first, resultId: 'previous-result', status: 'succeeded' };
  const request = { ...initial(), requestId: 'request-2', stage,
    source: { ...initial().source, runId: '1001' },
    previous: { resultId: evidence.resultId, digest: digest(evidence), stage: first.stage,
      requestId: first.requestId, repositoryId: first.repository.id, issueId: first.issue.id,
      source: first.source } };
  if (['deliver', 'accept'].includes(stage)) request.shapeDigest = h;
  if (stage === 'accept') request.candidateDigest = h;
  return { request, evidence, proof: { permission: 'verified', previousAuthenticity: 'verified', previousResult: evidence } };
}
test('one requested stage executes exactly once, with correlated structured result', async () => {
  const a = adapters();
  const r = initial();
  const result = await runOneStage(r, a);
  assert.equal(result.status, 'succeeded');
  assert.equal(a.calls.length, 1);
  assert.deepEqual(a.calls[0], r);
  for (const key of ['requestId', 'stage', 'repository', 'issue', 'authority', 'source']) assert.deepEqual(result[key], r[key]);
  assert.equal(result.components, null);
  assert.equal(result.resultId, 'request-1:result');
});
test('production defaults and partial adapters never report success', async () => {
  assert.equal((await invoke(initial())).status, 'blocked');
  const a = adapters();
  assert.equal((await invoke(initial(), { execute: a.execute })).status, 'blocked');
  assert.equal(a.calls.length, 0);
  assert.equal((await invoke(initial(), { verify: a.verify })).status, 'blocked');
});
const malformed = [
  ['null', () => null], ['array', () => []],
  ['schema', r => ({ ...r, schemaVersion: 2 })], ['stage', r => ({ ...r, stage: 'watch' })],
  ['request identity', r => ({ ...r, requestId: '' })],
  ['issue repository', r => ({ ...r, issue: { ...r.issue, repositoryId: 'wrong' } })],
  ['issue number', r => ({ ...r, issue: { ...r.issue, number: 0 } })],
  ['source repository', r => ({ ...r, source: { ...r.source, repositoryId: 'wrong' } })],
  ['attempt', r => ({ ...r, source: { ...r.source, attempt: 0 } })],
  ['authority', r => ({ ...r, authority: {} })], ['scope', r => ({ ...r, scopeDigest: '' })],
  ['self permission', r => ({ ...r, authorized: true })],
  ['initial predecessor', r => ({ ...r, previous: {} })],
  ['missing predecessor', r => ({ ...r, stage: 'shape-validator' })]
];
for (const [name, mutate] of malformed) test(`reject malformed ${name} before execution`, async () => {
  const a = adapters();
  assert.equal((await invoke(mutate(initial()), a)).status, 'rejected');
  assert.equal(a.calls.length, 0);
});
test('all later stages accept matching verified evidence', async () => {
  for (const stage of ['shape-validator', 'deliver', 'accept']) {
    const { request, proof } = await successor(stage);
    const a = adapters(proof);
    assert.equal((await invoke(request, a)).status, 'succeeded');
    assert.equal(a.calls.length, 1);
  }
});
const badEvidence = [
  ['digest', e => ({ ...e, resultId: 'altered' })],
  ['repository', e => ({ ...e, repository: { id: 'wrong', name: 'example/other' } })],
  ['Issue', e => ({ ...e, issue: { ...e.issue, id: 'wrong' } })],
  ['stage', e => ({ ...e, stage: 'accept' })],
  ['request', e => ({ ...e, requestId: 'wrong' })],
  ['Run', e => ({ ...e, source: { ...e.source, runId: 'wrong' } })],
  ['Attempt', e => ({ ...e, source: { ...e.source, attempt: 2 } })],
  ['incomplete', e => ({ ...e, status: 'blocked' })],
  ['unsuccessful', e => ({ ...e, status: 'rejected' })],
  ['authority', e => ({ ...e, authority: { ...e.authority, grantId: 'wrong' } })],
  ['Scope', e => ({ ...e, scopeDigest: 'b'.repeat(64) })]
];
for (const [name, mutate] of badEvidence) test(`block wrong predecessor ${name}`, async () => {
  const { request, proof } = await successor();
  proof.previousResult = mutate(proof.previousResult);
  // Correlation checks must reject even when attacker updates the input digest.
  if (name !== 'digest') request.previous.digest = digest(proof.previousResult);
  const a = adapters(proof);
  assert.equal((await invoke(request, a)).status, 'blocked');
  assert.equal(a.calls.length, 0);
});
test('reference stage, request, repository and Issue cannot be substituted', async () => {
  for (const change of [{ stage: 'accept' }, { requestId: 'request-2' }, { repositoryId: 'wrong' }, { issueId: 'wrong' }]) {
    const { request, proof } = await successor();
    Object.assign(request.previous, change);
    const a = adapters(proof);
    assert.equal((await invoke(request, a)).status, 'rejected');
    assert.equal(a.calls.length, 0);
  }
});
test('stage-applicable Shape and candidate references are mandatory', async () => {
  for (const [stage, key] of [['deliver', 'shapeDigest'], ['accept', 'candidateDigest']]) {
    const { request, proof } = await successor(stage);
    delete request[key];
    const a = adapters(proof);
    assert.equal((await invoke(request, a)).status, 'rejected');
    assert.equal(a.calls.length, 0);
  }
});
test('predecessor Shape and candidate must match current invocation', async () => {
  for (const [stage, key] of [['deliver', 'shapeDigest'], ['accept', 'candidateDigest']]) {
    const { request, proof } = await successor(stage);
    request[key] = 'b'.repeat(64);
    const a = adapters(proof);
    assert.equal((await invoke(request, a)).status, 'blocked');
    assert.equal(a.calls.length, 0);
  }
});
test('structural validity alone is never verified success', async () => {
  const { request, proof } = await successor();
  assert.equal(validateRequest(request), request);
  for (const p of [{}, { permission: 'verified' }, { ...proof, previousAuthenticity: 'unavailable' }]) {
    const a = adapters(p);
    assert.equal((await invoke(request, a)).status, 'blocked');
    assert.equal(a.calls.length, 0);
  }
});
test('verification exception and execution uncertainty block without retry', async () => {
  let calls = 0;
  assert.equal((await invoke(initial(), { verify: async () => { throw Error('private detail'); }, execute: async () => calls++ })).status, 'blocked');
  assert.equal(calls, 0);
  const result = await invoke(initial(), { verify: async () => ({ permission: 'verified' }),
    execute: async () => { calls++; throw Error('private detail'); } });
  assert.equal(result.status, 'blocked');
  assert.equal(calls, 1);
  assert(!JSON.stringify(result).includes('private detail'));
});
test('non-string stages are rejected before either trusted adapter is called', async () => {
  for (const stage of [['shape'], [['shape']], [], {}, { name: 'shape' }, null, true, 1]) {
    const request = JSON.parse(JSON.stringify({ ...initial(), stage }));
    let verifications = 0;
    let executions = 0;
    assert.throws(() => validateRequest(request), /unsupported stage/);
    const result = await runOneStage(request, {
      verify: async () => { verifications++; return { permission: 'verified' }; },
      execute: async () => { executions++; return { status: 'succeeded' }; }
    });
    assert.equal(result.status, 'rejected');
    assert.match(result.error, /unsupported stage/);
    assert.equal(verifications, 0);
    assert.equal(executions, 0);
  }
});
