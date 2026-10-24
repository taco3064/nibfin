import {gunzipSync} from 'node:zlib';
import {readFileSync, mkdirSync, renameSync, mkdtempSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

export const packageFiles = ['README.md', 'docs/package.md', 'package.json', 'src/index.mjs'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Read the actual tar payload without extracting attacker-controlled paths.
export function inspectArchive(archive) {
  const tar = gunzipSync(archive);
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error('Trailing tar data');
      return files;
    }
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const octal = text => {
      if (!/^[0-7]+$/.test(text.trim())) throw new Error('Invalid tar number');
      return parseInt(text.trim(), 8);
    };
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(field(148, 8))) throw new Error('Invalid tar checksum');
    const name = field(0, 100);
    const size = octal(field(124, 12));
    if (field(345, 155) || !['0', ''].includes(field(156, 1)) || !name.startsWith('package/')) {
      throw new Error(`Unsupported archive entry: ${name}`);
    }
    const path = name.slice(8);
    if (!packageFiles.includes(path) || files.has(path)) throw new Error(`Forbidden or duplicate archive entry: ${path}`);
    offset += 512;
    if (offset + size > tar.length) throw new Error('Truncated tar entry');
    files.set(path, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing tar terminator');
}

export function verifyArchive(archive, producer = root) {
  const files = inspectArchive(archive);
  for (const path of packageFiles) {
    if (!files.has(path)) throw new Error(`Missing required archive entry: ${path}`);
    if (!files.get(path).equals(readFileSync(join(producer, path)))) throw new Error(`Archive/source mismatch: ${path}`);
  }
  const manifest = JSON.parse(files.get('package.json'));
  if (manifest.name !== '@nibfin/core' || manifest.exports?.['.'] !== './src/index.mjs'
      || manifest.dependencies || manifest.optionalDependencies || manifest.workspaces) {
    throw new Error('Unexpected package boundary');
  }
  return [...files.keys()].sort();
}

export function consumeArchive(archivePath) {
  const consumer = mkdtempSync(join(tmpdir(), 'nibfin-consumer-'));
  try {
    if (realpathSync(consumer).startsWith(root + sep)) throw new Error('Consumer is inside producer');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({private: true, type: 'module'}));
    // Deliberately pass no inherited credential or npm configuration variables.
    const env = {PATH: process.env.PATH, HOME: consumer, npm_config_cache: join(consumer, 'cache'),
      npm_config_userconfig: join(consumer, 'empty-npmrc'), npm_config_globalconfig: join(consumer, 'global-npmrc')};
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', resolve(archivePath)],
      {cwd: consumer, env, stdio: 'pipe'});
    writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {githubId, repositoryCoordinates, memberRunnerLabel} from '@nibfin/core';
assert.equal(githubId('9007199254740993'), '9007199254740993');
assert.equal(repositoryCoordinates('Example-Org', 'Core').key, 'example-org/core');
assert.equal(memberRunnerLabel('42'), 'nibfin-user-42');
assert.throws(() => githubId('01'), TypeError);
const entry = realpathSync(fileURLToPath(import.meta.resolve('@nibfin/core')));
assert.equal(entry, process.cwd() + '/node_modules/@nibfin/core/src/index.mjs');
console.log('Installed archive consumer passed:', entry);
`);
    return execFileSync(process.execPath, ['smoke.mjs'], {cwd: consumer, env, encoding: 'utf8'}).trim();
  } catch (error) {
    throw new Error(`Archive consumer failed: ${error.message}\n${error.stderr?.toString() ?? ''}`, {cause: error});
  } finally {
    rmSync(consumer, {recursive: true, force: true});
  }
}

export function buildArchive(producer = root) {
  const output = join(producer, 'out');
  mkdirSync(output, {recursive: true});
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', output],
    {cwd: producer, encoding: 'utf8'}));
  const archivePath = join(output, 'nibfin-core.tgz');
  renameSync(join(output, result[0].filename), archivePath);
  console.log('Archive entries:', verifyArchive(readFileSync(archivePath), producer).join(', '));
  console.log(consumeArchive(archivePath));
  return archivePath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildArchive();
