import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { identity } from '../src/identity.mjs';
const mode = process.argv[2];
try {
  if (!['build', 'check'].includes(mode)) throw new Error('Expected build or check mode.');
  const p = JSON.parse(await readFile('package.json', 'utf8'));
  if (process.versions.node !== p.engines.node) throw new Error(`Required Node.js version: ${p.engines.node}.`);
  const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  if (npm !== p.engines.npm) throw new Error(`Required npm version: ${p.engines.npm}.`);
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  if (lock.packages[''].version !== p.version || lock.name !== p.name) throw new Error('Root lockfile identity mismatch.');
  if (p.dependencies || p.devDependencies || p.workspaces) throw new Error('Bootstrap dependency boundary changed; review quality configuration.');
  let count = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Unsupported source symlink: ${path}.`);
      if (stat.isDirectory()) await walk(path);
      else {
        const content = await readFile(path, 'utf8');
        if (content.split('\n').some(line => /[\t ]+$/.test(line))) throw new Error(`Trailing whitespace: ${path}.`);
        if (!content.endsWith('\n')) throw new Error(`Missing final newline: ${path}.`);
        if (path.endsWith('.mjs')) {
          execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
          count++;
        }
      }
    }
  }
  for (const directory of ['src', 'scripts', 'test', 'examples', 'experiments', 'docs']) await walk(directory);
  // Build validates executable ESM and resolves both public interfaces; no transpilation needed.
  const core = await import('../src/index.mjs');
  if (typeof core.invoke !== 'function' || typeof core.validateRequest !== 'function') throw new Error('Missing runtime exports.');
  console.log(JSON.stringify({ mode, checkedModules: count, identity: await identity() }));
} catch (error) {
  console.error(`Bootstrap ${mode ?? 'configuration'} failed: ${error.message}`);
  process.exitCode = 1;
}
