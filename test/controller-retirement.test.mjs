import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { distributionMap } from '../tooling/distribution-map.mjs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('retired engine has a public recovery identity and no executable entry', () => {
  const archive = JSON.parse(read('provenance/controller-baseline.json'));
  assert.equal(archive.repository, 'taco3064/nibfin');
  assert.equal(archive.commit, '83a0e9cd8e1026925ddd8c5bf9d5f987e8905708');
  assert.match(archive.tree, /^[a-f0-9]{40}$/);
  assert.equal(archive.disposition, 'retired-reference-only');
  assert.equal(existsSync(new URL('../controller', import.meta.url)), false);
  assert.equal(
    existsSync(new URL('../controller/bin/controller.mjs', import.meta.url)),
    false,
  );
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!pkg.files.some((path) => path.startsWith('controller/')));
  assert.ok(pkg.files.includes('provenance/controller-baseline.json'));
});

test('packaged source map preserves historical hashes after retirement', () => {
  const archive = JSON.parse(read('provenance/controller-baseline.json'));
  const generated = distributionMap();
  assert.deepEqual(JSON.parse(read('src/distribution-map.json')), generated);
  for (const input of archive.inputs) {
    assert.match(input.sha256, /^[a-f0-9]{64}$/);
    assert.ok(input.path.startsWith('controller/src/'));
    assert.deepEqual(
      generated.origin.inputs.find(
        (value) => value.responsibility === input.responsibility,
      ),
      input,
    );
  }
  assert.equal(generated.origin.sourceArchive.tree, archive.tree);
  const workflow = read('.github/workflows/ci.yml');
  assert.doesNotMatch(workflow, /working-directory: controller/);
  assert.match(workflow, /node --test test\/controller-retirement.test.mjs/);
});
