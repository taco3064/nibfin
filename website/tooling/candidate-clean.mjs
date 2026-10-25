import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const build = JSON.parse(readFileSync('out/build-evidence.json'));
const theme = JSON.parse(readFileSync('out/theme-evidence.json'));
// Only discard generated work after the required final-source evidence exists.
assert.deepEqual(theme.inputs, build.inputs, 'Build/theme input identities differ');
for (const [path, digest] of Object.entries(build.inputs)) assert.equal(hash(resolve('..', path)), digest, `Stale input: ${path}`);
assert(build.commands.every(command => command.exitCode === 0), 'Build checks did not pass');
assert.equal(theme.buildArchive.sha256, build.archive.sha256);
assert.equal(hash('out/site.tar.gz'), build.archive.sha256);
assert.equal(hash('out/theme-screenshots.tar.gz'), theme.screenshotArchive.sha256);
const generated = ['node_modules', '.astro', 'dist', '.cache'];
for (const path of generated) rmSync(path, { recursive: true, force: true });
const root = resolve('..');
let files = 0;
function scan(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), info = lstatSync(path);
    assert(!info.isSymbolicLink(), `Symlink remains: ${relative(root, path)}`);
    if (info.isDirectory()) scan(path);
    else { assert(info.isFile(), `Unsupported file type: ${relative(root, path)}`); files++; }
  }
}
scan(root);
for (const path of ['build-evidence.json', 'site.tar.gz', 'theme-evidence.json', 'theme-screenshots.tar.gz']) assert(lstatSync(`out/${path}`).isFile());
theme.handoff = { command: 'npm run candidate:clean', removedGeneratedDirectories: generated, workspaceScan: { regularFiles: files, symlinks: 0 }, reason: 'Core isolated workspace capture rejects symlinks, including ignored dependency/tool links. Required artifacts remain regular files.' };
writeFileSync('out/theme-evidence.json', JSON.stringify(theme, null, 2) + '\n');
console.log(`Candidate handoff: ${files} regular files, zero symlinks; all four required artifacts preserved.`);
