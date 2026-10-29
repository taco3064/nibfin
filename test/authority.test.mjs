import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {exportAuthority, importAuthority, authoritySnapshot, verifyAuthority, synchronizeAuthority,
  bodyDigest, contentIdentity, signGrant, verifyGrant, prepareGrant, createEvidence, compareEvidence} from '@nibfin/core';
import {grantFixture, grantContext} from '../tooling/grant-fixture.mjs';

const clone = v => JSON.parse(JSON.stringify(v));
const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({type:'pkcs8',format:'pem'});
const publicKey = keys.publicKey.export({type:'spki',format:'pem'});
const source = 'https://github.com/example-org/core/issues/101';
const input = () => ({source, revision:'2026-10-24T13:10:19.626Z', approvalId:'owner-approval-1', cycle:'cycle-1',
  components:[{id:'goal',kind:'section',body:'Hello\n世界',references:['rules']},
    {id:'rules',kind:'section',body:'"quoted"\n魚\r\n',references:['diagram','material']},
    {id:'diagram',kind:'attachment',body:'AAEC/w==',references:[]},
    {id:'material',kind:'reference',body:'Complete material referenced requirements\n',references:[]}]});
function approve(exported) {
  const payload = grantFixture(bodyDigest); payload.authority = authoritySnapshot(exported);
  const {draft} = prepareGrant(payload);
  return {grant:signGrant(draft,{keyId:'owner-1',privateKey}), grantContext:grantContext(draft,publicKey),
    expected:{source:exported.source,revision:exported.revision,approvalId:exported.approvalId,cycle:exported.cycle}};
}
const accepted = (v, ctx) => {
  const result = verifyAuthority(v,ctx); assert.equal(result.ok,true,JSON.stringify(result)); return result.binding;
};
const auth = (previous, replacement) => ({previousIdentity:previous.identity,
  replacementIdentity:replacement.identity,cycle:replacement.cycle});

test('AC1: exact complete representation and deterministic round trip, public digest vectors', () => {
  const v = exportAuthority(input()), ctx = approve(v);
  assert.deepEqual(importAuthority(JSON.stringify(v)),v);
  assert.deepEqual(exportAuthority(input()),v);
  assert.equal(exportAuthority({source,revision:'1',approvalId:'approval-1',cycle:'cycle-1',
    components:[{id:'section',kind:'section',body:'Hello\n世界',references:[]}]}).identity,
    'c427352280c6df8598331b6d7deb265233c9f28430bb5ec20a488c064d1904a4');
  assert.deepEqual(accepted(v,ctx),accepted(importAuthority(JSON.stringify(v)),ctx));
  assert.deepEqual(v.components,input().components);
  assert.equal(v.manifest.components[0].hash,'e25356b0e259cd559cbbe5495f10b8eb613890dd47e20afbb9d2a105c3531bf7');
  assert.equal(bodyDigest('"quoted"\n魚'),'25c8e296ea1d5da1c922ab22d824b23fbb8ce43be2d35212914e02e3bf9474dd');
  assert.equal(contentIdentity({b:2,a:1}),contentIdentity({a:1,b:2}));
  // Returned/imported structures are detached, not aliases to active caller data.
  const imported = importAuthority(v); imported.components[0].body = 'changed';
  assert.equal(v.components[0].body,'Hello\n世界');
});

test('AC2: table-driven malformed/tampered/foreign/stale/incomplete rejection', () => {
  const v = exportAuthority(input()), ctx = approve(v);
  const attacks = [
    ['wrong canonical source', x => x.source = source.replace('/101','/102')],
    ['unexpected revision', x => x.revision = 'stale'],
    ['approval', x => x.approvalId = 'stale'], ['cycle', x => x.cycle = 'stale'],
    ['missing component', x => x.components.splice(1,1)],
    ['missing attachment', x => x.components.splice(2,1)],
    ['missing reference', x => x.components.pop()],
    ['content', x => x.components[0].body += 'secret'],
    ['order', x => x.components.reverse()],
    ['manifest', x => x.manifest.components.reverse()],
    ['digest', x => x.identity = 'a'.repeat(64)],
    ['version', x => x.version = 2], ['malformed version', x => x.version = '1'],
    ['claim', x => x.approved = true], ['schema', x => delete x.manifest]
  ];
  for (const [name, mutate] of attacks) {
    const bad = clone(v); mutate(bad);
    const result = verifyAuthority(bad,ctx);
    assert.equal(result.ok,false,name); assert.ok(!JSON.stringify(result).includes('secret'));
  }
  // Attacker closes references AND recomputes all hashes after dropping material.
  const truncated = input(); truncated.components = [truncated.components[0]];
  truncated.components[0].references = [];
  const recomputed = exportAuthority(truncated);
  assert.equal(verifyAuthority(recomputed,ctx).category,'expectation');
  for (const mutate of [x => x.components.reverse(), x => x.components[0].body += 'changed',
    x => x.source = source.replace('/101','/102'), x => x.revision = '2',
    x => x.approvalId = 'other', x => x.cycle = 'other']) {
    const bad = input(); mutate(bad);
    assert.equal(verifyAuthority(exportAuthority(bad),ctx).ok,false);
  }
  for (const mutate of [c => delete c.grant, c => c.grant.signature = 'invalid-secret',
    c => c.grantContext.trustedKeys = new Map(), c => c.grantContext.now = 2000,
    c => c.grantContext.revocation.available = false, c => delete c.expected,
    c => delete c.grantContext.expectedAuthority]) {
    const c = approve(v); mutate(c);
    assert.equal(verifyAuthority(v,c).ok,false);
  }
  assert.equal(verifyAuthority(v).ok,false);
  assert.equal(verifyAuthority(v,null).ok,false);
  const forged = approve(v); forged.grant.payload.authority.body += 'secret';
  assert.equal(verifyAuthority(v,forged).ok,false);
  const otherKeys = generateKeyPairSync('ed25519');
  const untrusted = approve(v);
  untrusted.grant = signGrant(untrusted.grant.payload,{keyId:'owner-1',
    privateKey:otherKeys.privateKey.export({type:'pkcs8',format:'pem'})});
  assert.equal(verifyAuthority(v,untrusted).category,'approval');
  for (const malformed of ['{',null,[],{version:1},'secret']) {
    assert.throws(() => importAuthority(malformed),/^TypeError: authority:(schema|version)$/);
  }
  for (const mutate of [x => x.components[0].references.push('absent'),
    x => x.components.push(x.components[0]), x => x.components[2].body = 'https://private/secret',
    x => x.source = 'https://evil.example/secret', x => x.components = []]) {
    const bad = input(); mutate(bad); assert.throws(() => exportAuthority(bad),/^TypeError: authority:/);
  }
});

