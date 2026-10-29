import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, repoPath } from '../src/github.mjs';
import { CodexAgent, resolveSkill } from '../src/agent.mjs';
import { digest } from '../src/core.mjs';
import { readFile } from 'node:fs/promises';

test('GitHub API never follows credential-bearing redirects or silently retries writes', async () => {
  let calls = 0;
  const gh = new GitHub('fixture-token', async (url, options) => {
    calls++; assert.equal(options.redirect, 'error'); assert.equal(options.method, 'PUT');
    assert.equal(JSON.parse(options.body).sha, 'exact-head');
    return { ok: false, status: 409 };
  });
  await assert.rejects(gh.merge('owner/repo', 1, 'exact-head', 'squash'), /HTTP 409/);
  assert.equal(calls, 1);
  assert.throws(() => repoPath('owner/repo/../../other'), /Invalid/);
});

test('transient GitHub reads retry with a bounded backoff and return only fresh successful data', async () => {
  let calls = 0, cancelled = 0;
  const waits = [];
  const gh = new GitHub('fixture', async () => ++calls < 3
    ? { ok: false, status: 502, body: { cancel: async () => cancelled++ } }
    : { ok: true, status: 200, json: async () => ({ fresh: true }) }, async ms => waits.push(ms));
  assert.deepEqual(await gh.api('/repos/owner/repo'), { fresh: true });
  assert.equal(calls, 3); assert.equal(cancelled, 2);
  assert.deepEqual(waits, [1000, 2000]);
  calls = 0;
  gh.fetch = async () => { calls++; return {ok: false, status: 503}; };
  await assert.rejects(gh.api('/repos/owner/repo'), /HTTP 503/);
  assert.equal(calls, 3);
});

