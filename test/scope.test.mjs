import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { digest, verifyScopePlan, verifyScopeHandoff, auditScope, scopeInstructions,
  publicationPlanDigest, skillForRole } from '../src/index.mjs';
import { scopeFixture } from './fixtures/scope.mjs';
const codes = result => result.findings.map(f => f.code);
const validate = f => verifyScopePlan(f.plan, f.trusted);

test('whole plan covers authority and independent multi-repository work; handoff is separate', async () => {
  const f = scopeFixture();
  const result = await verifyScopeHandoff(f.plan, f.trusted);
  assert.equal(result.planValid, true);
  assert.equal(result.publicationReady, true);
  assert.deepEqual(result.coverage.behavior, ['item-0']);
  assert.equal(result.planDigest, publicationPlanDigest(f.plan));
  assert.equal(result.executionEligibility, undefined);
  assert.equal(f.writes(), 0);
});

test('approved partial plans partition authority and identify external prerequisites', async () => {
  const f = scopeFixture();
  f.plan.boundary = { mode: 'partial', included: ['behavior', 'docs', 'release'], excluded: [{ id: 'safety', reason: 'Separately approved safety work.' }] };
  f.plan.items.splice(1, 1);
  // A release prerequisite may be explicitly evidenced instead of duplicated in a ticket.
  f.plan.items = f.plan.items.filter(i => i.id !== 'item-3');
  f.plan.dependencies = [];
  f.plan.prerequisites = [{ requirement: 'release', outcome: 'Existing release integration', repository: 'example/entry', evidence: ['release:verified-baseline'] }];
  const boundaryDigest = digest(f.plan.boundary);
  f.trusted.verifyBoundaryApproval = async ({ boundary }) => digest(boundary) === boundaryDigest;
  assert.equal((await validate(f)).planValid, true);
  f.plan.items.push(scopeFixture().plan.items[1]);
  assert(codes(await validate(f)).includes('outside-boundary'));
  f.plan.boundary.excluded = [];
  assert(codes(await validate(f)).includes('invalid-boundary'));
  delete f.trusted.verifyBoundaryApproval;
  assert(codes(await validate(f)).includes('partial-approval'));
});

test('missing, duplicate and deliberate shared coverage are distinct', async () => {
  const f = scopeFixture();
  const removed = f.plan.items.shift();
  assert(codes(await validate(f)).includes('missing-coverage'));
  f.plan.items.unshift(removed, { ...structuredClone(removed), id: 'shared' });
  assert(codes(await validate(f)).includes('duplicate-coverage'));
  f.plan.sharedVerification = [{ requirement: 'behavior', items: ['item-0', 'shared'],
    rationale: 'A separate consumer verifies compatibility.', evidence: ['consumer:contract-test'] }];
  assert.equal((await validate(f)).planValid, true);
});

test('missing and unauthenticated authority prevents completeness; approval flags are powerless', async () => {
  for (const mutate of [f => { f.plan.authority.content = ''; }, f => { delete f.plan.authority.reference; },
    f => { delete f.trusted.verifyAuthority; }, f => { f.trusted.verifyAuthority = async () => { throw Error('denied'); }; },
    f => { f.plan.requirements.pop(); }]) {
    const f = scopeFixture(); mutate(f);
    assert(codes(await validate(f)).includes('authority-unavailable'));
  }
  const f = scopeFixture();
  f.plan.approved = true;
  delete f.trusted.verifyPublicationApproval;
  assert.equal((await verifyScopeHandoff(f.plan, f.trusted)).publicationReady, false);
});

test('ownership, accounting, oversized work and explicit reassessment', async () => {
  const f = scopeFixture();
  f.plan.items[0].repository = 'example/wrong';
  assert(codes(await validate(f)).includes('ownership-drift'));
  f.plan.items[0].repository = 'example/core';
  f.plan.items[0].effort.lines = 1100;
  assert(codes(await validate(f)).includes('invalid-effort'));
  f.plan.items[0].effort.counts.added += 400;
  assert(codes(await validate(f)).includes('oversized-item'));
  f.plan.items[0].effort.exception = { reason: 'Atomic safety interface cannot split acceptably.', reassessment: ['scope:reviewed-exception'] };
  assert.equal((await validate(f)).planValid, true);
});

