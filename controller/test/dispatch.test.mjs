import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRoot, readBindings, rootIdentity, bindingSecret, signDispatch, verifyDispatch, enrollBinding } from '../src/runner-binding.mjs';
import { dispatchFromZip, verifyOrigin, downloadDispatch, pollDispatch, dispatchGrantIdentity, watchDispatch } from '../src/dispatch.mjs';
import { KAIRO_REPOSITORY, KAIRO_REPOSITORY_ID } from '../src/owner-identity.mjs';
import { Store } from '../src/store.mjs';
import { digest, plan } from '../src/core.mjs';
import { fixture, NOW } from './fixtures.mjs';
import { execFileSync } from 'node:child_process';

const descriptor = (runnerId = 'trusted-runner') => ({ runnerId, repository: 'example/one', repositoryId: '123', ownerId: '77', bindingId: 'a'.repeat(32), workflowPath: '.github/workflows/kairo.yml', workflowBlob: 'b'.repeat(40) });
function envelope(entry, now = Date.now()) {
  const b = entry.binding;
  return signDispatch({ schemaVersion: 1, operation: 'reevaluate', runnerId: b.runnerId, repository: b.repository, repositoryId: b.repositoryId, bindingId: b.bindingId, runId: '456', runAttempt: 1, nonce: 'c'.repeat(32), issuedAt: now, expiresAt: now + 86400000 }, entry.secret);
}
function zip(value, name = 'dispatch.json') {
  const data = Buffer.from(JSON.stringify(value)), filename = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kairo-dispatch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { kairoOwnerGitHubUserId: '77', runnerId: 'trusted-runner', stateDirectory: join(dir, 'state'), publicRunner: { rootKeyPath: join(dir, 'root'), registryPath: join(dir, 'registry') } };
  const { rootId } = await createRoot(config.publicRunner.rootKeyPath);
  const b = descriptor(), registry = { runnerId: config.runnerId, bindings: [{ binding: structuredClone(b), active: true }] };
  await writeFile(config.publicRunner.registryPath, JSON.stringify(registry));
  const policy = { kairoOwnerGitHubUserId: '77', runnerId: config.runnerId, publicRunner: { rootId, bindings: { [b.repository]: b } } };
  const entry = (await readBindings(config, policy))[b.repository];
  const message = envelope(entry), bytes = zip(message);
  const artifact = { id: 9, name: 'kairo-dispatch', expired: false, size_in_bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, workflow_run: { id: 456, repository_id: 123, head_repository_id: 123 } };
  const run = { event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_attempt: 1, repository: { id: 123 }, head_repository: { id: 123 }, head_branch: 'main', head_sha: 'd'.repeat(40), path: b.workflowPath, actor: { id: 77 }, triggering_actor: { id: 77 } };
  const github = {
    token: 'controller-secret', repository: async name => name === KAIRO_REPOSITORY ? { id: KAIRO_REPOSITORY_ID, owner: { id: 77, type: 'User' } } : ({ private: false, id: 123, owner: { id: 77, type: 'User' }, default_branch: 'main' }),
    api: async path => path.includes('/contents/') ? { sha: b.workflowBlob } : run,
    list: async path => path.endsWith('/jobs') ? [{ name: 'preflight', status: 'completed', conclusion: 'success', labels: ['ubuntu-latest'] }] : [artifact],
    fetch: async (url, options) => {
      if (url.startsWith('https://api.github.com/')) { assert.equal(options.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://test.blob.core.windows.net/artifact' } }); }
      assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error');
      return new Response(bytes);
    },
  };
  return { config, policy, entry, message, bytes, artifact, run, github, registry };
}
test('per-repository derived keys never disclose root and cannot route to another runner', async t => {
  const f = await setup(t), root = Buffer.from((await readFile(f.config.publicRunner.rootKeyPath, 'utf8')).trim(), 'hex');
  assert.notEqual(f.entry.secret, root.toString('hex'));
  assert.equal(rootIdentity(root), f.policy.publicRunner.rootId);
  assert.equal(verifyDispatch(f.message, f.entry).runnerId, 'trusted-runner');
  for (const change of [{ runnerId: 'laptop-b' }, { repositoryId: '124' }, { bindingId: 'b'.repeat(32) }]) {
    const binding = { ...f.entry.binding, ...change };
    assert.throws(() => verifyDispatch(f.message, { binding, secret: bindingSecret(root, binding) }));
  }
  const bad = structuredClone(f.message); bad.payload.shell = 'arbitrary command';
  assert.throws(() => verifyDispatch(signDispatch(bad.payload, f.entry.secret), f.entry), /invalid/);
  assert.throws(() => verifyDispatch(f.message, f.entry, f.message.payload.expiresAt), /expired/);
  assert.throws(() => verifyDispatch({ ...f.message, signature: '0'.repeat(64) }, f.entry), /signature/);
});
test('local revocation, rotation and machine identity changes invalidate existing messages', async t => {
  const f = await setup(t);
  f.registry.bindings[0].active = false;
  await writeFile(f.config.publicRunner.registryPath, JSON.stringify(f.registry));
  await assert.rejects(readBindings(f.config, f.policy), /revoked/);
  f.registry.bindings[0].active = true; f.registry.bindings[0].binding.bindingId = 'd'.repeat(32);
  await writeFile(f.config.publicRunner.registryPath, JSON.stringify(f.registry));
  await assert.rejects(readBindings(f.config, f.policy), /rotated/);
  f.policy.publicRunner.rootId = 'e'.repeat(64);
  await assert.rejects(readBindings(f.config, f.policy), /machine identity/);
});
test('fresh GitHub origin refuses fork, foreign actor, rerun, failed run and changed workflow', async t => {
  const f = await setup(t);
  await verifyOrigin(f.github, f.entry, f.message);
  for (const patch of [{ event: 'pull_request' }, { actor: { id: 78 } }, { triggering_actor: { id: 78 } }, { head_repository: { id: 124 } }, { run_attempt: 2 }, { conclusion: 'failure' }, { head_branch: 'feature' }]) {
    const original = structuredClone(f.run); Object.assign(f.run, patch);
    await assert.rejects(verifyOrigin(f.github, f.entry, f.message), /origin/);
    Object.assign(f.run, original);
  }
  f.github.api = async path => path.includes('/contents/') ? { sha: '0'.repeat(40) } : f.run;
  await assert.rejects(verifyOrigin(f.github, f.entry, f.message), /pin/);
});
test('bounded artifact download drops controller authorization and validates archive identity', async t => {
  const f = await setup(t);
  assert.deepEqual(await downloadDispatch(f.github, 'example/one', f.artifact), f.message);
  await assert.rejects(downloadDispatch(f.github, 'example/one', { ...f.artifact, digest: 'sha256:bad' }), /digest/);
  f.github.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/x' } });
  await assert.rejects(downloadDispatch(f.github, 'example/one', f.artifact), /origin/);
  assert.throws(() => dispatchFromZip(zip(f.message, '../dispatch.json')), /entry/);
  assert.throws(() => dispatchFromZip(Buffer.alloc(65537)), /large/);
});

test('Issue wake-ups bind the event, live owner-created Issue, and trusted workflow without widening authority', async t => {
  const f = await setup(t), issue = { number: 12, node_id: 'I_owner_issue', user: { id: 77 } };
  const api = f.github.api;
  f.github.api = async path => path.endsWith('/issues/12') ? issue : api(path);
  f.run.event = 'issues';
  const payload = { ...f.message.payload, schemaVersion: 2, eventName: 'issues', eventAction: 'edited', issueId: issue.node_id, issueNumber: 12 };
  const signed = () => signDispatch(payload, f.entry.secret);
  for (const action of ['opened', 'edited', 'labeled', 'unlabeled', 'reopened', 'closed', 'milestoned', 'demilestoned']) {
    payload.eventAction = action;
    assert.equal((await verifyOrigin(f.github, f.entry, signed())).issueNumber, 12);
  }
  // An old valid HMAC has no Issue event binding and cannot be repurposed.
  await assert.rejects(verifyOrigin(f.github, f.entry, f.message), /origin/);
  const original = structuredClone(issue);
  for (const patch of [{ user: { id: 78 } }, { node_id: 'I_replaced' }, { number: 13 }, { pull_request: { url: 'untrusted' } }]) {
    Object.assign(issue, patch);
    await assert.rejects(verifyOrigin(f.github, f.entry, signed()), /Issue/);
    for (const key of Object.keys(issue)) delete issue[key]; Object.assign(issue, original);
  }
  for (const patch of [{ eventAction: 'deleted' }, { issueNumber: '../secrets' }, { issueId: '' }, { eventName: 'pull_request' }, { eventName: 'schedule' }]) {
    const invalid = signDispatch({ ...payload, ...patch }, f.entry.secret);
    assert.throws(() => verifyDispatch(invalid, f.entry), /invalid/);
  }
  const tampered = signed(); tampered.payload.issueNumber = 13;
  assert.throws(() => verifyDispatch(tampered, f.entry), /signature/);
  payload.eventName = 'workflow_dispatch'; payload.eventAction = ''; payload.issueId = null; payload.issueNumber = null;
  await assert.rejects(verifyOrigin(f.github, f.entry, signed()), /origin/);
  for (const event of ['workflow_dispatch', 'schedule']) {
    payload.eventName = event; f.run.event = event;
    await verifyOrigin(f.github, f.entry, signed());
  }
});

test('duplicate Issue notifications recompute once and still require a signed grant', async t => {
  const f = await setup(t); let invoked = 0;
  const message = signDispatch({ ...f.message.payload, schemaVersion: 2, eventName: 'issues', eventAction: 'labeled', issueId: 'I_owner_issue', issueNumber: 12 }, f.entry.secret);
  const bytes = zip(message);
  f.artifact.size_in_bytes = bytes.length; f.artifact.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const fetch = f.github.fetch; f.github.fetch = async (url, options) => url.startsWith('https://api.github.com/') ? fetch(url, options) : new Response(bytes);
  const api = f.github.api; f.github.api = async path => path.endsWith('/issues/12') ? { number: 12, node_id: 'I_owner_issue', user: { id: 77 } } : api(path);
  f.run.event = 'issues';
  const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => { throw new Error('No signed grant'); }, resume: async () => { invoked++; return { status: 'COMPLETE' }; } };
  await assert.rejects(pollDispatch(runtime), /No signed grant/); assert.equal(invoked, 0);
  runtime.grant = async () => ({ manifest: { id: 'cohort' }, policy: f.policy });
  assert.equal((await pollDispatch(runtime)).status, 'COMPLETE');
  assert.equal((await pollDispatch(runtime)).status, 'WAITING'); assert.equal(invoked, 1);
});
test('dispatch is durable, one-use across restarts and cannot invoke without a grant', async t => {
  const f = await setup(t); let invoked = 0;
  const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => ({ manifest: { id: 'cohort' }, policy: f.policy }), resume: async () => { invoked++; return { status: 'COMPLETE' }; } };
  assert.equal((await pollDispatch(runtime)).status, 'COMPLETE');
  assert.equal((await pollDispatch(runtime)).status, 'WAITING'); assert.equal(invoked, 1);
  const record = await new Store(f.config.stateDirectory, `dispatch:${f.policy.publicRunner.rootId}`).read();
  assert.equal(record.seen.length, 2); assert.equal(record.active, null);
  runtime.grant = async () => { throw new Error('No signed grant'); };
  await assert.rejects(pollDispatch(runtime), /No signed grant/); assert.equal(invoked, 1);
});
test('offline target and invalid dispatch never call Agent or reassign to another machine', async t => {
  const f = await setup(t); let invoked = 0;
  const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => ({ manifest: { id: 'cohort' }, policy: f.policy }), resume: async () => { invoked++; } };
  f.github.list = async () => [];
  assert.equal((await pollDispatch(runtime)).status, 'WAITING'); assert.equal(invoked, 0);
  f.config.runnerId = 'laptop-b';
  await assert.rejects(pollDispatch(runtime), /machine mismatch/); assert.equal(invoked, 0);
});

