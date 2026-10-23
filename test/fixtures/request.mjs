import { digest } from '../../src/index.mjs';
export const h = 'a'.repeat(64);
export function initial() {
  return { schemaVersion: 2, requirements: bindings(), requestId: 'request-1', stage: 'shape',
    repository: { id: '100', name: 'example/project' },
    issue: { id: 'issue-2', number: 2, repositoryId: '100' },
    authority: { grantId: 'grant-1', digest: h }, scopeDigest: h,
    source: { repositoryId: '100', workflow: '.github/workflows/stage.yml',
      workflowDigest: h, runId: '1000', attempt: 1 } };
}

// Synthetic Notion observations and authenticated approval stand-ins only.
export function snapshot(id, revision = 'A', content = 'Synthetic requirements') {
  const canonical = { schemaVersion: 1, source: { kind: 'notion', id }, revision, contentDigest: digest(content) };
  return { reference: { ...canonical, snapshotId: digest(canonical) }, content };
}
export function bindings() {
  return { productSecurity: snapshot('synthetic-security').reference,
    delivery: snapshot('external-project').reference };
}
export function requirementAdapters() {
  const snapshots = [snapshot('synthetic-security'), snapshot('external-project')];
  const reader = s => ({ source: s.reference.source, read: async () => ({
    source: s.reference.source, revision: s.reference.revision, endRevision: s.reference.revision,
    content: s.content, complete: true, unavailable: [] }) });
  return { productSecurity: reader(snapshots[0]), delivery: reader(snapshots[1]),
    storage: { get: async id => snapshots.find(s => s.reference.snapshotId === id) },
    verifyApproval: async () => true };
}
