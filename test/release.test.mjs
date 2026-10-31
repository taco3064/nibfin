import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  releaseVersion,
  releaseHash,
  releaseComponents,
  verifyRelease,
  validateReleaseCompatibility,
  configuration,
  workflowInstallation,
  workflowFiles,
} from '../src/index.mjs';
import {
  initialCompatibility,
  sourceBinding,
  prepareRelease,
  verifyPreparedRelease,
  releaseInputs,
} from '../tooling/release.mjs';
import { publishRelease, githubReleaseRequest } from '../tooling/release-publish.mjs';
const sha = 'a'.repeat(40),
  base = 'b'.repeat(40);
function archiveBytes(files) {
  const chunks = [];
  for (const f of files) {
    const bytes = readFileSync(f.path),
      header = Buffer.alloc(512);
    header.write('package/' + f.path);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function fixture() {
  const components = releaseComponents(),
    compatibility = initialCompatibility(components);
  const compatibilityBytes = Buffer.from(JSON.stringify(compatibility)),
    archive = archiveBytes(components.core.files);
  const source = sourceBinding({ base, mergedCommit: sha });
  const manifest = {
    format: 1,
    package: '@nibfin/core',
    version: components.core.version,
    source,
    components,
    archive: { name: 'nibfin-core.tgz', sha256: releaseHash(archive) },
    compatibility: {
      name: 'compatibility.json',
      sha256: releaseHash(compatibilityBytes),
    },
  };
  return {
    manifest,
    compatibility,
    compatibilityBytes,
    archive,
    expectedVersion: components.core.version,
    expectedSource: source,
  };
}
test('exact installer identities and capability boundary', () => {
  const f = fixture();
  assert.equal(verifyRelease(f), f.manifest);
  assert.deepEqual(
    f.manifest.components.workflow.files.map((f) => f.path),
    [...workflowFiles].sort(),
  );
  verifyRelease({ ...f, read: (p) => readFileSync(p) });
  for (const version of ['latest', 'main', 'v0.1.0', '01.0.0', '0.1', '0.1.0-pre'])
    assert.throws(() => releaseVersion(version));
  for (const update of [
    { expectedVersion: '0.2.0' },
    { expectedSource: { ...f.expectedSource, commit: 'main' } },
    { archive: Buffer.from('changed') },
    { compatibilityBytes: Buffer.from('{}') },
    { manifest: { ...f.manifest, format: 2 } },
    {
      requiredCapabilities: [
        { capability: 'agent-execution', configuration: { agent: 'claude' } },
      ],
    },
  ]) {
    assert.throws(() => verifyRelease({ ...f, ...update }));
  }
  assert.throws(
    () =>
      verifyRelease({
        ...f,
        read: (p) =>
          p === 'skills/accept/SKILL.md' ? Buffer.from('tampered') : readFileSync(p),
      }),
    /installed-content/,
  );
  const scope = f.manifest.components.skills.files.find(
    (file) => file.path === 'instructions/scope.md',
  );
  assert.equal(scope.sha256, releaseHash(readFileSync('instructions/scope.md')));
  assert.throws(
    () =>
      verifyRelease({
        ...f,
        read: (p) =>
          p === 'instructions/scope.md'
            ? Buffer.from('stale Scope')
            : readFileSync(p),
      }),
    /installed-content/,
  );

  const subset = archiveBytes(
    f.manifest.components.core.files.filter(
      (x) => x.path !== 'skills/accept/SKILL.md',
    ),
  );
  assert.throws(
    () =>
      verifyRelease({
        ...f,
        archive: subset,
        manifest: {
          ...f.manifest,
          archive: { name: 'nibfin-core.tgz', sha256: releaseHash(subset) },
        },
      }),
    /archive-component/,
  );
  const clone = () => structuredClone(f.compatibility);
  for (const change of [
    (m) => (m.format = 2),
    (m) => (m.components.workflow.version = '0.2.0'),
    (m) => (m.components.skills.files[0].sha256 = '0'.repeat(64)),
    (m) => (m.entries[0].status = 'Supported'),
    (m) => (m.entries.find((e) => e.visibility === 'private').status = 'Unverified'),
    (m) => delete m.entries[1].registration,
  ]) {
    const metadata = clone();
    change(metadata);
    assert.throws(() =>
      validateReleaseCompatibility(metadata, f.manifest.components),
    );
  }
  for (const registration of ['repository', 'organization']) {
    const metadata = clone();
    Object.assign(metadata.entries[1], { ownership: 'organization', registration });
    assert.equal(
      validateReleaseCompatibility(metadata, f.manifest.components),
      metadata,
    );
  }
  const conflated = clone();
  conflated.entries[1].ownership = 'organization-runner';
  assert.throws(() => validateReleaseCompatibility(conflated, f.manifest.components));
  const m = clone(),
    supported = m.entries.find((e) => e.status === 'Supported');
  supported.evidence[0].configuration = 'f'.repeat(64);
  assert.throws(
    () => validateReleaseCompatibility(m, f.manifest.components),
    /evidence/,
  );
  const supportedEntry = f.compatibility.entries.find(
    (e) => e.status === 'Supported',
  );
  verifyRelease({
    ...f,
    requiredCapabilities: [
      {
        capability: supportedEntry.capability,
        configuration: configuration(supportedEntry),
      },
    ],
  });
  assert.throws(
    () =>
      workflowInstallation({
        commit: 'main',
        hostCommit: sha,
        hostRepository: 'taco3064/nibfin',
      }),
    /immutable-pin/,
  );
});

test('installer rejects unsafe tar entries despite a matching digest', () => {
  for (const unsafe of ['traversal', 'symlink']) {
    const f = fixture(),
      tar = gunzipSync(f.archive),
      header = tar.subarray(0, 512);
    if (unsafe === 'traversal') {
      header.fill(0, 0, 100);
      header.write('package/../escape');
    } else header.write('2', 156);
    header.fill(32, 148, 156);
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    const archive = gzipSync(tar),
      manifest = {
        ...f.manifest,
        archive: { name: 'nibfin-core.tgz', sha256: releaseHash(archive) },
      };
    assert.throws(
      () => verifyRelease({ ...f, manifest, archive }),
      /Unsupported|Forbidden/,
    );
  }
});
test('real preparation binds exact archive, source and mandatory files', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-prepare-'));
  try {
    for (const path of releaseInputs()) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(path, join(root, path));
    }
    const candidate = prepareRelease({ root, base });
    assert.equal(candidate.source.kind, 'candidate');
    assert.equal(candidate.source.commit, null);
    assert.deepEqual(verifyPreparedRelease(root), candidate);
    const bytes = readFileSync(join(root, 'out/nibfin-core.tgz'));
    const merged = prepareRelease({
      root,
      base: sha,
      mergedCommit: sha,
      pack: false,
    });
    assert.equal(merged.source.commit, sha);
    assert.deepEqual(readFileSync(join(root, 'out/nibfin-core.tgz')), bytes);
    const asset = join(root, 'out/compatibility.json'),
      original = readFileSync(asset);
    writeFileSync(asset, '{}');
    assert.throws(() => verifyPreparedRelease(root));
    writeFileSync(asset, original);
    const file = join(root, 'skills/shape/SKILL.md');
    writeFileSync(file, 'changed');
    assert.throws(() => verifyPreparedRelease(root), /Archive\/source mismatch/);
    assert.throws(() => prepareRelease({ root, base: 'main' }), /source-input/);
    rmSync(join(root, 'out/nibfin-core.tgz'));
    assert.throws(() => verifyPreparedRelease(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
function publicationFixture() {
  const f = fixture(),
    assets = new Map([
      ['nibfin-core.tgz', f.archive],
      ['compatibility.json', f.compatibilityBytes],
      ['release-manifest.json', Buffer.from(JSON.stringify(f.manifest))],
    ]);
  const state = {
    release: null,
    tag: null,
    assets: [],
    writes: [],
    records: [],
    immutable: true,
    protected: true,
    merged: true,
    reads: [],
    listedBefore: [],
    duplicates: [],
    readFailure: null,
    fail: null,
    unknown: null,
    annotationTarget: sha,
    invalidImmutable: false,
  };
  const prefix = '/repos/taco3064/nibfin';
  const request = async (r) => {
    const p = r.path.replace('https://uploads.github.com', '').slice(prefix.length);
    if (r.method === 'GET') {
      state.reads.push(p);
      if (state.readFailure === p) return { status: 503 };
      const page = Number(
        new URL('https://api.github.com' + r.path).searchParams.get('page'),
      );
      const listing = [
        ...state.listedBefore,
        ...(state.release ? [state.release] : []),
        ...state.duplicates,
      ];
      const data =
        p === ''
          ? { id: 1427838662, full_name: 'taco3064/nibfin', visibility: 'public' }
          : p === '/branches/main'
            ? { protected: state.protected }
            : p.startsWith('/commits/')
              ? [
                  {
                    merged_at: state.merged ? '2026-10-26' : null,
                    merge_commit_sha: sha,
                    base: { ref: 'main', repo: { id: 1427838662 } },
                  },
                ]
              : p === '/immutable-releases'
                ? state.invalidImmutable
                  ? {}
                  : { enabled: state.immutable }
                : p.startsWith('/git/tags/')
                  ? {
                      sha: p.split('/').at(-1),
                      object: { type: 'commit', sha: state.annotationTarget },
                    }
                  : p.startsWith('/git/ref/')
                    ? state.tag
                    : p.startsWith('/releases?')
                      ? listing.slice((page - 1) * 100, page * 100)
                      : p.startsWith('/releases/tags/')
                        ? state.release?.draft
                          ? null
                          : state.release
                        : p === '/releases/1'
                          ? state.release
                          : p.includes('/assets?')
                            ? state.assets
                            : null;
      return {
        status:
          p === '/immutable-releases' && !state.immutable
            ? 404
            : data === null
              ? 404
              : 200,
        data: structuredClone(data),
      };
    }
    state.writes.push(r.method + ' ' + p);
    if (state.fail === p) return { status: 500 };
    if (r.method === 'POST' && p === '/releases')
      state.release = {
        ...r.data,
        id: 1,
        immutable: false,
        html_url:
          'https://github.com/taco3064/nibfin/releases/tag/' + r.data.tag_name,
      };
    else if (r.method === 'POST' && p.includes('/assets?')) {
      const name = new URL(
        'https://uploads.github.com' +
          r.path.replace('https://uploads.github.com', ''),
      ).searchParams.get('name');
      state.assets.push({
        name,
        id: state.assets.length + 1,
        size: r.bytes.length,
        digest: 'sha256:' + releaseHash(r.bytes),
        state: 'uploaded',
        browser_download_url: 'https://github.com/asset/' + name,
      });
    } else if (r.method === 'PATCH') {
      Object.assign(state.release, {
        draft: false,
        immutable: true,
        published_at: '2026-10-26',
      });
      state.tag = { object: { type: 'commit', sha } };
    } else throw Error('unexpected fixture write');
    if (state.unknown === p) throw Error('connection lost');
    return { status: 201, data: state.release };
  };
  const input = {
    manifest: f.manifest,
    assets,
    run: {
      repository: 'taco3064/nibfin',
      repositoryId: '1427838662',
      ref: 'refs/heads/main',
      event: 'push',
      sha,
      id: '123',
      attempt: '1',
    },
    request,
    record: (r) => state.records.push(structuredClone(r)),
  };
  return { state, input, publish: () => publishRelease(input) };
}
test('publication binds draft, immutable readback and exact retries', async () => {
  const f = publicationFixture(),
    result = await f.publish();
  assert.equal(result.status, 'published');
  assert.equal(result.assets.length, 3);
  const count = f.state.writes.length;
  assert.equal((await f.publish()).status, 'published');
  assert.equal(f.state.writes.length, count);
  f.state.tag = { object: { type: 'tag', sha: 'd'.repeat(40) } };
  assert.equal((await f.publish()).status, 'published');
  assert.equal(f.state.writes.length, count);
  f.state.annotationTarget = base;
  await assert.rejects(f.publish(), /conflicting-tag/);
  f.state.annotationTarget = sha;
  f.state.assets[0].digest = 'sha256:' + 'c'.repeat(64);
  await assert.rejects(f.publish(), /conflicting-asset/);
  assert.equal(f.state.writes.length, count);
});
test('draft discovery is paginated and draft readback uses its returned ID', async () => {
  const f = publicationFixture();
  f.state.readFailure = '/releases/1';
  await assert.rejects(f.publish(), /readback-503/);
  assert.equal(f.state.release.draft, true);
  assert.equal(f.state.writes.length, 1);
  assert.ok(f.state.reads.includes('/releases/1'));
  assert.ok(!f.state.reads.some((p) => p.startsWith('/releases/tags/')));
  f.state.readFailure = null;
  f.state.listedBefore = Array.from({ length: 100 }, (_, i) => ({
    id: i + 2,
    tag_name: 'other-' + i,
    draft: false,
  }));
  assert.equal((await f.publish()).status, 'published');
  assert.ok(f.state.reads.includes('/releases?per_page=100&page=2'));
  assert.equal(f.state.writes.filter((p) => p === 'POST /releases').length, 1);
  const count = f.state.writes.length;
  f.state.duplicates = [structuredClone(f.state.release)];
  await assert.rejects(f.publish(), /ambiguous-release/);
  assert.equal(f.state.writes.length, count);
});
test('failed and unknown writes stop, then require state reconciliation', async () => {
  for (const unknown of [false, true]) {
    const f = publicationFixture();
    f.state[unknown ? 'unknown' : 'fail'] = '/releases';
    await assert.rejects(f.publish(), unknown ? /unknown-outcome/ : /write-500/);
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.records.at(-1).status, 'unknown');
    f.state.unknown = null;
    f.state.fail = null;
    assert.equal((await f.publish()).status, 'published');
    assert.equal(
      f.state.writes.filter((x) => x === 'POST /releases').length,
      unknown ? 1 : 2,
    );
  }
  for (const operation of [
    '/releases/1/assets?name=nibfin-core.tgz',
    '/releases/1',
  ]) {
    const f = publicationFixture();
    f.state.unknown = operation;
    await assert.rejects(f.publish(), /unknown-outcome/);
    const count = f.state.writes.filter((x) => x.endsWith(operation)).length;
    f.state.unknown = null;
    assert.equal((await f.publish()).status, 'published');
    assert.equal(f.state.writes.filter((x) => x.endsWith(operation)).length, count);
  }
  const f = publicationFixture();
  f.state.fail = '/releases/1';
  await assert.rejects(f.publish(), /write-500/);
  assert.equal(f.state.release.draft, true);
  assert.notEqual(f.state.records.at(-1).status, 'published');
});
test('publication rejects untrusted or incomplete source and conflicts', async () => {
  for (const change of [
    (f) => (f.input.run.ref = 'refs/pull/1/merge'),
    (f) => (f.input.run.event = 'pull_request'),
    (f) => (f.input.run.repository = 'other/repo'),
    (f) => (f.input.run.sha = base),
    (f) => (f.input.manifest.version = 'latest'),
    (f) => (f.input.manifest.source.kind = 'candidate'),
    (f) => f.input.assets.delete('compatibility.json'),
    (f) => f.input.assets.set('nibfin-core.tgz', Buffer.from('wrong')),
    (f) => (f.state.immutable = false),
    (f) => (f.state.invalidImmutable = true),
    (f) => (f.state.protected = false),
    (f) => (f.state.merged = false),
    (f) => (f.state.tag = { object: { type: 'commit', sha: base } }),
    (f) =>
      (f.state.release = {
        id: 1,
        tag_name: 'v' + f.input.manifest.version,
        target_commitish: base,
      }),
  ]) {
    const f = publicationFixture();
    change(f);
    await assert.rejects(f.publish());
    assert.equal(f.state.writes.length, 0);
  }
  assert.throws(() => githubReleaseRequest(''), /missing-token/);
  await assert.rejects(
    githubReleaseRequest('fixture')({ method: 'GET', path: 'https://evil.invalid' }),
    /request-origin/,
  );
});
test('retained CD uses trusted main, pinned actions and complete real checks', () => {
  const workflow = parse(readFileSync('.github/workflows/core-release.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.version, {
    description: 'Exact package.json version to publish (without the v prefix)',
    required: true,
    type: 'string',
  });
  assert.match(workflow.jobs.release.if, /github.event_name == 'workflow_dispatch'/);
  assert.match(workflow.jobs.release.if, /github.ref == 'refs\/heads\/main'/);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const steps = workflow.jobs.release.steps;
  const requested = steps.find((s) => s.name === 'Confirm requested package version');
  assert.equal(requested.env.NIBFIN_RELEASE_VERSION, '${{ inputs.version }}');
  assert(
    steps.indexOf(requested) < steps.findIndex((s) => s.run?.startsWith('npm ci')),
  );
  for (const s of steps.filter((s) => s.uses)) assert.match(s.uses, /@[a-f0-9]{40}$/);
  for (const command of [
    'npm run check',
    'npm run test:artifact-sdk',
    'npm run verify:release',
    'node tooling/release-publish.mjs',
  ]) {
    assert.ok(steps.some((s) => s.run === command));
  }
  assert.equal(steps.filter((s) => s.env?.NIBFIN_RELEASE_TOKEN).length, 1);
  assert.equal(workflow.jobs.release.permissions.contents, 'write');
  assert.equal(workflow.jobs.release.permissions['pull-requests'], 'read');
  const publish = steps.find((s) => s.run === 'node tooling/release-publish.mjs');
  assert.equal(publish.env.NIBFIN_RELEASE_TOKEN, '${{ github.token }}');
  assert.equal(publish.env.NIBFIN_RELEASE_IMMUTABILITY_POLICY, 'repository-enforced');
});

test('workflow version guard requires the requested merged version', (t) => {
  const workflow = parse(readFileSync('.github/workflows/core-release.yml', 'utf8'));
  const step = workflow.jobs.release.steps.find(
    (s) => s.name === 'Confirm requested package version',
  );
  const script = /^node -e "([\s\S]+)"$/.exec(step.run)?.[1];
  assert(script);
  assert(!step.run.includes('${{'));
  const directory = mkdtempSync(join(tmpdir(), 'nibfin-release-request-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ version: '1.2.3' }),
  );
  const run = (version) =>
    execFileSync(process.execPath, ['-e', script], {
      cwd: directory,
      env: { ...process.env, NIBFIN_RELEASE_VERSION: version },
      stdio: 'pipe',
    });
  assert.doesNotThrow(() => run('1.2.3'));
  for (const version of ['', '1.2.4', 'v1.2.3', '1.2.3; echo unwanted'])
    assert.throws(() => run(version), /requested-version-mismatch/);
});

test('repository enforcement requires immutable final readback', async () => {
  const f = publicationFixture();
  f.input.immutabilityPolicy = 'repository-enforced';
  f.state.readFailure = '/immutable-releases';
  assert.equal((await f.publish()).status, 'published');
  assert.ok(!f.state.reads.includes('/immutable-releases'));
  const g = publicationFixture(),
    request = g.input.request;
  g.input.immutabilityPolicy = 'repository-enforced';
  g.input.request = async (r) => {
    const response = await request(r);
    if (r.method === 'GET' && r.path.includes('/releases/tags/'))
      response.data = { ...response.data, immutable: false };
    return response;
  };
  await assert.rejects(g.publish(), /not-immutable-published/);
  assert.notEqual(g.state.records.at(-1).status, 'published');
  const h = publicationFixture();
  h.input.immutabilityPolicy = 'unknown';
  await assert.rejects(h.publish(), /immutability-policy/);
  assert.equal(h.state.writes.length, 0);
});

test('HTTP adapter preserves the merged-source publication schema', async (t) => {
  const f = publicationFixture(),
    versions = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url),
      version = options.headers['X-GitHub-Api-Version'];
    versions.push(version);
    const upload = u.hostname === 'uploads.github.com';
    const response = await f.input.request({
      method: options.method,
      path: upload ? url : u.pathname + u.search,
      data: !upload && options.body ? JSON.parse(options.body) : undefined,
      bytes: upload ? options.body : undefined,
    });
    // Observed provider difference: 2026-03-10 removes this field from PR objects.
    if (version === '2026-03-10' && u.pathname.includes('/commits/'))
      for (const pr of response.data) delete pr.merge_commit_sha;
    return new Response(JSON.stringify(response.data), { status: response.status });
  });
  const result = await publishRelease({
    ...f.input,
    request: githubReleaseRequest('fixture'),
  });
  assert.equal(result.status, 'published');
  assert.ok(versions.length > 0);
  assert.ok(versions.every((v) => v === '2022-11-28'));
});
