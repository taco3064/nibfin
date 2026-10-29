import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core.mjs';
import { signGrant } from '../src/authority.mjs';
import { unitId, projectUnit, summarizeDynamicCompletion } from '../src/dynamic.mjs';
import { assertRevisionExecution, revisionDependency, revisionEventBoundary } from '../src/requirement-revision.mjs';
import { verifyAssigneeRevision, attachAssigneeRevision, migrateAssigneeRequirements, assigneeRetirement, isAssigneeRetirement } from '../src/assignee-revision.mjs';
import { assigneeFixture } from './assignee-revision-fixture.mjs';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'kairo-assignee-')); t.after(() => rm(root, { recursive: true, force: true })); return assigneeFixture(root); }

test('two-subject retirement preserves all 74 projections and old six-subject cycles without changing original history', async t => {
  const f = await fixture(t), before = f.grant.manifest.issues.map(i => ({ id: i.id, unit: unitId(f.grant, i), projection: canonical(projectUnit(f.grant, i)) }));
  const states = canonical(f.d.states), parent = canonical(f.grant);
  await migrateAssigneeRequirements(f.record, f.host); attachAssigneeRevision(f.grant, f.record);
  for (const i of f.grant.manifest.issues) if (i.id !== f.item(31).id) {
    const b = before.find(x => x.id === i.id); assert.equal(unitId(f.grant, i), b.unit); assert.equal(canonical(projectUnit(f.grant, i)), b.projection);
  }
  assert.notEqual(unitId(f.grant, f.item(31)), before.find(x => x.id === f.item(31).id).unit);
  assert.equal(projectUnit(f.grant, f.item(31)).manifest.issues[0].scopeHash, f.record.subjects[1].newScopeHash);
  assert.equal(canonical(f.d.states), states); assert.equal(canonical(f.grant), parent);
  assert.deepEqual(f.writes, f.record.operations); assert.equal(f.d.observations[f.item(28).id].stateReason, 'not_planned');
  assert.equal(f.d.observations[f.item(28).id].metadata.labels.includes('delivered'), false);
  await assert.rejects(assertRevisionExecution(f.runtime, f.grant, f.item(28)), { code: 'REQUIREMENT_RETIRED_NOT_DELIVERED' });
  await assertRevisionExecution(f.runtime, f.grant, f.item(31), f.record.revisionHash);
  await revisionDependency(f.runtime, f.grant, f.item(5), f.item(31)); // Does not assert #5 is complete.
  await revisionDependency(f.runtime, f.grant, f.item(31), f.item(32));
  await assert.rejects(revisionDependency(f.runtime, f.grant, f.item(28), f.item(31)), { code: 'RETIRED_REQUIREMENT_DEPENDENCY' });
});

for (const fault of ['signature', 'parent', 'prior-revision', 'extra-subject', 'extra-operation', 'wrong-scope', 'edge', 'compatibility', 'unaffected']) test(`rejects ${fault} before mutation`, async t => {
  const f = await fixture(t), p = structuredClone(f.signed.payload);
  if (fault === 'parent') p.parentPayloadHash = digest('other');
  if (fault === 'prior-revision') p.priorRequirementRevisionHash = digest('other');
  if (fault === 'extra-subject') p.subjects.push(p.subjects[0]);
  if (fault === 'extra-operation') p.operations.push('dispatch');
  if (fault === 'wrong-scope') p.subjects[1].newScopeHash = digest('other');
  if (fault === 'edge') p.subjects[0].blocking.push(f.item(32).id);
  if (fault === 'compatibility') p.compatibility.pop();
  if (fault === 'unaffected') p.unaffected.pop();
  const b = signGrant(p, f.d.privateKey); if (fault === 'signature') b.signature = 'invalid';
  assert.throws(() => verifyAssigneeRevision(b, f.grant, f.d.publicKey, f.oldRevision.revisionHash)); assert.equal(f.writes.length, 0);
});
for (const id of ['replace-31-body', 'remove-28-blocks-31', 'close-28-not-planned']) test(`lost successful ${id} response reconciles once without duplicate effect`, async t => {
  const f = await fixture(t), mutate = f.host.mutate; let lost = false;
  f.host.mutate = async op => { await mutate(op); if (op === id && !lost) { lost = true; throw Error('Lost response'); } };
  await assert.rejects(migrateAssigneeRequirements(f.record, f.host), { code: 'ASSIGNEE_WRITE_OUTCOME_UNKNOWN' });
  assert.equal((await f.host.store.read()).phase, 'fenced');
  await assert.rejects(assertRevisionExecution(f.runtime, f.grant, f.item(31)), { code: 'ASSIGNEE_MIGRATION_HELD' });
  f.host.mutate = mutate; await migrateAssigneeRequirements(f.record, f.host);
  assert.deepEqual(f.writes, f.record.operations); assert.equal((await f.host.store.read()).phase, 'active');
});
test('attempted write with no observed effect remains fenced and is never retried', async t => {
  const f = await fixture(t); f.host.mutate = async id => { f.writes.push(id); throw Error('Unknown whether sent'); };
  await assert.rejects(migrateAssigneeRequirements(f.record, f.host));
  await assert.rejects(migrateAssigneeRequirements(f.record, f.host), { code: 'ASSIGNEE_PROVIDER_DRIFT' });
  assert.deepEqual(f.writes, ['replace-31-body']); assert.equal((await f.host.store.read()).phase, 'fenced');
});
test('fresh event boundary and provider creation time reject old queued or rerun requests', async t => {
  const f = await fixture(t); await migrateAssigneeRequirements(f.record, f.host); attachAssigneeRevision(f.grant, f.record);
  const b = await revisionEventBoundary(f.runtime, f.grant, f.item(31)); assert.equal(b.revisionHash, f.record.revisionHash);
  await assert.rejects(assertRevisionExecution(f.runtime, f.grant, f.item(31), null), { code: 'STALE_ASSIGNEE_REQUEST' });
  f.runtime.github.api = async () => ({ id: 200, created_at: '2020-01-01T00:00:00Z' });
  await assert.rejects(assertRevisionExecution(f.runtime, f.grant, f.item(31)), { code: 'STALE_ASSIGNEE_RUN' });
});
for (const fault of ['metadata', 'reverse-edge', 'active-writer', 'unaffected', 'archive', 'core']) test(`migration blocks ${fault} without provider writes`, async t => {
  const f = await fixture(t);
  if (fault === 'metadata') f.d.observations[f.item(31).id].metadata.title = 'Changed';
  if (fault === 'reverse-edge') f.d.observations[f.item(28).id].blocking = [];
  if (fault === 'active-writer') { const h = f.host.history; f.host.history = async s => ({ ...await h(s), pending: { stage: 'deliver' } }); }
  if (fault === 'unaffected') f.d.states[f.item(32).id].pending = { stage: 'shape' };
  if (fault === 'archive') f.host.archive = async s => ({ issueId: s.issueId, verified: false });
  if (fault === 'core') f.host.installedCoreDigest = digest('wrong');
  await assert.rejects(migrateAssigneeRequirements(f.record, f.host)); assert.equal(f.writes.length, 0);
});

