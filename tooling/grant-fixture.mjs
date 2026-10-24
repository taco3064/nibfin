// Synthetic local contract inputs, never an execution authorization.
export function grantFixture(digest) {
  const snapshot = body => ({source: 'fixture:approved', revision: '1', body, hash: digest(body)});
  const repo = {id: '9007199254740993', name: 'example-org/core', visibility: 'public'};
  return {
    version: 1, recordId: 'record-1', revision: '1', revocationId: 'revocations-1',
    validFrom: 1000, expiresAt: 2000, authority: snapshot('Approved specification\n授權'),
    work: ['101', '102'].map(number => ({repository: {...repo}, issueId: 'I_' + number, number,
      scope: snapshot('Original Scope\n議題 ' + number), currentBody: snapshot('Original Scope\n議題 ' + number),
      shape: null, observation: snapshot('GitHub read: ' + number)})),
    permissions: [{repository: {...repo}, paths: ['src'], operations: ['deliver']}],
    policy: {core: 'core-content-1', runtime: 'runtime-content-1', agent: 'agent-content-1',
      skills: Object.fromEntries(['shape', 'deliver', 'accept'].map(identity =>
        [identity, {identity, mode: 'default', instructions: snapshot(identity + ' instructions')} ])),
      ci: {requiredChecks: ['owner-pr'], trustedAppIds: ['15368'], workflow: snapshot('fixed CI workflow')},
      merge: {baseBranch: 'main', method: 'rebase', protected: true}, maxParallel: 2},
  };
}
export function grantContext(p, publicKey) {
  return {trustedKeys: new Map([['owner-1', publicKey]]), now: 1000,
    revocation: {id: p.revocationId, available: true, revokedRecords: []},
    expectedAuthority: p.authority, expectedPolicy: p.policy, expectedWork: p.work,
    request: {repository: {...p.work[0].repository}, issueId: p.work[0].issueId,
      number: p.work[0].number, path: 'src/file.mjs', operation: 'deliver'}};
}
