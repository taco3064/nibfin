import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyActionRun, requireDistinctActionRuns, requireFreshActionRun } from '../src/action-provenance.mjs';

test('Owner continuation accepts grouped history but never reuses a current Run or invalid identity',()=>{
 const identity=runId=>({kind:'github-action-stage',repository:'owner/control',runId,runAttempt:1,identityHash:'verified'}),old=identity('50'),current=identity('60');
 assert.doesNotThrow(()=>requireFreshActionRun([old,old],current,{controlMode:'owner-project'}));
 assert.throws(()=>requireFreshActionRun([old,old],current,{}),/share an Actions Run/);
 for(const history of [[old,current],[old,{...current,runAttempt:2}],[null],[{...old,identityHash:null}]])assert.throws(()=>requireFreshActionRun(history,current,{controlMode:'owner-project'}));
 assert.throws(()=>requireFreshActionRun([],null,{controlMode:'owner-project'}));
});

function fixture() {
  const policy = { repository: 'owner/control', repositoryId: '123', workflowPath: '.github/workflows/stage.yml', workflowBlob: 'a'.repeat(40), actorIds: ['7'], runnerIds: [9], runnerName: 'coordinator', jobName: 'execute' };
  const identity = { runId: '50', attempt: 2, jobId: '80' };
  const state = { repository: { id: 123, private: true, default_branch: 'main' },
    run: { id: 50, run_attempt: 2, repository: { id: 123, full_name: 'owner/control' }, path: policy.workflowPath, event: 'workflow_dispatch', actor: { id: 7 }, triggering_actor: { id: 7 }, head_sha: 'b'.repeat(40), status: 'in_progress' },
    jobs: [{ id: 80, runner_id: 9, runner_name: 'coordinator', name: 'execute', head_sha: 'b'.repeat(40), status: 'in_progress' }], blob: policy.workflowBlob };
  const gh = { repository: async () => state.repository, api: async path => path.includes('/contents/') ? { sha: state.blob } : state.run, list: async () => state.jobs };
  return { policy, identity, state, gh };
}

test('effective workflow pin retains historical Run identity and rejects unexpected current or old bytes',async()=>{
 const f=fixture(),original=f.policy.workflowBlob,newPin='c'.repeat(40),api=f.gh.api;
 const before=await verifyActionRun(f.gh,f.policy,f.identity);
 f.policy={...f.policy,workflowBlob:newPin,previousWorkflowBlob:original};
 let runPin=original,currentPin=newPin;
 f.gh.api=async path=>path.includes('/contents/')?{sha:path.endsWith('ref=main')?currentPin:runPin}:api(path);
 assert.equal((await verifyActionRun(f.gh,f.policy,f.identity)).identityHash,before.identityHash);
 runPin=newPin;assert.equal((await verifyActionRun(f.gh,f.policy,f.identity)).workflowBlob,newPin);
 runPin='d'.repeat(40);await assert.rejects(verifyActionRun(f.gh,f.policy,f.identity),/pin changed/);
 runPin=original;currentPin=original;await assert.rejects(verifyActionRun(f.gh,f.policy,f.identity),/pin changed/);
 currentPin=newPin;f.policy.previousWorkflowBlob='untrusted';await assert.rejects(verifyActionRun(f.gh,f.policy,f.identity),/historical/);
});

test('display-only workflow update retains both approved historical generations and rejects unapproved bytes',async()=>{
 const f=fixture(),current='c'.repeat(40),previous='d'.repeat(40),original=f.policy.workflowBlob,api=f.gh.api;
 f.policy={...f.policy,workflowBlob:current,previousWorkflowBlob:previous,originalWorkflowBlob:original};let runPin=original;
 f.gh.api=async path=>path.includes('/contents/')?{sha:path.endsWith('ref=main')?current:runPin}:api(path);
 for(const pin of [original,previous,current]){runPin=pin;assert.equal((await verifyActionRun(f.gh,f.policy,f.identity)).workflowBlob,pin);}
 runPin='e'.repeat(40);await assert.rejects(verifyActionRun(f.gh,f.policy,f.identity),/pin changed/);
 f.policy.originalWorkflowBlob='main';await assert.rejects(verifyActionRun(f.gh,f.policy,f.identity),/original workflow/);
});