test('a valid dispatch from A cannot activate a public cohort while B has no key proof', async t => {
  const f = await setup(t);
  const b = { ...descriptor(), repository: 'example/two', repositoryId: '124', bindingId: 'b'.repeat(32) };
  f.policy.publicRunner.bindings[b.repository] = b;
  f.registry.bindings.push({ binding: b, active: true });
  await writeFile(f.config.publicRunner.registryPath, JSON.stringify(f.registry));
  const list = f.github.list;
  f.github.list = async path => path.includes('/example/two/') ? [] : list(path);
  let invoked = 0;
  const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => ({ manifest: { id: 'cohort' }, policy: f.policy }), resume: async () => { invoked++; } };
  assert.equal((await pollDispatch(runtime)).status, 'WAITING');
  assert.equal((await pollDispatch(runtime)).status, 'WAITING');
  assert.equal(invoked, 0);
  const record = await new Store(f.config.stateDirectory, `dispatch:${f.policy.publicRunner.rootId}`).read();
  assert.deepEqual(Object.keys(record.pendingDispatches), ['example/one']);
});

test('a crash after dispatch consumption resumes its durable activation without consuming twice', async t => {
  const f = await setup(t); let invoked = 0;
  const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => ({ manifest: { id: 'cohort' }, policy: f.policy }), resume: async () => { if (++invoked === 1) throw new Error('interrupted'); return { status: 'COMPLETE' }; } };
  await assert.rejects(pollDispatch(runtime), /interrupted/);
  assert.equal(runtime.publicDispatch, null);
  assert.equal((await pollDispatch(runtime)).status, 'COMPLETE');
  assert.equal((await pollDispatch(runtime)).status, 'WAITING');
  assert.equal(invoked, 2);
});

