import { fixtureAuthorization } from './fixtures/authority.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { invoke, digest, captureSnapshot, validateReference, validateSnapshot } from '../src/index.mjs';
import { initial, snapshot, requirementAdapters } from './fixtures/request.mjs';
function setup() {
  const requirements = requirementAdapters();
  const request = initial();
  let calls = 0;
  const adapters = { authorization: fixtureAuthorization(request).host, requirements, verify: async () => ({ permission: 'verified' }),
    execute: async () => { calls++; return { status: 'succeeded' }; } };
  return { request, requirements, adapters, calls: () => calls };
}
test('canonical references distinguish sources and protect exact content', () => {
  const a = snapshot('a', 'A', ' x\n');
  assert.equal(a.reference.contentDigest, digest(' x\n'));
  assert.notEqual(a.reference.snapshotId, snapshot('b', 'A', ' x\n').reference.snapshotId);
  assert.deepEqual(validateSnapshot(a), a);
  assert.throws(() => validateSnapshot({ ...a, content: 'x\n' }));
  for (const change of [{ revision: '' }, { contentDigest: 'bad' }, { snapshotId: '' },
    { source: { kind: 'url', id: 'a' } }, { source: { kind: 'notion', id: '' } }, { revision: 'B' }]) {
    assert.throws(() => validateReference({ ...a.reference, ...change }));
  }
});
test('synthetic Notion capture is immutable, unapproved and executable only after independent approval', async () => {
  const x = setup();
  const records = new Map();
  const storage = { get: async id => records.get(id), putIfAbsent: async (id, s) => {
    if (!records.has(id)) records.set(id, s);
  } };
  for (const context of ['productSecurity', 'delivery']) {
    const s = await captureSnapshot(x.requirements[context], storage);
    assert.deepEqual(s.reference, x.request.requirements[context]);
  }
  x.requirements.storage = storage;
  x.requirements.verifyApproval = async () => false;
  assert.equal((await invoke(x.request, x.adapters)).status, 'blocked');
  const approvals = [];
  x.requirements.verifyApproval = async binding => { approvals.push(binding); return true; };
  const result = await invoke(x.request, x.adapters);
  assert.equal(result.status, 'succeeded');
  assert.equal(x.calls(), 1);
  assert.deepEqual(result.requirements, x.request.requirements);
  assert.deepEqual(approvals.map(a => a.context), ['productSecurity', 'delivery']);
  assert.deepEqual(approvals[1].authority, x.request.authority);
  assert.deepEqual(approvals[1].repository, x.request.repository);
  assert.deepEqual(approvals[1].issue, x.request.issue);
  const id = result.requirements.delivery.snapshotId;
  records.get(id).content = 'altered';
  await assert.rejects(captureSnapshot(x.requirements.delivery, storage));
});
const observations = [
  ['wrong page', o => ({ ...o, source: { ...o.source, id: 'wrong' } })],
  ['incomplete', o => ({ ...o, complete: false })],
  ['required block inaccessible', o => ({ ...o, unavailable: ['private block'] })],
  ['revision race', o => ({ ...o, endRevision: 'B' })],
  ['new revision', o => ({ ...o, revision: 'B', endRevision: 'B' })],
  ['changed content', o => ({ ...o, content: 'changed' })],
  ['missing revision', o => ({ ...o, revision: undefined })],
  ['unreadable', () => { throw Error('secret provider body and token'); }]
];
for (const [name, change] of observations) test(`Notion ${name} blocks capture and invoke without execution or retry`, async () => {
  const x = setup();
  const original = x.requirements.delivery.read;
  let reads = 0;
  x.requirements.delivery.read = async () => { reads++; return change(await original()); };
  await assert.rejects(captureSnapshot(x.requirements.delivery, { putIfAbsent: async () => assert.fail('write') }));
  reads = 0;
  const result = await invoke(x.request, x.adapters);
  assert.equal(result.status, 'blocked');
  assert.equal(reads, 1);
  assert.equal(x.calls(), 0);
  assert(!JSON.stringify(result).includes('secret'));
  assert(!JSON.stringify(result).includes('Synthetic requirements'));
});
test('missing, substituted and self-asserted evidence never bypasses verification', async () => {
  for (const mutate of [
    x => { delete x.adapters.requirements; },
    x => { delete x.request.requirements; },
    x => { delete x.request.requirements.delivery; },
    x => { x.request.requirements.delivery = x.request.requirements.productSecurity; },
    x => { x.request.requirements.productSecurity = x.request.requirements.delivery; },
    x => { x.request.verified = true; },
    x => { x.requirements.verifyApproval = async () => ({ approved: true }); },
    x => { x.requirements.verifyApproval = async () => { throw Error('secret'); }; },
    x => { x.requirements.storage.get = async () => ({ ...snapshot('external-project'), content: 'altered' }); },
    x => { delete x.requirements.delivery; }
  ]) {
    const x = setup(); mutate(x);
    assert.notEqual((await invoke(x.request, x.adapters)).status, 'succeeded');
    assert.equal(x.calls(), 0);
  }
});
test('A history remains identifiable; B requires matching renewed approval and cannot reuse A predecessor', async () => {
  const x = setup();
  const a = await invoke(x.request, x.adapters);
  const b = snapshot('external-project', 'B', 'New synthetic content');
  x.requirements.delivery.read = async () => ({ source: b.reference.source, revision: 'B', endRevision: 'B',
    content: b.content, complete: true, unavailable: [] });
  assert.equal((await invoke(x.request, x.adapters)).status, 'blocked');
  const oldGet = x.requirements.storage.get;
  x.requirements.storage.get = async id => id === b.reference.snapshotId ? b : oldGet(id);
  x.request.requirements.delivery = b.reference;
  x.requirements.verifyApproval = async approval => approval.reference.revision === 'A';
  assert.equal((await invoke(x.request, x.adapters)).status, 'blocked');
  x.requirements.verifyApproval = async () => true;
  const renewed = fixtureAuthorization(x.request); x.request.authority = renewed.authority; x.adapters.authorization = renewed.host;
  const result = await invoke(x.request, x.adapters);
  assert.equal(result.status, 'succeeded');
  assert.equal(a.requirements.delivery.revision, 'A');
  assert.equal(result.requirements.delivery.revision, 'B');
  x.request.requestId = 'next'; x.request.stage = 'shape-validator';
  x.request.previous = { resultId: a.resultId, digest: digest(a), stage: a.stage, requestId: a.requestId,
    repositoryId: a.repository.id, issueId: a.issue.id, source: a.source };
  x.adapters.verify = async () => ({ permission: 'verified', previousAuthenticity: 'verified', previousResult: a });
  const before = x.calls();
  assert.equal((await invoke(x.request, x.adapters)).status, 'blocked');
  assert.equal(x.calls(), before);
});
test('adapter mutation cannot alter execution or recorded approval inputs', async () => {
  const x = setup();
  const original = structuredClone(x.request);
  x.adapters.verify = async r => { r.requirements.delivery.revision = 'evil'; return { permission: 'verified' }; };
  x.requirements.verifyApproval = async a => { a.reference.revision = 'evil'; a.authority.grantId = 'evil'; return true; };
  x.adapters.execute = async r => { assert.deepEqual(r, original); r.requirements.delivery.revision = 'evil'; return { status: 'succeeded' }; };
  const result = await invoke(x.request, x.adapters);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.requirements, original.requirements);
  assert.deepEqual(x.request, original);
});
test('successor stages require fresh source, snapshot and approval evidence despite authentic predecessors', async () => {
  for (const stage of ['shape-validator', 'deliver', 'accept']) {
    for (const failure of ['reader', 'snapshot', 'approval', 'exception', 'missing']) {
      const x = setup();
      const priorStage = { 'shape-validator': 'shape', deliver: 'shape-validator', accept: 'deliver' }[stage];
      const prior = { ...initial(), resultId: 'prior', stage: priorStage, status: 'succeeded',
        shapeDigest: 'a'.repeat(64), candidateDigest: 'a'.repeat(64) };
      x.request = { ...x.request, stage, requestId: 'successor', shapeDigest: prior.shapeDigest,
        candidateDigest: prior.candidateDigest, previous: { resultId: prior.resultId, digest: digest(prior),
          stage: priorStage, requestId: prior.requestId, repositoryId: prior.repository.id,
          issueId: prior.issue.id, source: prior.source } };
      x.adapters.verify = async () => ({ permission: 'verified', previousAuthenticity: 'verified', previousResult: prior });
      if (failure === 'reader') x.requirements.delivery.read = async () => { throw Error('private'); };
      if (failure === 'snapshot') x.requirements.storage.get = async () => ({ ...snapshot('external-project'), content: 'altered' });
      if (failure === 'approval') x.requirements.verifyApproval = async () => false;
      if (failure === 'exception') x.requirements.verifyApproval = async () => { throw Error('private'); };
      if (failure === 'missing') delete x.adapters.requirements;
      assert.equal((await invoke(x.request, x.adapters)).status, 'blocked');
      assert.equal(x.calls(), 0);
    }
  }
});
