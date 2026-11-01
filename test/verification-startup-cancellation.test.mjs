import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { runVerificationChild } from '../src/verification-child.mjs';

test('cancellation during supervisor startup retains kernel reconciliation', async () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const controller = new AbortController();
    const pending = runVerificationChild(
      {
        file: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: tmpdir(),
        timeoutMs: 2000,
        env: { PATH: '/usr/bin:/bin' },
      },
      { signal: controller.signal },
    );
    queueMicrotask(() => controller.abort());
    const result = await pending;
    assert.equal(result.status, 'cancelled', JSON.stringify({ attempt, result }));
  }
});
