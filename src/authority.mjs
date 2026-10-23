import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { validateRequirements, verifyRequirements } from './requirements.mjs';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const insist = ok => { if (!ok) throw Error('Owner authorization is invalid or unavailable.'); };
const text = x => typeof x === 'string' && /^[\x21-\x7e]+$/.test(x) && !x.includes('*');
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const positive = x => Number.isSafeInteger(x) && x > 0;
function fields(x, keys) {
  insist(x && Object.getPrototypeOf(x) === Object.prototype &&
    Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k)));
}
// Only JSON data is signed; sorted object keys remove caller property-order ambiguity.
function canonical(x) {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
  if (typeof x === 'number') { insist(Number.isSafeInteger(x)); return x; }
  if (Array.isArray(x)) { insist(Object.keys(x).length === x.length); return x.map(canonical); }
  insist(x && Object.getPrototypeOf(x) === Object.prototype && Object.getOwnPropertySymbols(x).length === 0);
  return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const serializeGrant = payload => JSON.stringify(canonical(validateGrant(payload)));
export const grantDraftDigest = payload => digest(serializeGrant(payload));
const operations = ['shape', 'validate-shape', 'diagnose-shape', 'shaper-review', 'deliver', 'accept',
  'publish-shape', 'pre-accept-hooks', 'post-accept-hooks', 'commit-pr', 'merge', 'verify-deployment',
  'close', 'mark-delivered', 'handoff', 'recovery-comment', 'reopen', 'repair', 'invalidate-shape'];
const skillRoles = { shape: 'shape', 'shape-validator': 'shape', 'shape-diagnosis': 'shape',
  'shaper-review': 'shape', deliver: 'deliver', accept: 'accept' };
function path(p) {
  insist(text(p) && !/[\\:%?#\x00-\x20]/.test(p) && !p.startsWith('/') &&
    p.split('/').every(s => s !== '' && s !== '.' && s !== '..'));
}
function unique(items, test) {
  insist(Array.isArray(items) && items.length > 0 && new Set(items.map(x => JSON.stringify(canonical(x)))).size === items.length);
  items.forEach(x => insist(test(x)));
}
function repository(r) {
  fields(r, ['id', 'name']); insist(text(r.id) && text(r.name) && /^[^/]+\/[^/]+$/.test(r.name));
}
function issue(i, r) {
  fields(i, ['id', 'number', 'repositoryId']); insist(text(i.id) && positive(i.number) && i.repositoryId === r.id);
}
function policy(p) {
  fields(p, ['ci', 'merge']);
  fields(p.ci, ['mode', 'requiredChecks', 'trustedAppIds', 'workflowDigest']);
  insist(['github-repository', 'signed-workflow'].includes(p.ci.mode) && hash(p.ci.workflowDigest));
  unique(p.ci.requiredChecks, text); unique(p.ci.trustedAppIds, text);
  fields(p.merge, ['baseBranch', 'method', 'protectionDigest']);
  insist(text(p.merge.baseBranch) && ['rebase', 'squash', 'merge'].includes(p.merge.method) && hash(p.merge.protectionDigest));
}
function execution(e) {
  fields(e, ['core', 'runtime', 'agent', 'skills']);
  insist(['core', 'runtime', 'agent'].every(k => hash(e[k])));
  fields(e.skills, ['shape', 'deliver', 'accept']);
  for (const s of Object.values(e.skills)) {
    fields(s, ['version', 'customization']); insist(hash(s.version));
    fields(s.customization, ['mode', 'contentDigest']);
    insist(['default', 'extend', 'override'].includes(s.customization.mode) && hash(s.customization.contentDigest));
  }
}
function reference(a) { fields(a, ['grantId', 'digest']); insist(text(a.grantId) && hash(a.digest)); }
const repairKeys = ['incidentId', 'repositoryId', 'issueId', 'environment', 'version', 'commit',
  'deliveryCycle', 'repairCycle', 'originalAuthority'];
function repair(r) {
  fields(r, repairKeys); insist(repairKeys.filter(k => k !== 'originalAuthority').every(k => text(r[k])));
  insist(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.commit)); reference(r.originalAuthority);
}
export function validateGrant(p) {
  fields(p, ['schemaVersion', 'grantId', 'recordId', 'ownerKeyId', 'members', 'validFrom', 'expiresAt',
    'revocationId', 'policy', 'execution', 'maxParallel', 'repair']);
  insist(p.schemaVersion === 1 && ['grantId', 'recordId', 'ownerKeyId', 'revocationId'].every(k => text(p[k])));
  for (const k of ['validFrom', 'expiresAt']) insist(typeof p[k] === 'string' &&
    Number.isFinite(Date.parse(p[k])) && new Date(p[k]).toISOString() === p[k]);
  insist(Date.parse(p.validFrom) < Date.parse(p.expiresAt) && positive(p.maxParallel));
  policy(p.policy); execution(p.execution);
  unique(p.members, m => {
    fields(m, ['repository', 'issue', 'scopeDigest', 'dependencies', 'requirements', 'paths', 'operations']);
    repository(m.repository); issue(m.issue, m.repository); insist(hash(m.scopeDigest)); validateRequirements(m.requirements);
    insist(Array.isArray(m.dependencies) && new Set(m.dependencies).size === m.dependencies.length && m.dependencies.every(text));
    unique(m.paths, x => { path(x); return true; }); unique(m.operations, x => operations.includes(x)); return true;
  });
  insist(new Set(p.members.map(m => m.issue.id)).size === p.members.length &&
    new Set(p.members.map(m => `${m.repository.id}:${m.issue.number}`)).size === p.members.length);
  const names = new Map(), ids = new Map();
  for (const m of p.members) {
    insist(!names.has(m.repository.name) || names.get(m.repository.name) === m.repository.id);
    insist(!ids.has(m.repository.id) || ids.get(m.repository.id) === m.repository.name);
    names.set(m.repository.name, m.repository.id); ids.set(m.repository.id, m.repository.name);
  }
  if (p.repair !== null) {
    repair(p.repair); insist(p.members.length === 1 && p.repair.repositoryId === p.members[0].repository.id && p.repair.issueId === p.members[0].issue.id);
  } else insist(p.members.every(m => !m.operations.some(o => ['repair', 'reopen', 'recovery-comment'].includes(o))));
  return p;
}
async function safe(work) {
  try { return await work(); } catch { throw Error('Owner authorization is invalid or unavailable.'); }
}
// Host readers have no write/sign/execute capability requirement. Discovery never edits membership.
export async function prepareGrant(proposal, host) {
  return safe(async () => {
    const p = structuredClone(proposal); validateGrant(p);
    insist(typeof host?.readWorkSet === 'function' && typeof host?.readPolicy === 'function');
    const targets = p.members.map(m => ({ repository: m.repository, issue: m.issue }));
    const current = structuredClone(await host.readPolicy(structuredClone(targets)));
    fields(current, ['policy', 'execution', 'maxParallel']);
    insist(same(current.policy, p.policy) && same(current.execution, p.execution) &&
      positive(current.maxParallel) && p.maxParallel <= current.maxParallel);
    const observed = structuredClone(await host.readWorkSet(structuredClone(p.members.map(m => ({ repository: m.repository, issue: m.issue })))));
    fields(observed, ['complete', 'members']); insist(observed.complete === true && Array.isArray(observed.members));
    insist(new Set(observed.members.map(m => m.issue?.id)).size === observed.members.length);
    for (const o of observed.members) {
      fields(o, ['repository', 'issue', 'originalBody', 'dependencies', 'requirements']);
      repository(o.repository); issue(o.issue, o.repository); validateRequirements(o.requirements);
      insist(typeof o.originalBody === 'string' && Array.isArray(o.dependencies) &&
        o.dependencies.every(text) && new Set(o.dependencies).size === o.dependencies.length);
    }
    for (const m of p.members) {
      const o = observed.members.find(o => o.issue?.id === m.issue.id);
      fields(o, ['repository', 'issue', 'originalBody', 'dependencies', 'requirements']);
      insist(typeof o.originalBody === 'string' && same(o.repository, m.repository) && same(o.issue, m.issue) &&
        digest(o.originalBody) === m.scopeDigest && same(o.dependencies, m.dependencies) && same(o.requirements, m.requirements));
      await verifyRequirements({ ...structuredClone(m), authority: { grantId: p.grantId, digest: grantDraftDigest(p) } }, host.requirements);
    }
    const unauthorized = observed.members.filter(o => !p.members.some(m => m.issue.id === o.issue.id)).map(o => o.issue.id);
    return { payload: p, draftDigest: grantDraftDigest(p), unauthorized,
      summary: [
        'Unsigned authorization draft. No execution authority.',
        `Grant: ${p.grantId}; record: ${p.recordId}; Owner key: ${p.ownerKeyId}.`,
        `Validity: ${p.validFrom} inclusive until ${p.expiresAt} exclusive; revocation record: ${p.revocationId}.`,
        `Concurrency limit (maxParallel): ${p.maxParallel}.`,
        ...p.members.map(m => `${m.repository.name}#${m.issue.number} (repository ${m.repository.id}, Issue ${m.issue.id}): original Scope ${m.scopeDigest}; native upstream Issues ${JSON.stringify(m.dependencies)}; allowed operations ${m.operations.join(', ')}; allowed paths ${m.paths.join(', ')}; approved requirements ${JSON.stringify(m.requirements)}.`),
        `CI and merge policy: ${JSON.stringify(p.policy)}.`,
        `Trusted execution and Skill identities: ${JSON.stringify(p.execution)}.`,
        `Repair bounds: ${JSON.stringify(p.repair)}.`,
        `Unauthorized discovered Issues: ${JSON.stringify(unauthorized)}.`
      ].join('\n') };
  });
}
function key(k) {
  const publicKey = k?.type === 'public' ? k : createPublicKey(k);
  insist(publicKey.asymmetricKeyType === 'ed25519'); return publicKey;
}
const signedBytes = (payload, approvalId) => Buffer.from(JSON.stringify(canonical({ domain: 'nibfin-owner-grant-v1', payload, approvalId })));
const signatureBytes = s => {
  insist(typeof s === 'string' && /^[A-Za-z0-9_-]{86}$/.test(s));
  const b = Buffer.from(s, 'base64url'); insist(b.length === 64 && b.toString('base64url') === s); return b;
};
export async function signGrant(draft, host) {
  return safe(async () => {
    const d = structuredClone(draft);
    fields(d, ['payload', 'draftDigest', 'unauthorized', 'summary']); validateGrant(d.payload);
    insist(d.draftDigest === grantDraftDigest(d.payload) && typeof host?.readApproval === 'function' && typeof host?.signingKey === 'function');
    const expected = { grantId: d.payload.grantId, draftDigest: d.draftDigest, ownerKeyId: d.payload.ownerKeyId };
    const a = structuredClone(await host.readApproval(structuredClone(expected)));
    fields(a, ['grantId', 'draftDigest', 'ownerKeyId', 'approvalId', 'approved']);
    insist(a.approved === true && text(a.approvalId) && Object.keys(expected).every(k => a[k] === expected[k]));
    const privateKey = await host.signingKey(d.payload.ownerKeyId);
    const publicKey = key(await host.ownerKey(d.payload.ownerKeyId));
    const signature = sign(null, signedBytes(d.payload, a.approvalId), privateKey).toString('base64url');
    insist(verify(null, signedBytes(d.payload, a.approvalId), publicKey, signatureBytes(signature)));
    return { payload: d.payload, approvalId: a.approvalId, signature };
  });
}
async function authenticate(grant, host, authority) {
  const g = structuredClone(grant);
  fields(g, ['payload', 'approvalId', 'signature']); validateGrant(g.payload); insist(text(g.approvalId));
  reference(authority); insist(authority.grantId === g.payload.grantId && authority.digest === digest(g));
  insist(typeof host?.ownerKey === 'function');
  insist(verify(null, signedBytes(g.payload, g.approvalId), key(await host.ownerKey(g.payload.ownerKeyId)), signatureBytes(g.signature)));
  return g;
}
export async function verifyGrant(grant, host, authority) {
  return safe(async () => {
    const a = structuredClone(authority), g = await authenticate(grant, host, a), p = g.payload;
    insist(typeof host.now === 'function' && typeof host.revocation === 'function');
    const now = await host.now(); insist(Number.isSafeInteger(now) && now >= Date.parse(p.validFrom) && now < Date.parse(p.expiresAt));
    const expected = { authority: a, revocationId: p.revocationId };
    const status = structuredClone(await host.revocation(structuredClone(expected)));
    fields(status, ['authority', 'revocationId', 'revoked']); insist(same(status, { ...expected, revoked: false }));
    if (p.repair !== null) {
      insist(typeof host.resolve === 'function');
      const original = await authenticate(await host.resolve(structuredClone(p.repair.originalAuthority)), host, p.repair.originalAuthority);
      insist(original.payload.repair === null && p.grantId !== original.payload.grantId && p.recordId !== original.payload.recordId);
      const m = p.members[0];
      insist(original.payload.members.some(o => same(o.repository, m.repository) && same(o.issue, m.issue) && o.scopeDigest === m.scopeDigest && same(o.requirements, m.requirements)));
    }
    return g;
  });
}
// Actual operation context is observed independently by trusted Core, never inferred from events.
export async function authorizeOperation(grant, context, host, authority) {
  return safe(async () => {
    const c = structuredClone(context);
    const g = await verifyGrant(grant, host, structuredClone(authority)), p = g.payload;
    fields(c, ['repository', 'issue', 'scopeDigest', 'dependencies', 'requirements', 'paths', 'operation',
      'policy', 'execution', 'maxParallel', 'repair']);
    repository(c.repository); issue(c.issue, c.repository); validateRequirements(c.requirements);
    const m = p.members.find(m => same(m.repository, c.repository) && same(m.issue, c.issue));
    insist(m && c.scopeDigest === m.scopeDigest && same(c.dependencies, m.dependencies) && same(c.requirements, m.requirements));
    insist(m.operations.includes(c.operation) && Array.isArray(c.paths));
    for (const target of c.paths) { path(target); insist(m.paths.some(bound => target === bound || target.startsWith(`${bound}/`))); }
    insist(same(c.policy, p.policy) && same(c.execution, p.execution) && positive(c.maxParallel) && c.maxParallel <= p.maxParallel && same(c.repair, p.repair));
    return { authority: structuredClone(authority), approvalId: g.approvalId, operation: c.operation };
  });
}
export async function authorizeRequest(request, host, protectedBinding = false) {
  return safe(async () => {
    const r = structuredClone(request), b = protectedBinding ? r.binding : r;
    insist(typeof host?.resolve === 'function' && typeof host?.observe === 'function');
    const a = structuredClone(b.authority);
    const grant = structuredClone(await host.resolve(structuredClone(a)));
    const c = structuredClone(await host.observe(structuredClone(r)));
    for (const k of ['repository', 'issue', 'scopeDigest', 'requirements']) insist(same(c[k], b[k]));
    const role = protectedBinding ? b.role : b.stage;
    const operation = { 'shape-validator': 'validate-shape', 'shape-diagnosis': 'diagnose-shape' }[role] ?? role;
    insist(c.operation === operation);
    if (protectedBinding) {
      insist(skillRoles[b.role] === b.skill && c.execution.core === b.versions.core &&
        c.execution.runtime === b.versions.runtime && c.execution.agent === b.versions.adapter &&
        c.execution.skills[b.skill].version === b.versions.skill);
      insist(c.repair === null ? b.incidentId === null && b.repairCycle === null :
        c.repair.incidentId === b.incidentId && c.repair.repairCycle === b.repairCycle && c.repair.deliveryCycle === b.deliveryCycle);
    }
    const receipt = await authorizeOperation(grant, c, host, a);
    return { ...receipt, context: c };
  });
}
