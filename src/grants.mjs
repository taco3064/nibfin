import {canonicalJSON,bodyDigest} from './canonical.mjs';
export {canonicalJSON,bodyDigest} from './canonical.mjs';
import {createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {verifyOwnerSignature} from './collaboration.mjs';
import {githubId, repositoryCoordinates} from './index.mjs';

const fail = category => { throw new TypeError(category); };
const text = (v, category) => {
  if (typeof v !== 'string' || !v.length || /[\x00-\x1f]/.test(v)) fail(category);
};
const object = (v, category) => {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype) fail(category);
};
function fields(v, names, category) {
  object(v, category);
  equal(Object.keys(v).sort(), names.split(' ').sort(), category);
}
const clone = v => JSON.parse(canonicalJSON(v));
const equal = (a, b, category) => { if (canonicalJSON(a) !== canonicalJSON(b)) fail(category); };
function list(v, check, category) {
  if (!Array.isArray(v) || !v.length) fail(category);
  v.forEach(check);
  if (new Set(v.map(canonicalJSON)).size !== v.length) fail(category);
}
function path(v) {
  text(v, 'path');
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(v)
      || v.split('/').some(p => p === '.' || p === '..')) fail('path');
}
function token(v) {
  text(v, 'identity');
  if (v.includes('*')) fail('identity');
}
function snapshot(v) {
  fields(v, 'source revision body hash', 'snapshot');
  text(v.source, 'snapshot'); text(v.revision, 'snapshot');
  if (typeof v.body !== 'string' || v.hash !== bodyDigest(v.body)) fail('snapshot');
}
function repository(v) {
  fields(v, 'id name visibility', 'repository'); githubId(v.id);
  if (typeof v.name !== 'string') fail('repository');
  const parts = v.name.split('/');
  if (parts.length !== 2 || repositoryCoordinates(...parts).key !== v.name) fail('repository');
  if (v.visibility !== 'public') fail('visibility');
}
function work(v) {
  fields(v, 'repository issueId number scope currentBody shape observation', 'work'); repository(v.repository); token(v.issueId);
  githubId(v.number); snapshot(v.scope); snapshot(v.currentBody);
  if (v.shape !== null) snapshot(v.shape);
  snapshot(v.observation);
}
function policy(v) {
  fields(v, 'core runtime agent skills ci merge maxParallel' + (Object.hasOwn(v,'repair')?' repair':''), 'policy');
  if (Object.hasOwn(v,'repair')) {
    fields(v.repair,'mode maxRepairs','repair');
    if (!['until-conformant','bounded'].includes(v.repair.mode)
      || (v.repair.mode==='until-conformant' ? v.repair.maxRepairs!==null
        : !Number.isSafeInteger(v.repair.maxRepairs) || v.repair.maxRepairs<0)) fail('repair');
  }
  for (const key of ['core', 'runtime', 'agent']) token(v[key]);
  object(v.skills, 'skills');
  equal(Object.keys(v.skills).sort(), ['accept', 'deliver', 'shape'], 'skills');
  for (const [identity, s] of Object.entries(v.skills)) {
    fields(s, 'identity mode instructions', 'skills');
    if (s.identity !== identity) fail('skills');
    if (!['default', 'extend', 'override'].includes(s.mode)) fail('skills');
    snapshot(s.instructions);
  }
  fields(v.ci, 'requiredChecks trustedAppIds workflow', 'ci'); list(v.ci.requiredChecks, token, 'ci');
  list(v.ci.trustedAppIds, githubId, 'ci'); snapshot(v.ci.workflow);
  fields(v.merge, 'baseBranch method protected', 'merge'); token(v.merge.baseBranch);
  if (!['merge', 'squash', 'rebase'].includes(v.merge.method) || v.merge.protected !== true) fail('merge');
  if (!Number.isSafeInteger(v.maxParallel) || v.maxParallel < 1) fail('parallelism');
}
function payload(v) {
  fields(v, 'version recordId revision revocationId validFrom expiresAt authority work permissions policy', 'payload');
  if (v.version !== 1) fail('version');
  token(v.recordId); token(v.revision); token(v.revocationId);
  if (!Number.isSafeInteger(v.validFrom) || !Number.isSafeInteger(v.expiresAt)
      || v.validFrom >= v.expiresAt) fail('validity');
  snapshot(v.authority); policy(v.policy);
  list(v.work, work, 'work');
  const identities = v.work.map(w => `${w.repository.id}:${w.issueId}`);
  if (new Set(identities).size !== identities.length
      || new Set(v.work.map(w => w.issueId)).size !== v.work.length
      || new Set(v.work.map(w => `${w.repository.id}:${w.number}`)).size !== v.work.length) fail('work');
  const repos = new Map();
  for (const w of v.work) {
    const prior = repos.get(w.repository.id);
    if (prior) equal(prior, w.repository, 'repository');
    if ([...repos.values()].some(r => r.name === w.repository.name && r.id !== w.repository.id)) fail('repository');
    repos.set(w.repository.id, w.repository);
  }
  list(v.permissions, p => {
    fields(p, 'repository paths operations', 'permissions'); repository(p.repository);
    equal(repos.get(p.repository.id), p.repository, 'permissions');
    list(p.paths, path, 'paths'); list(p.operations, token, 'operations');
  }, 'permissions');
  if (new Set(v.permissions.map(p => p.repository.id)).size !== v.permissions.length) fail('permissions');
  for (const id of repos.keys()) if (!v.permissions.some(p => p.repository.id === id)) fail('permissions');
}