test('temporary failures never retry writes, authorization denials, redirects or invalid read responses', async () => {
  for (const [method, status] of [['POST',502],['PUT',503],['PATCH',504],['DELETE',502],['GET',401],['GET',403],['GET',404],['GET',429],['GET',302]]) {
    let calls = 0;
    const gh = new GitHub('fixture', async () => { calls++; return {ok: false, status}; }, async () => assert.fail('must not retry'));
    await assert.rejects(gh.api('/repos/owner/repo', method), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
  const gh = new GitHub('fixture', async () => ({ok:true,status:200,json:async()=>{throw new SyntaxError('Invalid JSON');}}), async()=>assert.fail('must not retry'));
  await assert.rejects(gh.api('/repos/owner/repo'), /Invalid JSON/);
});

test('read transport timeouts can recover but ambiguous write timeouts cannot be repeated', async () => {
  let calls = 0;
  const gh = new GitHub('fixture', async () => {
    if (++calls === 1) throw Object.assign(new Error('read timeout'), {name:'TimeoutError'});
    return {ok:true,status:200,json:async()=>({recovered:true})};
  }, async()=>{});
  assert.deepEqual(await gh.api('/repos/owner/repo'), {recovered:true});
  calls = 0;
  await assert.rejects(gh.api('/repos/owner/repo', 'POST'), /timeout/);
  assert.equal(calls, 1);
});
test('Agent container exposes no controller source, GitHub token or writeable reviewer workspace', () => {
  const a = new CodexAgent({ image: `trusted/codex@sha256:${'a'.repeat(64)}`, network: 'restricted-egress', user: '1000:1000', authDirectory: '/safe/auth' }, '/private/core', '/state');
  const args = a.args('/candidate', '/execution', false);
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.some(x => x.includes('dst=/work,readonly')));
  assert.ok(!args.join(' ').includes('/private/core'));
  assert.ok(!args.join(' ').includes('GH_TOKEN'));
  a.config.image = `sha256:${'b'.repeat(64)}`;
  assert.ok(a.args('/candidate', '/execution', true).includes(a.config.image));
  a.config.image = 'sha256:abc'; assert.throws(() => a.args('/candidate', '/execution', true), /digest/);
  a.config.image = 'untrusted:latest'; assert.throws(() => a.args('/candidate', '/execution', true), /digest/);
});
test('skill override is digest-bound and recorded without altering Core gates', async () => {
  const path = 'skills/accept/SKILL.md';
  const content = await readFile(path, 'utf8');
  const skill = await resolveSkill(process.cwd(), 'accept', { mode: 'override', path, hash: digest(content) });
  assert.equal(skill.mode, 'override'); assert.equal(skill.hash, digest(content));
  await assert.rejects(resolveSkill(process.cwd(), 'accept', { mode: 'override', path, hash: 'wrong' }), /digest/);
});

test('explicit Docker sandbox boundary preserves reviewer and container isolation', () => {
  const config = { image: `sha256:${'a'.repeat(64)}`, network: 'restricted-egress', user: '1000:1000', authDirectory: '/safe/auth' };
  const agent = new CodexAgent(config, '/private/core', '/state');
  assert.ok(agent.executionArgs('/candidate', '/io', false).includes('read-only'));
  config.sandboxBoundary = 'docker';
  const reviewer = agent.executionArgs('/candidate', '/io', false);
  assert.ok(reviewer.includes('danger-full-access'));
  assert.ok(reviewer.some(x => x.endsWith('dst=/work,readonly')));
  assert.ok(reviewer.includes('--read-only'));
  assert.ok(reviewer.includes('--cap-drop=ALL'));
  assert.ok(reviewer.includes('--security-opt=no-new-privileges'));
  assert.ok(!reviewer.includes('--privileged'));
  assert.ok(!agent.executionArgs('/candidate', '/io', true).some(x => x.endsWith('dst=/work,readonly')));
  config.sandboxBoundary = 'automatic-fallback';
  assert.throws(() => agent.executionArgs('/candidate', '/io', true), /Unknown sandbox/);
});

test('runner registration is checked independently for each repository', async () => {
  const gh = new GitHub('fixture');
  gh.list = async path => path.includes('/one/') ? [{ id: 1, name: 'host', status: 'online', labels: [{name:'linux'},{name:'kairo-private'}] }] : [];
  assert.equal((await gh.verifyRunner('owner/one', [1], 'host')).id, 1);
  await assert.rejects(gh.verifyRunner('owner/two', [1], 'host'), /absent/);
  await assert.rejects(gh.verifyRunner('owner/one', [], 'host'), /Missing approved/);
});
test('initialization creates exactly the three milestones and reports safe public routing', async () => {
  const gh = new GitHub('fixture'), writes = [];
  gh.repository = async () => ({ private: false, visibility:'public', default_branch:'main', permissions:{push:true} });
  gh.list = async () => [];
  gh.api = async (path, method, body) => { writes.push({path, method, body}); return {}; };
  const result = await gh.initialize('owner/repo');
  assert.deepEqual(writes.map(w=>w.body.name), ['scope','shaped','delivered']);
  assert.equal(result.entrypoint, 'public-runner-dispatch');
});
test('API-key logins are rejected and do not fall back to a different auth mode', async () => {
  let calls = 0;
  const agent = new CodexAgent({image:`sha256:${'a'.repeat(64)}`,network:'restricted',user:'1000:1000',authDirectory:'/auth'},'/core','/state',async ()=>{calls++;return {stdout:'Logged in using an API key',stderr:''};});
  agent.verifyEgress=async()=>{}; // Isolate the authentication test from the separately tested egress gate.
  await assert.rejects(agent.login('/work','/io'), /API fallback is forbidden/);
  assert.equal(calls,1);
});

test('root aliases and host or shared container networks cannot bypass isolation', () => {
  const config = {image:`sha256:${'a'.repeat(64)}`,network:'restricted',user:'1000:1000',authDirectory:'/auth'};
  const agent = new CodexAgent(config,'/core','/state');
  for (const user of ['0:0','00:1000','000:000']) {
    config.user=user; assert.throws(()=>agent.args('/work','/io',true), /Root/);
  }
  config.user='1000:1000';
  for (const network of ['host','bridge','default','container:controller']) {
    config.network=network; assert.throws(()=>agent.args('/work','/io',true), /isolated network/);
  }
});