for (const point of ['before', 'after']) test(`distinct-process crash ${point} provider effect preserves the fence and never blindly repeats`, async t => {
  const f = await fixture(t), child = spawnSync(process.execPath, [fileURLToPath(new URL('./assignee-revision-fixture.mjs', import.meta.url)), '--crash-child', f.root, point], { encoding: 'utf8' });
  assert.equal(child.status, point === 'before' ? 23 : 24, child.stderr);
  await assert.rejects(migrateAssigneeRequirements(f.record, f.host), { code: 'EEXIST' });
  const path = join(f.host.store.directory, 'execution.lock'), lock = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(lock.pid, child.pid); await unlink(path); // Test-only recovery after the child demonstrably exited.
  const fresh = await assigneeFixture(f.root);
  if (point === 'before') {
    await assert.rejects(migrateAssigneeRequirements(fresh.record, fresh.host), { code: 'ASSIGNEE_PROVIDER_DRIFT' });
    assert.equal(fresh.writes.length, 0); assert.equal((await fresh.host.store.read()).phase, 'fenced');
  } else {
    await migrateAssigneeRequirements(fresh.record, fresh.host); assert.deepEqual(fresh.writes, fresh.record.operations);
    assert.equal((await fresh.host.store.read()).phase, 'active');
  }
});

test('unpersisted attempted intent and malformed journal prefix cannot cause provider effects', async t => {
  const f = await fixture(t), tx = f.host.store.transaction.bind(f.host.store); let rejectAttempt = true;
  f.host.store.transaction = async (version, update) => tx(version, old => { const next = update(old);
    if (rejectAttempt && next.operations?.some(o => o.status === 'attempted')) throw Error('Cannot persist'); return next; });
  await assert.rejects(migrateAssigneeRequirements(f.record, f.host)); assert.equal(f.writes.length, 0);
  rejectAttempt = false; const state = await f.host.store.read();
  await tx(state.revision, old => ({ ...old, operations: old.operations.map((o, i) => i === 1 ? { ...o, status: 'matching', evidence: ['forged-prefix'] } : o) }));
  await assert.rejects(migrateAssigneeRequirements(f.record, f.host), { code: 'ASSIGNEE_JOURNAL_INVALID' }); assert.equal(f.writes.length, 0);
});

test('retirement is independently read back, never a delivered proof or a caller-supplied verified flag', async t => {
  const f = await fixture(t); await migrateAssigneeRequirements(f.record, f.host); attachAssigneeRevision(f.grant, f.record);
  const result = await assigneeRetirement(f.runtime, f.grant, f.item(28));
  assert.equal(result.status, 'RETIRED'); assert.equal(result.completed, false); assert.equal(result.completionHash, undefined);
  assert.ok(isAssigneeRetirement(result)); assert.equal(isAssigneeRetirement(structuredClone(result)), false);
  const units = f.grant.manifest.issues.map(i => i.id === f.item(28).id ? Object.assign(result, { issueId: i.id, unitId: unitId(f.grant, i) }) :
    { issueId: i.id, unitId: unitId(f.grant, i), status: 'COMPLETE', completionHash: digest('synthetic-complete:' + i.id) });
  const summary = summarizeDynamicCompletion(f.grant, units); assert.equal(summary.complete, true);
  assert.equal(summary.retiredUnits.length, 1); assert.equal(summary.retiredUnits[0].issueId, f.item(28).id);
  const copied = units.map(u => structuredClone(u)); assert.equal(summarizeDynamicCompletion(f.grant, copied).complete, false);
  f.d.observations[f.item(28).id].metadata.labels.push('delivered');
  await assert.rejects(assigneeRetirement(f.runtime, f.grant, f.item(28)), { code: 'ASSIGNEE_RETIREMENT_UNVERIFIED' });
  f.d.observations[f.item(28).id].metadata.labels.pop(); f.d.observations[f.item(28).id].blocking.push(f.item(31).id);
  await assert.rejects(assigneeRetirement(f.runtime, f.grant, f.item(28)), { code: 'RETIRED_REQUIREMENT_DEPENDENCY' });
});