async function expiredActivation(f) {
  const grant = { manifest: { id: 'cohort' }, policy: f.policy };
  const old = envelope(f.entry, Date.now() - 86401000);
  old.payload.runId = '455'; old.payload.nonce = 'e'.repeat(32);
  const signed = signDispatch(old.payload, f.entry.secret);
  const store = new Store(f.config.stateDirectory, `dispatch:${f.policy.publicRunner.rootId}`);
  await store.transaction(0, s => ({ ...s, active: { grantHash: dispatchGrantIdentity(grant), envelopes: { 'example/one': signed } }, seen: [digest({ bindingId: signed.payload.bindingId, nonce: signed.payload.nonce })] }));
  return { grant, store };
}
test('expired active dispatch waits, then renews the same grant without changing candidate evidence', async t => {
  const f = await setup(t), { grant, store } = await expiredActivation(f);
  const cohort = new Store(f.config.stateDirectory, 'cohort');
  await cohort.transaction(0, s => ({ ...s, candidate: 'immutable-tree', accept: 'independent-review', ci: 'exact-head' }));
  const before = await cohort.read(); let invoked = 0;
  const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => grant, resume: async () => { invoked++; assert.deepEqual(await cohort.read(), before); return { status: 'COMPLETE' }; } };
  const list = f.github.list; f.github.list = async path => path.includes('/artifacts') ? [] : list(path);
  assert.equal((await pollDispatch(runtime)).status, 'WAITING'); assert.equal(invoked, 0);
  assert.equal((await store.read()).renewalGrantHash, dispatchGrantIdentity(grant));
  f.github.list = list;
  assert.equal((await pollDispatch(runtime)).status, 'COMPLETE'); assert.equal(invoked, 1);
  assert.equal((await pollDispatch(runtime)).status, 'WAITING'); assert.equal(invoked, 1);
});
test('expiry cannot downgrade tampered workflows or a changed grant into automatic renewal', async t => {
  const f = await setup(t), { grant, store } = await expiredActivation(f);
  const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => grant, resume: async () => assert.fail('must not execute') };
  const api = f.github.api;
  f.github.api = async path => path.includes('/contents/') ? { sha: 'f'.repeat(40) } : api(path);
  await assert.rejects(pollDispatch(runtime), /pin changed/);
  assert.ok((await store.read()).active);
  f.github.api = api;
  f.github.list = async path => path.endsWith('/jobs') ? [{ name: 'preflight', status: 'completed', conclusion: 'success', labels: ['ubuntu-latest'] }] : [];
  assert.equal((await pollDispatch(runtime)).status, 'WAITING');
  grant.recordId = 'replacement-authority';
  await assert.rejects(pollDispatch(runtime), /Renewal authority changed/);
});
test('expiry signal at a stage boundary returns to polling and reenters runtime gates', async t => {
  const f = await setup(t); let calls = 0;
  const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => ({ manifest: { id: 'cohort' }, policy: f.policy }), resume: async () => { if (++calls === 1) throw Object.assign(new Error('expired'), { code: 'DISPATCH_EXPIRED' }); return { status: 'COMPLETE' }; } };
  assert.equal((await pollDispatch(runtime)).code, 'DISPATCH_EXPIRED');
  assert.equal((await pollDispatch(runtime)).status, 'COMPLETE'); assert.equal(calls, 2);
});
test('watcher retries only transient reads, never ambiguous writes or authority failures', async () => {
  let reads = 0, waits = 0;
  const runtime = { environment: {}, grant: async () => { reads++; throw Object.assign(new Error('unavailable'), { requestMethod: 'GET', status: 503 }); } };
  assert.equal((await watchDispatch(runtime, { maxPolls: 2, delay: async () => { waits++; } })).status, 'WAITING');
  assert.equal(reads, 2); assert.equal(waits, 1);
  runtime.grant = async () => { throw Object.assign(new Error('ambiguous write'), { requestMethod: 'PUT', status: 503 }); };
  await assert.rejects(watchDispatch(runtime, { maxPolls: 2, delay: async () => assert.fail('no retry') }), /ambiguous write/);
});

