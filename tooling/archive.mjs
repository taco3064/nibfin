import { inspectPackageArchive } from '../src/archive.mjs';
import {
  readFileSync,
  mkdirSync,
  renameSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { grantFixture } from './grant-fixture.mjs';
import { bodyDigest } from '../src/index.mjs';

export const packageFiles = [
  'README.md',
  'package.json',
  ...JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).files,
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const inspectArchive = (archive) =>
  inspectPackageArchive(archive, packageFiles);

export function verifyArchive(archive, producer = root) {
  const files = inspectArchive(archive);
  for (const path of packageFiles) {
    if (!files.has(path)) throw new Error(`Missing required archive entry: ${path}`);
    if (!files.get(path).equals(readFileSync(join(producer, path))))
      throw new Error(`Archive/source mismatch: ${path}`);
  }
  const manifest = JSON.parse(files.get('package.json'));
  if (
    manifest.name !== '@nibfin/core' ||
    manifest.exports?.['.'] !== './src/index.mjs' ||
    JSON.stringify(manifest.dependencies) !== JSON.stringify({ jose: '6.2.13' }) ||
    manifest.optionalDependencies ||
    manifest.workspaces
  ) {
    throw new Error('Unexpected package boundary');
  }
  const lock = JSON.parse(files.get('npm-shrinkwrap.json'));
  if (
    lock.lockfileVersion !== 3 ||
    lock.name !== manifest.name ||
    lock.version !== manifest.version ||
    JSON.stringify(lock.packages?.['']?.dependencies) !==
      JSON.stringify(manifest.dependencies) ||
    lock.packages?.['node_modules/jose']?.version !== '6.2.13' ||
    !lock.packages['node_modules/jose'].integrity?.startsWith('sha512-')
  )
    throw Error('Invalid installed dependency lock');
  return [...files.keys()].sort();
}

export function consumeArchive(archivePath, { release = false } = {}) {
  const consumer = mkdtempSync(join(tmpdir(), 'nibfin-consumer-'));
  try {
    if (realpathSync(consumer).startsWith(root + sep))
      throw new Error('Consumer is inside producer');
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    // Deliberately pass no inherited credential or npm configuration variables.
    const env = {
      PATH: process.env.PATH,
      HOME: consumer,
      npm_config_cache: join(consumer, 'cache'),
      npm_config_userconfig: join(consumer, 'empty-npmrc'),
      npm_config_globalconfig: join(consumer, 'global-npmrc'),
    };
    const dependencies = [];
    for (const name of ['jose', 'yaml']) {
      const packed = JSON.parse(
        execFileSync(
          'npm',
          [
            'pack',
            '--json',
            '--ignore-scripts',
            '--offline',
            '--pack-destination',
            consumer,
          ],
          { cwd: join(root, 'node_modules', name), env, encoding: 'utf8' },
        ),
      );
      const dependency = join(consumer, packed[0].filename);
      dependencies.push(dependency);
      execFileSync('npm', ['cache', 'add', dependency], {
        cwd: consumer,
        env,
        stdio: 'pipe',
      });
    }
    execFileSync(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        ...dependencies,
        resolve(archivePath),
      ],
      { cwd: consumer, env, stdio: 'pipe' },
    );
    writeFileSync(
      join(consumer, 'custody-fixture.mjs'),
      readFileSync(join(root, 'tooling/custody-fixture.mjs'), 'utf8').replace(
        "'../src/index.mjs'",
        "'@nibfin/core'",
      ),
    );
    writeFileSync(
      join(consumer, 'actions-fixture.mjs'),
      readFileSync(join(root, 'tooling/actions-fixture.mjs'), 'utf8').replace(
        "'../src/index.mjs'",
        "'@nibfin/core'",
      ),
    );
    for (const fixture of [
      'docker-observation-fixture.mjs',
      'registration-host-fixture.mjs',
      'host-routing-fixture.mjs',
      'custody-host-fixture.mjs',
      'host-identity-fixture.mjs',
      'workflow-fixture.mjs',
      'registration-fixture.mjs',
      'core-fixture.mjs',
      'fanout-fixture.mjs',
      'recovery-fixture.mjs',
      'completion-fixture.mjs',
      'final-review-fixture.mjs',
      'candidate-publication-fixture.mjs',
      'repair-fixture.mjs',
      'evidence-fixture.mjs',
      'accept-fixture.mjs',
      'wsl-fixture.mjs',
      'shape-fixture.mjs',
      'codex-fixture.mjs',
      'relay-fixture.mjs',
      'operations-fixture.mjs',
      'selection-fixture.mjs',
      'grant-fixture.mjs',
      'dynamic-fixture.mjs',
      'rescue-fixture.mjs',
      'merged-continuation-fixture.mjs',
      'merged-continuation-repair-fixture.mjs',
    ]) {
      writeFileSync(
        join(consumer, fixture),
        readFileSync(join(root, 'tooling', fixture), 'utf8')
          .replaceAll("'../src/index.mjs'", "'@nibfin/core'")
          .replaceAll(
            "'../host/runner-job-hook.mjs'",
            "'./node_modules/@nibfin/core/host/runner-job-hook.mjs'",
          )
          .replaceAll("'../host/entry.mjs'", "'@nibfin/core/protected-host'"),
      );
    }
    writeFileSync(
      join(consumer, 'core-lock-fixture.json'),
      readFileSync(join(root, 'package-lock.json')),
    );
    writeFileSync(
      join(consumer, 'ci-fixture.mjs'),
      readFileSync(join(root, 'test/ci-fixture.mjs'), 'utf8').replace(
        "'../src/provider.mjs'",
        "'@nibfin/core'",
      ),
    );
    for (const file of [
      'requirements-document.test.mjs',
      'requirement-source.test.mjs',
      'issue-authority.test.mjs',
      'installation.test.mjs',
      'runner-job-gate.test.mjs',
      'runner-job-hook.test.mjs',
      'rescue.test.mjs',
      'rescue-completion.test.mjs',
      'rescue-continuation.test.mjs',
      'rescue-agent.test.mjs',
      'rescue-composition.test.mjs',
      'rescue-workflow.test.mjs',
      'delivery-composition.test.mjs',
      'nibfin-reuse.test.mjs',
      'readonly-tools.test.mjs',
      'collaboration.test.mjs',
      'runner-lifecycle.test.mjs',
      'docker-security.test.mjs',
      'credential-output.test.mjs',
      'agent-gh-read.test.mjs',
      'isolation-reuse.test.mjs',
      'verification-runner.test.mjs',
      'verification-prepare.test.mjs',
      'registration-host.test.mjs',
      'host-routing.test.mjs',
      'custody-host.test.mjs',
      'approved-inputs.test.mjs',
      'role-host.test.mjs',
      'verification.test.mjs',
      'agent-session.test.mjs',
      'egress.test.mjs',
      'host-identity.test.mjs',
      'protected-host.test.mjs',
      'workflows.test.mjs',
      'lifecycle.test.mjs',
      'core-owners.test.mjs',
      'core.test.mjs',
      'fanout.test.mjs',
      'recovery.test.mjs',
      'completion.test.mjs',
      'final-review.test.mjs',
      'candidate-publication.test.mjs',
      'repair.test.mjs',
      'accept.test.mjs',
      'hooks.test.mjs',
      'wsl.test.mjs',
      'gemini.test.mjs',
      'claude.test.mjs',
      'shape.test.mjs',
      'publisher.test.mjs',
      'codex.test.mjs',
      'publication.test.mjs',
      'portfolio.test.mjs',
      'registration.test.mjs',
      'relay.test.mjs',
      'operations.test.mjs',
      'concurrency.test.mjs',
      'merged-continuation.test.mjs',
      'merged-continuation-repair.test.mjs',
      'github-commit-identity.test.mjs',
    ]) {
      writeFileSync(
        join(consumer, file),
        readFileSync(join(root, 'test', file), 'utf8')
          .replaceAll(
            "'../src/distribution-map.json'",
            "'./node_modules/@nibfin/core/src/distribution-map.json'",
          )
          .replaceAll("'../src/runner-job-gate.mjs'", "'@nibfin/core'")
          .replaceAll(
            "'../src/core-contract.mjs'",
            "'./node_modules/@nibfin/core/src/core-contract.mjs'",
          )
          .replaceAll(
            "'../tooling/merged-continuation-repair-fixture.mjs'",
            "'./merged-continuation-repair-fixture.mjs'",
          )
          .replaceAll(
            "'../tooling/merged-continuation-fixture.mjs'",
            "'./merged-continuation-fixture.mjs'",
          )
          .replaceAll(
            "'../host/runner-job-hook.sh'",
            "'./node_modules/@nibfin/core/host/runner-job-hook.sh'",
          )
          .replaceAll("'../tooling/rescue-fixture.mjs'", "'./rescue-fixture.mjs'")
          .replaceAll(
            "'../tooling/selection-fixture.mjs'",
            "'./selection-fixture.mjs'",
          )
          .replaceAll(
            "'../tooling/docker-observation-fixture.mjs'",
            "'./docker-observation-fixture.mjs'",
          )
          .replaceAll(
            "'../tooling/registration-host-fixture.mjs'",
            "'./registration-host-fixture.mjs'",
          )
          .replaceAll(
            "'../tooling/host-routing-fixture.mjs'",
            "'./host-routing-fixture.mjs'",
          )
          .replaceAll(
            "'../tooling/custody-host-fixture.mjs'",
            "'./custody-host-fixture.mjs'",
          )
          .replaceAll(
            "'../tooling/host-identity-fixture.mjs'",
            "'./host-identity-fixture.mjs'",
          )
          .replaceAll(
            "'../host/runner-job-hook.mjs'",
            "'./node_modules/@nibfin/core/host/runner-job-hook.mjs'",
          )
          .replaceAll("'../host/entry.mjs'", "'@nibfin/core/protected-host'")
          .replaceAll("'../src/index.mjs'", "'@nibfin/core'")
          .replaceAll("'../tooling/workflow-fixture.mjs'", "'./workflow-fixture.mjs'")
          .replaceAll(
            "'../tooling/registration-fixture.mjs'",
            "'./registration-fixture.mjs'",
          )
          .replace("'../tooling/core-fixture.mjs'", "'./core-fixture.mjs'")
          .replaceAll("'../tooling/fanout-fixture.mjs'", "'./fanout-fixture.mjs'")
          .replace("'../tooling/recovery-fixture.mjs'", "'./recovery-fixture.mjs'")
          .replace(
            "'../tooling/completion-fixture.mjs'",
            "'./completion-fixture.mjs'",
          )
          .replace(
            "'../tooling/final-review-fixture.mjs'",
            "'./final-review-fixture.mjs'",
          )
          .replace(
            "'../tooling/candidate-publication-fixture.mjs'",
            "'./candidate-publication-fixture.mjs'",
          )
          .replace("'../tooling/repair-fixture.mjs'", "'./repair-fixture.mjs'")
          .replaceAll("'../tooling/evidence-fixture.mjs'", "'./evidence-fixture.mjs'")
          .replace("'../tooling/grant-fixture.mjs'", "'./grant-fixture.mjs'")
          .replace("'../tooling/accept-fixture.mjs'", "'./accept-fixture.mjs'")
          .replace("'../tooling/wsl-fixture.mjs'", "'./wsl-fixture.mjs'")
          .replace("'../tooling/shape-fixture.mjs'", "'./shape-fixture.mjs'")
          .replace("'../tooling/dynamic-fixture.mjs'", "'./dynamic-fixture.mjs'")
          .replace("'../tooling/codex-fixture.mjs'", "'./codex-fixture.mjs'")
          .replace("'../tooling/custody-fixture.mjs'", "'./custody-fixture.mjs'")
          .replace(
            "'../tooling/operations-fixture.mjs'",
            "'./operations-fixture.mjs'",
          )
          .replace("'../tooling/relay-fixture.mjs'", "'./relay-fixture.mjs'")
          .replaceAll(
            /\b(from\s*|import\s*\(\s*)'\.\.\/src\/([^']+)'/g,
            "$1'./node_modules/@nibfin/core/src/$2'",
          ),
      );
      const result = execFileSync(process.execPath, ['--test', file], {
        cwd: consumer,
        env,
        encoding: 'utf8',
      });
      if (!result.includes('# fail 0'))
        throw Error('Installed controlled operation contract failed');
      console.log(
        'Installed consumer',
        file,
        result.match(/^# tests \d+/m)?.[0],
        result.match(/^# pass \d+/m)?.[0],
      );
    }
    if (release) {
      for (const name of ['release-manifest.json', 'compatibility.json']) {
        writeFileSync(
          join(consumer, name),
          readFileSync(join(dirname(archivePath), name)),
        );
      }
      writeFileSync(join(consumer, 'nibfin-core.tgz'), readFileSync(archivePath));
    }
    writeFileSync(
      join(consumer, 'smoke.mjs'),
      readFileSync(join(root, 'tooling/archive-smoke.mjs')),
    );
    writeFileSync(
      join(consumer, 'grant-input.json'),
      JSON.stringify(grantFixture(bodyDigest)),
    );
    const smoke = execFileSync(
      process.execPath,
      ['smoke.mjs', ...(release ? ['--release'] : [])],
      {
        cwd: consumer,
        env,
        encoding: 'utf8',
      },
    ).trim();
    writeFileSync(
      join(consumer, 'workspace.test.mjs'),
      readFileSync(join(root, 'test/workspace.test.mjs'), 'utf8').replace(
        "'../src/index.mjs'",
        "'@nibfin/core'",
      ),
    );
    const workspace = execFileSync(
      process.execPath,
      ['--test', 'workspace.test.mjs'],
      { cwd: consumer, env, encoding: 'utf8' },
    );
    if (!workspace.includes('# fail 0'))
      throw Error('Installed workspace contract failed');
    writeFileSync(
      join(consumer, 'deployment.test.mjs'),
      readFileSync(join(root, 'test/deployment.test.mjs')),
    );
    const deployment = execFileSync(
      process.execPath,
      ['--test', 'deployment.test.mjs'],
      { cwd: consumer, env, encoding: 'utf8' },
    );
    if (!deployment.includes('# fail 0'))
      throw Error('Installed deployment contract failed');
    return (
      smoke +
      '\nInstalled publication/restart/relay/controlled operation/' +
      'concurrency public contracts passed\n' +
      'Installed deployment public contract: 5 tests passed; ' +
      'installed workspace contract: 6 tests passed'
    );
  } catch (error) {
    // node:test emits assertion diagnostics on stdout, including on failure.
    // Retain those credential-free consumer diagnostics rather than just exit 1.
    throw new Error(
      [
        'Archive consumer failed: ' + error.message,
        error.stdout?.toString() ?? '',
        error.stderr?.toString() ?? '',
      ].join('\n'),
      { cause: error },
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

// Packing and byte validation do not execute the installed consumer suite.
// Keep that gate in buildArchive, including every CLI/release entry point.
export function packArchive(producer = root) {
  const output = join(producer, 'out');
  mkdirSync(output, { recursive: true });
  const result = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--offline',
        '--pack-destination',
        output,
      ],
      { cwd: producer, encoding: 'utf8' },
    ),
  );
  const archivePath = join(output, 'nibfin-core.tgz');
  renameSync(join(output, result[0].filename), archivePath);
  console.log(
    'Archive entries:',
    verifyArchive(readFileSync(archivePath), producer).join(', '),
  );
  return archivePath;
}

export function buildArchive(producer = root) {
  const archivePath = packArchive(producer);
  console.log(consumeArchive(archivePath));
  return archivePath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--verify' && process.argv.length === 4) {
    const path = resolve(process.argv[3]);
    verifyArchive(readFileSync(path));
    console.log(consumeArchive(path));
  } else if (process.argv.length === 2) buildArchive();
  else throw Error('Usage: archive.mjs [--verify archive.tgz]');
}
