// Synthetic normalized observations, never public payload assertions of authority.
export const initial = () => ({ authenticated: true, repository: 'repo-101', issue: 'issue-7',
  workflow: 'fixed-workflow', revision: 'fixed-content', ref: 'refs/heads/main', run: 42, attempt: 2,
  sourceFresh: true, predecessorAuthenticated: true, predecessorFresh: true, completion: 'receipt',
  relation: 'cross-run', permission: 'write', grant: true, member: true, recipientSet: true,
  preReceipt: true, isolated: true, unknownEffects: false, payloadRole: null, payloadCode: null,
  event: 'stage', signature: true, delivery: 'delivery-1', subscription: true, compensation: false,
  merge: 'merge-1', environment: 'test', deploymentRun: 50, deploymentAttempt: 1,
  healthFresh: true, deploymentAuthenticated: true, recoveryAuthenticated: true,
  responsibilityVerified: true, logVerified: true });
const reject = {
  'forged-source': { authenticated: false }, 'missing-source': { authenticated: null },
  'expired-source': { sourceFresh: false }, 'wrong-repository': { repository: 'repo-102' },
  'wrong-issue': { issue: 'issue-8' }, 'wrong-workflow': { workflow: 'attacker' },
  'changed-workflow': { revision: 'changed' }, 'wrong-ref': { ref: 'refs/pull/1/head' },
  'wrong-run': { run: 41 }, 'wrong-attempt': { attempt: 1 },
  'forged-predecessor': { predecessorAuthenticated: false },
  'missing-predecessor': { predecessorAuthenticated: null }, 'expired-predecessor': { predecessorFresh: false },
  'oidc-only': { completion: 'oidc' }, 'login-only': { completion: 'login' },
  'partial-log': { completion: 'partial-log' }, 'cross-run-needs': { completion: 'needs' },
  'payload-role': { payloadRole: 'merge' }, 'payload-code': { payloadCode: 'attacker.mjs' },
  'permission-denied': { permission: '403' }, 'permission-unknown': { permission: null },
  'revoked-before-dispatch': { grant: false }, 'revoked-queued': { member: false },
  'revoked-during-execution': { grant: false }, 'unknown-effects': { unknownEffects: true },
  'recipient-set-unknown': { recipientSet: false }, 'post-start-only': { preReceipt: false },
  'persistent-credential-runner': { isolated: false }, 'runs-on-only': { isolated: false },
  'dependency-forged-signature': { event: 'dependency', signature: false },
  'dependency-forged-source': { event: 'dependency', authenticated: false },
  'dependency-missing-delivery': { event: 'dependency', delivery: '' },
  'subscription-unavailable': { event: 'dependency', subscription: false },
  'spoofed-deployment': { deploymentAuthenticated: false }, 'wrong-merge': { merge: 'other' },
  'wrong-environment': { environment: 'other' }, 'wrong-deployment-run': { deploymentRun: 49 },
  'wrong-deployment-attempt': { deploymentAttempt: 2 }, 'stale-health': { healthFresh: false },
  'forged-recovery-comment': { recoveryAuthenticated: false }, 'forged-log': { logVerified: false },
  'unproven-responsibility': { responsibilityVerified: false },
  'fork-executable': { ref: 'fork/head' }, 'changed-action': { revision: 'floating-action' },
  'poisoned-artifact': { predecessorAuthenticated: false }, 'poisoned-cache': { predecessorAuthenticated: false }
};
export const cases = [
  { id: 'valid-cross-run', input: initial(), expected: 'admit' },
  { id: 'valid-native-needs', input: { ...initial(), relation: 'same-fixed-workflow', completion: 'needs' }, expected: 'admit' },
  { id: 'valid-compensation', input: { ...initial(), event: 'dependency', subscription: false, compensation: true }, expected: 'admit' },
  { id: 'ping', input: { ...initial(), event: 'ping' }, expected: 'observe-only' },
  ...Object.entries(reject).map(([id, patch]) => ({ id, input: { ...initial(), ...patch }, expected: 'block' }))
];
export const probeFamilies = ['agent-login', 'core-login', 'cross-member', 'cross-instance',
  'persisted-state', 'cache', 'artifact', 'workspace', 'process-store', 'mount-store'];