/** Pure preparation: supplied observations only, no signing or provider access. */
export function prepareGrant(input) {
  const draft = clone(input); payload(draft);
  const summary = [
    `DRAFT ONLY: ${draft.recordId} revision ${draft.revision}`,
    `Authority: ${draft.authority.source} ${draft.authority.revision} ${draft.authority.hash}`,
    `Validity [${draft.validFrom}, ${draft.expiresAt}); revocation ${draft.revocationId}`,
    ...draft.work.map(w => `${w.repository.name} (${w.repository.id}) #${w.number} (${w.issueId}) Scope ${w.scope.hash}`),
    ...draft.permissions.map(p => `${p.repository.name}: paths ${p.paths.join(', ')}; operations ${p.operations.join(', ')}`),
    `Policy: ${canonicalJSON(draft.policy)}`,
  ].join('\n');
  return {draft, summary};
}
const bytes = p => Buffer.from('nibfin-grant-v1\n' + canonicalJSON(p));
export function signGrant(approvedPayload, {keyId, privateKey}) {
  const approved = clone(approvedPayload); payload(approved); token(keyId);
  let key;
  try { key = createPrivateKey(privateKey); } catch { fail('signing-key'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('signing-key');
  return {version: 1, algorithm: 'Ed25519', keyId, payload: approved,
    signature: sign(null, bytes({keyId, payload: approved}), key).toString('base64')};
}

/** Returns only a predicate and safe category; never echoes supplied secrets/errors. */
export function verifyGrant(grant, context) {
  try {
    const g = clone(grant); const c = context;
    fields(g, 'version algorithm keyId payload signature', 'grant');
    if (g.version !== 1 || g.algorithm !== 'Ed25519') fail('version');
    token(g.keyId); payload(g.payload); object(c, 'context');
    if (!(c.trustedKeys instanceof Map) || !c.trustedKeys.has(g.keyId)) fail('trust');
    let key;
    try { key = createPublicKey(c.trustedKeys.get(g.keyId)); } catch { fail('trust'); }
    if (key.asymmetricKeyType !== 'ed25519') fail('trust');
    if (typeof g.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(g.signature)) fail('signature');
    const sig = Buffer.from(g.signature, 'base64');
    if (sig.length !== 64 || sig.toString('base64') !== g.signature
        || !verifyOwnerSignature(bytes({keyId: g.keyId, payload: g.payload}), sig, c.trustedKeys.get(g.keyId))) fail('signature');
    const p = g.payload;
    if (!Number.isSafeInteger(c.now) || c.now < p.validFrom || c.now >= p.expiresAt) fail('time');
    object(c.revocation, 'revocation');
    const revocation = clone(c.revocation);
    fields(revocation, 'id available revokedRecords', 'revocation');
    if (revocation.id !== p.revocationId || revocation.available !== true
        || !Array.isArray(revocation.revokedRecords)
        || revocation.revokedRecords.some(r => typeof r !== 'string' || !r.length || /[\x00-\x1f*]/.test(r))
        || new Set(revocation.revokedRecords).size !== revocation.revokedRecords.length
        || revocation.revokedRecords.includes(p.recordId)) fail('revocation');
    equal(p.authority, c.expectedAuthority, 'authority');
    equal(p.policy, c.expectedPolicy, 'policy');
    equal(p.work, c.expectedWork, 'work');
    const r = c.request; object(r, 'request'); repository(r.repository);
    token(r.issueId); githubId(r.number); path(r.path); token(r.operation);
    if (!p.work.some(w => canonicalJSON(w.repository) === canonicalJSON(r.repository)
        && w.issueId === r.issueId && w.number === r.number)) fail('membership');
    const permission = p.permissions.find(x => canonicalJSON(x.repository) === canonicalJSON(r.repository));
    if (!permission || !permission.operations.includes(r.operation)) fail('operation');
    if (!permission.paths.some(x => r.path === x || r.path.startsWith(x + '/'))) fail('path');
    return {ok: true, category: 'authorized'};
  } catch (error) {
    const safe = ['serialization','body','snapshot','repository','visibility','work','payload','version',
      'identity','policy','skills','ci','merge','parallelism','validity','permissions','paths','operations',
      'grant','context','trust','signature','time','revocation','authority','request','membership','operation','path'];
    return {ok: false, category: safe.includes(error.message) ? error.message : 'malformed'};
  }
}
