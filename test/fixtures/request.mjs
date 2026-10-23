export const h = 'a'.repeat(64);
export function initial() {
  return { schemaVersion: 1, requestId: 'request-1', stage: 'shape',
    repository: { id: '100', name: 'example/project' },
    issue: { id: 'issue-2', number: 2, repositoryId: '100' },
    authority: { grantId: 'grant-1', digest: h }, scopeDigest: h,
    source: { repositoryId: '100', workflow: '.github/workflows/stage.yml',
      workflowDigest: h, runId: '1000', attempt: 1 } };
}