test('approved local gh identity never queries current or predecessor Job status', async () => {
  const f=fixture();Object.assign(f.policy,{identityMode:'local-gh',ownerId:'7'});
  const api=f.gh.api;f.gh.api=async path=>path==='/user'?{id:7,type:'User'}:api(path);
  f.gh.list=async()=>assert.fail('No Job identity or completion polling');
  f.state.run.status='queued';f.state.jobs=[];
  const first=await verifyActionRun(f.gh,f.policy,f.identity);
  const previous=await verifyActionRun(f.gh,f.policy,f.identity,{completed:true});
  assert.equal(first.authentication,'local-gh');assert.equal(first.operatorId,'7');
  assert.equal(first.jobId,null);assert.equal(first.jobKey,'execute');assert.equal(first.identityHash,previous.identityHash);
  f.policy.ownerId='8';await assert.rejects(verifyActionRun(f.gh,f.policy,f.identity),/gh login/);
});
test('stage provenance independently resolves exact private Run/Attempt/job, enrolled actor, pins and runner', async () => {
  const f = fixture(), r = await verifyActionRun(f.gh, f.policy, f.identity);
  assert.equal(r.runId, '50'); assert.equal(r.runAttempt, 2); assert.equal(r.jobId, '80');
  assert.match(r.url, /runs\/50\/attempts\/2$/);
  assert.equal(requireDistinctActionRuns([r]), undefined);
  assert.throws(() => requireDistinctActionRuns([r, { ...r, runAttempt: 3 }]), /share an Actions Run/);
});
test('public execution, forged event/actor, stale attempt, wrong runner and changed workflow fail closed', async () => {
  const mutations = [f => f.state.repository.private = false, f => f.state.repository.id++,
    f => f.state.run.event = 'schedule', f => f.state.run.event = 'issues',
    f => f.state.run.triggering_actor.id++, f => f.state.run.actor.id++,
    f => f.state.run.run_attempt++, f => f.state.run.repository.id++,
    f => f.state.run.path = '.github/workflows/other.yml', f => f.state.jobs[0].runner_id++,
    f => f.state.jobs[0].head_sha = 'c'.repeat(40), f => f.state.jobs.push({ ...f.state.jobs[0] }),
    f => f.state.blob = 'c'.repeat(40), f => f.state.jobs[0].status = 'completed',
    f => f.policy.actorIds = [], f => f.identity.runId = '../secrets'];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(verifyActionRun(f.gh, f.policy, f.identity), { code: 'ACTION_PROVENANCE_INVALID' }); }
});
test('previous-stage handoff needs both Run and exact job to have independently completed successfully', async () => {
  const f = fixture();
  await assert.rejects(verifyActionRun(f.gh, f.policy, f.identity, { completed: true }));
  Object.assign(f.state.run, { status: 'completed', conclusion: 'success' });
  Object.assign(f.state.jobs[0], { status: 'completed', conclusion: 'failure' });
  await assert.rejects(verifyActionRun(f.gh, f.policy, f.identity, { completed: true }));
  f.state.jobs[0].conclusion = 'success';
  assert.equal((await verifyActionRun(f.gh, f.policy, f.identity, { completed: true })).runId, '50');
});

test('hosted handoff may still be active only after every execution prerequisite succeeded', async () => {
  const f = fixture(); f.policy.handoffJobName = 'handoff';
  Object.assign(f.state.jobs[0], { status: 'completed', conclusion: 'success' });
  f.state.jobs.push({ id: 81, name: 'resolve', status: 'completed', conclusion: 'success' }, { id: 82, name: 'handoff', status: 'in_progress' });
  assert.equal((await verifyActionRun(f.gh, f.policy, f.identity, { completed: true })).runId, '50');
  f.state.jobs[1].conclusion = 'failure';
  await assert.rejects(verifyActionRun(f.gh, f.policy, f.identity, { completed: true }));
  f.state.jobs[1].conclusion = 'success'; f.state.run.conclusion = 'cancelled';
  await assert.rejects(verifyActionRun(f.gh, f.policy, f.identity, { completed: true }));
});
