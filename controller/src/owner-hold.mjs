import { createPublicKey, verify } from 'node:crypto';
import { canonical, digest } from './core.mjs';
import { revisionRetiresHold } from './requirement-revision.mjs';

// A separately signed negative execution restriction. It cannot revise Scope,
// approve research as delivery evidence, or grant any additional operation.
export function verifyOwnerHolds(bundles, grant, publicKey) {
  if (bundles === undefined) return [];
  if (!Array.isArray(bundles)) throw Error('Invalid Owner execution holds');
  const key = createPublicKey(publicKey), ids = new Set();
  return bundles.map(bundle => {
    const p = bundle?.payload, issue = grant.manifest.issues.find(i => i.id === p?.issueId && i.repository === p?.repository);
    if (!p || key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(p)), key, Buffer.from(bundle.signature || '', 'base64')) ||
        p.kind !== 'owner-execution-hold' || p.schemaVersion !== 1 || p.grantRecordId !== grant.recordId ||
        p.manifestHash !== digest(grant.manifest) || p.policyHash !== digest(grant.policy) ||
        !issue || p.scopeHash !== issue.scopeHash || ids.has(issue.id) ||
        p.release !== 'explicit-owner-reauthorization' || typeof p.reason !== 'string' || !p.reason.trim())
      throw Error('Owner execution hold does not match this authority');
    ids.add(issue.id);
    return { ...p, holdHash: digest(bundle) };
  });
}

export function ownerHold(runtime, issue) {
  const hold=runtime.ownerExecutionHolds?.find(h => h.issueId === issue.id && h.repository === issue.repository);
  return hold && !revisionRetiresHold(runtime,issue,hold) ? hold : null;
}
