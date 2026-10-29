import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, digest, validateManifest } from '../src/core.mjs';
import { fixture, shape, deliver, NOW, SHA } from './fixtures.mjs';

const run = f => plan(f.manifest, f.policy, f.snapshot, NOW);
function shaped() { const f = fixture(); for (const i of f.manifest.issues) shape(f, i.id); return f; }
function merging() { const f = shaped(); deliver(f, 'I_A'); return f; }

test('single total order, all-shaped barrier, sequential delivery and terminal certificate', () => {
  const f = fixture();
  for (const id of ['I_A', 'I_B', 'I_C']) {
    assert.equal(run(f).operation, 'shape');
    assert.equal(run(f).issueId, id);
    shape(f, id, false);
    assert.equal(run(f).operation, 'publish-shape');
    shape(f, id);
  }
  for (const id of ['I_A', 'I_B', 'I_C']) {
    assert.equal(run(f).operation, 'deliver');
    assert.equal(run(f).issueId, id);
    deliver(f, id);
    assert.equal(run(f).operation, 'merge');
    deliver(f, id, true);
  }
  const result = run(f);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.completionHash, run(f).completionHash);
});

test('scope-to-shape body rewrite preserves frozen scope', () => {
  const f = shaped();
  assert.notEqual(f.snapshot.issues.I_A.bodyHash, f.manifest.issues[0].scopeHash);
  assert.equal(run(f).operation, 'deliver');
});

test('closure and delivered are separate gates before next issue', () => {
  const f = merging(); deliver(f, 'I_A', true);
  f.snapshot.issues.I_A.state = 'open';
  assert.equal(run(f).operation, 'close');
  f.snapshot.issues.I_A.state = 'closed';
  f.snapshot.issues.I_A.labels = ['scope', 'shaped'];
  assert.equal(run(f).operation, 'mark-delivered');
});

const refusals = [
  ['missing owner approval', f => { delete f.snapshot.approval; }, 'NO_GRANT'],
  ['revoked policy', f => { f.snapshot.approval.revoked = true; }, 'EXPIRED_OR_REVOKED'],
  ['changed live policy', f => { f.snapshot.policyHash = 'new'; }, 'STALE_AUTHORITY'],
  ['public credentials', f => { f.snapshot.issues.I_A.visibility = 'public'; }, 'PUBLIC_EXECUTION_BLOCKED'],
  ['core pin changed', f => { f.snapshot.runtime.coreDigest = 'other'; }, 'UNTRUSTED_RUNTIME'],
  ['agent logout', f => { f.snapshot.runtime.authenticated = false; }, 'AGENT_UNAVAILABLE'],
  ['scope drift', f => { f.snapshot.issues.I_A.scopeHash = 'other'; }, 'SCOPE_REVIEW_REQUIRED'],
  ['dependency drift', f => { f.snapshot.issues.I_B.dependencies = []; }, 'SCOPE_REVIEW_REQUIRED'],
  ['extra scope', f => { f.snapshot.issues.I_D = {}; }, 'SCOPE_REVIEW_REQUIRED'],
  ['same shape validator', f => { f.snapshot.issues.I_A.shape.validator.executionId = 'I_A-shape'; }, 'NOT_INDEPENDENT'],
  ['shape publication body changed', f => { f.snapshot.issues.I_A.bodyHash = 'edited'; }, 'SHAPE_PUBLICATION_MISMATCH'],
  ['self acceptance', f => { f.snapshot.issues.I_A.accept.executionId = 'I_A-deliver'; }, 'NOT_INDEPENDENT'],
  ['postcommit acceptance', f => { f.snapshot.issues.I_A.accept.artifactIdentities.preCommit = false; }, 'INVALID_ACCEPT'],
  ['candidate changed', f => { f.snapshot.issues.I_A.candidate.tree = SHA('e'); }, 'STALE_EVIDENCE'],
  ['head changed', f => { f.snapshot.issues.I_A.pr.head = SHA('e'); }, 'CI_PENDING_OR_FAILED'],
  ['wrong CI head', f => { f.snapshot.issues.I_A.checks[0].head = SHA('e'); }, 'CI_PENDING_OR_FAILED'],
  ['skipped check', f => { f.snapshot.issues.I_A.checks[0].conclusion = 'skipped'; }, 'CI_PENDING_OR_FAILED'],
  ['pending check', f => { f.snapshot.issues.I_A.checks[0].status = 'queued'; }, 'CI_PENDING_OR_FAILED'],
  ['duplicate check', f => { f.snapshot.issues.I_A.checks.push(f.snapshot.issues.I_A.checks[0]); }, 'CI_PENDING_OR_FAILED'],
  ['no live check config', f => { f.snapshot.issues.I_A.requiredChecks = []; }, 'CI_NOT_CONFIGURED'],
  ['extra required check', f => { f.snapshot.issues.I_A.requiredChecks.push('security'); }, 'CI_PENDING_OR_FAILED'],
  ['untrusted CI', f => { f.snapshot.issues.I_A.checks[0].trusted = false; }, 'CI_PENDING_OR_FAILED'],
  ['self final review', f => { f.snapshot.issues.I_A.review.executionId = 'I_A-accept'; }, 'NOT_INDEPENDENT'],
  ['stale final review', f => { f.snapshot.issues.I_A.review.artifactIdentities.head = SHA('e'); }, 'STALE_EVIDENCE'],
  ['protected branch', f => { f.snapshot.issues.I_A.pr.protectionSatisfied = false; }, 'MERGE_PROTECTED'],
  ['no permission', f => { f.snapshot.issues.I_A.pr.mergePermission = false; }, 'MERGE_PROTECTED'],
  ['agent grants authority', f => { f.snapshot.issues.I_A.review.authorized = true; }, 'AGENT_AUTHORITY_REJECTED'],
  ['old policy envelope', f => { f.snapshot.issues.I_A.accept.autonomyPolicyRevision = 'old'; }, 'STALE_EVIDENCE'],
  ['unsafe candidate path', f => { f.snapshot.issues.I_A.candidate.paths = ['../other/file']; }, 'INVALID_CANDIDATE'],
];
for (const [name, mutate, code] of refusals) test(`refuses ${name}`, () => {
  const f = merging(); mutate(f);
  const result = run(f); assert.equal(result.status, 'BLOCKED'); assert.equal(result.code, code, result.reason);
});