test('public watcher waits for a proven rate reset then completes the same authorized dispatch',async t=>{
  const f=await setup(t);let now=Date.now(),reads=0,executions=0;
  const reset=now+121000;
  const runtime={config:f.config,environment:{},github:f.github,grant:async()=>{if(++reads===1)throw Object.assign(new Error('rate limit'),{code:'GITHUB_RATE_LIMIT',requestMethod:'GET',status:403,retryAt:reset});assert.ok(now>=reset);return {manifest:{id:'cohort'},policy:f.policy};},resume:async()=>{executions++;return {status:'COMPLETE'};}};
  assert.equal((await watchDispatch(runtime,{maxPolls:2,now:()=>now,delay:async ms=>{assert.ok(ms<=60000);now+=ms;}})).status,'COMPLETE');
  assert.equal(executions,1);assert.equal(reads,2);
  runtime.grant=async()=>{throw Object.assign(new Error('permission denied'),{requestMethod:'GET',status:403});};
  await assert.rejects(watchDispatch(runtime,{delay:async()=>assert.fail('denial must stop')}),/permission denied/);
});
test('Core requires public binding plus independent grant and preserves the normal first stage', () => {
  const f = fixture(), b = descriptor();
  f.policy.kairoOwnerGitHubUserId = '77';
  f.policy.publicRunner = { rootId: 'a'.repeat(64), bindings: { 'example/one': b } };
  for (const i of Object.values(f.snapshot.issues)) if (i.repository === b.repository) { i.visibility = 'public'; i.runnerBinding = b; i.creatorGitHubUserId = '77'; }
  f.snapshot.runtime.publicDispatch = { kind: 'public-runner-dispatch', kairoOwnerGitHubUserId: '77', rootId: f.policy.publicRunner.rootId };
  f.snapshot.policyHash = f.snapshot.approval.policyHash = digest(f.policy);
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).operation, 'shape');
  delete f.snapshot.runtime.publicDispatch;
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'PUBLIC_EXECUTION_BLOCKED');
  delete f.snapshot.approval;
  assert.equal(plan(f.manifest, f.policy, f.snapshot, NOW).code, 'NO_GRANT');
});

