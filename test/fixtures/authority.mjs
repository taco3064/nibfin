import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { digest, serializeGrant } from '../../src/index.mjs';
// Ephemeral keys exist only in this test process. No fixture secret is persisted.
const keys = generateKeyPairSync('ed25519');
export const clock = Date.parse('2026-10-23T12:00:00.000Z');
const h = 'a'.repeat(64);
export function execution() {
  return { core: h, runtime: h, agent: h, skills: Object.fromEntries(['shape', 'deliver', 'accept'].map(s => [s,
    { version: h, customization: { mode: 'default', contentDigest: digest(readFileSync(new URL(`../../src/instructions/${s}.md`, import.meta.url), 'utf8')) } }])) };
}
export function payloadFor(b) {
  return { schemaVersion: 1, grantId: 'grant-1', recordId: 'record-1', ownerKeyId: 'owner-key',
    members: [{ repository: structuredClone(b.repository), issue: structuredClone(b.issue), scopeDigest: b.scopeDigest,
      dependencies: [], requirements: structuredClone(b.requirements), paths: ['src', 'docs'],
      operations: ['shape', 'validate-shape', 'diagnose-shape', 'shaper-review', 'deliver', 'accept', 'handoff', 'verify-deployment'] }],
    validFrom: '2026-10-23T00:00:00.000Z', expiresAt: '2026-10-24T00:00:00.000Z', revocationId: 'revocation-1',
    policy: { ci: { mode: 'github-repository', requiredChecks: ['quality'], trustedAppIds: ['15368'], workflowDigest: h },
      merge: { baseBranch: 'main', method: 'rebase', protectionDigest: h } }, execution: execution(), maxParallel: 2, repair: null };
}
export function signedFixture(payload) {
  const p = JSON.parse(serializeGrant(payload));
  // Same domain/serialization as documented; public API tests sign separately.
  const bytes = JSON.stringify({ approvalId: 'fixture-approval', domain: 'nibfin-owner-grant-v1', payload: p });
  return { payload: p, approvalId: 'fixture-approval', signature: sign(null, Buffer.from(bytes), keys.privateKey).toString('base64url') };
}
export function authorityOf(g) { return { grantId: g.payload.grantId, digest: digest(g) }; }
export function contextFor(g, operation = 'shape') {
  const p = g.payload, m = p.members[0];
  return { repository: m.repository, issue: m.issue, scopeDigest: m.scopeDigest, dependencies: m.dependencies,
    requirements: m.requirements, paths: [], operation, policy: p.policy, execution: p.execution, maxParallel: 2, repair: p.repair };
}
export function fixtureAuthorization(b) {
  const p = payloadFor(b), parents = [];
  if (b.incidentId) {
    const original = signedFixture(p); parents.push(original);
    p.grantId = 'repair-grant'; p.recordId = 'repair-record'; p.revocationId = 'repair-revocation';
    p.repair = { incidentId: b.incidentId, repositoryId: b.repository.id, issueId: b.issue.id,
      environment: 'production', version: 'release-1', commit: 'a'.repeat(40), deliveryCycle: b.deliveryCycle,
      repairCycle: b.repairCycle, originalAuthority: authorityOf(original) };
  }
  const grant = signedFixture(p);
  return { grant, parents, authority: authorityOf(grant), host: hostFor(grant, parents) };
}
export function hostFor(grant, parents = []) {
  const g = structuredClone(grant);
  return { ownerKey: async id => { if (id !== 'owner-key') throw Error('Unknown key'); return keys.publicKey; },
    signingKey: async () => keys.privateKey,
    readApproval: async expected => ({ ...expected, approved: true, approvalId: 'fixture-approval' }),
    now: () => clock, revocation: async expected => ({ ...expected, revoked: false }),
    resolve: async a => structuredClone([g, ...parents].find(x => digest(x) === a.digest)),
    observe: async request => contextFor(g, ({ 'shape-validator': 'validate-shape', 'shape-diagnosis': 'diagnose-shape' })[request.binding?.role ?? request.stage] ?? request.binding?.role ?? request.stage) };
}