test('expiry is evaluated on every resume', () => {
  const f = merging();
  assert.equal(plan(f.manifest, f.policy, f.snapshot, Date.parse(f.policy.expiresAt)).code, 'EXPIRED_OR_REVOKED');
});
test('manual milestone labels do not create evidence', () => {
  const f = fixture(); for (const live of Object.values(f.snapshot.issues)) { live.labels = ['scope', 'shaped', 'delivered']; live.state = 'closed'; }
  assert.equal(run(f).operation, 'shape');
});
test('repairs stay on the same issue and are bounded', () => {
  const f = merging(); f.snapshot.issues.I_A.review.outcome = 'changes_required';
  assert.equal(run(f).operation, 'repair'); assert.equal(run(f).issueId, 'I_A');
  f.snapshot.issues.I_A.repairs = 2;
  assert.equal(run(f).code, 'REPAIR_BUDGET_EXHAUSTED');
  f.snapshot.issues.I_A.repairs = 1; f.snapshot.issues.I_A.sameRootCauseFailures = 2;
  assert.equal(run(f).code, 'REPEATED_ROOT_CAUSE');
});
test('dependencies require approved order and reject cycles, missing dependencies and duplicates', () => {
  for (const dependency of ['I_A', 'I_C', 'missing']) {
    const f = fixture(); f.manifest.issues[0].dependencies = [dependency];
    assert.throws(() => validateManifest(f.manifest), /blocked by/);
  }
  const f = fixture(); f.manifest.issues.push(f.manifest.issues[0]);
  assert.throws(() => validateManifest(f.manifest), /Duplicate/);
});
test('canonical identity ignores object key order but preserves array order', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.notEqual(digest(['a', 'b']), digest(['b', 'a']));
});

test('each handoff requests its independent stage before later actions', () => {
  const f = fixture(); shape(f, 'I_A', false);
  delete f.snapshot.issues.I_A.shape.validator;
  assert.equal(run(f).operation, 'validate-shape');
  for (const i of f.manifest.issues) shape(f, i.id);
  deliver(f, 'I_A');
  const live = f.snapshot.issues.I_A;
  const saved = structuredClone(live);
  delete live.accept; delete live.pr; delete live.review;
  assert.equal(run(f).operation, 'accept');
  live.accept = saved.accept;
  assert.equal(run(f).operation, 'commit-pr');
  live.pr = saved.pr;
  assert.equal(run(f).operation, 'shaper-review');
});

test('independent review defects can be repaired but successful results cannot retain blockers', () => {
  const f = merging();
  f.snapshot.issues.I_A.accept.outcome = 'changes_required';
  f.snapshot.issues.I_A.accept.blockingFindings = ['Missing required regression test'];
  assert.equal(run(f).operation, 'repair');
  f.snapshot.issues.I_A.accept.outcome = 'accepted';
  assert.equal(run(f).code, 'STAGE_BLOCKED');
});

test('product decisions block without a repair or silent scope change', () => {
  const f = fixture(); shape(f, 'I_A', false);
  delete f.snapshot.issues.I_A.shape.validator;
  f.snapshot.issues.I_A.shape.author.outcome = 'decision_required';
  f.snapshot.issues.I_A.shape.author.blockingFindings = ['New product semantics'];
  assert.equal(run(f).code, 'OWNER_DECISION_REQUIRED');
});

