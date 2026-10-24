import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bodyDigest, protectedSkills, skillForRole, outcomesForRole, parseStageResult, validateStageResult,
  byteDigest, contentIdentity, stageApplicability, createEvidence, compareEvidence, createCompletion,
  verifyCompletion, validateCompatibility, compareCompatibility} from '@nibfin/core';

import {h, g, clone, binding, result, execution, fixture, context, chain, chainContext} from '../tooling/evidence-fixture.mjs';
function leaves(v, prefix = []) {
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, value]) => leaves(value, [...prefix, k]));
  return [prefix];
}
function change(v, keys) {
  let obj = v;
  for (const k of keys.slice(0, -1)) obj = obj[k];
  const k = keys.at(-1);
  const value = obj[k];
  obj[k] = typeof value === 'string' && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value)
    ? (value[0] === 'a' ? 'b' : 'a') + value.slice(1)
    : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? String(BigInt(value) + 1n)
    : typeof value === 'string' ? value + 'x' : value === null ? 'changed' : 2;
}

test('AC1/2: public roles, result separation, strict structures and all outcomes', () => {
  assert.deepEqual(protectedSkills, ['shape', 'deliver', 'accept']);
  for (const role of ['shape', 'shape-validator', 'shape-diagnosis', 'shaper-review', 'deliver', 'accept']) {
    assert.equal(skillForRole(role), ['deliver', 'accept'].includes(role) ? role : 'shape');
    const ctx = {execution: execution(role), binding};
    assert.deepEqual(validateStageResult(JSON.stringify(result(role)), ctx), result(role));
    for (const outcome of outcomesForRole(role)) {
      const v = result(role); v.outcome = outcome;
      v.failureClass = outcome === outcomesForRole(role)[0] ? 'none'
        : outcome === 'changes_required' ? 'implementation_defect' : 'authority_gap';
      validateStageResult(v, ctx);
    }
    const bad = clone(ctx); bad.execution.skill = 'scope';
    assert.throws(() => validateStageResult(result(role), bad));
    const wrong = result(role); wrong.outcome = role === 'deliver' ? 'approved' : 'ready';
    if (!outcomesForRole(role).includes(wrong.outcome)) assert.throws(() => validateStageResult(wrong, ctx));
  }
  for (const role of ['scope', 'constructor', '__proto__', '', null]) assert.throws(() => skillForRole(role));
  for (const mutate of [v => v.version = 2, v => v.authorized = true, v => v.summary = 3,
    v => delete v.conflicts, v => v.outcome = 'COMPLETE', v => v.summary = '']) {
    const v = result('deliver'); mutate(v); assert.throws(() => parseStageResult(v));
  }
  // Parsing accepts no subject claims. Contextual checking is an independent step.
  assert.equal(parseStageResult(result('deliver')).outcome, 'ready');
  const foreign = fixture('deliver'); foreign.binding.repositoryId = '43';
  assert.throws(() => compareEvidence(foreign, context(fixture('deliver'))));
  foreign.binding = clone(binding); foreign.binding.issueId = 'I_foreign';
  assert.throws(() => compareEvidence(foreign, context(fixture('deliver'))));
  for (const id of [42, 9007199254740992, '01', '1e3', ' 42']) {
    const v = fixture('deliver'); v.binding.repositoryId = id;
    assert.throws(() => createEvidence(context(v)));
  }
});

