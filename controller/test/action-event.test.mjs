import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { canonical } from '../src/core.mjs';
import { verifyActionEnvelope, verifyActionEvent } from '../src/action-event.mjs';
import { KAIRO_REPOSITORY_ID } from '../src/owner-identity.mjs';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { relayActionEvent } from '../src/action-relay.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const now = Date.parse('2026-10-22T00:00:00Z');

test('actual hosted lifecycle signer script emits verifier-compatible bounded hints without Issue text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kairo-event-script-')); t.after(() => rm(dir, { recursive: true }));
  const workflow = (await readFile('examples/workflows/actions-public-caller.yml', 'utf8')).replaceAll('\r\n', '\n');
  const script = workflow.split("node <<'NODE'\n")[1].split('\n          NODE')[0].split('\n').map(line => line.slice(10)).join('\n');
  const path = join(dir, 'sign.cjs'), eventPath = join(dir, 'event.json'), outputPath = join(dir, 'output');
  await writeFile(path, script);
  const f = fixture(), env = { ...process.env, KAIRO_RUNNER_KEY: JSON.stringify(f.entry), GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath, GITHUB_REPOSITORY: f.entry.binding.repository, GITHUB_EVENT_NAME: 'issues', GITHUB_RUN_ID: '50', GITHUB_RUN_ATTEMPT: '1' };
  for (const action of ['opened', 'labeled', 'closed', 'reopened']) {
    const body = '$(never execute) `private instruction`';
    await writeFile(eventPath, JSON.stringify({ action, repository: { id: 123, owner: { id: 7 } }, issue: { number: 1, node_id: 'I_A', user: { id: 7 }, body } }));
    await writeFile(outputPath, '');
    execFileSync(process.execPath, [path], { env, cwd: dir, stdio: 'pipe' });
    const line = (await readFile(outputPath, 'utf8')).trim(); assert.ok(line.startsWith('envelope='));
    const envelope = JSON.parse(Buffer.from(line.slice(9), 'base64').toString('utf8'));
    assert.equal(verifyActionEnvelope(envelope, f.entry).eventAction, action);
    assert.ok(!JSON.stringify(envelope).includes(body)); assert.ok(!JSON.stringify(envelope).includes(f.entry.secret));
  }
  assert.doesNotMatch(workflow, /^\s*(schedule:|.*cron:)/m);
  assert.ok(!workflow.includes('${{ github.event.issue.body }}'));
});
function fixture() {
  const b = { repository: 'owner/app', repositoryId: '123', runnerId: 'private-core', bindingId: 'a'.repeat(32), ownerId: '7', workflowPath: '.github/workflows/kairo.yml', workflowBlob: 'b'.repeat(40) };
  const entry = { binding: b, secret: 'c'.repeat(64), kairoOwnerGitHubUserId: '7' };
  const payload = { schemaVersion: 3, repository: b.repository, repositoryId: b.repositoryId, runnerId: b.runnerId, bindingId: b.bindingId,
    runId: '50', runAttempt: 1, nonce: 'd'.repeat(32), issuedAt: now, expiresAt: now + 600000,
    eventName: 'issues', eventAction: 'opened', issueId: 'I_A', issueNumber: 1, relatedRunId: null };
  const sign = () => ({ payload: { ...payload }, signature: createHmac('sha256', Buffer.from(entry.secret, 'hex')).update(canonical(payload)).digest('hex') });
  const run = { id: 50, run_attempt: 1, event: 'issues', path: b.workflowPath, repository: { id: 123 }, head_repository: { id: 123 }, head_branch: 'main', head_sha: 'e'.repeat(40), actor: { id: 7 }, triggering_actor: { id: 7 }, status: 'in_progress' };
  const jobs = [{ name: 'sign-event', status: 'completed', conclusion: 'success', labels: ['ubuntu-latest'] }, { name: 'relay', status: 'in_progress', labels: ['ubuntu-latest'] }];
  const issue = { node_id: 'I_A', number: 1, user: { id: 7 } };
  const gh = { repository: async name => name === 'taco3064/kairo' ? { id: KAIRO_REPOSITORY_ID, owner: { id: 7, type: 'User' } } : { id: 123, private: false, owner: { id: 7 }, default_branch: 'main' },
    api: async path => path.includes('/contents/') ? { sha: b.workflowBlob } : path.includes('/issues/') ? issue : run,
    list: async () => jobs };
  const policy = { actorIds: ['7'], reconcileWorkflowPaths: ['.github/workflows/ci.yml'] };
  return { entry, payload, sign, run, jobs, issue, gh, policy };
}
test('actual Issue lifecycle hint can directly reach private Actions after the hosted signer job completes', async () => {
  const f = fixture();
  for (const action of ['opened', 'labeled', 'closed', 'reopened', 'assigned', 'unassigned']) {
    f.payload.eventAction = action;
    const result = await verifyActionEvent(f.gh, f.entry, f.sign(), f.policy, now);
    assert.equal(result.eventAction, action);
  }
  // The relay may still be running. There is no requirement for a background
  // controller to wait for and collect the whole public notification Run.
  assert.equal(f.run.status, 'in_progress');
});
test('event payload cannot select a stage, weaken grant requirements or enable schedules', () => {
  for (const patch of [{ operation: 'merge' }, { eventName: 'schedule' }, { eventAction: 'deleted' },
    { issueNumber: '../secrets' }, { repositoryId: '456' }, { expiresAt: now + 600001 }, { issuedAt: now + 1 }]) {
    const f = fixture(); Object.assign(f.payload, patch);
    assert.throws(() => verifyActionEnvelope(f.sign(), f.entry, now), { code: 'ACTION_EVENT_INVALID' });
  }
  const f = fixture(), envelope = f.sign(); envelope.payload.issueId = 'I_B';
  assert.throws(() => verifyActionEnvelope(envelope, f.entry, now), /HMAC/);
});

