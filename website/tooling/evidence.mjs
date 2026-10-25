import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = {};
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'out', '.astro', '.cache'].includes(e.name)) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p); else inputs[`website/${relative(process.cwd(), p)}`] = hash(readFileSync(p));
  }
}
walk(process.cwd());
inputs['.github/workflows/website-ci.yml'] = hash(readFileSync('../.github/workflows/website-ci.yml'));
const commands = [];
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, maxBuffer: 16 * 1024 * 1024 });
  const log = ((result.stdout ?? '') + (result.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
  process.stdout.write(log);
  commands.push({ command: [command, ...args].join(' '), exitCode: result.status, log });
  if (result.status !== 0) throw new Error(`Required command failed: ${command} ${args.join(' ')}`);
}
run('npm', ['ci', '--no-audit', '--no-fund']);
for (const script of ['typecheck', 'lint', 'blueprint', 'content', 'test', 'test:boundaries', 'build', 'links']) run('npm', ['run', script]);
mkdirSync('out', { recursive: true });
run('tar', ['-czf', 'out/site.tar.gz', '-C', 'dist', '.']);
const packages = {};
for (const name of Object.keys({ ...JSON.parse(readFileSync('package.json')).dependencies, ...JSON.parse(readFileSync('package.json')).devDependencies })) {
  packages[name] = JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version;
}
writeFileSync('out/build-evidence.json', JSON.stringify({
  schemaVersion: 1, execution: process.env.GITHUB_RUN_ID ? { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, commit: process.env.GITHUB_SHA } : { kind: 'local-deliver', reference: '/io/context.json: executionContext', cwd: process.cwd() },
  createdAt: new Date().toISOString(), node: process.version,
  npm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
  sourceHashAlgorithm: 'SHA-256 of exact file bytes (not a Core body digest)', inputs, packages, commands,
  archive: { path: 'website/out/site.tar.gz', sha256: hash(readFileSync('out/site.tar.gz')) },
  limits: 'Static and local verification only. Browser E2E and Pages deployment belong to #132.'
}, null, 2) + '\n');
