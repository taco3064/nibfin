import { digest } from '../../src/index.mjs';
export function scopeFixture() {
  const content = 'Current requirements: Core behavior, safe authorization, English docs and release integration.';
  const canonical = { schemaVersion: 1, source: { kind: 'notion', id: 'product' }, revision: 'revision-1', contentDigest: digest(content) };
  const authority = { reference: { ...canonical, snapshotId: digest(canonical) }, content };
  const requirements = ['behavior', 'safety', 'docs', 'release'].map((id, n) => ({ id,
    repository: n < 2 ? 'example/core' : 'example/entry', outcome: `${id} observable outcome`,
    sourceClause: `clause-${n}`, evidence: ['authority:revision-1'] }));
  const plan = { schemaVersion: 1, id: 'plan-1', authority, requirements,
    boundary: { mode: 'whole' }, unresolved: [], prerequisites: [], sharedVerification: [], investigations: [],
    items: requirements.map((r, n) => ({ id: `item-${n}`, repository: r.repository, requirements: [r.id],
      body: `Original Scope for ${r.id}`, metadata: { labels: ['scope'] },
      acceptance: `Verify ${r.outcome}`, evidence: ['target:source@revision-1'],
      effort: { lines: 700, confidence: 'medium', basis: 'Meaningful first-party work, no net-growth discount.',
        counts: { added: 300, ported: 100, rewritten: 100, tests: 150, scripts: 20, configuration: 20, workflows: 10 } } })),
    dependencies: [{ item: 'item-3', blockedBy: 'item-0', kind: 'prerequisite',
      rationale: 'Release integration consumes the Core API.', interface: 'Published immutable API contract', evidence: ['source:consumer@revision-1'] }] };
  const approvedDigest = digest(plan), approvedBoundary = digest(plan.boundary);
  const authorityDigest = digest(authority), ledgerDigest = digest(requirements);
  const trusted = {
    verifyAuthority: async ({ snapshot, requirements: ledger }) => digest(snapshot) === authorityDigest && digest(ledger) === ledgerDigest,
    verifyBoundaryApproval: async ({ boundary }) => digest(boundary) === approvedBoundary,
    verifyPublicationApproval: async ({ planId, planDigest }) => planId === plan.id && planDigest === approvedDigest,
    verifyAssigneeDecision: async () => false,
    observeWork: async () => ({ complete: true, states: ['original'], evidence: ['trusted:work-read'] }),
    publicationPreflight: async () => ({ tools: true, writeRepositories: ['example/core', 'example/entry'],
      journal: { writable: true, persistent: true, recoverable: true, evidence: ['trusted:journal-probe'] } })
  };
  const observations = plan.items.map((i, n) => ({ planItemId: i.id, repository: i.repository,
    issueId: `stable-${n}`, originalScopeDigest: digest(i.body), body: `Published Shape ${n}`,
    blockedBy: n === 3 ? [{ repository: 'example/core', issueId: 'stable-0' }] : [], evidence: [`read:issue-${n}`] }));
  let writes = 0;
  const adapter = { readInventory: async repository => ({ complete: true, evidence: ['trusted:inventory'],
    issues: observations.filter(o => o.repository === repository) }),
    createIssue: () => writes++, updateIssue: () => writes++, addDependency: () => writes++,
    removeDependency: () => writes++, rollback: () => writes++ };
  return { plan, trusted, observations, adapter, writes: () => writes };
}