test('a fake delivered label, closure or merge never completes a cohort', () => {
  const f = merging(); deliver(f, 'I_A', true);
  delete f.snapshot.issues.I_A.delivered;
  assert.equal(run(f).code, 'DELIVERY_UNVERIFIED');
  deliver(f, 'I_A', true); f.snapshot.issues.I_A.closure.mergeCommit = SHA('e');
  assert.equal(run(f).code, 'CLOSURE_UNVERIFIED');
  deliver(f, 'I_A', true); f.snapshot.issues.I_A.merge.verified = false;
  assert.equal(run(f).code, 'MERGE_UNVERIFIED');
});

function rebindPolicy(f) {
  f.snapshot.policyHash = digest(f.policy);
  f.snapshot.approval.policyHash = digest(f.policy);
  for (const i of f.manifest.issues) shape(f, i.id);
  deliver(f, 'I_A');
}
test('a policy must explicitly permit the next operation', () => {
  const f = merging(); f.policy.operations = f.policy.operations.filter(x => x !== 'merge');
  rebindPolicy(f);
  assert.equal(run(f).code, 'OPERATION_DENIED');
});
test('required final proof is bound to actual merged commit', () => {
  const f = merging(); f.policy.repositories['example/one'].finalProofs = ['release'];
  rebindPolicy(f); deliver(f, 'I_A', true);
  assert.equal(run(f).code, 'FINAL_PROOF_MISSING');
  f.snapshot.issues.I_A.finalProofs = [{ id: 'release-1', name: 'release', commit: SHA('e'), verified: true }];
  assert.equal(run(f).code, 'FINAL_PROOF_MISSING');
  f.snapshot.issues.I_A.finalProofs[0].commit = SHA('d');
  assert.equal(run(f).issueId, 'I_B');
});
test('missing check policy and restricted candidate paths fail closed', () => {
  const f = merging(); f.policy.repositories['example/one'].requiredChecks = [];
  rebindPolicy(f);
  assert.equal(run(f).code, 'CI_NOT_CONFIGURED');
  const g = merging(); g.policy.deniedPaths = ['src']; rebindPolicy(g);
  assert.equal(run(g).code, 'PATH_DENIED');
});
test('malformed JSON-shaped inputs return a blocked result', () => {
  for (const value of [null, {}, [], { schemaVersion: 1 }]) assert.equal(plan(value, null, {}, NOW).status, 'BLOCKED');
});

test('positive path allowlists permit only approved files or directory descendants', () => {
  const narrow = merging(); narrow.manifest.issues[0].allowedPaths = ['src/another.mjs'];
  narrow.policy.manifestHash = digest(narrow.manifest);
  narrow.snapshot.manifestHash = narrow.snapshot.approval.manifestHash = digest(narrow.manifest);
  rebindPolicy(narrow);
  assert.equal(run(narrow).code, 'PATH_DENIED');
  for (const allowed of [[], ['src/other.mjs'], ['src/feature'], ['src-other']]) {
    const f=merging(); f.policy.repositories['example/one'].allowedPaths=allowed;
    rebindPolicy(f); assert.equal(run(f).code, 'PATH_DENIED');
  }
  for (const allowed of [['src/feature.mjs'], ['src'], ['src/']]) {
    const f=merging(); f.policy.repositories['example/one'].allowedPaths=allowed;
    rebindPolicy(f); assert.notEqual(run(f).code, 'PATH_DENIED');
  }
});
test('failed CI and advanced default branch trigger bounded same-Issue repair', () => {
  const f = merging(); f.snapshot.issues.I_A.checks[0].conclusion = 'failure';
  assert.equal(run(f).operation, 'repair'); assert.equal(run(f).artifacts.cause, 'ci');
  const g = merging(); g.snapshot.issues.I_A.defaultHead = SHA('e');
  assert.equal(run(g).operation, 'repair'); assert.equal(run(g).artifacts.cause, 'base');
});

test('repository settings own merge eligibility without frozen CI lists or workflow provenance',()=>{
 const f=fixture();f.policy.controlMode='owner-project';
 const g=f.policy.repositories['example/one'];g.ciMode='github-repository';g.mergeStrategy='github-api';g.requiredChecks=[];g.finalProofs=[];
 f.policy.expiresAt='2000-01-01T00:00:00Z';
 f.snapshot.policyHash=digest(f.policy);f.snapshot.approval.policyHash=digest(f.policy);
 for(const i of f.manifest.issues)shape(f,i.id);
 deliver(f,'I_A');const live=f.snapshot.issues.I_A;
 live.checks=[];live.requiredChecks=[];delete live.protectionInspection;live.pr.protectionSatisfied=false;
 assert.equal(run(f).operation,'merge',JSON.stringify(run(f)));
 live.pr.mergeState='dirty';assert.equal(run(f).artifacts.cause,'merge-conflict');
 live.pr.mergeState='blocked';live.checks=[{name:'test',status:'completed',conclusion:'failure'}];assert.equal(run(f).artifacts.cause,'ci');
 live.pr.mergeState='clean';live.checks=[];
 live.pr.head=SHA('f');assert.notEqual(run(f).operation,'merge');
});

