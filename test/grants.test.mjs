import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createHash} from 'node:crypto';
import {bodyDigest, canonicalJSON, prepareGrant, signGrant, verifyGrant} from '../src/index.mjs';
import {grantFixture, grantContext} from '../tooling/grant-fixture.mjs';
const copy = v => structuredClone(v);
const keys = () => {
  const k = generateKeyPairSync('ed25519');
  return {privateKey: k.privateKey.export({type: 'pkcs8', format: 'pem'}),
    publicKey: k.publicKey.export({type: 'spki', format: 'pem'})};
};
const owner = keys();
const sign = p => signGrant(p, {keyId: 'owner-1', privateKey: owner.privateKey});
const setup = () => {
  const p = grantFixture(bodyDigest); return {p, g: sign(p), c: grantContext(p, owner.publicKey)};
};
const rejects = (g, c, category) => {
  const result = verifyGrant(g, c); assert.equal(result.ok, false);
  if (category) assert.equal(result.category, category);
  assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false);
};

test('AC1 explicit inert preparation retains two records and readable exact powers', () => {
  const input = grantFixture(bodyDigest);
  const {draft, summary} = prepareGrant(input);
  assert.deepEqual(draft, input); assert.notEqual(draft, input);
  assert.equal(Object.hasOwn(draft, 'signature'), false);
  for (const value of ['DRAFT ONLY', 'I_101', 'I_102', '9007199254740993', 'src', 'deliver', input.authority.hash]) {
    assert.ok(summary.includes(value));
  }
  input.work.push({...copy(input.work[0]), issueId: 'I_103', number: '103'});
  assert.equal(draft.work.length, 2);
  const c = grantContext(draft, owner.publicKey); c.request.issueId = 'I_103';
  rejects(sign(draft), c, 'membership');
  for (const mutate of [p => p.work.push(copy(p.work[0])), p => p.work[0].repository.id = '01',
    p => delete p.policy.ci, p => delete p.policy.runtime, p => p.permissions = [],
    p => p.permissions[0].operations = [], p => p.policy.skills.deliver = {},
    p => p.work[1].repository.name = 'other/core', p => p.privateKey = owner.privateKey,
    p => p.work[1].number = p.work[0].number, p => p.work[1].issueId = p.work[0].issueId]) {
    const p = grantFixture(bodyDigest); mutate(p); assert.throws(() => prepareGrant(p));
  }
});

test('AC2 real serialized signature, trusted keys and all signed categories', () => {
  const {g, c} = setup();
  assert.deepEqual(verifyGrant(JSON.parse(JSON.stringify(g)), c), {ok: true, category: 'authorized'});
  rejects({...g, signature: undefined}, c);
  for (const signature of ['', 'true', 'A'.repeat(86) + '==', g.signature.slice(1)]) rejects({...g, signature}, c);
  rejects({...g, version: 2}, c, 'version'); rejects({...g, algorithm: 'none'}, c, 'version');
  rejects({...g, keyId: 'attacker'}, c, 'trust');
  rejects(g, {...c, trustedKeys: new Map([['owner-1', keys().publicKey]])}, 'signature');
  rejects(g, {...c, trustedKeys: new Map()}, 'trust');
  const mutations = [p => p.recordId += 'x', p => p.revision = '2', p => p.revocationId += 'x',
    p => p.work.reverse(), p => p.work[0].issueId += 'x', p => p.work[0].number = '103',
    p => {p.work[0].scope.body += '!'; p.work[0].scope.hash = bodyDigest(p.work[0].scope.body);},
    p => p.work[0].observation.revision = '2', p => p.work[0].currentBody.revision = '2',
    p => p.work[0].shape = copy(p.work[0].scope), p => p.authority.revision = '2',
    p => p.permissions[0].operations.push('merge'), p => p.permissions[0].paths.push('docs'),
    p => p.expiresAt++, p => p.validFrom--, p => p.policy.core += 'x', p => p.policy.runtime += 'x',
    p => p.policy.agent += 'x', p => p.policy.skills.deliver.mode = 'override',
    p => p.policy.skills.deliver.instructions.revision = '2', p => p.policy.ci.requiredChecks.push('test'),
    p => p.policy.ci.trustedAppIds.push('42'), p => p.policy.ci.workflow.revision = '2',
    p => p.policy.merge.method = 'squash', p => p.policy.maxParallel++];
  for (const mutate of mutations) {
    const tampered = copy(g); mutate(tampered.payload); rejects(tampered, c, 'signature');
  }
  assert.throws(() => signGrant(g.payload, {keyId: 'owner-1', privateKey: keys().publicKey}), /signing-key/);
  const unknown = copy(g); unknown.payload.version = 2; rejects(unknown, c, 'version');
  const rsa = generateKeyPairSync('rsa', {modulusLength: 2048});
  rejects(g, {...c, trustedKeys: new Map([['owner-1', rsa.publicKey.export({type: 'spki', format: 'pem'})]])}, 'trust');
  assert.throws(() => signGrant(g.payload, {keyId: 'owner-1', privateKey: rsa.privateKey.export({type: 'pkcs8', format: 'pem'})}), /signing-key/);
});