test('AC3/10: every stage leaf independently invalidates evidence; no cached fallback', () => {
  for (const stage of Object.keys(stageApplicability)) {
    const valid = fixture(stage), ctx = context(valid);
    assert.deepEqual(createEvidence(ctx), valid);
    for (const keys of leaves(valid)) {
      const bad = clone(valid); change(bad, keys);
      assert.throws(() => compareEvidence(bad, ctx), `${stage}:${keys.join('.')}`);
    }
    for (const key of Object.keys(valid.inputs)) {
      const bad = clone(valid); delete bad.inputs[key];
      assert.throws(() => compareEvidence(bad, ctx), `${stage}:missing:${key}`);
    }
    assert.throws(() => compareEvidence(valid, {consumed: []}));
  }
  const valid = fixture('deliver');
  for (const key of ['artifacts', 'hooks']) {
    const bad = clone(valid); bad.inputs.candidate[key] = [];
    assert.throws(() => compareEvidence(bad, context(valid)));
  }
  for (const inventory of ['artifacts', 'hooks']) {
    const originalBytes = Buffer.from('required source bytes');
    const changedBytes = Buffer.from(originalBytes); changedBytes[0] ^= 1;
    const original = fixture('deliver');
    original.inputs.candidate[inventory][0].digest = byteDigest(originalBytes);
    const changed = clone(original);
    changed.inputs.candidate[inventory][0].digest = byteDigest(changedBytes);
    assert.throws(() => compareEvidence(changed, context(original)));
    createEvidence(context(changed)); // valid new content needs fresh downstream evidence
  }
  const empty = fixture('deliver');
  empty.inputs.candidate.hooks = []; empty.inputs.candidate.emptyHooksReason = 'No configured hooks';
  createEvidence(context(empty));
  empty.inputs.candidate.emptyHooksReason = '';
  assert.throws(() => createEvidence(context(empty)));
});

test('AC4: trusted executions, source attempts and consumed results', () => {
  for (const [stage, keys] of [['shape-validator', ['author']], ['accept', ['deliver']],
    ['shaper-review', ['author', 'validator', 'deliver', 'accept']]]) {
    for (const key of keys) {
      const v = fixture(stage); v.execution.id = v.inputs[key];
      assert.throws(() => createEvidence(context(v)));
      v.execution.role = 'deliver'; v.execution.skill = 'deliver';
      assert.throws(() => createEvidence(context(v)));
    }
  }
  const publication = fixture('publication'); publication.inputs.validator = publication.inputs.author;
  assert.throws(() => createEvidence(context(publication)));
  const v = fixture('accept');
  assert.throws(() => compareEvidence(v, {expected: v, consumed: [v.execution.result]}));
  for (const key of ['request', 'id', 'result']) {
    const bad = clone(v); bad.execution[key] += '-other'; assert.throws(() => compareEvidence(bad, context(v)));
  }
  const bad = clone(v); bad.execution.source.attempt = '2';
  assert.throws(() => compareEvidence(bad, context(v)));
  bad.execution.id = 'fresh'; bad.execution.result = 'fresh-result';
  createEvidence(context(bad));
});

test('AC5: every defect class and exact Shape conflict proof', () => {
  const ctx = {binding, execution: execution('shape-diagnosis'), scopeBody: 'original scope', shapeBody: 'published shape'};
  for (const failureClass of ['none', 'implementation_defect', 'shape_defect', 'authority_gap', 'external_failure']) {
    const v = result('shape-diagnosis'); v.failureClass = failureClass;
    if (failureClass !== 'none') v.outcome = 'blocked';
    if (failureClass === 'shape_defect') v.conflicts = [{scopeHash: binding.scopeHash, shapeHash: binding.shapeHash,
      scopeQuote: 'original', shapeQuote: 'published', evidenceReference: 'frozen-snapshot'}];
    validateStageResult(v, ctx);
    const bad = clone(v); bad.outcome = failureClass === 'none' ? 'blocked' : 'accepted';
    assert.throws(() => validateStageResult(bad, ctx));
    if (failureClass === 'shape_defect') {
      for (const mutate of [x => x.conflicts = [], x => x.conflicts[0].scopeHash = h('a'),
        x => x.conflicts[0].shapeHash = h('b'), x => x.conflicts[0].scopeQuote = 'not present',
        x => x.conflicts[0].shapeQuote = 'not present']) {
        const wrong = clone(v); mutate(wrong); assert.throws(() => validateStageResult(wrong, ctx));
      }
    }
  }
});

