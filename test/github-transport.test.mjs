import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConditionalGithubTransport,
  createGithubProvider,
  localGhTransport,
  githubRateLimit,
} from '../src/index.mjs';

const request = {
  method: 'GET',
  endpoint: '/user',
  target: '7',
  operation: 'read',
  correlation: 'fixture',
  headers: {},
};

test('stored login forwards ETag and accepts gh nonzero 304 without tokens', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'nibfin-gh-contract-'));
  const executable = join(root, 'gh'),
    log = join(root, 'requests.jsonl');
  const previous = process.env.GH_TOKEN;
  try {
    const script = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.GH_TOKEN) process.exit(9);
if (args[0] === 'auth') process.exit(0);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.includes('If-None-Match: "fixture"')) {
  process.stdout.write('HTTP/2 304\\r\\nETag: "fixture"\\r\\n\\r\\n');
  process.exitCode = 1;
} else {
  process.stdout.write('HTTP/2 200\\r\\nETag: "fixture"\\r\\n\\r\\n{"id":7}');
}
`;
    await fs.writeFile(executable, script, { mode: 0o700 });
    process.env.GH_TOKEN = 'untrusted-environment';
    const transport = localGhTransport({ executable });
    const provider = createGithubProvider({ attempts: 1, transport });
    assert.equal((await provider.request(request)).data.id, '7');
    assert.equal((await provider.request(request)).data.id, '7');
    const requests = (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.ok(requests[1].includes('If-None-Match: "fixture"'));
    assert.equal(transport.metrics().notModified, 1);
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('denial and unavailable reads never become old authenticated values', async () => {
  const responses = [
    { status: 200, headers: { etag: '"first"' }, body: '{"id":7}' },
    { status: 304, headers: {}, body: '' },
    { status: 403, headers: {}, body: '{}' },
    { status: 503, headers: {}, body: '{}' },
  ];
  const sent = [];
  const transport = createConditionalGithubTransport({
    send: async (value) => {
      sent.push(value);
      return responses.shift();
    },
  });
  const provider = createGithubProvider({ attempts: 1, transport });
  assert.equal((await provider.request(request)).data.id, '7');
  assert.equal((await provider.request(request)).data.id, '7');
  assert.equal(sent[1].headers['If-None-Match'], '"first"');
  assert.equal((await provider.request(request)).diagnostic.kind, 'denied');
  assert.equal((await provider.request(request)).diagnostic.kind, 'server');
  assert.equal(sent.length, 4);
});

test('mutation invalidates in-flight 304; pagination remains fresh', async () => {
  let changed = false,
    release,
    waiting;
  const seen = [];
  const transport = createConditionalGithubTransport({
    send: async (value) => {
      seen.push(value);
      if (value.method !== 'GET') {
        changed = true;
        return { status: 200, headers: {}, body: '{}' };
      }
      if (waiting) {
        await waiting;
        waiting = null;
        return { status: 304, headers: {}, body: '' };
      }
      return {
        status: 200,
        headers: { etag: '"current"' },
        body: changed ? 'new' : 'old',
      };
    },
  });
  await transport(request);
  waiting = new Promise((resolve) => {
    release = resolve;
  });
  const pending = transport(request);
  await Promise.resolve();
  await transport({ ...request, method: 'PATCH' });
  release();
  assert.equal((await pending).body, 'new');
  assert.equal(seen.at(-1).headers['If-None-Match'], undefined);
  const page = { ...request, endpoint: '/repos/example/project/issues?per_page=100' };
  await transport(page);
  await transport(page);
  assert.equal(seen.at(-1).headers['If-None-Match'], undefined);
});

test('cooldown uses the latest trusted deadline, preserving ordinary denial', () => {
  const now = 100000;
  const response = {
    status: 403,
    headers: {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '110',
      'Retry-After': '30',
      'X-RateLimit-Resource': 'core',
    },
  };
  assert.deepEqual(githubRateLimit(response, { now }), {
    version: 1,
    resource: 'core',
    resetAt: 130000,
    observedAt: now,
    reason: 'github-api-rate-limit',
  });
  assert.equal(githubRateLimit({ status: 403, headers: {} }, { now }), null);
  assert.equal(githubRateLimit({ status: 429 }, { now }).resetAt, 160000);
  assert.equal(
    githubRateLimit({ status: 403, body: 'secondary rate limit' }, { now }).resetAt,
    160000,
  );
  assert.equal(
    githubRateLimit(
      { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' } },
      { now },
    ),
    null,
  );
  assert.equal(
    githubRateLimit(
      { status: 429, headers: { 'retry-after': '9999999999999' } },
      { now },
    ),
    null,
  );
});

test('collection keeps fresh pagination without explicit page parameters', async () => {
  const endpoint = '/repos/example/project/issues';
  const requests = [];
  const transport = createConditionalGithubTransport({
    send: async (value) => {
      requests.push(value);
      if (value.endpoint.includes('page=2')) {
        return { status: 200, headers: {}, body: '[{"id":8}]' };
      }
      if (value.headers['If-None-Match']) {
        return { status: 304, headers: {}, body: '' };
      }
      const link = '<https://api.github.com' + endpoint + '?page=2>; rel="next"';
      return {
        status: 200,
        headers: { etag: '"first-page"', link },
        body: '[{"id":7}]',
      };
    },
  });
  const provider = createGithubProvider({ attempts: 1, transport });
  for (let observation = 0; observation < 2; observation++) {
    const result = await provider.collection({
      ...request,
      endpoint,
      allowPage: (value) => value.split('?')[0] === endpoint,
    });
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(
      result.data.map((value) => value.id),
      ['7', '8'],
    );
  }
  assert.equal(requests.length, 4);
  assert.ok(requests.every((value) => !value.headers['If-None-Match']));
});
