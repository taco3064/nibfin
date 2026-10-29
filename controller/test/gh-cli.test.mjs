import test from 'node:test';
import assert from 'node:assert/strict';
import { ghTransport, ghEnvironment, ghDownload } from '../src/gh-cli.mjs';
import { GitHub } from '../src/github.mjs';
import { Workspace } from '../src/workspace.mjs';

test('gh uses local login and passes mutation JSON on stdin without token headers', async () => {
  const transport = ghTransport(async (exe, args, options) => {
    assert.equal(exe, 'gh');
    assert.ok(args.includes('--include'));
    assert.ok(!args.some(a => /authorization|secret-token/i.test(a)));
    assert.deepEqual(JSON.parse(options.input), { labels: ['scope'] });
    assert.equal(options.env.GH_TOKEN, undefined);
    return { stdout: 'HTTP/2.0 200 OK\r\nX-Github-Request-Id: request-1\r\n\r\n{"ok":true}' };
  });
  const github = new GitHub(undefined, transport);
  assert.deepEqual(await github.api('/repos/owner/repo/issues/1/labels', 'POST', { labels: ['scope'] }), { ok: true });
  const env = ghEnvironment({ GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', GH_DEBUG: 'api', HOME: '/home/owner' });
  assert.equal(env.HOME, '/home/owner');
  assert.equal(env.GH_TOKEN, undefined); assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.GH_DEBUG, undefined);
});

test('401 is actionable, logged safely and never retried for writes', async () => {
  let calls = 0;
  const github = new GitHub(undefined, ghTransport(async () => {
    calls++;
    throw Object.assign(new Error('unsafe detail'), { exitCode: 1,
      stdout: 'HTTP/2.0 401 Unauthorized\nX-Github-Request-Id: auth-1\n\n{"message":"private-response"}', stderr: 'secret-token' });
  }));
  await assert.rejects(github.api('/repos/owner/repo/issues', 'POST', {}), error => {
    assert.equal(error.code, 'GITHUB_AUTH_FAILED'); assert.equal(error.status, 401);
    assert.ok(!JSON.stringify(error).includes('secret-token')); return true;
  });
  assert.equal(calls, 1);
});

test('gh missing and missing login do not leak stderr or retry a write', async () => {
  for (const code of ['ENOENT', undefined]) {
    const transport = ghTransport(async () => { throw Object.assign(new Error('secret-token'), { code, exitCode: 4, stderr: 'secret-token' }); });
    await assert.rejects(transport('https://api.github.com/user', {method:'POST'}), error => {
      assert.equal(error.code, code ? 'GH_CLI_MISSING' : 'GH_CLI_FAILED');
      assert.ok(!error.message.includes('secret-token')); return true;
    });
  }
});

test('conditional empty responses and binary downloads preserve their types', async () => {
  const response = await ghTransport(async () => ({stdout:'HTTP/2.0 304 Not Modified\nEtag: abc\n\n'}))('https://api.github.com/user');
  assert.equal(response.status, 304); assert.equal(await response.text(), '');
  const binary = Buffer.from([0, 255, 128, 10]);
  assert.deepEqual(await ghDownload('/repos/owner/repo/actions/artifacts/1/zip', 100, async (exe,args,options) => {
    if (args.includes('--help')) return {stdout:'--allow-escape-sequences'};
    assert.ok(args.includes('--allow-escape-sequences'));
    assert.equal(options.encoding, null); assert.equal(options.limit, 100);
    return {stdout: binary};
  }), binary);
  await assert.rejects(ghDownload('https://attacker.example/secret', 100), /Invalid/);
});

test('production Git workspace delegates credentials to gh without embedding a token', () => {
  const workspace = new Workspace('/tmp/kairo-cli-test', {repository:'owner/repo'});
  assert.ok(Object.values(workspace.env).includes('!gh auth git-credential'));
  assert.ok(!Object.values(workspace.env).some(v => /AUTHORIZATION: basic/.test(v)));
  assert.equal(workspace.env.GITHUB_TOKEN, undefined);
});
