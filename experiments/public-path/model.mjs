// Research admission model. Authenticity/freshness are stipulated trusted facts,
// not cryptographic verifiers, provider reads or a production authorization engine.
import { initial } from '../../test/fixtures/public-path/cases.mjs';
export function inspect(input, seen = new Set()) {
  const stop = reason => ({ outcome: 'block', stoppedAt: reason, protectedExecution: false });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return stop('malformed');
  const base = initial();
  if (Object.keys(input).length !== Object.keys(base).length ||
    Object.keys(input).some(k => !Object.hasOwn(base, k))) return stop('malformed');
  for (const key of ['authenticated', 'sourceFresh', 'predecessorAuthenticated', 'predecessorFresh',
    'grant', 'member', 'recipientSet', 'preReceipt', 'isolated', 'signature',
    'healthFresh', 'deploymentAuthenticated', 'recoveryAuthenticated', 'responsibilityVerified', 'logVerified']) {
    if (input[key] !== true) return stop(key);
  }
  for (const key of ['repository', 'issue', 'workflow', 'revision', 'ref', 'run', 'attempt',
    'permission', 'merge', 'environment', 'deploymentRun', 'deploymentAttempt', 'payloadRole', 'payloadCode', 'unknownEffects']) {
    if (input[key] !== base[key]) return stop(key);
  }
  if (!['stage', 'dependency', 'ping'].includes(input.event) || typeof input.delivery !== 'string' || !input.delivery ||
    typeof input.subscription !== 'boolean' || typeof input.compensation !== 'boolean') return stop('event');
  if (!['cross-run', 'same-fixed-workflow'].includes(input.relation) ||
    !(input.completion === 'receipt' || (input.completion === 'needs' && input.relation === 'same-fixed-workflow')))
    return stop('completion');
  if (input.event === 'ping') return { outcome: 'observe-only', stoppedAt: 'ping', protectedExecution: false };
  if (input.event === 'dependency' && !input.subscription && !input.compensation) return stop('subscription');
  // Semantic key deduplicates both dependency sides and native/Dispatch transport.
  const key = JSON.stringify([input.repository, input.issue, input.run, input.attempt, input.event]);
  if (seen.has(key)) return { outcome: 'duplicate', stoppedAt: 'deduplication', protectedExecution: false };
  seen.add(key);
  return { outcome: 'admit', stoppedAt: 'research-only', protectedExecution: false };
}
