import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/core.mjs';
import { signGrant, verifyGrant, coreDigest } from '../src/authority.mjs';
import { Store } from '../src/store.mjs';
import { unitId, projectUnit } from '../src/dynamic.mjs';
import { runtimeConfigurationHash } from '../src/runtime.mjs';
import { verifyRequirementRevision, attachRequirementRevision, revisionStore } from '../src/requirement-revision.mjs';
import { createAssigneeRevisionHost } from '../src/assignee-revision-host.mjs';
import { migrateAssigneeRequirements } from '../src/assignee-revision.mjs';
import { assigneeFixture } from './assignee-revision-fixture.mjs';

test('Linux operator adapter fsyncs archives and applies only the exact PATCH/DELETE/PATCH plan; replay does not repeat', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-native-assignee-')); t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state'); await mkdir(stateDirectory);
  const f = await assigneeFixture(stateDirectory), p = structuredClone(f.d.parentBundle.payload);
  const config = { runnerId: 'test-runner', stateDirectory, publicKeyPath: join(root, 'owner.pem'),
    agent: { authDirectory: join(root, 'unused-auth') }, grantSource: { repository: 'test/private', path: 'grant.json' },
    proposalSource: { repository: 'test/private', path: 'original-freeze.txt' } };
  await writeFile(config.publicKeyPath, f.d.publicKey); p.actorGitHubUserId = '77'; p.policy.runtimeHash = runtimeConfigurationHash(config);
  const parent = signGrant(p, f.d.privateKey), grant = verifyGrant(parent, f.d.publicKey), priorPayload = structuredClone(f.d.revisionBundle.payload);
  Object.assign(priorPayload, { parentPayloadHash: digest(p), parentManifestHash: digest(p.manifest), parentPolicyHash: digest(p.policy) });
  const priorBundle = signGrant(priorPayload, f.d.privateKey), prior = verifyRequirementRevision(priorBundle, grant, f.d.publicKey); attachRequirementRevision(grant, prior);
  for (const i of grant.manifest.issues) await new Store(stateDirectory, unitId(grant, i)).transaction(0, () => structuredClone(f.d.states[i.id]));
  const current = await coreDigest(process.cwd()), payload = structuredClone(f.signed.payload);
  Object.assign(payload, { parentPayloadHash: digest(p), parentManifestHash: digest(p.manifest), parentPolicyHash: digest(p.policy),
    priorRequirementRevisionHash: prior.revisionHash, requiredCoreDigest: current });
  for (const s of payload.subjects) { const i = grant.manifest.issues.find(i => i.id === s.issueId);
    s.oldStateHash = digest(await new Store(stateDirectory, unitId(grant, i)).read()); }
  payload.unaffected = await Promise.all(grant.manifest.issues.filter(i => !payload.subjects.some(s => s.issueId === i.id)).map(async i => ({ issueId: i.id,
    stateHash: digest(await new Store(stateDirectory, unitId(grant, i)).read()), projectionHash: digest(projectUnit(grant, i)), unitId: unitId(grant, i) })));
  payload.unaffectedHash = digest(payload.unaffected); const signed = signGrant(payload, f.d.privateKey);
  const archives = prior.subjects.map(s => ({ issueId: s.issueId, digest: digest(s), verified: true })), operations = [];
  const recovery = { revisionHash: prior.revisionHash, coreDigest: digest('previous-installed-core'), recoveryPlanHash: digest('original-recovery-plan'), resumedAt: '2026-01-01T00:00:00Z' };
  await revisionStore(stateDirectory, grant).transaction(0, () => ({ phase: 'active', revisionHash: prior.revisionHash,
    subjects: prior.subjects.map(s => s.issueId), archives, operations, runtimeRecovery: recovery,
    activation: { revisionHash: prior.revisionHash, at: '2026-01-01T00:00:00Z', archivesHash: digest(archives), operationsHash: digest(operations) } }));
  const upgrade = signGrant({ schemaVersion: 1, kind: 'owner-core-upgrade', grantRecordId: grant.recordId,
    manifestHash: digest(grant.manifest), policyHash: digest(grant.policy), runtimeHash: grant.policy.runtimeHash,
    fromCoreDigest: grant.policy.coreDigest, toCoreDigest: current, sourceCommit: 'a'.repeat(40), reason: 'Fixture Core upgrade' }, f.d.privateKey);
  const repair = signGrant({ schemaVersion: 1, kind: 'owner-revision-core-repair', parentRecordId: grant.recordId,
    parentManifestHash: digest(grant.manifest), parentPolicyHash: digest(grant.policy), runtimeHash: grant.policy.runtimeHash,
    requirementRevisionHash: prior.revisionHash, fromCoreDigest: prior.requiredCoreDigest, toCoreDigest: current,
    sourceCommit: 'a'.repeat(40), recoveryPlanHash: recovery.recoveryPlanHash, retainedRecoveryHash: digest(recovery),
    subjectsHash: digest(prior.subjects.map(s => ({ issueId: s.issueId, scopeHash: s.newScopeHash }))),
    allowedEffects: ['execute-existing-six-cycles'], eventRepair: 'provider-native-cycle-boundary-v1', legacyPublicationBounds: [], reason: 'Preserve original recovery' }, f.d.privateKey);
  const bundle = { ...parent, requirementRevision: priorBundle, coreUpgrades: [upgrade], revisionCoreRepairs: [repair], assigneeOrderRevision: signed }, calls = [];
  const get = n => grant.manifest.issues.find(i => i.repository === 'taco3064/nibfin' && i.number === n);
  const github = { grant: async () => structuredClone(bundle), text: async () => p.proposal,
    repository: async () => ({ id: 1 }), dependencies: async i => f.d.observations[i.id].blockedBy.map(node_id => ({ node_id })),
    list: async path => f.d.observations[get(Number(path.split('/')[5])).id].blocking.map(node_id => ({ node_id })),
    issue: async i => { const o = f.d.observations[i.id]; return { node_id: i.id, id: i.number + 1000,
      body: o.bodyHash === payload.subjects[1].newScopeHash ? payload.subjects[1].newScopeBody : grant.manifest.issues.find(s => s.id === i.id).scopeBody,
      ...o.metadata, labels: o.metadata.labels.map(name => ({ name })), state_reason: o.stateReason, assignees: [], milestone: null }; },
    api: async (path, method, body) => {
      if (path === '/user') return { id: 77, type: 'User' };
      if (path === '/graphql') return { data: { node: { id: body.variables.id, projectItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
      assert.equal(method, 'DELETE'); assert.equal(path, '/repos/taco3064/nibfin/issues/31/dependencies/blocked_by/1028'); calls.push({ method, path });
      f.d.observations[get(28).id].blocking = [];
      f.d.observations[get(31).id].blockedBy = f.d.observations[get(31).id].blockedBy.filter(id => id !== get(28).id);
    },
    updateIssue: async (i, patch) => { calls.push({ method: 'PATCH', number: i.number, patch }); const o = f.d.observations[i.id];
      if (i.number === 31) { assert.deepEqual(patch, { body: payload.subjects[1].newScopeBody }); o.bodyHash = digest(patch.body); }
      else { assert.equal(i.number, 28); assert.deepEqual(patch, { state: 'closed', state_reason: 'not_planned' });
        o.metadata.state = 'closed'; o.metadataHash = digest(o.metadata); o.stateReason = 'not_planned'; } }
  };
  const created = await createAssigneeRevisionHost(config, process.cwd(), github, signed, { containers: async () => [] });
  await migrateAssigneeRequirements(created.record, created.host); assert.deepEqual(calls.map(c => c.method), ['PATCH', 'DELETE', 'PATCH']);
  await migrateAssigneeRequirements(created.record, created.host); assert.equal(calls.length, 3);
  const journal = await created.host.store.read(); assert.equal(journal.phase, 'active');
  for (const a of journal.archives) {
    const snapshot = JSON.parse(await readFile(join(stateDirectory, 'assignee-requirement-archives', created.record.revisionHash, a.issueId + '.json'), 'utf8'));
    assert.equal(digest(snapshot), a.digest);
  }
});
