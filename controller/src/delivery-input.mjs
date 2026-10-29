import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, digest } from './core.mjs';

// Supplemental data, never execution authority or a replacement for the Shape.
// Blob paths are derived from hashes; a signed document cannot select host files.
export function verifyDeliveryInputs(bundles, grant, publicKey) {
  if (bundles === undefined) return [];
  if (!Array.isArray(bundles) || bundles.length > grant.manifest.issues.length) throw Error('Invalid delivery input enrollment');
  const key = createPublicKey(publicKey), subjects = new Set();
  return bundles.map(bundle => {
    const p = bundle?.payload, issue = grant.manifest.issues.find(i => i.id === p?.issueId && i.repository === p?.repository);
    const liveScope = p?.scopeSource === 'github-issue';
    if (!p || key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(p)), key, Buffer.from(bundle.signature || '', 'base64')) ||
        p.schemaVersion !== 1 || p.kind !== 'owner-delivery-input' || p.grantRecordId !== grant.recordId ||
        p.manifestHash !== digest(grant.manifest) || p.policyHash !== digest(grant.policy) ||
        !issue || (liveScope ? grant.policy.controlMode !== 'owner-project' || !/^[a-f0-9]{64}$/.test(p.scopeHash || '') || p.shapeHash !== null
          : p.scopeSource !== undefined || p.scopeHash !== issue.scopeHash || !/^[a-f0-9]{64}$/.test(p.shapeHash || '')) ||
        subjects.has(issue.id) || !Array.isArray(p.files) || !p.files.length || p.files.length > 16 ||
        typeof p.purpose !== 'string' || !p.purpose.trim()) throw Error('Delivery input is not approved for this exact authority and Issue');
    subjects.add(issue.id);
    const names = new Set(); let total = 0;
    for (const f of p.files) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(f.name || '') || names.has(f.name) ||
          !/^[a-f0-9]{64}$/.test(f.sha256 || '') || !Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > 64 * 1024 * 1024)
        throw Error('Invalid approved delivery input file');
      names.add(f.name); total += f.bytes;
    }
    if (total > 128 * 1024 * 1024) throw Error('Delivery input set too large');
    return { ...p, approvalHash: digest(bundle) };
  });
}

export function selectDeliveryInput(inputs, issue, shapeHash) {
  const record = inputs?.find(p => p.issueId === issue.id && p.repository === issue.repository && p.scopeHash === issue.scopeHash);
  if (record?.scopeSource === 'github-issue') return record;
  if (shapeHash === undefined) return null;
  if (record && record.shapeHash !== shapeHash) throw Error('Delivery input differs from the published Shape');
  return record || null;
}

export async function materializeDeliveryInput(stateRoot, executionId, record) {
  if (!record) return null;
  // This is outside /io and /work so neither writable mount provides an alias.
  const directory = join(stateRoot, 'delivery-input-snapshots', executionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [];
  for (const file of record.files) {
    const source = join(stateRoot, 'delivery-input-blobs', file.sha256);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) throw Error('Delivery input blob identity differs');
    const bytes = await readFile(source);
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Delivery input content differs');
    await writeFile(join(directory, file.name), bytes, { flag: 'wx', mode: 0o400 });
    files.push({ ...file, path: '/inputs/' + file.name });
  }
  return { directory, receipt: { approvalHash: record.approvalHash, issueId: record.issueId, scopeHash: record.scopeHash,
    ...(record.scopeSource ? {scopeSource:record.scopeSource} : {}), shapeHash: record.shapeHash,
    purpose: record.purpose, provenance: record.provenance, files, boundary: 'read-only /inputs; data only; independently verify against the approved contract' } };
}