test('approved HMAC caller verifies event provenance without consulting signer Jobs', async()=>{
  const f=fixture();f.policy.signerVerification='hmac-workflow-pin';
  f.gh.list=async()=>assert.fail('Signer Jobs must not be queried');
  assert.equal((await verifyActionEvent(f.gh,f.entry,f.sign(),f.policy,now)).issueId,'I_A');
  f.run.actor.id++;await assert.rejects(verifyActionEvent(f.gh,f.entry,f.sign(),f.policy,now),{code:'ACTION_EVENT_INVALID'});
});
test('forks, wrong actors, unfinished signer, self-hosted signer and handwritten foreign Issue are refused', async () => {
  const changes = [f => f.run.head_repository.id++, f => f.run.actor.id++, f => f.run.triggering_actor.id++,
    f => f.jobs[0].labels.push('self-hosted'),
    f => f.jobs[0].conclusion = 'failure', f => f.issue.user.id++, f => f.issue.node_id = 'I_B'];
  for (const mutate of changes) { const f = fixture(); mutate(f); await assert.rejects(verifyActionEvent(f.gh, f.entry, f.sign(), f.policy, now), { code: 'ACTION_EVENT_INVALID' }); }
});

test('unfinished or missing signer waits without granting execution; terminal and ambiguous evidence is rejected', async () => {
  for (const status of ['queued','waiting','pending','in_progress']) {
    const f=fixture(); f.jobs[0].status=status; f.jobs[0].conclusion=null;
    await assert.rejects(verifyActionEvent(f.gh,f.entry,f.sign(),f.policy,now),{code:'ACTION_EVENT_SIGNER_PENDING'});
    f.jobs[0].labels.push('self-hosted');
    await assert.rejects(verifyActionEvent(f.gh,f.entry,f.sign(),f.policy,now),{code:'ACTION_EVENT_INVALID'});
  }
  const f=fixture(); f.jobs.length=0;
  await assert.rejects(verifyActionEvent(f.gh,f.entry,f.sign(),f.policy,now),{code:'ACTION_EVENT_SIGNER_PENDING'});
});

test('pending relay creates no write intent and fresh completion dispatches exactly once',async t=>{
  const f=fixture(),stateDirectory=await mkdtemp(join(tmpdir(),'kairo-relay-readback-'));t.after(()=>rm(stateDirectory,{recursive:true}));
  f.payload.issuedAt=Date.now();f.payload.expiresAt=f.payload.issuedAt+600000;
  let writes=0,fresh=0;const original=f.gh.api;
  f.gh.api=async(path,method)=>{if(method==='POST'){writes++;return null;}return original(path);};
  f.gh.freshReadObservation=async work=>{fresh++;return work();};
  const context={github:f.gh,entry:f.entry,policy:f.policy,stateDirectory,execution:{repository:'taco3064/kairo',workflowPath:'.github/workflows/action-stage.yml',ref:'main'}};
  f.jobs[0].status='queued';f.jobs[0].conclusion=null;
  await assert.rejects(relayActionEvent(context,f.sign()),{code:'ACTION_EVENT_SIGNER_PENDING'});
  assert.equal(writes,0);assert.deepEqual(await readdir(stateDirectory),[]);
  f.jobs[0].status='completed';f.jobs[0].conclusion='success';
  assert.equal((await relayActionEvent(context,f.sign())).status,'DISPATCH_ACCEPTED');
  assert.equal((await relayActionEvent(context,f.sign())).status,'DUPLICATE');
  assert.equal(writes,1);assert.equal(fresh,3);
});