test('AC6: first completion, existing receipt, full chain, stale and missing proof rejection', () => {
  for (const empty of [true, false]) for (const required of [true, false]) {
    const c = chain(empty, required); verifyCompletion(createCompletion(c, chainContext(c)), chainContext(c));
  }
  const v = chain(), ctx = chainContext(v);
  const receipt = createCompletion(v, ctx);
  assert.deepEqual(verifyCompletion(JSON.parse(JSON.stringify(receipt)), ctx), receipt);
  assert.deepEqual(createCompletion(v, ctx), receipt);
  assert.equal(receipt.identity, 'a76b345ed708643afca57b0cf0bb57c5bb8da951309c78f3917183778f3cd96d');
  for (const stage of Object.keys(v.receipts)) {
    const missing = clone(v); delete missing.receipts[stage];
    assert.throws(() => createCompletion(missing, ctx), stage);
    const bad = clone(v); bad.receipts[stage].execution.result += '-stale';
    assert.throws(() => createCompletion(bad, ctx), stage);
    for (const key of Object.keys(v.receipts[stage].inputs)) {
      const replaced = clone(v); change(replaced, ['receipts', stage, 'inputs', key]);
      assert.throws(() => createCompletion(replaced, ctx), `${stage}:${key}`);
    }
  }
  for (const claims of [{labels: ['delivered']}, {state: 'closed'}, {aggregate: 'COMPLETE'}, {authenticated: true}]) {
    assert.throws(() => createCompletion(claims, ctx));
  }
  const altered = clone(receipt); altered.identity = h('a'); assert.throws(() => verifyCompletion(altered, ctx));
  // Even matching current envelopes cannot stitch inconsistent upstream links.
  const broken = chain(); broken.receipts.accept.inputs.hooks = h('f');
  assert.throws(() => createCompletion(broken, chainContext(broken)));
  const missingProof = chain(); missingProof.receipts.final.inputs.postMerge.identities = [];
  assert.throws(() => createCompletion(missingProof, chainContext(missingProof)));
});

const compatibility = () => ({version: 1, content: {core: h('a'), skills: {shape: h('b'), deliver: h('c'), accept: h('d')},
  action: h('e'), workflow: h('f'), cli: h('1')}, agent: {name: 'example', version: '1.0.0'},
  host: {os: 'linux', architecture: 'x64'}, guest: {os: 'linux', architecture: 'x64'},
  authentication: 'member-login', isolation: 'container', runner: {registration: 'repository', automatic: false},
  visibility: 'public', ownership: 'personal', capability: 'example-only', status: 'Supported',
  evidence: [{kind: 'real-execution', location: 'fixture:synthetic-not-live', digest: h('2')}], limitations: []});
test('AC7: compatibility is evidence classification, never self-promotion to support', () => {
  for (const ownership of ['personal', 'organization']) for (const registration of ['repository', 'organization']) {
    for (const automatic of [true, false]) {
      const v = compatibility(); v.ownership = ownership; v.runner = {registration, automatic};
      assert.deepEqual(compareCompatibility(JSON.parse(JSON.stringify(v)), v), v);
    }
  }
  const research = compatibility(); research.status = 'Unverified'; research.agent.version = 'unknown';
  research.evidence[0].kind = 'research'; research.limitations = ['Not executed'];
  validateCompatibility(research);
  const privateScope = clone(research); privateScope.visibility = 'private'; privateScope.status = 'Unsupported';
  validateCompatibility(privateScope);
  const implemented = compatibility(); implemented.status = 'Implemented'; implemented.evidence[0].kind = 'source-tested';
  validateCompatibility(implemented);
  for (const mutate of [v => v.version = 2, v => delete v.content.cli, v => delete v.evidence[0].digest,
    v => v.evidence = [], v => v.agent.version = 'unknown', v => v.visibility = 'private',
    v => v.evidence[0].kind = 'research', v => v.authorized = true]) {
    const v = compatibility(); mutate(v); assert.throws(() => validateCompatibility(v));
  }
  const promoted = clone(research); promoted.status = 'Supported';
  assert.throws(() => compareCompatibility(promoted, research));
});

