import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.mjs';
import { digest, plan } from '../src/core.mjs';
import { fixture, shape, deliver, SHA, NOW } from './fixtures.mjs';

const pin = { path: '.github/workflows/ci.yml', blobSha: SHA('a'), checks: ['test'] };
function ready(mutatePolicy = () => {}) {
  const f = fixture();
  Object.assign(f.policy.repositories['example/one'], { ciMode: 'owner-policy', mergeStrategy:'atomic-merge', mergeMethod:'merge', requiredWorkflows: [structuredClone(pin)] });
  mutatePolicy(f.policy.repositories['example/one']);
  f.snapshot.policyHash = f.snapshot.approval.policyHash = digest(f.policy);
  for (const i of f.manifest.issues) shape(f, i.id);
  deliver(f, 'I_A');
  const live = f.snapshot.issues.I_A;
  live.requiredChecks = [];
  live.protectionInspection = { source: 'branch-api', protected: false };
  Object.assign(live.checks[0], { provenanceVerified: true, workflowPath: pin.path, workflowBlobSha: pin.blobSha, runId: '123', runAttempt: 1, checkSuiteId: '456' });
  return f;
}
const run = f => plan(f.manifest, f.policy, f.snapshot, NOW);
test('signed owner check policy permits an unprotected branch only with actual pinned exact-head CI', () => {
  assert.equal(run(ready()).operation, 'merge');
});
for (const [name, mutate, code] of [
  ['missing check', l => { l.checks = []; }, 'CI_PENDING_OR_FAILED'],
  ['pending run', l => { l.checks[0].status = 'in_progress'; }, 'CI_PENDING_OR_FAILED'],
  ['skipped run', l => { l.checks[0].conclusion = 'skipped'; }, 'CI_PENDING_OR_FAILED'],
  ['wrong head', l => { l.checks[0].head = SHA('d'); }, 'CI_PENDING_OR_FAILED'],
  ['unknown protection', l => { delete l.protectionInspection; }, 'MERGE_PROTECTED'],
  ['protected branch without inspection', l => { l.protectionInspection.protected = true; }, 'MERGE_PROTECTED'],
  ['workflow mismatch', l => { l.checks[0].workflowBlobSha = SHA('d'); }, 'CI_PROVENANCE_MISMATCH'],
  ['unverified provenance', l => { l.checks[0].provenanceVerified = false; }, 'CI_PROVENANCE_MISMATCH'],
  ['blocked GitHub merge', l => { l.pr.protectionSatisfied = false; }, 'MERGE_PROTECTED'],
  ['new server check', l => { l.requiredChecks = ['security']; }, 'CI_PENDING_OR_FAILED'],
]) test(`owner CI refuses ${name}`, () => {
  const f = ready(); mutate(f.snapshot.issues.I_A); assert.equal(run(f).code, code);
});
test('owner CI requires explicit workflow pins and preserves signature binding', () => {
  assert.equal(run(ready(g => { delete g.requiredWorkflows; })).code, 'INVALID_POLICY');
  assert.equal(run(ready(g => { g.requiredWorkflows[0].checks = ['other']; })).code, 'INVALID_POLICY');
  const f = ready(); f.policy.repositories['example/one'].requiredChecks = [];
  assert.equal(run(f).code, 'NO_GRANT');
});
test('explicit unprotected branch readback avoids paid APIs, never swallows a permission failure', async () => {
  const gh = new GitHub('fixture');
  const seen = [];
  gh.api = async path => { seen.push(path); return { protected: false, commit: { sha: SHA('a') } }; };
  assert.deepEqual(await gh.protections('owner/repo', 'main', 'owner-policy'), { head: SHA('a'), requiredChecks: [], inspection: { source: 'branch-api', protected: false } });
  assert.deepEqual(seen, ['/repos/owner/repo/branches/main']);
  gh.api = async () => { throw Object.assign(new Error('Denied'), { status: 403 }); };
  await assert.rejects(gh.protections('owner/repo', 'main', 'owner-policy'), /Denied/);
});
test('protected or unknown branches cannot use the unprotected path', async () => {
  const gh = new GitHub('fixture');
  gh.api = async path => {
    if (path.endsWith('/branches/main')) return { protected: true, commit: { sha: SHA('a') } };
    throw Object.assign(new Error('Protection API denied'), { status: 403 });
  };
  await assert.rejects(gh.protections('owner/repo', 'main', 'owner-policy'), /Protection API denied/);
  gh.api = async () => ({ commit: { sha: SHA('a') } });
  await assert.rejects(gh.protections('owner/repo', 'main', 'owner-policy'), /unknown/);
});

