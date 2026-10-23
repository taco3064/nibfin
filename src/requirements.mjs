import { digest } from './index.mjs';
const text = x => typeof x === 'string' && x.trim().length > 0;
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const insist = ok => { if (!ok) throw Error('Requirement evidence is invalid or unavailable.'); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function validateSource(s) {
  insist(exact(s, ['kind', 'id']) && s.kind === 'notion' && text(s.id));
  return { kind: s.kind, id: s.id };
}
export function validateReference(r) {
  insist(exact(r, ['schemaVersion', 'source', 'revision', 'contentDigest', 'snapshotId']) &&
    r.schemaVersion === 1 && text(r.revision) && hash(r.contentDigest) && hash(r.snapshotId));
  const source = validateSource(r.source);
  const canonical = { schemaVersion: 1, source, revision: r.revision, contentDigest: r.contentDigest };
  insist(r.snapshotId === digest(canonical));
  return { ...canonical, snapshotId: r.snapshotId };
}
export function validateRequirements(bindings) {
  insist(exact(bindings, ['productSecurity', 'delivery']));
  return Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, validateReference(value)]));
}
export function validateSnapshot(s) {
  insist(exact(s, ['reference', 'content']) && typeof s.content === 'string');
  const reference = validateReference(s.reference);
  insist(digest(s.content) === reference.contentDigest);
  return { reference, content: s.content };
}
async function observe(configuration) {
  const source = validateSource(configuration.source);
  insist(typeof configuration.read === 'function');
  // A trusted reader must assemble all required blocks and revalidate the revision.
  const read = structuredClone(await configuration.read(structuredClone(source)));
  insist(exact(read, ['source', 'revision', 'endRevision', 'content', 'complete', 'unavailable']) &&
    equal(validateSource(read.source), source) && text(read.revision) &&
    read.revision === read.endRevision && typeof read.content === 'string' &&
    read.complete === true && Array.isArray(read.unavailable) && read.unavailable.length === 0);
  const canonical = { schemaVersion: 1, source, revision: read.revision, contentDigest: digest(read.content) };
  return { reference: { ...canonical, snapshotId: digest(canonical) }, content: read.content };
}
// Storage is trusted and must implement atomic insert-if-absent, never replacement.
export async function captureSnapshot(configuration, storage) {
  const snapshot = await observe(configuration);
  insist(typeof storage?.putIfAbsent === 'function' && typeof storage?.get === 'function');
  await storage.putIfAbsent(snapshot.reference.snapshotId, structuredClone(snapshot));
  const stored = validateSnapshot(structuredClone(await storage.get(snapshot.reference.snapshotId)));
  insist(equal(stored, snapshot));
  return snapshot;
}
export async function verifyRequirements(request, configuration) {
  const bindings = validateRequirements(request.requirements);
  insist(exact(configuration, ['productSecurity', 'delivery', 'storage', 'verifyApproval']));
  insist(typeof configuration.verifyApproval === 'function' && typeof configuration.storage?.get === 'function');
  for (const context of ['productSecurity', 'delivery']) {
    const expected = bindings[context];
    const current = await observe(configuration[context]);
    insist(equal(current.reference, expected));
    const snapshot = validateSnapshot(structuredClone(await configuration.storage.get(expected.snapshotId)));
    insist(equal(snapshot, current));
    const approval = { schemaVersion: 1, context, reference: expected,
      authority: request.authority, repository: request.repository, issue: request.issue };
    insist(await configuration.verifyApproval(structuredClone(approval)) === true);
  }
  return bindings;
}
