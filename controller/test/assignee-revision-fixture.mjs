import { digest } from '../src/core.mjs';
import { signGrant, verifyGrant } from '../src/authority.mjs';
import { unitId, projectUnit } from '../src/dynamic.mjs';
import { Store } from '../src/store.mjs';
import { attachRequirementRevision, verifyRequirementRevision } from '../src/requirement-revision.mjs';
import { verifyAssigneeRevision, assigneeRevisionStore } from '../src/assignee-revision.mjs';
import { revisionFixture } from './requirement-revision-fixture.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function assigneeFixture(root) {
  const f = await revisionFixture(root), d = structuredClone(f.data), p = d.parentBundle.payload;
  const numbers = [28, 31, 2, 5, 30, 32];
  numbers.forEach((n, k) => { p.manifest.issues[k + 8].number = n; });
  p.policy.manifestHash = digest(p.manifest);
  d.parentBundle = signGrant(p, d.privateKey);
  const legacy = d.revisionBundle.payload;
  Object.assign(legacy, { parentManifestHash: digest(p.manifest), parentPolicyHash: digest(p.policy), parentPayloadHash: digest(p) });
  d.revisionBundle = signGrant(legacy, d.privateKey);
  const grant = verifyGrant(d.parentBundle, d.publicKey), oldRevision = verifyRequirementRevision(d.revisionBundle, grant, d.publicKey);
  attachRequirementRevision(grant, oldRevision);
  const item = n => grant.manifest.issues.find(i => i.number === n && i.repository === 'taco3064/nibfin');
  const edges = [[2, 28], [5, 31], [28, 31], [30, 31], [31, 32]];
  for (const n of numbers) {
    const i = item(n), o = d.observations[i.id];
    o.blockedBy = edges.filter(e => e[1] === n).map(e => item(e[0]).id).sort();
    o.blocking = edges.filter(e => e[0] === n).map(e => item(e[1]).id).sort();
    o.stateReason = null; o.databaseId = n + 1000;
  }
  const subjects = [28, 31].map(n => { const i = item(n), o = d.observations[i.id]; return {
    repository: i.repository, repositoryId: i.repositoryId, number: n, issueId: i.id,
    oldScopeHash: i.scopeHash, oldBodyHash: i.scopeHash, oldStateHash: digest(d.states[i.id]), oldShapeHash: null,
    oldMetadata: structuredClone(o.metadata), metadataHash: digest(o.metadata), oldStateReason: null,
    blockedBy: o.blockedBy, blocking: o.blocking,
    disposition: n === 28 ? 'retire-not-planned' : 'replace-scope',
    newScopeBody: n === 28 ? null : 'Resolve using the fresh trusted GitHub assignees array in returned order.',
    newScopeHash: n === 28 ? null : digest('Resolve using the fresh trusted GitHub assignees array in returned order.') }; });
  const unaffected = grant.manifest.issues.filter(i => ![item(28), item(31)].includes(i)).map(i => ({ issueId: i.id,
    stateHash: digest(d.states[i.id]), unitId: unitId(grant, i), projectionHash: digest(projectUnit(grant, i)) }));
  const effective = n => n === 31 ? subjects[1].newScopeHash : item(n).scopeHash;
  const payload = { schemaVersion: 1, kind: 'owner-assignee-requirement-revision', profile: 'nibfin-assignee-api-order-v0.12.0',
    ordering: 'fresh-github-assignees-array', completionPolicy: 'exclude-retired-not-delivered', recordId: 'assignee-v012', parentRecordId: grant.recordId,
    parentManifestHash: digest(grant.manifest), parentPolicyHash: digest(grant.policy), parentPayloadHash: digest(p),
    priorRequirementRevisionHash: oldRevision.revisionHash, planHash: digest('approved-test-plan'),
    requiredCoreDigest: digest('candidate-core'), proposal: 'Approved v0.12.0 requirement', proposalHash: digest('Approved v0.12.0 requirement'),
    proposalRevision: 'v0.12.0', freezeRevision: 'assignee-v012-freeze', cycleRevision: 'assignee-v012-cycle',
    subjects, retiredDatabaseId: 1028, operations: ['replace-31-body', 'remove-28-blocks-31', 'close-28-not-planned'],
    compatibility: [[5, 31], [30, 31], [31, 32]].map(([a, b]) => ({ producer: item(a).id, consumer: item(b).id,
      producerScopeHash: effective(a), consumerScopeHash: effective(b) })), unaffected, unaffectedHash: digest(unaffected) };
  const signed = signGrant(payload, d.privateKey), record = verifyAssigneeRevision(signed, grant, d.publicKey, oldRevision.revisionHash);
  const archives = new Map(), writes = [], originalStates = structuredClone(d.states);
  const persistence = join(root, 'assignee-provider.json');
  try { const old = JSON.parse(await readFile(persistence, 'utf8')); d.observations = old.observations;
    for (const a of old.archives) archives.set(a.issueId, a); writes.push(...old.writes);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const persist = () => writeFile(persistence, JSON.stringify({ observations: d.observations, archives: [...archives.values()], writes }));
  const host = { installedCoreDigest: record.requiredCoreDigest, store: assigneeRevisionStore(root, grant),
    syncJournal: async () => {}, withSubjectLeases: async (_s, work) => work(),
    authorize: async () => { verifyAssigneeRevision(signed, grant, d.publicKey, oldRevision.revisionHash); },
    verifyUnaffected: async expected => { for (const x of expected) {
      const i = grant.manifest.issues.find(i => i.id === x.issueId);
      if (digest(d.states[x.issueId]) !== x.stateHash || unitId(grant, i) !== x.unitId || digest(projectUnit(grant, i)) !== x.projectionHash) throw Error('Unaffected state changed');
    } },
    history: async s => ({ stateHash: digest(d.states[s.issueId]), pending: null, candidate: false, completed: false, shapeHash: null, quiescent: true }),
    archive: async (s, h) => { const a = { issueId: s.issueId, digest: digest({ s, h }), verified: true }; archives.set(s.issueId, a); await persist(); return a; },
    verifyArchives: async a => { if (a.length !== 2 || a.some(x => archives.get(x.issueId)?.digest !== x.digest)) throw Error('Archive changed');
      if (digest(d.states) !== digest(originalStates)) throw Error('Original history changed'); },
    observe: async s => structuredClone(d.observations[s.issueId]),
    mutate: async id => { writes.push(id); const a = d.observations[item(28).id], b = d.observations[item(31).id];
      if (id === 'replace-31-body') b.bodyHash = subjects[1].newScopeHash;
      else if (id === 'remove-28-blocks-31') { a.blocking = []; b.blockedBy = b.blockedBy.filter(id => id !== item(28).id); }
      else if (id === 'close-28-not-planned') { a.metadata.state = 'closed'; a.metadataHash = digest(a.metadata); a.stateReason = 'not_planned'; }
      else throw Error('Forbidden operation'); await persist(); } };
  const runtime = { installedCoreDigest: record.requiredCoreDigest, config: { stateDirectory: root }, actionIdentity: { runId: '200' },
    github: { api: async () => ({ id: 200, created_at: '2099-01-01T00:00:00Z' }),
      issue: async i => ({ node_id: i.id, id: i.number + 1000, body: i.scopeBody, state: d.observations[i.id].metadata.state,
        state_reason: d.observations[i.id].stateReason, labels: d.observations[i.id].metadata.labels.map(name => ({ name })) }),
      list: async () => d.observations[item(28).id].blocking.map(node_id => ({ node_id })) } };
  return { d, grant, oldRevision, signed, record, host, runtime, item, writes, archives, root };
}

if (process.argv[2] === '--crash-child') {
  const f = await assigneeFixture(process.argv[3]), mutate = f.host.mutate;
  f.host.mutate = async id => { if (process.argv[4] === 'before') process.exit(23); await mutate(id); process.exit(24); };
  const { migrateAssigneeRequirements } = await import('../src/assignee-revision.mjs');
  await migrateAssigneeRequirements(f.record, f.host);
}
