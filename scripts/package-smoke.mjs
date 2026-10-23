import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initial } from '../test/fixtures/request.mjs';
const directory = await mkdtemp(join(tmpdir(), 'nibfin-consumer-'));
const run = (args, cwd) => execFileSync('npm', args, {
  cwd, encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true' }
});
try {
  const packed = JSON.parse(run(['pack', '--json', '--pack-destination', directory], process.cwd()))[0];
  const paths = packed.files.map(f => f.path).sort();
  const allowed = path => ['package.json', 'README.md', 'LICENSE'].includes(path) ||
    /^(src|examples|docs)\//.test(path);
  assert(paths.every(allowed), `Unexpected package files: ${paths}`);
  const required = ['package.json', 'README.md', 'LICENSE', 'src/identity.mjs', 'src/index.mjs',
    'examples/action.mjs', 'examples/cli.mjs'];
  for (const path of required) assert(paths.includes(path), `Missing ${path}`);
  // Compute expected identity from reviewed source bytes independently of package code.
  const entries = [];
  for (const path of ['LICENSE', 'package.json', 'src/identity.mjs', 'src/index.mjs']) {
    assert((await lstat(path)).isFile());
    entries.push([path, (await readFile(path)).toString('base64')]);
  }
  const metadata = JSON.parse(await readFile('package.json', 'utf8'));
  const expected = { name: metadata.name, version: metadata.version,
    contentDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)], directory);
  await writeFile(join(directory, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { identity } from '@nibfin/core/identity';
import { runOneStage } from './node_modules/@nibfin/core/examples/action.mjs';
import { checkInstalledCore } from './node_modules/@nibfin/core/examples/cli.mjs';
const expected = ${JSON.stringify(expected)};
assert.deepEqual(await identity(), expected);
assert.deepEqual(await checkInstalledCore(expected), expected);
for (const change of [{ version: 'wrong' }, { contentDigest: '0'.repeat(64) }]) {
  await assert.rejects(checkInstalledCore({ ...expected, ...change }), /identity mismatch/);
}
const request = ${JSON.stringify(initial())};
assert.equal((await runOneStage(request)).status, 'blocked');
let executions = 0;
const result = await runOneStage(request, {
  verify: async () => ({ permission: 'verified' }),
  execute: async () => { executions++; return { status: 'succeeded' }; }
});
assert.equal(result.status, 'succeeded');
assert.equal(result.requestId, request.requestId);
assert.equal(executions, 1);
console.log('External installed consumer identity and rejection checks passed.');
`);
  console.log(execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, encoding: 'utf8' }).trim());
  console.log(JSON.stringify({ packageFiles: paths, expectedIdentity: expected }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
