import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disablePublicRunner, dispatchServiceCheck } from '../src/runner-operations.mjs';
import { UPSTREAM_REPOSITORY, UPSTREAM_REPOSITORY_ID } from '../src/owner-identity.mjs';
import { signGrant } from '../src/authority.mjs';
import { Store } from '../src/store.mjs';
import { rootIdentity } from '../src/runner-binding.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nibfin-ops-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const config = { runnerId: 'runner-a', nibfinOwnerGitHubUserId: '77', stateDirectory: join(dir, 'state'), publicKeyPath: join(dir, 'owner.pem'), grantSource: { repository: 'example/control', path: 'grant.json', ref: 'main' }, publicRunner: { registryPath: join(dir, 'registry') } };
  config.publicRunner.rootKeyPath = join(dir, 'runner-root');
  await writeFile(config.publicRunner.rootKeyPath, Buffer.alloc(32, 1).toString('hex'));
  await writeFile(config.publicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const privateKeyPath = join(dir, 'private.pem'); await writeFile(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const b = { runnerId: 'runner-a', repository: 'example/one', repositoryId: '123', ownerId: '77', bindingId: 'a'.repeat(32), workflowPath: '.github/workflows/nibfin.yml', workflowBlob: 'b'.repeat(40) };
  await writeFile(config.publicRunner.registryPath, JSON.stringify({ runnerId: config.runnerId, bindings: [{ binding: b, active: true }] }));
  const grant = { actor: 'owner', actorGitHubUserId: '77', revoked: false, manifest: { id: 'cohort' }, policy: { runnerId: config.runnerId, nibfinOwnerGitHubUserId: '77', publicRunner: { rootId: 'c'.repeat(64), bindings: { [b.repository]: b } }, repositories: { [b.repository]: {} } } };
  grant.policy.publicRunner.rootId = rootIdentity(Buffer.alloc(32, 1));
  let bundle = signGrant(grant, keys.privateKey), secretPresent = true;
  const writes = [];
  const github = {
    repository: async name => ({ id: name === UPSTREAM_REPOSITORY ? UPSTREAM_REPOSITORY_ID : name === 'example/one' ? 123 : 456, owner: { id: 77, type: 'User' } }),
    grant: async () => structuredClone(bundle),
    api: async (path, method = 'GET', body) => {
      if (path === '/users/owner') return { id: 77, type: 'User' };
      if (method !== 'GET') writes.push([path, method]);
      if (method === 'PUT') { bundle = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); return {}; }
      if (method === 'DELETE') { secretPresent = false; return null; }
      if (path.includes('/contents/')) return { sha: 'd'.repeat(40), encoding: 'base64', content: Buffer.from(JSON.stringify(bundle)).toString('base64') };
      if (path.includes('/secrets/')) { if (secretPresent) return { name: 'UPSTREAM_RUNNER_KEY' }; throw Object.assign(new Error('missing'), { status: 404 }); }
      throw new Error('Unexpected request');
    },
  };
  return { config, github, grant, privateKeyPath, writes };
}
test('formal disable revokes local execution, signed authority and wakeups with independent readback', async t => {
  const f = await setup(t);
  const result = await disablePublicRunner(f.config, f.github, f.privateKeyPath);
  assert.equal(result.status, 'DISABLED'); assert.equal(result.localBindings, 'revoked'); assert.equal(result.grant, 'revoked');
  assert.equal(result.wakeups['example/one'], 'stopped'); assert.deepEqual(result.errors, []);
  assert.equal(JSON.parse(await readFile(f.config.publicRunner.registryPath, 'utf8')).bindings[0].active, false);
  assert.equal((await f.github.grant()).payload.revoked, true);
  assert.equal((await disablePublicRunner(f.config, f.github, f.privateKeyPath)).status, 'DISABLED');
  assert.equal(f.writes.filter(([, method]) => method === 'PUT').length, 1);
});
test('failed remote grant revocation never rolls back local safety or claims complete disable', async t => {
  const f = await setup(t), api = f.github.api;
  f.github.api = async (path, method, body) => { if (method === 'PUT') throw new Error('remote unavailable'); return api(path, method, body); };
  const result = await disablePublicRunner(f.config, f.github, f.privateKeyPath);
  assert.equal(result.status, 'PARTIAL_DISABLE'); assert.equal(result.localBindings, 'revoked'); assert.equal(result.grant, 'pending');
  assert.equal((await f.github.grant()).payload.revoked, false);
  assert.equal(JSON.parse(await readFile(f.config.publicRunner.registryPath, 'utf8')).bindings[0].active, false);
});
test('formal disable rejects substituted Owner before local or remote mutation', async t => {
  const f = await setup(t); f.config.nibfinOwnerGitHubUserId = '78';
  await assert.rejects(disablePublicRunner(f.config, f.github, f.privateKeyPath), /Owner/);
  assert.equal(f.writes.length, 0);
  assert.equal(JSON.parse(await readFile(f.config.publicRunner.registryPath, 'utf8')).bindings[0].active, true);
});
test('service preflight never steals live or dead-process locks and validates persisted state', async t => {
  const f = await setup(t), runtime = { config: f.config, grant: async () => f.grant };
  assert.equal((await dispatchServiceCheck(runtime)).status, 'READY');
  const store = new Store(f.config.stateDirectory, f.grant.manifest.id);
  await store.lease(async () => { await assert.rejects(dispatchServiceCheck(runtime), /Existing.*lock/); });
  await mkdir(store.directory, { recursive: true });
  const lock = join(store.directory, 'execution.lock'), data = JSON.stringify({ pid: 999999999, startedAt: '2000-01-01' });
  await writeFile(lock, data);
  await assert.rejects(dispatchServiceCheck(runtime), /Existing.*lock/);
  assert.equal(await readFile(lock, 'utf8'), data);
});
test('service deployment restarts normal waits, starts at boot and stops on unsafe failures', async () => {
  const unit = await readFile('runner/nibfin-dispatch.service', 'utf8');
  for (const setting of ['WantedBy=multi-user.target', 'Restart=on-success', 'RestartPreventExitStatus=2 SIGINT SIGTERM SIGHUP SIGPIPE', 'KillMode=control-group', 'dispatch-service-check', 'User=nibfin']) assert.ok(unit.includes(setting));
  assert.ok(!unit.includes('Restart=always'));
  const windows = await readFile('runner/install-wsl-dispatch-startup.ps1', 'utf8');
  assert.ok(windows.includes('-ExecutionPolicy RemoteSigned'));
  assert.ok(!windows.includes('Set-ExecutionPolicy'));
  assert.ok(windows.includes('-MultipleInstances IgnoreNew')); assert.ok(windows.includes('-WindowStyle Hidden'));
});

test('installer rejects unsupported Node before installing the service', async () => {
  const { runInNewContext } = await import('node:vm');
  const script = await readFile('runner/install-dispatch-service.sh', 'utf8');
  const check = script.match(/node -e '([^']+)'/)[1];
  assert.ok(script.indexOf('test -x /usr/local/bin/node') < script.indexOf('install -m'));
  assert.ok(script.indexOf(check) < script.indexOf('install -m'));
  for (const version of ['18.20.0', '20.19.0', '21.7.0', '22.0.0', '24.1.0']) {
    let exit = 0;
    runInNewContext(check, { process: { versions: { node: version }, exit: code => { exit = code; } }, console: { error: () => {} } });
    assert.equal(exit, Number(version.split('.')[0]) < 22 ? 1 : 0);
  }
});
