import { binding, digest } from '../src/core.mjs';

export const NOW = Date.parse('2026-10-19T00:00:00Z');
export const SHA = digit => digit.repeat(40);
export function fixture() {
  const manifest = { schemaVersion: 1, id: 'cohort-test', freezeRevision: 'freeze-1', proposalRevision: '0.8.1', issues: [
    { id: 'I_A', repository: 'example/one', number: 3, scopeHash: 'scope-a', dependencies: [] },
    { id: 'I_B', repository: 'example/two', number: 1, scopeHash: 'scope-b', dependencies: ['I_A'] },
    { id: 'I_C', repository: 'example/one', number: 2, scopeHash: 'scope-c', dependencies: ['I_B'] },
  ] };
  const repositoryGrant = { baseBranch: 'main', branchPrefix: 'nibfin/', mergeMethod: 'squash', requiredChecks: ['test'], finalProofs: [] };
  const policy = { schemaVersion: 1, grantId: 'grant-test', revision: 'policy-1', manifestHash: digest(manifest), validFrom: '2026-10-18T00:00:00Z', expiresAt: '2026-10-20T00:00:00Z', runnerId: 'trusted-runner', coreDigest: 'installed-core-digest', maxRepairs: 2, deniedPaths: ['.github/workflows', 'secrets'], operations: ['shape', 'validate-shape', 'publish-shape', 'deliver', 'accept', 'commit-pr', 'shaper-review', 'merge', 'close', 'mark-delivered', 'repair'], repositories: { 'example/one': structuredClone(repositoryGrant), 'example/two': structuredClone(repositoryGrant) } };
  const snapshot = { manifestHash: digest(manifest), policyHash: digest(policy), approval: { verified: true, recordId: 'fixture-only', actor: 'fixture-owner', revoked: false, manifestHash: digest(manifest), policyHash: digest(policy) }, runtime: { trusted: true, isolated: true, coreDigest: policy.coreDigest, runnerId: policy.runnerId, agent: 'codex-chatgpt', authenticated: true }, issues: Object.fromEntries(manifest.issues.map(i => [i.id, { ...structuredClone(i), visibility: 'private', bodyHash: i.scopeHash, labels: ['scope'], state: 'open', defaultHead: SHA('a'), repairs: 0, sameRootCauseFailures: 0 }])) };
  return { manifest, policy, snapshot };
}
export function envelope(f, id, stage, outcome, artifacts) {
  return { schemaVersion: 1, stage, outcome, subject: id, ...binding(f.manifest, f.policy), executionId: `${id}-${stage}`, artifactIdentities: artifacts, evidenceReferences: [`fixture://${id}/${stage}`], blockingFindings: [], proposedNextTransition: null };
}
export function shape(f, id, published = true) {
  const live = f.snapshot.issues[id];
  const artifacts = { scopeHash: live.scopeHash, shapeHash: `shape-${id}` };
  live.shape = { body: 'Contract\n```nibfin-candidate\n{"artifacts":[],"hooks":[]}\n```\n', bodyHash: artifacts.shapeHash, author: envelope(f, id, 'shape', 'ready', artifacts), validator: envelope(f, id, 'shape-validator', 'approved', artifacts) };
  if (published) {
    live.bodyHash = artifacts.shapeHash;
    live.labels.push('shaped');
    live.shape.publication = { bodyHash: live.bodyHash, policyHash: digest(f.policy), decisionId: `publish-${id}` };
  }
}
export function deliver(f, id, complete = false) {
  const live = f.snapshot.issues[id];
  live.candidate = { repository: live.repository, base: live.defaultHead, tree: SHA('b'), diffHash: `diff-${id}`, paths: ['src/feature.mjs'], obligations:{artifacts:[],hooks:[]},artifacts:[],hookSources:[] };
  live.hookEvidence = {executionId:'hook-fixture',status:'not-applicable',candidateHash:digest(live.candidate)};
  live.preCommitHooks = {...live.hookEvidence,executionId:'post-accept-hook-fixture'};
  const artifacts = { candidateHash: digest(live.candidate), shapeHash: live.shape.bodyHash };
  live.delivery = envelope(f, id, 'deliver', 'ready', artifacts);
  live.accept = envelope(f, id, 'accept', 'accepted', { ...artifacts, preCommit: true });
  live.pr = { id: `PR-${id}`, repository: live.repository, head: SHA('c'), tree: live.candidate.tree, base: live.candidate.base, baseBranch: 'main', branch: `nibfin/${id}`, state: 'open', protectionSatisfied: true, mergePermission: true };
  live.protectionInspection = {source:'protection-apis',protected:true,strictBase:true};
  live.requiredChecks = ['test'];
  live.checks = [{ id: `check-${id}`, name: 'test', head: live.pr.head, status: 'completed', conclusion: 'success', trusted: true }];
  live.review = envelope(f, id, 'shaper-review', 'approved', { ...artifacts, head: live.pr.head, prId: live.pr.id });
  if (complete) {
    live.merge = { prId: live.pr.id, head: live.pr.head, commit: SHA('d'), verified: true, policyHash: digest(f.policy), decisionId: `merge-${id}` };
    live.state = 'closed';
    live.closure = { verified: true, id: `closure-${id}`, mergeCommit: live.merge.commit };
    live.labels.push('delivered');
    live.delivered = { policyHash: digest(f.policy), decisionId: `delivered-${id}`, mergeCommit: live.merge.commit };
  }
}
