import { createPublicKey, verify, sign } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { canonical, digest, validateManifest } from './core.mjs';
import { validateDynamic } from './dynamic.mjs';
import { validatePublicPolicy } from './runner-binding.mjs';
import {validateRescuePolicy,validateRescueContinuations,validateRescueAssistance} from './rescue-policy.mjs';

export function verifyGrant(bundle, publicKey, now = Date.now()) {
  const { payload, signature } = bundle;
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64'))) throw new Error('Invalid owner grant signature');
  validateManifest(payload.manifest);
  if (payload.manifest.schemaVersion === 2) validateDynamic(payload);
  validatePublicPolicy(payload.policy);
  if (payload.policy.publicRunner && payload.actorGitHubUserId !== payload.policy.kairoOwnerGitHubUserId) throw new Error('Signed actor GitHub identity differs from Kairo Owner');
  if (!payload.recordId || !payload.actor || payload.revoked !== false || payload.policy.manifestHash !== digest(payload.manifest)) throw new Error('Grant revoked or scope binding invalid');
  if (payload.policy.controlMode !== 'owner-project' && !(Date.parse(payload.policy.validFrom) <= now && now < Date.parse(payload.policy.expiresAt))) throw new Error('Grant expired or not yet active');
  if (!payload.proposal || digest(payload.proposal) !== payload.manifest.proposalHash) throw new Error('Proposal content does not match frozen hash');
  for (const issue of payload.manifest.issues) if (typeof issue.scopeBody !== 'string' || digest(issue.scopeBody) !== issue.scopeHash) throw new Error('Frozen Scope body hash mismatch');
  return { ...payload, approval: { verified: true, recordId: payload.recordId, actor: payload.actor, revoked: false, manifestHash: digest(payload.manifest), policyHash: digest(payload.policy) } };
}
export function signGrant(payload, privateKey) {
  return { payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') };
}
// A separate signed amendment changes only the installed Core identity, keeping
// the exact approved scope/policy and historical stage evidence intact.
export function verifyCoreUpgrade(bundle, grant, installedDigest, publicKey) {
  const p = bundle?.payload, key = createPublicKey(publicKey);
  if (!p || key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, Buffer.from(canonical(p)), key, Buffer.from(bundle.signature || '', 'base64')) ||
      p.schemaVersion !== 1 || p.kind !== 'owner-core-upgrade' ||
      p.grantRecordId !== grant.recordId || p.manifestHash !== digest(grant.manifest) ||
      p.policyHash !== digest(grant.policy) || p.runtimeHash !== grant.policy.runtimeHash ||
      p.fromCoreDigest !== grant.policy.coreDigest || p.toCoreDigest !== installedDigest ||
      !/^[a-f0-9]{64}$/.test(p.toCoreDigest || '') || !/^[a-f0-9]{40}$/.test(p.sourceCommit || '') ||
      typeof p.reason !== 'string' || !p.reason.trim() || grant.policy.controlMode !== 'owner-project' ||
      p.issueScopeSource!==undefined && p.issueScopeSource!=='github-issue')
    throw new Error('Core upgrade is not explicitly approved for this exact authority and installation');
  if(p.agentGithubRead!==undefined&&p.agentGithubRead!==true)throw Error('Agent GitHub read capability must be explicitly enabled');
  if(p.rescue!==undefined)validateRescuePolicy(p.rescue);
  if(p.rescuePreviousWorkflowBlob!==undefined&&(!p.rescue||!/^[a-f0-9]{40}$/.test(p.rescuePreviousWorkflowBlob)))throw Error('Invalid approved historical Rescue workflow');
  if(p.rescueContinuations!==undefined){if(!p.rescue)throw Error('Rescue continuation requires its base capability');validateRescueContinuations(p.rescueContinuations);}
  if(p.rescueAssistance!==undefined){if(!p.rescue)throw Error('Rescue assistance requires its base capability');validateRescueAssistance(p.rescueAssistance);}
  if(p.actionWorkflowBlob!==undefined&&(grant.policy.executionMode!=='actions-v1'||!/^[a-f0-9]{40}$/.test(p.actionWorkflowBlob)))throw Error('Invalid signed display-workflow pin');
  if (p.executionLimits !== undefined) {
    const l = p.executionLimits;
    if (!l || typeof l !== 'object' || Array.isArray(l) || grant.policy.executionMode !== 'actions-v1' ||
        l.previousWorkflowBlob !== grant.policy.actionExecution?.workflowBlob ||
        !/^[a-f0-9]{40}$/.test(l.workflowBlob || '') ||
        !Number.isSafeInteger(l.jobTimeoutMinutes) || l.jobTimeoutMinutes < 45 || l.jobTimeoutMinutes > 360 ||
        !Number.isSafeInteger(l.agentTimeoutMs) || l.agentTimeoutMs < 60000 ||
        l.agentTimeoutMs >= l.jobTimeoutMinutes * 60000 ||
        Object.keys(l).some(k => !['previousWorkflowBlob','workflowBlob','jobTimeoutMinutes','agentTimeoutMs'].includes(k)))
      throw new Error('Execution limits do not match the exact approved workflow and bounded timeouts');
  }
  return { ...p, verified:true, amendmentHash:digest(bundle) };
}
export function outside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel);
}
export async function coreDigest(root) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Core symlinks are forbidden');
      if (entry.isDirectory()) await walk(name);
      else files.push([name, await readFile(join(root, name), 'utf8')]);
    }
  }
  for (const path of ['src', 'bin', 'skills']) await walk(path);
  return digest(files.sort(([a], [b]) => a.localeCompare(b, 'en')));
}
