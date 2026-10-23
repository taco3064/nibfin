import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, createPublicKey } from 'node:crypto';
import { registrationFixture } from './fixtures/registration-exchange.mjs';
import { memberKeys, ownerKeys, publicText, openResponse } from '../experiments/registration-exchange.mjs';
const decrypt = (f, response, request = f.request, key = f.member.privateKey, owner = f.owner.publicKey) =>
  openResponse(response, request, key, owner, f.now());
test('encrypted exchange binds recipient, context, expiry and authenticated sender', async () => {
  const f = registrationFixture(), result = await f.host.exchange(f.request);
  assert.equal(result.status, 'encrypted'); assert.equal(f.calls(), 1); assert.equal(f.reads(), 2);
  const payload = decrypt(f, result.response);
  assert.equal(payload.token, f.token); assert.equal(payload.context.repositoryId, '2001');
  assert.equal(payload.context.userId, '1001'); assert.equal(payload.expires, 3700000);
  assert(!JSON.stringify(result).includes(f.token)); assert(!JSON.stringify(result).includes('PRIVATE KEY'));
  assert.throws(() => decrypt(f, result.response, f.request, memberKeys().privateKey));
  assert.throws(() => decrypt(f, result.response, f.request, f.member.privateKey, ownerKeys().publicKey));
  for (const change of [{ repositoryId: 'other' }, { id: 'other' }, { publicKey: publicText(memberKeys().publicKey) }]) {
    assert.throws(() => decrypt(f, result.response, { ...f.request, ...change }));
  }
  for (const field of ['ciphertext', 'tag']) {
    const response = structuredClone(result.response);
    const bytes = Buffer.from(response[field], 'base64'); bytes[0] ^= 1; response[field] = bytes.toString('base64');
    assert.throws(() => decrypt(f, response));
    // Re-sign to exercise AEAD rejection separately from signature verification.
    const { signature, ...envelope } = response;
    response.signature = sign(null, Buffer.from(JSON.stringify(envelope)), f.owner.privateKey).toString('base64');
    assert.throws(() => decrypt(f, response));
  }
  f.setTime(payload.expires); assert.throws(() => decrypt(f, result.response));
});
const denials = [
  ['disabled policy', 'policy', false], ...['read', 'triage', 'none'].map(p => [p, 'permission', p]),
  ['user mismatch', 'userId', 'fake'], ['repository mismatch', 'repositoryId', 'fake'],
  ['forged actor', 'actorId', 'fake'], ['unavailable identity', 'identityStatus', null],
  ['identity 401', 'identityStatus', 401], ['identity 403', 'identityStatus', 403],
  ['unavailable permission', 'permissionStatus', null], ['permission 401', 'permissionStatus', 401],
  ['permission 403', 'permissionStatus', 403], ['unavailable lookup', 'status', null],
  ['untrusted workflow', 'workflow', 'other'], ['untrusted ref', 'revision', 'member-ref'],
  ['untrusted source', 'source', 'member'], ['wrong run', 'runId', 'other'], ['wrong attempt', 'attempt', 2]
];
for (const [name, field, value] of denials) test(`reject ${name} before issuance`, async () => {
  const f = registrationFixture(); f.observation[field] = value;
  assert.equal((await f.host.exchange(f.request)).status, 'rejected'); assert.equal(f.calls(), 0);
});
for (const [name, change] of [
  ['organization', { scope: 'organization' }], ['claimed identity', { userId: 'fake' }],
  ['malformed key', { publicKey: 'bad' }], ['wrong key type', { publicKey: publicText(ownerKeys().publicKey) }],
  ['substituted key', { publicKey: publicText(memberKeys().publicKey) }],
  ['expired', { deadline: 100000 }], ['future', { created: 106000 }],
  ['invalid timestamp', { created: '100000' }], ['unbounded deadline', { deadline: 200000 }]
]) test(`reject ${name} input`, async () => {
  const f = registrationFixture(); Object.assign(f.request, change);
  assert.equal((await f.host.exchange(f.request)).status, 'rejected'); assert.equal(f.calls(), 0);
});
for (const change of [{ policy: false }, { permission: 'read' }]) test('issuance-time revalidation observes changed eligibility', async () => {
  const f = registrationFixture(); f.beforeRead = read => { if (read === 2) Object.assign(f.observation, change); };
  assert.equal((await f.host.exchange(f.request)).status, 'rejected'); assert.equal(f.calls(), 0);
});
test('concurrent duplicate, ID and nonce replay across bindings mint at most once', async () => {
  const f = registrationFixture();
  const results = await Promise.all([f.host.exchange(f.request), f.host.exchange(f.request)]);
  assert.equal(results.filter(r => r.status === 'encrypted').length, 1); assert.equal(f.calls(), 1);
  for (const change of [{ nonce: 'new' }, { id: 'new' }, { userId: 'other' }, { repositoryId: 'other' }]) {
    assert.equal((await f.host.exchange({ ...f.request, ...change })).status, 'rejected');
  }
  assert.equal(f.calls(), 1);
});
test('clock skew boundary and expiry during revalidation', async () => {
  const f = registrationFixture(); f.request.created += 5000; f.bind();
  assert.equal((await f.host.exchange(f.request)).status, 'encrypted');
  const g = registrationFixture(); g.beforeRead = n => { if (n === 2) g.setTime(g.request.deadline); };
  assert.equal((await g.host.exchange(g.request)).status, 'rejected'); assert.equal(g.calls(), 0);
});
test('lost response remains unknown, reconciles only confirmed expiry, never retries', async () => {
  const f = registrationFixture(); f.issuer = async () => { throw new Error('Synthetic private provider detail'); };
  assert.deepEqual(await f.host.exchange(f.request), { status: 'unknown' });
  assert.equal((await f.host.exchange(f.request)).status, 'rejected'); assert.equal(f.calls(), 1);
  assert.throws(() => f.host.reconcile(f.request.id, { verified: true, outcome: 'expired', expires: 3700000 }));
  f.setTime(3700000); f.host.reconcile(f.request.id, { verified: true, outcome: 'expired', expires: 3700000 });
  assert.equal(f.host.state(f.request.id), 'expired');
  assert.equal((await f.host.exchange(f.request)).status, 'rejected'); assert.equal(f.calls(), 1);
});
test('pre-cancellation, in-flight cancellation and late response cannot return usable results', async () => {
  const f = registrationFixture(), pre = new AbortController(); pre.abort();
  assert.equal((await f.host.exchange(f.request, pre.signal)).status, 'rejected'); assert.equal(f.calls(), 0);
  const g = registrationFixture(), controller = new AbortController();
  g.issuer = async () => { controller.abort(); return { token: g.token, expires: 3700000 }; };
  assert.equal((await g.host.exchange(g.request, controller.signal)).status, 'unknown'); assert.equal(g.calls(), 1);
  const h = registrationFixture(); h.issuer = async () => { h.setTime(h.request.deadline); return { token: h.token, expires: 3700000 }; };
  assert.equal((await h.host.exchange(h.request)).status, 'unknown');
});
test('hung issuance has a bounded timeout and blocks retry', async () => {
  const f = registrationFixture(); f.request.deadline = f.now() + 15; f.bind();
  f.issuer = () => new Promise(() => {});
  assert.equal((await f.host.exchange(f.request)).status, 'unknown');
  assert.equal((await f.host.exchange(f.request)).status, 'rejected'); assert.equal(f.calls(), 1);
});

test('low-order X25519 key is rejected before issuance', async () => {
  const f = registrationFixture();
  const der = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.alloc(32)]);
  f.request.publicKey = publicText(createPublicKey({ key: der, format: 'der', type: 'spki' }));
  f.bind();
  assert.equal((await f.host.exchange(f.request)).status, 'rejected'); assert.equal(f.calls(), 0);
});
test('unavailable trusted observation fails closed without issuance', async () => {
  const f = registrationFixture(); f.beforeRead = () => { throw new Error('Private lookup detail'); };
  assert.deepEqual(await f.host.exchange(f.request), { status: 'rejected' }); assert.equal(f.calls(), 0);
});

test('hanging identity lookup times out before issuance', async () => {
  const f = registrationFixture(); f.request.deadline = f.now() + 15; f.bind();
  f.beforeRead = () => new Promise(() => {});
  assert.deepEqual(await f.host.exchange(f.request), { status: 'rejected' }); assert.equal(f.calls(), 0);
});