function adapter() {
  const check = { id: 1, name: 'test', head_sha: SHA('c'), status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: 22 } };
  const action = { id: 33, check_suite_id: 22, head_sha: SHA('c'), head_repository: { full_name: 'owner/repo' }, event: 'push', path: pin.path, status: 'completed', conclusion: 'success', run_attempt: 2 };
  const job = { check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/1', head_sha: SHA('c'), status: 'completed', conclusion: 'success' };
  const file = { type: 'file', sha: pin.blobSha };
  const gh = new GitHub('fixture');
  gh.list = async path => path.includes('/check-runs?') ? [check] : path.includes('/attempts/2/jobs') ? [job] : path.includes('/actions/runs?') ? [action] : assert.fail(`Unexpected ${path}`);
  gh.api = async path => { assert.equal(path, `/repos/owner/repo/contents/${pin.path}?ref=${SHA('c')}`); return file; };
  return { gh, check, action, job, file };
}
test('CI adapter binds the check to a successful exact-head push workflow, blob and latest attempt job', async () => {
  const f = adapter();
  const [result] = await f.gh.checks('owner/repo', SHA('c'), [15368], [pin]);
  assert.equal(result.provenanceVerified, true);
  assert.equal(result.runAttempt, 2);
  assert.equal(result.workflowBlobSha, pin.blobSha);
});

test('same-named push and PR checks are resolved by pinned source, never by success preference', async()=>{
  for(const conclusion of ['success','failure']) {
    const f=adapter();
    f.check.conclusion=f.action.conclusion=f.job.conclusion=conclusion;
    const original=f.gh.list;
    f.gh.list=async path=>path.includes('/check-runs?')?[f.check,{...f.check,id:99,conclusion:conclusion==='success'?'failure':'success',check_suite:{id:999}}]:original(path);
    const results=await f.gh.checks('owner/repo',SHA('c'),[15368],[pin]);
    assert.equal(results.length,1);assert.equal(results[0].id,'1');
    assert.equal(results[0].conclusion,conclusion);
    assert.equal(results[0].provenanceMatched,true);
    assert.equal(results[0].provenanceVerified,conclusion==='success');
  }
});

test('two independently matching push runs remain ambiguous instead of choosing a green result',async()=>{
  const f=adapter(), original=f.gh.list;
  f.gh.list=async path=>path.includes('/check-runs?')?[f.check,{...f.check,id:2,check_suite:{id:23}}]:path.includes('/actions/runs?')?[f.action,{...f.action,id:34,check_suite_id:23}]:path.includes('/runs/34/')?[{...f.job,check_run_url:'https://api.github.com/repos/owner/repo/check-runs/2'}]:original(path);
  const results=await f.gh.checks('owner/repo',SHA('c'),[15368],[pin]);
  assert.equal(results.length,2);assert.ok(results.every(r=>r.provenanceMatched));
});
for (const [name, mutate] of [
  ['untrusted app', f => { f.check.app.id = 999; }],
  ['wrong check suite', f => { f.action.check_suite_id = 99; }],
  ['wrong repo', f => { f.action.head_repository.full_name = 'other/repo'; }],
  ['manual event', f => { f.action.event = 'workflow_dispatch'; }],
  ['different workflow', f => { f.action.path = '.github/workflows/fake.yml'; }],
  ['modified workflow', f => { f.file.sha = SHA('d'); }],
  ['pending rerun', f => { f.action.status = 'in_progress'; }],
  ['different attempt job', f => { f.job.check_run_url += '9'; }],
]) test(`CI adapter rejects ${name}`, async () => {
  const f = adapter(); mutate(f);
  const [result] = await f.gh.checks('owner/repo', SHA('c'), [15368], [pin]);
  assert.equal(result.provenanceVerified, false);
});