test('AC7: published body vectors and identity domains', () => {
  const vectors = [
    ['Hello\n世界', 'e25356b0e259cd559cbbe5495f10b8eb613890dd47e20afbb9d2a105c3531bf7'],
    ['"quoted"\n魚', '25c8e296ea1d5da1c922ab22d824b23fbb8ce43be2d35212914e02e3bf9474dd']
  ];
  for (const [body, digest] of vectors) {
    assert.equal(bodyDigest(body), digest);
    assert.notEqual(bodyDigest(body), byteDigest(Buffer.from(body)));
    assert.equal(byteDigest(Buffer.from(body)), createHash('sha256').update(body).digest('hex'));
    assert.throws(() => byteDigest(body));
    assert.notEqual(bodyDigest(body), contentIdentity(body));
  }
  assert.equal(contentIdentity({b: 2, a: 1}), contentIdentity({a: 1, b: 2}));
  assert.notEqual(contentIdentity({a: 1}), contentIdentity({a: 2}));
});

// Literal role-contract expectations deliberately do not use outcomesForRole.
test('AC1 regression: correct Shape diagnosis approves; Accept alone accepts', () => {
  const approved = {version: 1, outcome: 'approved', failureClass: 'none', summary: 'Shape is correct', conflicts: []};
  const accepted = {...approved, outcome: 'accepted'};
  const ctx = {execution: execution('shape-diagnosis'), binding};
  assert.deepEqual(validateStageResult(approved, ctx), approved);
  assert.throws(() => validateStageResult(accepted, ctx), /evidence:enum/);
  const envelope = fixture('shape-diagnosis'); envelope.result = approved;
  assert.deepEqual(createEvidence(context(envelope)), envelope);
  assert.deepEqual(compareEvidence(envelope, context(envelope)), envelope);
  const invalid = clone(envelope); invalid.result = accepted;
  assert.throws(() => createEvidence(context(invalid)), /evidence:enum/);
  assert.throws(() => compareEvidence(invalid, context(invalid)), /evidence:enum/);
  const acceptContext = {execution: execution('accept'), binding};
  assert.deepEqual(validateStageResult(accepted, acceptContext), accepted);
  assert.throws(() => validateStageResult(approved, acceptContext), /evidence:enum/);
});

// Build references after assigning instruction snapshots, as Core does.
test('AC3/6 regression: stage instructions differ while shared bindings stay invariant', () => {
  const v = chain(false, false, receipts => {
    for (const r of Object.values(receipts)) {
      r.binding.instructions = contentIdentity('trusted instructions for ' + r.execution.skill);
    }
  });
  assert.equal(new Set(Object.values(v.receipts).map(r => r.binding.instructions)).size, 3);
  const ctx = chainContext(v);
  for (const [stage, r] of Object.entries(v.receipts)) compareEvidence(r, ctx[stage]);
  verifyCompletion(createCompletion(v, ctx), ctx);
  for (const stage of Object.keys(v.receipts)) {
    const stale = clone(v); stale.receipts[stage].binding.instructions = h('0');
    assert.throws(() => createCompletion(stale, ctx), stage);
  }
  for (const key of Object.keys(binding).filter(k => k !== 'instructions')) {
    const inconsistent = chain(false, false, receipts => {
      change(receipts.accept.binding, [key]);
    });
    assert.throws(() => createCompletion(inconsistent, chainContext(inconsistent)), key);
  }
});

