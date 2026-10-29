import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { canonical } from './core.mjs';
import { verifyKairoOwner } from './owner-identity.mjs';

const fail = message => { throw new Error(`Runner binding: ${message}`); };
export const rootIdentity = root => createHash('sha256').update(root).digest('hex');
export function validateBinding(b) {
  if (!b || Object.keys(b).sort().join(',') !== 'bindingId,ownerId,repository,repositoryId,runnerId,workflowBlob,workflowPath' ||
      !/^[\w.-]+\/[\w.-]+$/.test(b.repository) || !/^[a-zA-Z0-9_-]{16,80}$/.test(b.bindingId) ||
      !/^[\w.-]{1,80}$/.test(b.runnerId) || !/^[1-9]\d*$/.test(b.repositoryId) || !/^[1-9]\d*$/.test(b.ownerId) ||
      !['.github/workflows/kairo.yml','.github/workflows/nibfin-events.yml'].includes(b.workflowPath) || !/^[a-f0-9]{40}$/.test(b.workflowBlob)) fail('invalid descriptor');
  return b;
}
export const bindingSecret = (root, b) => createHmac('sha256', root).update(`kairo-binding-v1\n${canonical(validateBinding(b))}`).digest('hex');
export async function createRoot(path) {
  const root = randomBytes(32);
  await writeFile(path, root.toString('hex'), { flag: 'wx', mode: 0o600 });
  return { rootId: rootIdentity(root) };
}
export async function readBindings(config, policy) {
  if (!config.publicRunner || !policy.publicRunner) fail('explicit public execution policy required');
  if (!config.kairoOwnerGitHubUserId || config.kairoOwnerGitHubUserId !== policy.kairoOwnerGitHubUserId) fail('Kairo Owner policy mismatch');
  const raw = (await readFile(config.publicRunner.rootKeyPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(raw)) fail('invalid local root key');
  const root = Buffer.from(raw, 'hex');
  if (rootIdentity(root) !== policy.publicRunner.rootId) fail('machine identity differs from grant');
  const registry = JSON.parse(await readFile(config.independentTransport?.registryPath || config.publicRunner.registryPath, 'utf8'));
  if (registry.runnerId !== config.runnerId || !Array.isArray(registry.bindings)) fail('registry machine mismatch');
  const bindings = {};
  for (const [repository, approved] of Object.entries(policy.publicRunner.bindings || {})) {
    validateBinding(approved);
    if (approved.ownerId !== config.kairoOwnerGitHubUserId) fail('binding does not belong to Kairo Owner');
    const matches = registry.bindings.filter(r => r.binding?.repository === repository && r.active === true);
    if (matches.length !== 1 || canonical(matches[0].binding) !== canonical(approved) || approved.runnerId !== config.runnerId || approved.repository !== repository) fail('revoked, rotated or mismatched repository binding');
    bindings[repository] = { binding: approved, secret: bindingSecret(root, approved), kairoOwnerGitHubUserId: config.kairoOwnerGitHubUserId };
  }
  return bindings;
}
export function validatePublicPolicy(policy) {
  if (!policy.publicRunner) return;
  const p = policy.publicRunner;
  if (typeof policy.kairoOwnerGitHubUserId !== 'string' || !/^[1-9]\d*$/.test(policy.kairoOwnerGitHubUserId)) fail('signed Kairo Owner identity required');
  if (!/^[a-f0-9]{64}$/.test(p.rootId) || !p.bindings || !Object.keys(p.bindings).length) fail('invalid public policy');
  for (const [repository, b] of Object.entries(p.bindings)) {
    validateBinding(b);
    if (b.repository !== repository || b.runnerId !== policy.runnerId || !policy.repositories?.[repository] || b.ownerId !== policy.kairoOwnerGitHubUserId) fail('binding outside grant or Kairo Owner');
  }
}
async function registryLock(config, work) {
  const path = `${config.publicRunner.registryPath}.lock`;
  const handle = await open(path, 'wx', 0o600);
  try { return await work(); }
  finally { await handle.close(); await unlink(path); }
}
export function enrollBinding(config, github, repository, secretOutput, expectedWorkflow) {
  return registryLock(config, () => enrollBindingUnlocked(config, github, repository, secretOutput, expectedWorkflow));
}
async function enrollBindingUnlocked(config, github, repository, secretOutput, expectedWorkflow) {
  const ownerId = await verifyKairoOwner(github, config);
  const repo = await github.repository(repository);
  const owner = await github.api('/user');
  if (repo.private || repo.owner?.type !== 'User' || owner.type !== 'User' || String(repo.owner?.id) !== ownerId || String(owner.id) !== ownerId || !repo.permissions?.admin) fail('public Kairo Owner-admin repository required');
  const workflowPath = '.github/workflows/kairo.yml';
  const file = await github.api(`/repos/${repository}/contents/${workflowPath}?ref=${encodeURIComponent(repo.default_branch)}`);
  if (!expectedWorkflow || file.encoding !== 'base64' || Buffer.from(file.content, 'base64').toString('utf8') !== expectedWorkflow) fail('install the exact hosted caller template before binding');
  const b = validateBinding({ runnerId: config.runnerId, repository, repositoryId: String(repo.id), ownerId: String(owner.id), bindingId: randomBytes(16).toString('hex'), workflowPath, workflowBlob: file.sha });
  const raw = (await readFile(config.publicRunner.rootKeyPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(raw)) fail('invalid root');
  const root = Buffer.from(raw, 'hex');
  let registry;
  try { registry = JSON.parse(await readFile(config.independentTransport?.registryPath || config.publicRunner.registryPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; registry = { runnerId: config.runnerId, bindings: [] }; }
  if (registry.runnerId !== config.runnerId || !Array.isArray(registry.bindings)) fail('registry mismatch');
  // New binding IDs rotate the repository key; never silently reuse old grants.
  for (const row of registry.bindings) if (row.binding.repository === repository) row.active = false;
  registry.bindings.push({ binding: b, active: true });
  await writeFile(secretOutput, JSON.stringify({ binding: b, secret: bindingSecret(root, b) }), { flag: 'wx', mode: 0o600 });
  const temp = `${config.publicRunner.registryPath}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(registry, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temp, config.publicRunner.registryPath);
  return { rootId: rootIdentity(root), binding: b, secretFile: secretOutput, executionAuthorized: false };
}
export function signDispatch(payload, secret) {
  return { payload, signature: createHmac('sha256', Buffer.from(secret, 'hex')).update(canonical(payload)).digest('hex') };
}
export function revokeBinding(config, repository) {
  return registryLock(config, () => revokeBindingUnlocked(config, repository));
}
async function revokeBindingUnlocked(config, repository) {
  const registry = JSON.parse(await readFile(config.independentTransport?.registryPath || config.publicRunner.registryPath, 'utf8'));
  if (registry.runnerId !== config.runnerId || !Array.isArray(registry.bindings)) fail('registry mismatch');
  let count = 0;
  for (const row of registry.bindings) if (row.binding.repository === repository && row.active === true) { row.active = false; count++; }
  const temp = `${config.publicRunner.registryPath}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(registry, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temp, config.publicRunner.registryPath);
  return { repository, revoked: count };
}
export function verifyDispatch(envelope, entry, now = Date.now(), allowExpired = false) {
  const p = envelope?.payload;
  const keys = 'bindingId,expiresAt,issuedAt,nonce,operation,repository,repositoryId,runAttempt,runId,runnerId,schemaVersion'.split(',');
  if (p?.schemaVersion === 2) keys.push('eventName', 'eventAction', 'issueId', 'issueNumber');
  if (!p || Object.keys(p).sort().join(',') !== keys.sort().join(',') ||
      ![1, 2].includes(p.schemaVersion) || p.operation !== 'reevaluate' || !/^[a-f0-9]{32}$/.test(p.nonce) ||
      !/^[1-9]\d*$/.test(p.runId) || !Number.isSafeInteger(p.runAttempt) || p.runAttempt < 1 ||
      !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.issuedAt > now + 60000 || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > 86400000) fail('invalid dispatch');
  if (p.schemaVersion === 2) {
    if (p.eventName === 'issues') {
      if (!['opened', 'edited', 'labeled', 'unlabeled', 'reopened', 'closed', 'milestoned', 'demilestoned'].includes(p.eventAction) || typeof p.issueId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.issueId) || !Number.isSafeInteger(p.issueNumber) || p.issueNumber < 1) fail('invalid Issue dispatch');
    } else if (!['workflow_dispatch', 'schedule'].includes(p.eventName) || p.eventAction !== '' || p.issueId !== null || p.issueNumber !== null) fail('invalid wake-up event');
  }
  for (const k of ['bindingId', 'repository', 'repositoryId', 'runnerId']) if (p[k] !== entry?.binding[k]) fail('dispatch target mismatch');
  if (!/^[a-f0-9]{64}$/.test(envelope.signature || '') || !timingSafeEqual(Buffer.from(envelope.signature, 'hex'), Buffer.from(signDispatch(p, entry.secret).signature, 'hex'))) fail('invalid dispatch signature');
  if (!allowExpired && p.expiresAt <= now) throw Object.assign(new Error('Dispatch expired; await a fresh message under the same grant'), { code: 'DISPATCH_EXPIRED' });
  return p;
}
