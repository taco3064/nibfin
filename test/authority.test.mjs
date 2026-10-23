import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { digest, prepareGrant, signGrant, verifyGrant, authorizeOperation, invoke, invokeProtected,
  grantDraftDigest, serializeGrant, validateGrant } from '../src/index.mjs';
import { initial, requirementAdapters } from './fixtures/request.mjs';
import { fixture, roleResult } from './fixtures/protected.mjs';
import { payloadFor, signedFixture, authorityOf, contextFor, hostFor, clock } from './fixtures/authority.mjs';
const clone = structuredClone;
function setup() {
  const p = payloadFor(initial()), grant = signedFixture(p), host = hostFor(grant);
  return { p, grant, host, authority: authorityOf(grant), context: contextFor(grant) };
}
function draft(p) { return { payload: p, draftDigest: grantDraftDigest(p), unauthorized: [], summary: 'Unsigned fixture' }; }
function repairSetup() {
  const x = setup(), p = clone(x.p);
  p.grantId = 'repair-grant'; p.recordId = 'repair-record'; p.revocationId = 'repair-revocation';
  p.repair = { incidentId: 'incident-1', repositoryId: p.members[0].repository.id, issueId: p.members[0].issue.id,
    environment: 'production', version: 'release-1', commit: 'a'.repeat(40), deliveryCycle: 'delivery-2',
    repairCycle: 'repair-1', originalAuthority: x.authority };
  p.members[0].operations.push('reopen', 'recovery-comment', 'repair');
  const grant = signedFixture(p);
  return { ...x, p, grant, host: hostFor(grant, [x.grant]), authority: authorityOf(grant), context: contextFor(grant, 'deliver') };
}
test('AC1: deterministic read-only bounded multi-repository draft with approved snapshots', async () => {
  const x = setup(), body = 'Original Scope\n'; x.p.members[0].scopeDigest = digest(body);
  const m = clone(x.p.members[0]); m.repository = { id: '200', name: 'example/second' };
  m.issue = { id: 'issue-3', number: 3, repositoryId: '200' }; m.dependencies = ['issue-2'];
  x.p.members.push(m);
  const observed = x.p.members.map(m => ({ repository: m.repository, issue: m.issue, originalBody: body,
    dependencies: m.dependencies, requirements: m.requirements }));
  let reads = 0;
  const host = { readPolicy: async () => ({ policy: x.p.policy, execution: x.p.execution, maxParallel: 2 }), requirements: requirementAdapters(), readWorkSet: async selection => {
    reads++; selection[0].repository.id = 'mutation'; return { complete: true, members: observed };
  } };
  for (const name of ['execute', 'signingKey', 'write', 'mutate']) Object.defineProperty(host, name, { get() { assert.fail('Preparation accessed privileged capability'); } });
  const a = await prepareGrant(x.p, host), b = await prepareGrant(x.p, host);
  assert.deepEqual(a, b); assert.equal(reads, 2); assert.equal(a.payload.members.length, 2);
  assert(a.summary.includes('Unsigned')); assert(a.summary.includes('maxParallel')); assert(a.summary.includes(x.p.expiresAt));
  assert.equal(a.payload.members[0].scopeDigest, digest(body));
  assert.notEqual(digest(body), createHash('sha256').update(body).digest('hex'));
  const extra = clone(observed[0]); extra.issue = { ...extra.issue, id: 'extra', number: 88 };
  observed.push(extra);
  const discovered = await prepareGrant(x.p, host);
  assert.deepEqual(discovered.payload, a.payload); assert.deepEqual(discovered.unauthorized, ['extra']);
  assert.equal(discovered.draftDigest, a.draftDigest);
  assert.equal(x.p.members[0].repository.id, '100');
  for (const change of [o => { o.complete = false; }, o => { o.members.pop(); o.members.pop(); },
    o => { o.members[0].repository.id = ''; }, o => { o.members[0].originalBody += '!'; },
    o => { o.members[0].requirements.delivery = o.members[0].requirements.productSecurity; },
    o => { o.members[0].dependencies.push('unknown'); }]) {
    const o = clone({ complete: true, members: observed }); change(o);
    await assert.rejects(prepareGrant(x.p, { ...host, readWorkSet: async () => o }));
  }
  for (const readPolicy of [undefined, async () => null, async () => ({ policy: {}, execution: x.p.execution, maxParallel: 2 }),
    async () => ({ policy: x.p.policy, execution: x.p.execution, maxParallel: 1 })]) {
    await assert.rejects(prepareGrant(x.p, { ...host, readPolicy }));
  }
  host.requirements.verifyApproval = async () => false;
  await assert.rejects(prepareGrant(x.p, host));
  host.readWorkSet = async () => { throw Error('private-provider-secret'); };
  await assert.rejects(prepareGrant(x.p, host), e => !e.message.includes('private-provider-secret'));
});
test('AC2: exact explicit approval and public signing API with ephemeral asymmetric keys', async () => {
  const x = setup(), d = draft(x.p);
  const grant = await signGrant(d, x.host), a = authorityOf(grant);
  assert.deepEqual(await verifyGrant(grant, x.host, a), grant);
  assert.deepEqual(Object.keys(grant), ['payload', 'approvalId', 'signature']);
  await assert.rejects(verifyGrant(d, x.host, a));
  for (const change of [a => { a.approved = false; }, a => { a.draftDigest = 'b'.repeat(64); },
    a => { a.ownerKeyId = 'other'; }, a => { delete a.approvalId; }, a => { a.grantId = 'other'; }]) {
    const host = { ...x.host, readApproval: async e => { const a = { ...e, approved: true, approvalId: 'approval' }; change(a); return a; } };
    await assert.rejects(signGrant(d, host));
  }
  const mutated = clone(d); mutated.payload.maxParallel++;
  await assert.rejects(signGrant(mutated, x.host));
  const originalDraft = draft(clone(x.p));
  const approvedDigest = originalDraft.draftDigest;
  const signed = await signGrant(originalDraft, { ...x.host, readApproval: async expected => {
    originalDraft.payload.maxParallel = 99;
    return { ...expected, approved: true, approvalId: 'mutation-proof' };
  } });
  assert.equal(grantDraftDigest(signed.payload), approvedDigest);
  assert.equal(signed.payload.maxParallel, x.p.maxParallel);
  const alien = generateKeyPairSync('ed25519');
  await assert.rejects(signGrant(d, { ...x.host, signingKey: async () => alien.privateKey }));
  await assert.rejects(signGrant(d, { ...x.host, readApproval: undefined }));
  for (const change of [g => { g.signature = 'A'.repeat(86); }, g => { g.payload.maxParallel++; },
    g => { g.publicKey = alien.publicKey.export({ type: 'spki', format: 'pem' }); }, g => { g.approvalId = 'another'; }]) {
    const bad = clone(grant); change(bad);
    await assert.rejects(verifyGrant(bad, x.host, authorityOf(bad)));
  }
  await assert.rejects(verifyGrant(grant, { ...x.host, ownerKey: async () => alien.publicKey }, a));
  await assert.rejects(signGrant(d, { ...x.host, signingKey: async () => { throw Error('PRIVATE KEY provider response'); } }),
    e => !e.message.includes('PRIVATE KEY'));
});
const mismatches = [
  ['repository name', c => { c.repository.name = 'other/project'; }],
  ['repository ID', c => { c.repository.id = 'other'; c.issue.repositoryId = 'other'; }],
  ['extra Issue', c => { c.issue.id = 'extra'; }], ['Issue number', c => { c.issue.number++; }],
  ['Scope', c => { c.scopeDigest = 'b'.repeat(64); }], ['native edges', c => { c.dependencies = ['new-edge']; }],
  ...['productSecurity', 'delivery'].map(k => [`requirements ${k}`, c => { c.requirements[k] = c.requirements[k === 'delivery' ? 'productSecurity' : 'delivery']; }]),
  ['operation', c => { c.operation = 'merge'; }], ['path sibling', c => { c.paths = ['src-other/file']; }],
  ...['/src/file', '../src/file', 'src/../file', 'src//file', 'C:/file', 'src\\file', 'src/%2e%2e/file', 'src/'].map(p => [p, c => { c.paths = [p]; }]),
  ['CI policy', c => { c.policy.ci.requiredChecks.push('other'); }], ['merge policy', c => { c.policy.merge.baseBranch = 'other'; }],
  ...['core', 'runtime', 'agent'].map(k => [`execution ${k}`, c => { c.execution[k] = 'b'.repeat(64); }]),
  ...['shape', 'deliver', 'accept'].flatMap(k => [
    [`Skill ${k}`, c => { c.execution.skills[k].version = 'b'.repeat(64); }],
    [`customization ${k}`, c => { c.execution.skills[k].customization.contentDigest = 'b'.repeat(64); }]]),
  ['concurrency', c => { c.maxParallel = 3; }], ['zero concurrency', c => { c.maxParallel = 0; }],
  ['unsupported context', c => { c.authorized = true; }], ['missing context', c => { delete c.policy; }]
];
for (const [name, change] of mismatches) test(`AC3: deny independently changed ${name}`, async () => {
  const x = setup(); await authorizeOperation(x.grant, x.context, x.host, x.authority);
  change(x.context); await assert.rejects(authorizeOperation(x.grant, x.context, x.host, x.authority));
});
test('AC3: payload versions, identities, duplicate/unsupported/missing bounds and unambiguous encoding', async () => {
  const x = setup();
  for (const change of [p => { p.schemaVersion = 2; }, p => { p.members.push(clone(p.members[0])); },
    p => { p.members[0].operations.push('*'); }, p => { delete p.execution; }, p => { p.unknown = true; },
    p => { p.execution.skills.owner = p.execution.skills.shape; }, p => { p.maxParallel = -1; },
    p => { p.members[0].paths = ['.']; }, p => { p.validFrom = '2026-10-23'; }]) {
    const p = clone(x.p); change(p); assert.throws(() => validateGrant(p));
  }
  for (const change of [p => { p.grantId += '-other'; }, p => { p.recordId += '-other'; },
    p => { p.ownerKeyId += '-other'; }, p => { p.revocationId += '-other'; }, p => { p.members.pop(); },
    p => { p.members[0].scopeDigest = 'b'.repeat(64); }, p => { p.policy.merge.method = 'squash'; },
    p => { p.members[0].operations.push('merge'); }, p => { p.members[0].paths.push('extra'); }]) {
    const g = clone(x.grant); change(g.payload);
    await assert.rejects(verifyGrant(g, x.host, authorityOf(g)));
  }
  const p = Object.fromEntries(Object.entries(x.p).reverse()); assert.equal(serializeGrant(p), serializeGrant(x.p));
  assert.equal(grantDraftDigest(p), grantDraftDigest(x.p));
  for (const a of [{ ...x.authority, grantId: 'another' }, { ...x.authority, digest: 'b'.repeat(64) }]) {
    await assert.rejects(verifyGrant(x.grant, x.host, a));
  }
  const c = clone(x.context); c.paths = ['src/module.mjs', 'docs']; c.maxParallel = 1;
  await authorizeOperation(x.grant, c, x.host, x.authority);
});
test('AC4: validity boundary and fresh exact revocation lookup on every operation', async () => {
  const x = setup(); let now = clock, reads = 0, revoked = false;
  x.host.now = () => now;
  x.host.revocation = async e => { reads++; return { ...e, revoked }; };
  await authorizeOperation(x.grant, x.context, x.host, x.authority);
  revoked = true; await assert.rejects(authorizeOperation(x.grant, x.context, x.host, x.authority));
  assert.equal(reads, 2); revoked = false;
  for (const instant of [Date.parse(x.p.validFrom) - 1, Date.parse(x.p.expiresAt)]) {
    now = instant; await assert.rejects(verifyGrant(x.grant, x.host, x.authority));
  }
  now = Date.parse(x.p.validFrom); await verifyGrant(x.grant, x.host, x.authority);
  for (const revocation of [async () => null, async e => ({ ...e, revoked: false, cached: true }),
    async e => ({ ...e, authority: { ...e.authority, grantId: 'other' }, revoked: false }),
    async () => { throw Error('secret'); }]) await assert.rejects(verifyGrant(x.grant, { ...x.host, revocation }, x.authority));
});
test('AC5/7: real invoke authentication, separate Scope/Shape, all existing gates and mutation isolation', async () => {
  const request = initial(), x = setup(); let calls = 0;
  const adapters = { authorization: x.host, requirements: requirementAdapters(), verify: async () => ({ permission: 'verified' }),
    execute: async () => { calls++; return { status: 'succeeded' }; } };
  assert.equal((await invoke(request, adapters)).status, 'succeeded'); assert.equal(calls, 1);
  for (const change of [a => { delete a.authorization; }, a => { a.authorization.resolve = async () => null; },
    a => { a.authorization.resolve = async () => ({ ...x.grant, signature: 'A'.repeat(86) }); },
    a => { a.authorization.observe = async () => ({ ...x.context, paths: ['outside'] }); },
    a => { a.verify = async () => ({ permission: 'denied' }); }, a => { delete a.requirements; }]) {
    const a = { ...adapters, authorization: { ...x.host } }; change(a); const before = calls;
    assert.equal((await invoke(request, a)).status, 'blocked'); assert.equal(calls, before);
  }
  for (const v of [1, 2, 3]) assert.equal((await invoke({ ...request, schemaVersion: v }, adapters)).status, 'rejected');
  for (const shapeDigest of ['b'.repeat(64), 'c'.repeat(64)]) {
    const prior = { ...request, stage: 'shape-validator', shapeDigest, resultId: 'previous-result', status: 'succeeded' };
    const r = { ...request, stage: 'deliver', shapeDigest, requestId: 'next', previous: { resultId: prior.resultId,
      digest: digest(prior), stage: prior.stage, requestId: prior.requestId, repositoryId: prior.repository.id, issueId: prior.issue.id, source: prior.source } };
    adapters.verify = async () => ({ permission: 'verified', previousAuthenticity: 'verified', previousResult: prior });
    assert.equal((await invoke(r, adapters)).status, 'succeeded');
    prior.shapeDigest = 'd'.repeat(64); r.previous.digest = digest(prior);
    assert.equal((await invoke(r, adapters)).status, 'blocked');
    r.scopeDigest = shapeDigest; assert.equal((await invoke(r, adapters)).status, 'blocked');
  }
  adapters.verify = async r => { r.scopeDigest = 'bad'; return { permission: 'verified' }; };
  const observe = x.host.observe;
  x.host.observe = async r => { r.repository.id = 'evil'; return observe(request); };
  x.host.revocation = async e => { e.authority.grantId = 'evil'; return { authority: x.authority, revocationId: x.p.revocationId, revoked: false }; };
  adapters.execute = async r => { assert.deepEqual(r, request); return { status: 'succeeded' }; };
  assert.equal((await invoke(request, adapters)).status, 'succeeded');
});
test('AC6: bounded fresh repair and every incident dimension, including original work-set lineage', async () => {
  const x = repairSetup(); await authorizeOperation(x.grant, x.context, x.host, x.authority);
  for (const k of Object.keys(x.p.repair)) {
    const c = clone(x.context); c.repair[k] = k === 'originalAuthority' ? { grantId: 'other', digest: 'b'.repeat(64) } : 'other';
    await assert.rejects(authorizeOperation(x.grant, c, x.host, x.authority));
  }
  for (const operation of ['reopen', 'recovery-comment', 'handoff', 'verify-deployment']) {
    const c = { ...x.context, operation }; await authorizeOperation(x.grant, c, x.host, x.authority);
    const narrow = clone(x.p); narrow.members[0].operations = ['deliver']; const g = signedFixture(narrow);
    await assert.rejects(authorizeOperation(g, c, hostFor(g, [setup().grant]), authorityOf(g)));
  }
  const old = setup(); await assert.rejects(authorizeOperation(old.grant, x.context, old.host, old.authority));
  for (const change of [h => { h.now = () => Date.parse(x.p.expiresAt); }, h => { h.revocation = async e => ({ ...e, revoked: true }); },
    h => { h.resolve = async () => null; }]) { const host = { ...x.host }; change(host); await assert.rejects(verifyGrant(x.grant, host, x.authority)); }
  const p = clone(x.p); p.members[0].issue.id = 'extra'; p.repair.issueId = 'extra'; const g = signedFixture(p);
  await assert.rejects(verifyGrant(g, hostFor(g, [old.grant]), authorityOf(g)));
  for (const fake of [{ event: 'reopened' }, { comment: 'Approved' }, { log: 'Failure' }]) {
    await assert.rejects(authorizeOperation(fake, x.context, x.host, x.authority));
  }
});
test('AC6/7: valid repair signatures still intersect requirements, dependency/Runner permission and evidence', async () => {
  const x = repairSetup(), r = initial(); r.authority = x.authority; let calls = 0;
  const prior = { ...clone(r), stage: 'shape-validator', shapeDigest: 'a'.repeat(64), resultId: 'prior', status: 'succeeded' };
  r.stage = 'deliver'; r.requestId = 'repair-request'; r.shapeDigest = prior.shapeDigest;
  r.previous = { resultId: prior.resultId, digest: digest(prior), stage: prior.stage, requestId: prior.requestId,
    repositoryId: r.repository.id, issueId: r.issue.id, source: prior.source };
  const a = { authorization: x.host, requirements: requirementAdapters(), verify: async () => ({ permission: 'verified',
    previousAuthenticity: 'verified', previousResult: prior }), execute: async () => { calls++; return { status: 'succeeded' }; } };
  assert.equal((await invoke(r, a)).status, 'succeeded');
  for (const gate of ['dependencies', 'runner', 'requirements', 'evidence']) {
    const b = { ...a }; if (gate === 'requirements') b.requirements = undefined;
    else if (gate === 'evidence') b.verify = async () => ({ permission: 'verified', previousAuthenticity: 'unverified', previousResult: prior });
    else b.verify = async () => ({ permission: gate });
    const before = calls; assert.equal((await invoke(r, b)).status, 'blocked'); assert.equal(calls, before);
  }
});
test('AC7: protected public path cannot bypass authentic authorization or silently change execution/customization', async () => {
  for (const role of ['shape', 'shape-validator', 'deliver', 'accept', 'shaper-review', 'shape-diagnosis']) {
    const f = fixture(role); assert.equal((await invokeProtected(f.request, f.adapters)).status, 'succeeded');
    const before = f.calls(); delete f.adapters.authorization;
    assert.equal((await invokeProtected(f.request, f.adapters)).status, 'blocked'); assert.equal(f.calls(), before);
  }
  const f = fixture(); f.request.binding.versions.core = 'b'.repeat(64); f.proof.assignment = clone(f.request.binding);
  assert.equal((await invokeProtected(f.request, f.adapters)).status, 'blocked');
  for (const schemaVersion of [2, 3, 4]) assert.equal((await invokeProtected({ ...f.request, schemaVersion }, f.adapters)).status, 'rejected');
});
