import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function outputMember(pathname) {
  assert(pathname.startsWith('/nibfin/'), 'Resource escapes the configured base');
  const member = decodeURIComponent(pathname.slice('/nibfin/'.length));
  assert(!member.includes('\\') && !member.split('/').some(p => p === '.' || p === '..'), 'Unsafe output member');
  return !member || member.endsWith('/') ? member + 'index.html' : member;
}
export function inventory() {
  const inputs = {};
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', 'out', '.astro', '.cache'].includes(e.name)) continue;
      assert(!e.isSymbolicLink(), `Input symlink: ${e.name}`);
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p); else inputs[`website/${relative(process.cwd(), p)}`] = hash(readFileSync(p));
    }
  }
  walk(process.cwd());
  for (const name of readdirSync('../.github/workflows').filter(n => n.startsWith('website-')).sort()) {
    const p = `.github/workflows/${name}`; inputs[p] = hash(readFileSync(`../${p}`));
  }
  return inputs;
}
export function outputInventory() {
  const output = {};
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name); assert(!lstatSync(p).isSymbolicLink(), 'Output symlink');
      if (e.isDirectory()) walk(p); else output[relative(resolve('dist'), p)] = hash(readFileSync(p));
    }
  }
  walk('dist'); return output;
}
export function verifyBuild() {
  const build = JSON.parse(readFileSync('out/build-evidence.json'));
  assert.deepEqual(inventory(), build.inputs, 'Build input inventory changed (including added files)');
  assert(build.commands.length >= 9 && build.commands.every(c => c.exitCode === 0), 'Incomplete/failed build');
  assert.equal(hash(readFileSync('out/site.tar.gz')), build.archive.sha256, 'Altered build archive');
  assert.deepEqual(outputInventory(), build.outputs, 'Changed or added output');
  assert.equal(spawnSync('tar', ['-dzf', 'out/site.tar.gz', '-C', 'dist']).status, 0, 'Output differs from archive');
  return build;
}