// Uses the existing complete chain harness, not a second completion model.
test('Issue #86 AC4: approved replacement invalidates complete historical chains', async () => {
  const {generateKeyPairSync} = await import('node:crypto');
  const {exportAuthority, authoritySnapshot, verifyAuthority, synchronizeAuthority, signGrant, verifyGrant} = await import('@nibfin/core');
  const {grantFixture, grantContext} = await import('../tooling/grant-fixture.mjs');
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({type:'pkcs8',format:'pem'});
  const publicKey = keys.publicKey.export({type:'spki',format:'pem'});
  const first = exportAuthority({source:'https://app.notion.com/p/40006b644a2080dab1a8c2e562f95373',
    revision:'1',approvalId:'approval-1',cycle:'cycle-1',
    components:[{id:'scope',kind:'section',body:'Full approved source',references:[]}]});
  const approve = v => {
    const p = grantFixture(bodyDigest); p.authority = authoritySnapshot(v);
    return {grant:signGrant(p,{keyId:'owner-1',privateKey}),grantContext:grantContext(p,publicKey),
      expected:{source:v.source,revision:v.revision,approvalId:v.approvalId,cycle:v.cycle}};
  };
  const a = approve(first), old = verifyAuthority(first,a).binding;
  const makeChain = (snapshot, grant) => chain(false,false,receipts => {
    for (const r of Object.values(receipts)) {
      r.binding.authority = contentIdentity(snapshot); r.binding.grant = contentIdentity(grant);
    }
  });
  const original = makeChain(old.snapshot,a.grant);
  const completion = createCompletion(original,chainContext(original));
  for (const delta of [{revision:'2'}, {approvalId:'approval-2'}, {}]) {
    const next = exportAuthority({source:first.source,revision:first.revision,approvalId:first.approvalId,
      cycle:'cycle-2',components:first.components,...delta});
    const b = approve(next);
    const replacement = synchronizeAuthority({active:old,expectedPrevious:old,replacement:next,verification:b,
      authorization:{previousIdentity:old.identity,replacementIdentity:next.identity,cycle:next.cycle}});
    assert.equal(verifyGrant(a.grant,b.grantContext).ok,false);
    const fresh = makeChain(replacement.active.snapshot,b.grant), current = chainContext(fresh);
    assert.throws(() => verifyCompletion(completion,current));
    verifyCompletion(createCompletion(fresh,current),current);
    assert.equal(original.receipts.publication.binding.scopeHash,binding.scopeHash);
    assert.equal(original.receipts.publication.binding.shapeHash,binding.shapeHash);
    assert.notEqual(binding.scopeHash,binding.shapeHash);
  }
});

test('semantic deployment qualification feeds the complete completion chain', async t => {
  const {createServer} = await import('node:http');
  const {once} = await import('node:events');
  const {verifyDeployment, createDeploymentFinal} = await import('@nibfin/core');
  const server = createServer((req,res) => res.end('healthy'));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => {server.closeAllConnections();server.close();});
  const url = `http://127.0.0.1:${server.address().port}/health`;
  const checks = [{url,status:200,body:'healthy'}];
  const policy = {mode:'required',reason:'Issue release',repositoryId:binding.repositoryId,
    commit:g('d'),version:'fixed',environment:'production',deploymentId:'1',statusId:'2',baseline:'fixed',
    source:{repositoryId:binding.repositoryId,workflow:'pinned-workflow',runId:'3',attempt:'1'},maxAgeMs:100,checks};
  const inputs = {policy,observation:{...policy,state:'success',observedAt:1000},
    health:{checks,allowlist:[url],timeoutMs:1000,maxBytes:32,maxRequests:1},now:()=>1100};
  const q = await verifyDeployment(inputs);
  const c = chain(false,true,receipts => {receipts.final.inputs.deployment=q.proof;});
  const ctx = chainContext(c);
  assert.deepEqual(await createDeploymentFinal(ctx.final,q,inputs),c.receipts.final);
  const completion = createCompletion(c,ctx);
  assert.deepEqual(verifyCompletion(completion,ctx),completion);
  for (const observation of [null,{...inputs.observation,state:'pending'},
    {...inputs.observation,state:'failure'},{...inputs.observation,commit:g('e')},
    {...inputs.observation,observedAt:999}]) {
    await assert.rejects(createDeploymentFinal(ctx.final,q,{...inputs,observation}));
  }
  const changed = chain(false,true,receipts => {receipts.final.inputs.deployment={...q.proof,identities:[h('8')]};});
  assert.throws(() => verifyCompletion(completion,chainContext(changed)));
});
