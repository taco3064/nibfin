import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('CLI validates manifest and refuses unauthenticated example observations', () => {
  let result = spawnSync(process.execPath, ['bin/controller.mjs', 'validate', 'examples/manifest.json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).issues, 3);
  result = spawnSync(process.execPath, ['bin/controller.mjs', 'plan', 'examples/manifest.json', 'examples/policy.json', 'examples/snapshot.json'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.executable, false);
  assert.equal(output.code, 'NO_GRANT');
});
test('CLI malformed input has a nonzero structured failure', () => {
  const result = spawnSync(process.execPath, ['bin/controller.mjs', 'validate', 'missing-file.json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).status, 'BLOCKED');
});
