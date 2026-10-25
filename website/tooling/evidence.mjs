import assert from 'node:assert/strict';
import { inventory, outputInventory } from './build-identity.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = inventory();
const commands = [];
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, maxBuffer: 16 * 1024 * 1024 });
  const log = ((result.stdout ?? '') + (result.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
  process.stdout.write(log);
  commands.push({ command: [command, ...args].join(' '), exitCode: result.status, log });
  if (result.status !== 0) { writeFileSync('out/build-failure.json', JSON.stringify({ status: 'failed', inputs, commands, createdAt: new Date().toISOString() }, null, 2)); throw new Error(`Required command failed: ${command} ${args.join(' ')}`); }
}
mkdirSync('out', { recursive: true });
for (const name of ['build-evidence.json', 'site.tar.gz', 'theme-evidence.json', 'site-evidence.json']) rmSync(`out/${name}`, { force: true });
run('npm', ['ci', '--no-audit', '--no-fund']);
for (const script of ['typecheck', 'lint', 'blueprint', 'content', 'test', 'test:boundaries', 'build', 'links']) run('npm', ['run', script]);
mkdirSync('out', { recursive: true });
writeFileSync('dist/build-identity.json', JSON.stringify({ inputs, execution: { commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null } }) + '\n');
run('tar', ['-czf', 'out/site.tar.gz', '-C', 'dist', '.']);
const packages = {};
for (const name of Object.keys({ ...JSON.parse(readFileSync('package.json')).dependencies, ...JSON.parse(readFileSync('package.json')).devDependencies })) {
  packages[name] = JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version;
}
assert.deepEqual(inventory(), inputs, 'Inputs changed during build');
const outputs = outputInventory();
writeFileSync('out/build-evidence.json', JSON.stringify({
  schemaVersion: 1, execution: process.env.GITHUB_RUN_ID ? { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, commit: process.env.GITHUB_SHA } : { kind: 'local-deliver', reference: '/io/context.json: executionContext', cwd: process.cwd() },
  createdAt: new Date().toISOString(), node: process.version,
  npm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
  sourceHashAlgorithm: 'SHA-256 of exact file bytes (not a Core body digest)', inputs, outputs, packages, commands,
  archive: { path: 'website/out/site.tar.gz', sha256: hash(readFileSync('out/site.tar.gz')) },
  limits: 'Build verification only. Issue #129 separately retains local rendered theme evidence; live Pages integration remains outside this build report.'
}, null, 2) + '\n');
