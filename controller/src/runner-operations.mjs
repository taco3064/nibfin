import { readFile, lstat } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { join } from 'node:path';
import { dynamicStoreIds } from './dynamic.mjs';
import { Store } from './store.mjs';
import { canonical, digest } from './core.mjs';
import { signGrant } from './authority.mjs';
import { verifyKairoOwner } from './owner-identity.mjs';
import { revokeBinding, validatePublicPolicy, rootIdentity } from './runner-binding.mjs';
import { repoPath } from './github.mjs';
import { transientDispatchRead } from './dispatch.mjs';

export async function dispatchServiceCheck(runtime) {
  let grant;
  try { grant = await runtime.grant(); }
  catch (error) {
    if (!transientDispatchRead(error)) throw error;
    return { status: 'WAITING', reason: 'Watcher will retry authority reads before acquiring any execution lease' };
  }
  if (!grant.policy.publicRunner) throw new Error('Public dispatch service requires its own signed policy');
  for (const id of [grant.manifest.id, `dispatch:${grant.policy.publicRunner.rootId}`, ...(grant.manifest.schemaVersion === 2 ? dynamicStoreIds(grant) : [])]) {
    const store = new Store(runtime.config.stateDirectory, id);
    for (const name of ['lock', 'execution.lock']) {
      try { await lstat(join(store.directory, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // A PID alone is insufficient proof of container and pending-write safety.
      // Never remove a crash lock, even if its recorded PID no longer exists.
      throw new Error('Existing execution/transaction lock: verify prior process, containers and pending intent before operator recovery');
    }
    const state = await store.read();
    if (state.pending?.recoveryRequired) throw new Error('Unconfirmed Agent cleanup requires operator recovery');
  }
  return { status: 'READY', runnerId: runtime.config.runnerId, cohort: grant.manifest.id };
}

// Explicit operator operation. Revoke locally first, and never roll that back
// when GitHub is unavailable. Partial completion is reported, never called DONE.
export async function disablePublicRunner(config, github, privateKeyPath) {
  const publicKey = await readFile(config.publicKeyPath, 'utf8');
  const source = config.grantSource;
  const bundle = await github.grant(source);
  // Permit an idempotent retry after the grant was already revoked. Verify its
  // signature independently; never make the revoked payload executable.
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(bundle.payload)), key, Buffer.from(bundle.signature, 'base64'))) throw new Error('Invalid owner grant signature');
  const grant = bundle.payload;
  validatePublicPolicy(grant.policy);
  const id = await verifyKairoOwner(github, config, grant.policy, grant.actor);
  if (grant.actorGitHubUserId !== id || !grant.policy.publicRunner) throw new Error('Public grant Owner mismatch');
  const root = (await readFile(config.publicRunner.rootKeyPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(root) || grant.policy.runnerId !== config.runnerId || rootIdentity(Buffer.from(root, 'hex')) !== grant.policy.publicRunner.rootId) throw new Error('Disable target belongs to another runner identity');
  const privateKey = await readFile(privateKeyPath, 'utf8');
  if (!createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(key.export({ type: 'spki', format: 'der' }))) throw new Error('Revocation signing key mismatch');
  const control = await github.repository(source.repository);
  if (control.owner?.type !== 'User' || String(control.owner.id) !== id) throw new Error('Grant source is not controlled by Kairo Owner');
  const report = { status: 'DISABLED', localBindings: 'pending', grant: 'pending', wakeups: {}, errors: [] };
  for (const repository of Object.keys(grant.policy.publicRunner.bindings)) {
    try { await revokeBinding(config, repository); }
    catch { report.errors.push(`Local binding revocation incomplete: ${repository}`); }
  }
  report.localBindings = report.errors.length ? 'unconfirmed' : 'revoked';
  try {
    const path = `${repoPath(source.repository)}/contents/${source.path.split('/').map(encodeURIComponent).join('/')}`;
    const file = await github.api(`${path}?ref=${encodeURIComponent(source.ref)}`);
    if (file.encoding !== 'base64' || digest(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))) !== digest(bundle)) throw new Error('Grant changed before revocation');
    const revoked = signGrant({ ...grant, revoked: true }, privateKey);
    if (!grant.revoked) await github.api(path, 'PUT', { message: 'Revoke public runner cohort authority', branch: source.ref, sha: file.sha, content: Buffer.from(JSON.stringify(revoked, null, 2) + '\n').toString('base64') });
    const actual = await github.grant(source);
    if (canonical(actual.payload) !== canonical(revoked.payload) || !verify(null, Buffer.from(canonical(actual.payload)), key, Buffer.from(actual.signature, 'base64'))) throw new Error('Grant revocation readback failed');
    report.grant = 'revoked';
  } catch { report.errors.push('Grant revocation incomplete; local execution remains revoked'); }
  for (const repository of Object.keys(grant.policy.publicRunner.bindings)) {
    try {
      const repo = await github.repository(repository);
      if (repo.owner?.type !== 'User' || String(repo.owner.id) !== id || String(repo.id) !== grant.policy.publicRunner.bindings[repository].repositoryId) throw new Error('Repository identity changed');
      const path = `${repoPath(repository)}/actions/secrets/KAIRO_RUNNER_KEY`;
      try { await github.api(path, 'DELETE'); } catch (error) { if (error.status !== 404) throw error; }
      let absent = false;
      try { await github.api(path); } catch (error) { if (error.status === 404) absent = true; else throw error; }
      if (!absent) throw new Error('Secret deletion not confirmed');
      report.wakeups[repository] = 'stopped';
    } catch { report.wakeups[repository] = 'unconfirmed'; report.errors.push(`Secret removal incomplete: ${repository}`); }
  }
  if (report.errors.length) report.status = 'PARTIAL_DISABLE';
  return report;
}
