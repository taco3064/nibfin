import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { inspect, receiptTrace } from '../experiments/runner-set/model.mjs';
import { evidence, modes } from '../experiments/runner-set/run.mjs';
import { cases, attacks, initial } from './fixtures/runner-set/cases.mjs';

// Explicit independent inventory makes accidental deletion of a required scenario fail.
const required = ['trusted-multiple', 'unauthorized-online', 'unauthorized-busy', 'unauthorized-offline',
  'unknown-binding', 'new-registration-id', 'downgrade-read', 'downgrade-triage', 'lost-access',
  'wrong-member', 'missing-isolation', 'wrong-os', 'missing-label', 'wrong-group', 'wrong-repository',
  'offline-fallback', 'busy-preserves-rank', 'all-offline', 'empty-complete',
  'http-401', 'http-403', 'http-404', 'http-429', 'http-500', 'incomplete', 'stale', 'missing-page',
  'malformed-page', 'malformed-runner', 'duplicate-id',
  'access-null-id', 'access-string-id', 'access-zero-id', 'access-negative-id',
  'access-fractional-id', 'access-unsafe-id', 'access-mixed-id', 'access-sparse-id'];
test('required inventory remains complete and unique', () => {
  assert.deepEqual(cases.map(c => c.id).sort(), required.sort());
  assert.deepEqual(attacks.map(a => a.id).sort(), ['registration', 'relabel', 'group-expansion',
    'access-expansion', 'binding-revocation', 'member-downgrade', 'nonreceipt-reassignment'].sort());
});
for (const c of cases) test(`inventory: ${c.id}`, () => {
  const actual = inspect(c.input);
  for (const [key, value] of Object.entries(c.expected)) assert.deepEqual(actual[key], value);
});
for (const attack of attacks) for (const mode of modes) test(`receipt: ${attack.id}/${mode.name}`, () => {
  const actual = receiptTrace(attack, mode.protection, mode.enforcement, mode.bypass);
  assert.equal(actual.exposed, mode.exposed);
  assert.equal(actual.dispatched, mode.dispatched);
  assert.equal(actual.earliestExposure, mode.exposed ? 'job-receipt-before-first-step' : null);
  if (mode.name === 'post-start') assert.equal(actual.events.at(-1).tooLate, true);
  if (mode.name === 'closed-range-enforced') {
    assert.equal(actual.stopped, true);
    assert.equal(actual.events.at(-1).runner, 1);
  }
  if (mode.name === 'closed-range-unverified') assert.equal(actual.events.at(-1).event, 'dispatch-denied');
});
test('all lifecycle phases are represented and model does not mutate inputs', () => {
  assert.deepEqual(new Set(attacks.flatMap(a => a.changes.map(c => c.phase))),
    new Set(['after-inspection', 'while-queued', 'before-receipt', 'after-nonreceipt-requeue']));
  const input = initial(); const before = structuredClone(input); inspect(input); assert.deepEqual(input, before);
});
test('required artifact exactly reproduces current model, sources and expectations', async () => {
  execFileSync(process.execPath, ['experiments/runner-set/run.mjs'], { stdio: 'pipe' });
  const current = await evidence();
  assert.equal(current.inventory.length, 38);
  assert.equal(current.traces.length, 35);
  assert.deepEqual(JSON.parse(await readFile('out/runner-set/evidence.json', 'utf8')), current);
  assert.deepEqual(current.providerObservations, []);
  assert.equal(current.finding, 'inconclusive');
});