test('AC3 original Scope, published Shape and source survive independently; pinned digest', () => {
  assert.equal(bodyDigest('Hello\n世界'), 'e25356b0e259cd559cbbe5495f10b8eb613890dd47e20afbb9d2a105c3531bf7');
  assert.notEqual(bodyDigest('Hello\n世界'), createHash('sha256').update('Hello\n世界').digest('hex'));
  const {p} = setup(); const original = copy(p.work[0].scope);
  const shape = {source: 'fixture:shape-publication', revision: '2', body: 'Published Shape\n形狀', hash: bodyDigest('Published Shape\n形狀')};
  p.work[0].shape = shape; p.work[0].currentBody = copy(shape);
  const g = JSON.parse(JSON.stringify(sign(p))); const c = grantContext(p, owner.publicKey);
  assert.equal(verifyGrant(g, c).ok, true);
  assert.deepEqual(g.payload.work[0].scope, original);
  assert.deepEqual(g.payload.work[0].shape, shape);
  for (const mutate of [x => x.expectedAuthority.revision = '3',
    x => {x.expectedAuthority.body += '!'; x.expectedAuthority.hash = bodyDigest(x.expectedAuthority.body);},
    x => x.expectedWork[0].scope.body += '!', x => x.expectedPolicy.runtime += 'x',
    x => x.expectedPolicy.skills.deliver.instructions.hash = 'bad', x => x.expectedPolicy.ci.workflow.revision = '3']) {
    const changed = copy(c); mutate(changed); rejects(g, changed);
  }
  const broken = copy(p); broken.work[0].scope.hash = 'bad'; assert.throws(() => sign(broken), /snapshot/);
});

test('AC4 injected validity boundaries, explicit current revocation and exact membership', () => {
  const {p, g, c} = setup();
  for (const now of [1000, 1999]) assert.equal(verifyGrant(g, {...c, now}).ok, true);
  for (const now of [999, 2000, 2001, undefined, NaN]) rejects(g, {...c, now}, 'time');
  for (const revocation of [undefined, {}, {id: p.revocationId, available: false, revokedRecords: []},
    {id: 'other', available: true, revokedRecords: []}, {id: p.revocationId, available: true, revokedRecords: [p.recordId]},
    {id: p.revocationId, available: true, revokedRecords: [true]}]) rejects(g, {...c, revocation}, 'revocation');
  for (const mutate of [r => r.issueId = 'I_103', r => r.number = '103', r => r.repository.id = '42']) {
    const changed = copy(c); mutate(changed.request); rejects(g, changed, 'membership');
  }
  rejects(g, {...c, revocation: {id: p.revocationId, available: true, revokedRecords: [, 'other']}});
  const expanded = copy(c); expanded.expectedWork.push({...copy(p.work[0]), issueId: 'I_103', number: '103'});
  rejects(g, expanded, 'work');
});

test('AC5 least authority, public owner equivalence and non-secret diagnostics', () => {
  const {g, c} = setup();
  for (const path of ['src', 'src/a/b.mjs']) assert.equal(verifyGrant(g, {...c, request: {...c.request, path}}).ok, true);
  for (const path of ['src-other/file', 'docs/file', '/src/a', '../src/a', 'src/../a', 'src\\a', 'C:/src/a', 'src//a', 'src/./a']) {
    rejects(g, {...c, request: {...c.request, path}}, 'path');
  }
  rejects(g, {...c, request: {...c.request, operation: 'merge', label: 'scope', assignee: 'owner', runner: 'online', autoRegister: true}}, 'operation');
  rejects(g, {...c, request: {...c.request, repository: {...c.request.repository, name: 'other/repo'}}}, 'membership');
  for (const name of ['personal/core', 'example-org/core']) {
    const p = grantFixture(bodyDigest);
    p.work.forEach(w => w.repository.name = name); p.permissions[0].repository.name = name;
    assert.equal(verifyGrant(sign(p), grantContext(p, owner.publicKey)).ok, true);
  }
  const privateTarget = grantFixture(bodyDigest); privateTarget.work[0].repository.visibility = 'private';
  assert.throws(() => prepareGrant(privateTarget), /visibility/);
  for (const mutate of [p => p.permissions[0].paths.push('*'), p => p.permissions[0].paths.push('src/../secret'),
    p => p.permissions[0].operations.push('*'), p => p.policy.maxParallel = 0,
    p => delete p.policy.merge.protected]) {
    const p = grantFixture(bodyDigest); mutate(p); assert.throws(() => sign(p));
  }
  rejects(g, {...c, request: {...c.request, repository: {...c.request.repository, visibility: 'private'}}}, 'visibility');
});

test('deterministic representation rejects ambiguous and unsupported JSON', () => {
  assert.equal(canonicalJSON({b: 2, a: [true, null]}), '{"a":[true,null],"b":2}');
  const cyclic = {}; cyclic.self = cyclic;
  for (const v of [undefined, NaN, Infinity, -0, 1n, () => {}, new Date(), cyclic, new (class extends Array {})(1),
    {x: undefined}, {x: Symbol()}, [, 1], Object.assign([], {extra: true}),
    Object.defineProperty([1], '0', {get() {throw Error('must not run');}}), Object.defineProperty({}, 'secret', {value: 1}),
    Object.defineProperty({}, 'getter', {enumerable: true, get() {throw Error('must not run');}})]) {
    assert.throws(() => canonicalJSON(v));
  }
  const p = grantFixture(bodyDigest); const sorted = JSON.parse(canonicalJSON(p));
  assert.equal(sign(p).signature, sign(sorted).signature);
});