test('actual hosted caller script emits nothing without key and interoperates with private verifier', async t => {
  const f = await setup(t), dir = join(f.config.stateDirectory, '..');
  const workflow = await readFile('examples/workflows/public-caller.yml', 'utf8');
  const code = workflow.split("node <<'NODE'\n")[1].split('\n          NODE')[0].split('\n').map(line => line.slice(10)).join('\n');
  const script = join(dir, 'caller.cjs'); await writeFile(script, code);
  const env = { ...process.env, KAIRO_RUNNER_KEY: '', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'example/one', REPOSITORY_ID: '123', OWNER_ID: '77', ACTOR_ID: '77', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: join(dir, 'output') };
  const output = execFileSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
  assert.match(output, /no dispatch/);
  await assert.rejects(readFile(join(dir, 'dispatch.json')), { code: 'ENOENT' });
  env.KAIRO_RUNNER_KEY = JSON.stringify(f.entry);
  const stdout = execFileSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(stdout, '');
  const text = await readFile(join(dir, 'dispatch.json'), 'utf8');
  assert.ok(!text.includes(f.entry.secret));
  assert.equal(verifyDispatch(JSON.parse(text), f.entry).repositoryId, '123');
  env.ACTOR_ID = '78';
  assert.throws(() => execFileSync(process.execPath, [script], { cwd: dir, env, stdio: 'pipe' }), /Command failed/);
});