test('native graph rejects dangling, ordering-only, cyclic and redundant blockers', async () => {
  const edge = (item, blockedBy) => ({ item, blockedBy, kind: 'prerequisite', rationale: 'Consumes required API', interface: 'API v1', evidence: ['source:API'] });
  for (const [edges, code] of [
    [[edge('item-0', 'missing')], 'dangling-dependency'],
    [[{ ...edge('item-0', 'item-1'), kind: 'ordering' }], 'unjustified-dependency'],
    [[edge('item-0', 'item-1'), edge('item-1', 'item-0')], 'dependency-cycle'],
    [[edge('item-0', 'item-1'), edge('item-1', 'item-2'), edge('item-0', 'item-2')], 'redundant-dependency']
  ]) {
    const f = scopeFixture(); f.plan.dependencies = edges;
    assert(codes(await validate(f)).includes(code));
  }
  const f = scopeFixture(); f.plan.dependencies = [];
  assert.equal((await validate(f)).planValid, true);
  f.plan.items.reverse();
  assert.equal((await validate(f)).planValid, true);
});

test('exact approval binds repositories, bodies, metadata, edges and plan identity', async () => {
  for (const mutate of [f => { f.plan.items[0].body += ' Changed'; },
    f => { f.plan.items[0].metadata.labels.push('other'); },
    f => { f.plan.dependencies = []; }, f => { f.plan.id = 'other-plan'; },
    f => { f.plan.items[0].repository = 'example/other'; }]) {
    const f = scopeFixture(); mutate(f);
    const r = await verifyScopeHandoff(f.plan, f.trusted);
    assert.equal(r.publicationReady, false);
    assert(r.limitations.some(s => s.includes('exact complete publication plan')));
  }
  const f = scopeFixture();
  f.plan.items[0].metadata.assignees = ['chosen-by-agent'];
  f.trusted.verifyPublicationApproval = async () => true;
  assert((await verifyScopeHandoff(f.plan, f.trusted)).limitations.some(s => s.includes('Assignee')));
  const exactItem = digest(f.plan.items[0]);
  f.trusted.verifyAssigneeDecision = async ({ item }) => digest(item) === exactItem;
  assert.equal((await verifyScopeHandoff(f.plan, f.trusted)).publicationReady, true);
});

test('all protected states and unknown reads block ordinary Publish, including metadata-only edits', async () => {
  for (const state of ['frozen', 'authorized', 'shaped', 'executing', 'delivered', 'closed']) {
    const f = scopeFixture();
    f.trusted.observeWork = async () => ({ complete: true, states: [state], evidence: ['trusted:state'] });
    const r = await verifyScopeHandoff(f.plan, f.trusted);
    assert.equal(r.planValid, true);
    assert.equal(r.publicationReady, false);
    assert(r.limitations.some(s => s.includes('Protected work')));
  }
  const f = scopeFixture(); delete f.trusted.observeWork;
  assert((await verifyScopeHandoff(f.plan, f.trusted)).limitations.some(s => s.includes('unknown')));
});

test('no write permission, unavailable tools or journal never turn sound design into failure', async () => {
  for (const available of [{ tools: false }, { tools: true, writeRepositories: [] },
    { tools: true, writeRepositories: ['example/core', 'example/entry'], journal: { writable: false } },
    { tools: true, writeRepositories: ['example/core', 'example/entry'], journal: { writable: true, persistent: true, recoverable: false } }]) {
    const f = scopeFixture(); f.trusted.publicationPreflight = async () => available;
    const r = await verifyScopeHandoff(f.plan, f.trusted);
    assert.equal(r.planValid, true); assert.equal(r.publicationReady, false);
    assert(r.limitations.length > 0); assert.equal(f.writes(), 0);
  }
});

test('Audit accepts mutable Shape with preserved original Scope and makes zero writes', async () => {
  const f = scopeFixture();
  const r = await auditScope(f.plan, f.trusted, f.adapter);
  assert.equal(r.status, 'consistent'); assert.deepEqual(r.findings, []);
  assert.equal(f.writes(), 0);
});

test('Audit reports missing, duplicate, ownership, stable identity and Scope drift with evidence', async () => {
  const f = scopeFixture();
  f.plan.items[1].observed = { repository: 'example/core', issueId: 'stable-1' };
  f.observations.splice(0, 1);
  f.observations[0].issueId = 'replacement';
  f.observations[0].originalScopeDigest = digest('unrelated');
  f.observations.push({ ...f.observations[1], issueId: 'duplicate' });
  f.observations[1].repository = 'example/core';
  const r = await auditScope(f.plan, f.trusted, f.adapter);
  for (const code of ['missing-ticket', 'duplicate-ticket', 'ownership-drift', 'identity-drift', 'scope-traceability-loss']) assert(codes(r).includes(code), code);
  for (const finding of r.findings.filter(f => f.observedIdentity)) {
    assert(finding.evidence.length); assert(finding.item); assert(finding.requirements.length);
  }
  assert.equal(f.writes(), 0);
});

