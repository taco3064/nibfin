import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync, gunzipSync} from 'node:zlib';
import {buildArchive, verifyArchive, packageFiles} from '../tooling/archive.mjs';

// Mutate real packed bytes, preserving valid tar checksums for rejection tests.
function changeEntry(archive, oldName, newName) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString(), 8);
    if (name === `package/${oldName}`) {
      header.fill(0, 0, 100);
      header.write(`package/${newName}`);
      header.fill(32, 148, 156);
      const checksum = [...header].reduce((a, b) => a + b, 0);
      header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
      return gzipSync(tar);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Fixture entry missing');
}

test('real archive, rejection policy and website isolation', () => {
  const fixture = mkdtempSync(join(process.cwd(), '.nibfin-producer-'));
  try {
    for (const path of ['package.json', 'package-lock.json', 'README.md', 'docs', 'src', 'test', 'tooling']) {
      cpSync(resolve(path), join(fixture, path), {recursive: true});
    }
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const run = args => execFileSync('npm', args, {cwd: fixture, env, encoding: 'utf8', stdio: 'pipe'});
    run(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
    // Run only identity tests here, avoiding recursive fixture creation.
    execFileSync(process.execPath, ['--test', 'test/identity.test.mjs'], {cwd: fixture, env});
    const archive = readFileSync(buildArchive(fixture));
    assert.deepEqual(verifyArchive(archive, fixture), [...packageFiles].sort());
    assert.throws(() => verifyArchive(changeEntry(archive, 'README.md', 'secrets/token'), fixture), /Forbidden/);
    assert.throws(() => verifyArchive(changeEntry(archive, 'src/index.mjs', 'src/missing.mjs'), fixture), /Forbidden/);
    // A valid subset still fails the mandatory-entry check.
    const tar = gunzipSync(archive);
    for (const required of ['src/index.mjs', 'src/grants.mjs', 'src/provider.mjs', 'src/obligations.mjs']) {
      let offset = 0;
      while (offset < tar.length) {
        const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/s, '');
        if (name === `package/${required}`) {
          const size = parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
          const end = offset + 512 + Math.ceil(size / 512) * 512;
          assert.throws(() => verifyArchive(gzipSync(Buffer.concat([tar.subarray(0, offset), tar.subarray(end)])), fixture), /Missing required/);
          break;
        }
        offset += 512 + Math.ceil(parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8) / 512) * 512;
      }
    }
    mkdirSync(join(fixture, 'website'), {recursive: true});
    writeFileSync(join(fixture, 'website/package.json'), JSON.stringify({private: true, dependencies: {'must-not-install': '0.0.0'}, scripts: {install: 'exit 99'}}));
    writeFileSync(join(fixture, 'website/fail.test.mjs'), "throw new Error('Website tests must not run');");
    writeFileSync(join(fixture, 'website/.npmrc'), 'registry=http://127.0.0.1:1');
    writeFileSync(join(fixture, 'website/tsconfig.json'), '{"invalid":true}');
    run(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
    assert.equal(existsSync(join(fixture, 'website/node_modules')), false);
    // Explicit root discovery executes all real root tests; remove this fixture test only.
    rmSync(join(fixture, 'test/archive.test.mjs'));
    assert.match(run(['run', 'check']), /fail 0/);
    const withWebsite = readFileSync(buildArchive(fixture));
    assert.deepEqual(withWebsite, archive);
    writeFileSync(join(fixture, 'src/index.mjs'), '// changed source');
    assert.throws(() => verifyArchive(archive, fixture), /Archive\/source mismatch/);
  } finally {
    rmSync(fixture, {recursive: true, force: true});
  }
});
