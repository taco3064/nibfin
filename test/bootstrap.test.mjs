import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { identity, verifyInstallation } from '../src/identity.mjs';
test('missing root configuration fails with English diagnostic and nonzero exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-missing-config-'));
  try {
    const result = spawnSync(process.execPath, [new URL('../scripts/quality.mjs', import.meta.url).pathname, 'check'],
      { cwd: directory, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bootstrap check failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('identity version/content mismatch is rejected', async () => {
  const expected = await identity();
  assert.deepEqual(await verifyInstallation(expected), expected);
  await assert.rejects(verifyInstallation({ ...expected, version: 'wrong' }), /identity mismatch/);
  await assert.rejects(verifyInstallation({ ...expected, contentDigest: '0'.repeat(64) }), /identity mismatch/);
});
test('unsupported runtime configuration fails explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-runtime-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ engines: { node: '0.0.0' } }));
    const result = spawnSync(process.execPath, [new URL('../scripts/quality.mjs', import.meta.url).pathname, 'build'],
      { cwd: directory, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required Node.js version: 0.0.0/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