test('Audit distinguishes native edge additions/removals and source completion claims', async () => {
  const f = scopeFixture();
  f.observations[3].blockedBy = [{ repository: 'example/entry', issueId: 'stable-2' }];
  f.observations[0].completion = { claimed: true, repository: 'source/project' };
  const r = await auditScope(f.plan, f.trusted, f.adapter);
  for (const code of ['dependency-added', 'dependency-removed', 'source-completion']) assert(codes(r).includes(code));
  assert.equal(f.writes(), 0);
});

test('Audit denied, incomplete, interrupted and malformed reads stay unknown and never write', async () => {
  for (const read of [async () => { throw Error('403'); }, async () => ({ complete: false, issues: [] }),
    async () => { throw new DOMException('Interrupted', 'AbortError'); }, async () => ({ complete: true, evidence: ['read'], issues: [null] })]) {
    const f = scopeFixture(); f.adapter.readInventory = read;
    const r = await auditScope(f.plan, f.trusted, f.adapter);
    assert.equal(r.status, 'unknown'); assert(codes(r).includes('unknown-read'));
    assert(!codes(r).includes('missing-ticket')); assert.equal(f.writes(), 0);
  }
});

test('Investigation revises planning rationale with uncertainty, never a protected stage', async () => {
  const f = scopeFixture();
  const finding = { source: 'example/entry/src/consumer.mjs', revision: 'commit-abc',
    evidence: ['source:consumer@commit-abc'], findings: 'Consumer requires immutable API before integration.',
    uncertainty: ['Remote release availability is unverified.'], interfaces: 'Core API v1',
    implication: 'Keep the required Core prerequisite rather than an ordering-only edge.', item: 'item-3', use: 'dependency' };
  f.plan.investigations = [finding];
  f.plan.dependencies[0].rationale = finding.findings;
  f.plan.dependencies[0].evidence = finding.evidence;
  const r = await validate(f);
  assert.equal(r.planValid, true);
  assert.equal(r.planningEvidence[0].status, 'planning-evidence');
  assert.deepEqual(r.planningEvidence[0].uncertainty, finding.uncertainty);
  for (const key of ['ownerGrant', 'executionEligibility', 'shapeApproval', 'validatorResult']) assert.equal(r[key], undefined);
  for (const role of ['scope', 'investigation']) assert.throws(() => skillForRole(role));
  assert.match(await scopeInstructions(), /strictly read-only Audit/);
  assert.match(await readFile('src/instructions/shape.md', 'utf8'), /Reusable read-only Investigation/);
});

test('malformed records and false role claims cannot become planning authority', async () => {
  const f = scopeFixture();
  f.plan.items.push(null);
  assert(codes(await validate(f)).includes('invalid-record'));
  const g = scopeFixture();
  g.plan.investigations = [{ source: 'source/module', revision: 'abc', evidence: ['source:abc'],
    findings: 'API required', uncertainty: [], interfaces: 'API', implication: 'Retain boundary',
    item: 'item-0', use: 'boundary', ownerGrant: true, shapeApproval: true, executionEligibility: true }];
  const r = await validate(g);
  assert.equal(r.planValid, true);
  for (const key of ['ownerGrant', 'shapeApproval', 'executionEligibility']) assert.equal(r.planningEvidence[0][key], undefined);
  g.trusted.observeWork = async () => ({ complete: true, states: [], evidence: ['read:unknown-state'] });
  assert.equal((await verifyScopeHandoff(g.plan, g.trusted)).publicationReady, false);
});


test('explicit Assignee clearing still requires a specific decision; stage labels are not original work', async () => {
  const f = scopeFixture();
  f.plan.items[0].metadata.assignees = [];
  f.trusted.verifyPublicationApproval = async () => true;
  assert((await verifyScopeHandoff(f.plan, f.trusted)).limitations.some(s => s.includes('Assignee')));
  f.plan.items[0].metadata.labels.push('shaped');
  assert(codes(await validate(f)).includes('protected-metadata'));
});