test('AC3: pure explicit synchronization, prior-state checks and idempotency', () => {
  const first = exportAuthority(input()), firstCtx = approve(first), active = accepted(first,firstCtx);
  const next = exportAuthority({...input(),revision:'2',approvalId:'approval-2',cycle:'cycle-2'});
  const verification = approve(next);
  const before = clone(active);
  importAuthority(JSON.stringify(next)); accepted(next,verification);
  assert.deepEqual(active,before);
  const args = {active,expectedPrevious:clone(active),replacement:next,verification,authorization:auth(active,next)};
  const result = synchronizeAuthority(args);
  assert.equal(result.status,'replaced'); assert.deepEqual(result.previous,active);
  assert.deepEqual(result.invalidated,['grants','evidence','completion']);
  assert.deepEqual(active,before);
  const repeat = synchronizeAuthority({...args,active:result.active,expectedPrevious:result.active,
    authorization:auth(result.active,next)});
  assert.equal(repeat.status,'unchanged'); assert.deepEqual(repeat.invalidated,[]);
  for (const mutate of [a => delete a.authorization, a => a.authorization = {...a.authorization,cycle:'stale'},
    a => a.expectedPrevious = result.active, a => a.replacement = first,
    a => a.verification = firstCtx, a => a.authorization = {approved:true}]) {
    const bad = {...args,authorization:{...args.authorization}}; mutate(bad);
    assert.throws(() => synchronizeAuthority(bad),/^TypeError: authority:/);
    assert.deepEqual(active,before);
  }
  const foreign = exportAuthority({...input(),source:source.replace('/101','/102'),cycle:'cycle-2'});
  assert.throws(() => synchronizeAuthority({...args,replacement:foreign}));
  assert.throws(() => synchronizeAuthority({...args,replacement:foreign,verification:approve(foreign),
    authorization:auth(active,foreign)}),/authority:source/);
  assert.throws(() => synchronizeAuthority(null),/authority:schema/);
  const sameCycle = exportAuthority({...input(),revision:'2'});
  assert.throws(() => synchronizeAuthority({...args,replacement:sameCycle,verification:approve(sameCycle),
    authorization:auth(active,sameCycle)}),/authority:cycle/);
});

test('AC4: real signed Grants and dependent evidence invalidate after replacement', () => {
  const first = exportAuthority(input()), ctx = approve(first), old = accepted(first,ctx);
  const payload = ctx.grant.payload;
  assert.notEqual(payload.work[0].scope.hash,payload.work[0].shape?.hash);
  assert.equal(verifyGrant(ctx.grant,ctx.grantContext).ok,true);
  const receipt = {version:1,stage:'shape',
    binding:{authority:contentIdentity(old.snapshot),grant:contentIdentity(ctx.grant),policy:contentIdentity(payload.policy),
      core:'a'.repeat(64),runtime:'b'.repeat(64),instructions:'c'.repeat(64),repositoryId:payload.work[0].repository.id,
      issueId:payload.work[0].issueId,scopeHash:payload.work[0].scope.hash,shapeHash:null},
    execution:{role:'shape',skill:'shape',id:'shape-1',request:'req-1',result:'result-1',source:null},
    inputs:{body:payload.work[0].scope.hash},
    result:{version:1,outcome:'ready',failureClass:'none',summary:'local evidence',conflicts:[]}};
  createEvidence({expected:receipt,consumed:[]});
  for (const change of [{revision:'2'}, {approvalId:'approval-2'},
    {components:[{id:'new',kind:'section',body:'replacement',references:[]}]}]) {
    const next = exportAuthority({...input(),...change,cycle:'cycle-2'}), nextCtx = approve(next);
    const transition = synchronizeAuthority({active:old,expectedPrevious:old,replacement:next,verification:nextCtx,
      authorization:auth(old,next)});
    assert.equal(verifyGrant(ctx.grant,nextCtx.grantContext).category,'authority');
    assert.equal(verifyGrant(nextCtx.grant,nextCtx.grantContext).ok,true);
    const current = clone(receipt); current.binding.authority = contentIdentity(transition.active.snapshot);
    current.binding.grant = contentIdentity(nextCtx.grant);
    assert.throws(() => compareEvidence(receipt,{expected:current,consumed:[]}));
    createEvidence({expected:current,consumed:[]});
    assert.deepEqual(transition.previous,old);
    // Arbitrary import cannot authorize even with a valid old Grant signature.
    assert.equal(verifyAuthority(next,ctx).ok,false);
  }
});
