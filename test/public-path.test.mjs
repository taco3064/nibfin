import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { inspect } from '../experiments/public-path/model.mjs';
import { evidence, verify } from '../experiments/public-path/run.mjs';
import { cases, initial, probeFamilies } from './fixtures/public-path/cases.mjs';
const required = ['valid-cross-run', 'valid-native-needs', 'valid-compensation', 'ping',
  'forged-source', 'missing-source', 'expired-source', 'wrong-repository', 'wrong-issue',
  'wrong-workflow', 'changed-workflow', 'wrong-ref', 'wrong-run', 'wrong-attempt',
  'forged-predecessor', 'missing-predecessor', 'expired-predecessor', 'oidc-only',
  'login-only', 'partial-log', 'cross-run-needs', 'payload-role', 'payload-code',
  'permission-denied', 'permission-unknown', 'revoked-before-dispatch', 'revoked-queued',
  'revoked-during-execution', 'unknown-effects', 'recipient-set-unknown', 'post-start-only',
  'persistent-credential-runner', 'runs-on-only', 'dependency-forged-signature',
  'dependency-forged-source', 'dependency-missing-delivery', 'subscription-unavailable',
  'spoofed-deployment', 'wrong-merge', 'wrong-environment', 'wrong-deployment-run',
  'wrong-deployment-attempt', 'stale-health', 'forged-recovery-comment', 'forged-log',
  'unproven-responsibility', 'fork-executable', 'changed-action', 'poisoned-artifact', 'poisoned-cache'];
test('required families cannot be silently omitted or expectations weakened', () => {
  assert.deepEqual(cases.map(c => c.id).sort(), required.sort());
  assert.equal(new Set(cases.map(c => c.id)).size, required.length);
  for (const c of cases) {
    const expected = c.id.startsWith('valid-') ? 'admit' : c.id === 'ping' ? 'observe-only' : 'block';
    assert.equal(c.expected, expected);
    assert.equal(inspect(c.input).outcome, expected, c.id);
    assert.equal(inspect(c.input).protectedExecution, false);
  }
  assert.deepEqual(probeFamilies, ['agent-login', 'core-login', 'cross-member', 'cross-instance',
    'persisted-state', 'cache', 'artifact', 'workspace', 'process-store', 'mount-store']);
});
test('malformed observations never become valid evidence', () => {
  for (const input of [null, [], {}, 'verified', { ...initial(), extra: true },
    { ...initial(), grant: 'true' }, { ...initial(), run: '42' },
    { ...initial(), subscription: null }, { ...initial(), relation: 'invented' }]) {
    assert.equal(inspect(input).outcome, 'block');
  }
  for (const key of Object.keys(initial())) {
    const input = initial(); delete input[key]; assert.equal(inspect(input).outcome, 'block', key);
  }
});
test('unauthenticated notifications cannot poison deduplication; ping never dispatches', () => {
  const seen = new Set();
  assert.equal(inspect({ ...initial(), authenticated: false }, seen).outcome, 'block');
  assert.equal(seen.size, 0);
  assert.equal(inspect({ ...initial(), event: 'ping' }, seen).outcome, 'observe-only');
  assert.equal(seen.size, 0);
  assert.equal(inspect(initial(), seen).outcome, 'admit');
  assert.equal(inspect(initial(), seen).outcome, 'duplicate');
  assert.equal(inspect({ ...initial(), unknownEffects: true }, seen).outcome, 'block');
});
test('artifact reproduces measured controls and current source identities', async () => {
  execFileSync(process.execPath, ['experiments/public-path/run.mjs'], { stdio: 'pipe' });
  const current = await evidence();
  assert.deepEqual(JSON.parse(await readFile('out/public-path/evidence.json', 'utf8')), current);
  assert.equal(current.inventory.length, 50);
  assert.equal(current.traces.length, 26);
  assert.equal(current.sequences.length, 5);
  for (const family of probeFamilies) {
    assert.deepEqual(current.traces.find(t => t.id === `${family}/unsafe-control`).observed,
      { attempted: true, exposed: true, stoppedAt: 'none' });
    assert.deepEqual(current.traces.find(t => t.id === `${family}/permission-deny`).observed,
      { attempted: true, exposed: false, stoppedAt: 'node-filesystem-permission' });
  }
  assert.deepEqual(current.providerObservations, []);
  assert.deepEqual(current.failures, []);
  assert.ok(current.routes.every(r => r.productionReliance === 'blocked' && r.blockers.length));
  const altered = structuredClone(current.inventory); altered[0].expected = 'block';
  assert.throws(() => verify(altered, current.traces), /Unexpected outcomes/);
  const omitted = cases.filter(c => c.id !== 'fork-executable');
  assert.notDeepEqual(omitted.map(c => c.id).sort(), required.sort());
});
