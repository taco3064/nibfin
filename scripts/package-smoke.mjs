import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initial, requirementAdapters, snapshot } from '../test/fixtures/request.mjs';
import { fixture, roleResult } from '../test/fixtures/protected.mjs';
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
  const required = ['package.json', 'README.md', 'LICENSE', 'src/identity.mjs', 'src/index.mjs', 'src/requirements.mjs',
    'examples/action.mjs', 'examples/cli.mjs'];
  for (const path of required) assert(paths.includes(path), `Missing ${path}`);
  // Compute expected identity from reviewed source bytes independently of package code.
  const entries = [];
  for (const path of ['LICENSE', 'package.json', 'src/identity.mjs', 'src/index.mjs', 'src/requirements.mjs', 'src/protected.mjs', 'src/instructions/shape.md', 'src/instructions/deliver.md', 'src/instructions/accept.md']) {
    assert((await lstat(path)).isFile());
    entries.push([path, (await readFile(path)).toString('base64')]);
  }
  const metadata = JSON.parse(await readFile('package.json', 'utf8'));
  const expected = { name: metadata.name, version: metadata.version,
    contentDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)], directory);
  const protectedFixture = fixture('accept');
  await writeFile(join(directory, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { digest } from '@nibfin/core';
import { identity } from '@nibfin/core/identity';
import { invokeProtected, resolveInstructions } from '@nibfin/core';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
const snapshot = ${snapshot.toString()};
const requirementAdapters = ${requirementAdapters.toString()};
let executions = 0;
const result = await runOneStage(request, {
  requirements: requirementAdapters(),
  verify: async () => ({ permission: 'verified' }),
  execute: async () => { executions++; return { status: 'succeeded' }; }
});
assert.equal(result.status, 'succeeded');
assert.equal(result.requestId, request.requestId);
assert.equal(executions, 1);
const protectedRequest = ${JSON.stringify(protectedFixture.request)};
const protectedProof = ${JSON.stringify(protectedFixture.proof)};
const protectedResult = ${JSON.stringify(roleResult(protectedFixture.request.binding))};
const selected = resolveInstructions('accept', protectedProof.configuration, protectedProof.instructionContext);
assert.equal(selected.contentDigest, protectedRequest.binding.instructionDigest);
assert.equal((await invokeProtected(protectedRequest)).status, 'blocked');
assert.equal((await invokeProtected(protectedRequest, {
  requirements: requirementAdapters(), verify: async () => protectedProof, execute: async () => protectedResult
})).status, 'succeeded');
protectedRequest.binding.sessionId = 'substituted';
assert.equal((await invokeProtected(protectedRequest, {
  requirements: requirementAdapters(), verify: async () => protectedProof, execute: async () => protectedResult
})).status, 'blocked');
const identityPaths = ${JSON.stringify(entries.map(e => e[0]))};
async function independentIdentity() {
  const pairs = [];
  for (const path of identityPaths) pairs.push([path, (await readFile('node_modules/@nibfin/core/' + path)).toString('base64')]);
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}
assert.equal(await independentIdentity(), expected.contentDigest);
for (const path of identityPaths.filter(p => ['src/protected.mjs', 'src/requirements.mjs'].includes(p) || p.startsWith('src/instructions/'))) {
  const file = 'node_modules/@nibfin/core/' + path;
  const original = await readFile(file);
  try {
    await writeFile(file, Buffer.concat([original, Buffer.from('\\nTampered bytes\\n')]));
    assert.notEqual(await independentIdentity(), expected.contentDigest);
    await assert.rejects(checkInstalledCore(expected), /identity mismatch/);
  } finally { await writeFile(file, original); }
}
assert.equal(await independentIdentity(), expected.contentDigest);
console.log('External installed v2/v3 consumers, instruction selection, rejection and tamper checks passed.');
`);
  console.log(execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, encoding: 'utf8' }).trim());
  console.log(JSON.stringify({ packageFiles: paths, expectedIdentity: expected }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
