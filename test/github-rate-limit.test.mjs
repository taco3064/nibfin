import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRateLimit, githubRetryDelay } from '../src/github-rate-limit.mjs';

test('an elapsed reset preserves bounded retries without a persistent wait', () => {
  const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' };
  assert.equal(githubRetryDelay(headers, 2000, 1, true), 1000);
  assert.equal(githubRateLimit({ status: 403, headers }, { now: 2000 }), null);
});

test('secondary retries retain exponential backoff when no deadline is supplied', () => {
  assert.equal(githubRetryDelay({}, 1000, 1, true), 60000);
  assert.equal(githubRetryDelay({}, 1000, 2, true), 120000);
  assert.equal(githubRetryDelay({}, 1000, 3, true), 240000);
  assert.equal(githubRetryDelay({}, 1000, 2, false), 2000);
});

test('provider and persistent cooldown use the same latest HTTP deadline', () => {
  const now = Date.parse('2026-10-31T00:00:00Z');
  const headers = {
    'retry-after': 'Sat, 31 Oct 2026 00:00:30 GMT',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(now / 1000 + 10),
  };
  const cooldown = githubRateLimit({ status: 403, headers }, { now });
  assert.equal(cooldown.resetAt, now + 30000);
  assert.equal(githubRetryDelay(headers, now, 1, true), cooldown.resetAt - now);
  assert.equal(
    githubRetryDelay({ 'retry-after': 'invalid' }, now, 1, true),
    Infinity,
  );
  assert.equal(
    githubRetryDelay({ 'x-ratelimit-remaining': '0' }, now, 1, true),
    Infinity,
  );
});