test('actual Issue caller signs only owner updates of owner-created Issues and never interpolates Issue text', async t => {
  const f = await setup(t), dir = join(f.config.stateDirectory, '..');
  const workflow = await readFile('examples/workflows/public-caller.yml', 'utf8');
  assert.match(workflow, /issues:\n\s+types: \[opened, edited, labeled, unlabeled, reopened, closed, milestoned, demilestoned\]/);
  assert.doesNotMatch(workflow, /^\s*(schedule:|.*cron:)/m);
  assert.doesNotMatch(await readFile('examples/workflows/private-caller.yml', 'utf8'), /^\s*(schedule:|.*cron:)/m);
  assert.ok(!workflow.includes('${{ github.event.issue.body }}'));
  const code = workflow.split("node <<'NODE'\n")[1].split('\n          NODE')[0].split('\n').map(line => line.slice(10)).join('\n');
  const script = join(dir, 'issue-caller.cjs'), eventPath = join(dir, 'event.json'); await writeFile(script, code);
  const env = { ...process.env, KAIRO_RUNNER_KEY: JSON.stringify(f.entry), GITHUB_EVENT_NAME: 'issues', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'example/one', REPOSITORY_ID: '123', OWNER_ID: '77', ACTOR_ID: '77', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: join(dir, 'output') };
  const event = { action: 'edited', repository: { id: 123, owner: { id: 77 } }, sender: { id: 77 }, issue: { number: 12, node_id: 'I_owner_issue', user: { id: 77 }, body: '$(arbitrary shell) `unsafe`' } };
  const run = async value => { await rm(join(dir, 'dispatch.json'), { force: true }); await writeFile(eventPath, JSON.stringify(value)); return execFileSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' }); };
  await run(event);
  const emitted = JSON.parse(await readFile(join(dir, 'dispatch.json'), 'utf8'));
  assert.equal(verifyDispatch(emitted, f.entry).issueId, 'I_owner_issue');
  assert.ok(!JSON.stringify(emitted).includes(event.issue.body));
  for (const patch of [{ sender: { id: 78 } }, { repository: { id: 124, owner: { id: 77 } } }, { action: 'deleted' }, { issue: { ...event.issue, user: { id: 78 } } }, { issue: { ...event.issue, pull_request: {} } }]) {
    assert.match(await run({ ...event, ...patch }), /no dispatch/);
    await assert.rejects(readFile(join(dir, 'dispatch.json')), { code: 'ENOENT' });
  }
  env.GITHUB_EVENT_NAME = 'pull_request';
  await assert.rejects(run(event), /Command failed/);
});

test('enrollment pins the exact caller, rotates per-repository secrets and never exports the root', async t => {
  const f = await setup(t), template = await readFile('examples/workflows/public-caller.yml', 'utf8');
  const gh = { repository: async name => name === KAIRO_REPOSITORY ? { id: KAIRO_REPOSITORY_ID, owner: { id: 77, type: 'User' } } : ({ private: false, id: 123, owner: { id: 77, type: 'User' }, default_branch: 'main', permissions: { admin: true } }), api: async path => path === '/user' ? { id: 77, type: 'User' } : { sha: 'b'.repeat(40), encoding: 'base64', content: Buffer.from(template).toString('base64') } };
  const secretFile = join(f.config.stateDirectory, '..', 'secret');
  const result = await enrollBinding(f.config, gh, 'example/one', secretFile, template);
  assert.equal(result.executionAuthorized, false);
  const key = JSON.parse(await readFile(secretFile, 'utf8'));
  assert.notEqual(key.secret, (await readFile(f.config.publicRunner.rootKeyPath, 'utf8')).trim());
  assert.notEqual(key.binding.bindingId, f.entry.binding.bindingId);
  await assert.rejects(readBindings(f.config, f.policy), /rotated/);
  await assert.rejects(enrollBinding(f.config, gh, 'example/one', secretFile + '2', 'different'), /exact hosted/);
});

const boundedWatch = { maxPolls: 1, continuationOptions: { maxPasses: 2, delay: async () => {} } };
test('service wakes after bounded CI wait and completes the same durable activation', async t => {
  const f = await setup(t); let calls = 0, grants = 0;
  const grant = { manifest: { id: 'cohort' }, policy: f.policy };
  const store = new Store(f.config.stateDirectory, 'dispatch:' + f.policy.publicRunner.rootId);
  const runtime = { config: f.config, environment: {}, github: f.github,
    grant: async () => { grants++; return grant; },
    resume: async () => { calls++; assert.equal(runtime.publicDispatch.grantHash, dispatchGrantIdentity(grant)); return calls <= 2 ? { status: 'BLOCKED', code: 'CI_PENDING_OR_FAILED' } : { status: 'COMPLETE' }; } };
  assert.equal((await watchDispatch(runtime, boundedWatch)).status, 'WAITING');
  const waiting = await store.read(); assert.ok(waiting.active); assert.equal(calls, 2);
  // A new service invocation uses only persisted state, not the old runtime.
  const restarted = { ...runtime, publicDispatch: undefined };
  restarted.resume = async () => { calls++; assert.deepEqual(restarted.publicDispatch, waiting.active); return { status: 'COMPLETE' }; };
  assert.equal((await watchDispatch(restarted, boundedWatch)).status, 'COMPLETE');
  const completed = await store.read(); assert.equal(completed.active, null);
  assert.deepEqual(completed.seen, waiting.seen); assert.equal(grants, 2); assert.equal(calls, 3);
  assert.equal((await watchDispatch(restarted, boundedWatch)).status, 'WAITING'); assert.equal(calls, 3);
});
test('bounded marker cannot turn a safety block into a service retry', async t => {
  for (const code of ['GRANT_REVOKED', 'OWNER_MISMATCH', 'PERMISSION_DENIED', 'UNKNOWN_WRITE']) {
    const f = await setup(t); let calls = 0;
    const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => ({ manifest: { id: 'cohort' }, policy: f.policy }), resume: async () => { calls++; return { status: 'BLOCKED', code, continuation: 'bounded-wait-exhausted' }; } };
    assert.equal((await watchDispatch(runtime, { ...boundedWatch, maxPolls: 2, delay: async () => assert.fail('must stop') })).status, 'BLOCKED');
    assert.equal(calls, 1);
  }
});
test('service wake revalidates authority and stops on revoked grant, permissions or ambiguous writes', async t => {
  for (const error of [new Error('grant revoked'), Object.assign(new Error('permission denied'), { requestMethod: 'GET', status: 403 }), Object.assign(new Error('ambiguous write'), { requestMethod: 'PUT', status: 503 })]) {
    const f = await setup(t); let calls = 0;
    const runtime = { config: f.config, environment: {}, github: f.github, grant: async () => ({ manifest: { id: 'cohort' }, policy: f.policy }), resume: async () => { calls++; return { status: 'BLOCKED', code: 'CI_PENDING_OR_FAILED' }; } };
    assert.equal((await watchDispatch(runtime, boundedWatch)).status, 'WAITING');
    runtime.grant = async () => { throw error; };
    await assert.rejects(watchDispatch(runtime, { ...boundedWatch, maxPolls: 2, delay: async () => assert.fail('must stop') }), e => e === error);
    assert.equal(calls, 2);
  }
});
