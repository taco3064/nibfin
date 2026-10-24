import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {custodyFixture, zipFixture} from '../tooling/custody-fixture.mjs';
import {prepareCustodyManifest, validateCustodyManifest, bindCustodyPublication,
  actionsArtifactUpload, contentIdentity, artifactArchiveTransport, canonicalJSON} from '../src/index.mjs';
import {readCustodyZip} from '../src/custody-zip.mjs';
const copy = v => structuredClone(v);

test('complete identity manifest and mandatory ignored payloads', () => {
  const f = custodyFixture();
  for (const stage of ['authorization', 'candidate']) {
    const binding = {...f.expected, stage};
    const manifest = JSON.parse(JSON.stringify(prepareCustodyManifest(binding, f.payloads)));
    assert.deepEqual(validateCustodyManifest(manifest, binding, f.payloads), manifest);
  }
  for (const key of Object.keys(f.expected)) {
    const expected = copy(f.expected);
    expected[key] = key === 'candidate' ? {...expected.candidate, identity: 'b'.repeat(64)}
      : ['scopeHash', 'shapeHash', 'authorization'].includes(key) ? 'b'.repeat(64)
      : ['repositoryId', 'runId', 'attempt'].includes(key) ? '99'
      : key === 'repository' ? 'other/core' : key === 'stage' ? 'accept' : 'other';
    assert.throws(() => validateCustodyManifest(f.manifest, expected, f.payloads), key);
  }
  for (const change of [m => m.version++, m => m.payloads.push(m.payloads[0]), m => m.payloads[0].size++,
    m => m.payloads[0].digest = 'b'.repeat(64), m => m.binding.repositoryId = 42]) {
    const m = copy(f.manifest); change(m); assert.throws(() => validateCustodyManifest(m, f.expected, f.payloads));
  }
  const missing = new Map(f.payloads); missing.delete('out/ignored.bin');
  assert.throws(() => prepareCustodyManifest(f.expected, missing), /missing/);
  for (const path of ['../x', '/x', 'a/../b', 'a\\b', 'custody-manifest.json'])
    assert.throws(() => prepareCustodyManifest(f.expected, new Map([[path, Buffer.from('x')]])));
});

test('official toolkit boundary, readback and fresh cross-repository reconstruction', async () => {
  for (const repository of ['person/core', 'example-org/core']) {
    const f = custodyFixture(repository), published = await f.publish();
    assert.equal(published.outcome, 'retained');
    const upload = f.calls.find(c => c.upload).upload;
    assert.deepEqual(upload.options, {retentionDays: 7, compressionLevel: 6});
    assert.equal(existsSync(upload.rootDirectory), false);
    // Remove producer maps; new independent instance has no producer/cache API.
    f.payloads.clear();
    const reader = f.fresh(), received = await reader.retrieve({ref: published.ref, expected: copy(f.expected)});
    assert.equal(received.outcome, 'retrieved');
    assert.deepEqual(received.payloads.get('out/ignored.bin'), Buffer.from([0, 255, 1, 128]));
    for (const altered of [{attempt: '2'}, {cycle: 'obsolete'}])
      assert.equal((await reader.retrieve({ref: published.ref, expected: {...f.expected, ...altered}})).outcome, 'failed');
    assert.ok(f.calls.filter(c => c.endpoint).every(c => c.endpoint.startsWith(`/repos/${repository}`)));
    assert.ok(f.calls.filter(c => c.method).every(c => c.method === 'GET'));
    assert.ok(f.storageCalls.every(c => c.options.credentials === 'omit' && Object.keys(c.options.headers).length === 0));
    assert.ok(f.calls.some(c => c.endpoint?.endsWith('page=2')));
  }
});

test('upload missing runtime, ambiguous writes, unsafe IDs and failed readback never confirm', async () => {
  const f = custodyFixture();
  for (const runtime of [undefined, {...f.runtime, available: false}, {...f.runtime, attempt: '2'}])
    assert.equal((await f.publish({runtime})).outcome, 'failed');
  let attempts = 0;
  assert.equal((await f.publish({client: {uploadArtifact: async () => {attempts++; throw Error('secret');}}})).outcome, 'unconfirmed');
  assert.equal(attempts, 1);
  assert.throws(() => bindCustodyPublication(f.manifest, {id: 9007199254740993, digest: 'a'.repeat(64)}));
  f.state.status = 403;
  const result = await f.publish(); assert.equal(result.outcome, 'unconfirmed'); assert.ok(result.ref);
  assert.equal(result.diagnostic.status, 403); assert.equal(result.diagnostic.requestId, 'REQ-1');
});

test('fresh provider failures reject despite previously retrieved bytes', async () => {
  const f = custodyFixture(), reader = f.fresh(), ref = f.ref();
  const cache = await reader.retrieve({ref, expected: f.expected}); assert.equal(cache.outcome, 'retrieved');
  for (const [status, kind] of [[401, 'authentication'], [403, 'denied'], [404, 'not_found_or_inaccessible'], [429, 'rate_limited'], [500, 'server']]) {
    f.state.status = status;
    const r = await reader.retrieve({ref, expected: f.expected, cache});
    assert.equal(r.outcome, 'failed'); assert.equal(r.diagnostic.kind, kind);
    assert.equal(r.diagnostic.status, status); assert.equal(r.diagnostic.requestId, 'REQ-1');
  }
  f.state.status = 200; f.state.error = true;
  assert.equal((await reader.retrieve({ref, expected: f.expected, cache})).diagnostic.kind, 'transport');
  f.state.error = false; f.state.expires = '2020-01-01';
  assert.equal((await reader.retrieve({ref, expected: f.expected, cache})).diagnostic.kind, 'expired');
  f.state.expires = '2030-01-01'; f.state.onDownload = () => { f.state.now = Date.parse('2031-01-01'); };
  assert.equal((await reader.retrieve({ref, expected: f.expected, cache})).diagnostic.kind, 'expired');
  assert.deepEqual(cache.payloads.get('out/ignored.bin'), Buffer.from([0, 255, 1, 128]));
});

test('timeout/cancellation bound uncooperative transports and redact diagnostics', async () => {
  const f = custodyFixture(); f.state.hang = true;
  const keepAlive = setInterval(() => {}, 50);
  try {
    assert.equal((await f.fresh({timeoutMs: 15}).retrieve({ref: f.ref(), expected: f.expected})).diagnostic.kind, 'timeout');
    const controller = new AbortController(); controller.abort();
    const r = await f.fresh().retrieve({ref: f.ref(), expected: f.expected, signal: controller.signal});
    assert.equal(r.diagnostic.kind, 'cancelled');
    assert.doesNotMatch(JSON.stringify(r), /signed|secret|storage.example/);
  } finally { clearInterval(keepAlive); }
});

test('pagination is complete, unambiguous and stays within the read-only source', async () => {
  for (const change of [
    d => d.artifacts ? {...d, total_count: 2} : d,
    d => d.artifacts?.length ? {...d, artifacts: [...d.artifacts, ...d.artifacts], total_count: 2} : d,
    d => d.artifacts ? {...d, artifacts: undefined} : d,
    d => d.workflow_run ? {...d, workflow_run: {...d.workflow_run, repository_id: '99'}} : d,
    d => d.workflow_run ? {...d, id: '99'} : d,
    d => d.artifacts ? {...d, artifacts: []} : d,
    d => d.full_name ? {...d, id: '99'} : d,
    d => d.full_name ? {...d, private: true} : d
  ]) {
    const f = custodyFixture(); f.state.change = change;
    assert.equal((await f.fresh().retrieve({ref: f.ref(), expected: f.expected})).outcome, 'failed');
  }
  // Provider guard rejects a syntactically valid Link to another repository before I/O.
  const {createGithubProvider} = await import('../src/index.mjs'); let requests = 0;
  const provider = createGithubProvider({transport: async () => {requests++; return {status: 200,
    headers: {link: '<https://api.github.com/repos/other/core/actions/artifacts?page=2>; rel="next"'}, body: '{"artifacts":[]}'};}});
  const r = await provider.collection({endpoint: '/repos/org/core/actions/artifacts', envelope: 'artifacts', operation: 'read', correlation: 'test', target: '42',
    allowPage: p => p.startsWith('/repos/org/core/')});
  assert.equal(r.outcome, 'incomplete'); assert.equal(requests, 1);
});

test('archive and payload integrity, exact inventory, path and size boundaries', async () => {
  const f = custodyFixture();
  const badArchives = [f.state.bytes.subarray(0, -1), Buffer.from('invalid'),
    zipFixture([['../escape', 'x']]), zipFixture([['/absolute', 'x']]),
    zipFixture([['link', 'target', 0o120777]]), zipFixture([['same', '1'], ['same', '2']]),
    f.encode(new Map([['extra', Buffer.from('x')], ...f.payloads])),
    f.encode(new Map([['out/ignored.bin', Buffer.from('wrong')]])),
    f.encode(new Map([['authorization.json', Buffer.from('{}')]])),
    f.encode(f.payloads, {...f.manifest, version: 99}),
    f.encode(f.payloads, {...f.manifest, payloads: f.manifest.payloads.map(p => ({...p, size: p.size + 1}))})];
  for (const bytes of badArchives) {
    f.state.bytes = bytes;
    const result = await f.fresh().retrieve({ref: f.ref(), expected: f.expected});
    assert.equal(result.outcome, 'failed'); assert.equal(result.payloads, undefined);
  }
  const valid = f.encode(); f.state.bytes = valid;
  assert.equal((await f.fresh({maxBytes: 10}).retrieve({ref: f.ref(), expected: f.expected})).outcome, 'failed');
  assert.equal((await f.fresh({maxFiles: 1}).retrieve({ref: f.ref(), expected: f.expected})).outcome, 'failed');
  const bomb = zipFixture([['large', Buffer.alloc(10000)]]);
  assert.throws(() => readCustodyZip(bomb, {maxBytes: 1000, maxFiles: 5}));
  const corrupt = Buffer.from(valid); corrupt[50] ^= 1;
  assert.throws(() => readCustodyZip(corrupt, {maxBytes: 100000, maxFiles: 10}));
  const ref = f.ref(); f.state.archiveChange = b => {const x = Buffer.from(b); x[50] ^= 1; return x;};
  assert.equal((await f.fresh().retrieve({ref, expected: f.expected})).diagnostic.kind, 'digest');
  f.state.archiveChange = b => b.subarray(0, -1);
  assert.equal((await f.fresh().retrieve({ref, expected: f.expected})).diagnostic.kind, 'incomplete');
  for (const status of [401, 403, 404, 410, 429]) {
    f.state.archiveStatus = status;
    assert.equal((await f.fresh().retrieve({ref, expected: f.expected})).outcome, 'failed');
  }
});

test('existing stage evidence is independently compared and bound to source and candidate', async () => {
  const f = custodyFixture(), h = 'a'.repeat(64);
  const candidate = {base: 'b'.repeat(40), tree: 'c'.repeat(40), diff: h, paths: [], artifacts: copy(f.expected.candidate.payloads), hooks: [], emptyHooksReason: 'No hooks configured'};
  const receipt = {version: 1, stage: 'deliver', binding: {authority: h, grant: h, policy: h, core: h, runtime: h,
    instructions: h, repositoryId: '42', issueId: 'I_101', scopeHash: h, shapeHash: h},
  execution: {role: 'deliver', skill: 'deliver', id: 'writer', request: 'request', result: 'result-1',
    source: {repositoryId: '42', workflow: h, runId: f.expected.runId, attempt: '1'}},
  inputs: {publication: h, candidate}, result: {version: 1, outcome: 'ready', failureClass: 'none', summary: 'implemented', conflicts: []}};
  f.expected.stage = 'deliver';
  f.expected.candidate.identity = contentIdentity(candidate);
  f.payloads.set('stage.json', Buffer.from(canonicalJSON(receipt)));
  const manifest = prepareCustodyManifest(f.expected, f.payloads); f.state.bytes = f.encode(f.payloads, manifest);
  const ref = {...f.ref(), manifestIdentity: contentIdentity(manifest)};
  const evidence = {'stage.json': {expected: receipt, consumed: []}};
  assert.equal((await f.fresh().retrieve({ref, expected: f.expected, evidence})).outcome, 'retrieved');
  evidence['stage.json'].consumed.push('result-1');
  assert.equal((await f.fresh().retrieve({ref, expected: f.expected, evidence})).outcome, 'failed');
  evidence['stage.json'].consumed = []; evidence['stage.json'].expected = {...receipt, execution: {...receipt.execution, id: 'other'}};
  assert.equal((await f.fresh().retrieve({ref, expected: f.expected, evidence})).outcome, 'failed');
});

test('redirect adapter strips credentials, rejects unsupported responses and bounds streams', async () => {
  const signal = AbortSignal.timeout(1000);
  for (const location of ['http://storage.example/x', 'https://user:pass@storage.example/x']) {
    const adapter = artifactArchiveTransport({api: async () => ({status: 302, headers: {location}})});
    await assert.rejects(adapter({endpoint: '/artifact', signal, maxBytes: 100}));
  }
  for (const [body, headers] of [['abcdef', {}], ['abc', {'content-length': '5'}]]) {
    const adapter = artifactArchiveTransport({api: async () => ({status: 302, headers: {location: 'https://storage.example/x'}}),
      fetch: async () => new Response(body, {headers})});
    await assert.rejects(adapter({endpoint: '/artifact', signal, maxBytes: 4}));
  }
});


test('official host preflight checks every runtime prerequisite before loading SDK', async () => {
  const f = custodyFixture(), environment = {GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: f.expected.repository, GITHUB_REPOSITORY_ID: '42', GITHUB_RUN_ID: f.expected.runId,
    GITHUB_RUN_ATTEMPT: '1', ACTIONS_RUNTIME_TOKEN: 'fixture-only', ACTIONS_RESULTS_URL: 'https://results.example/'};
  let loads = 0;
  const load = async () => {loads++; throw Error('SDK unavailable');};
  for (const key of Object.keys(environment)) {
    const absent = {...environment}; delete absent[key];
    await assert.rejects(actionsArtifactUpload({expected: f.expected, environment: absent, load}), /runtime/);
  }
  assert.equal(loads, 0);
  await assert.rejects(actionsArtifactUpload({expected: f.expected, environment, load: async () => ({version: '1.0.0'})}));
  await assert.rejects(actionsArtifactUpload({expected: f.expected, environment, load}), /runtime/);
  assert.equal(bindCustodyPublication(f.manifest, {id: 123, digest: 'a'.repeat(64)}).artifactId, '123');
});

test('publication cancellation remains unconfirmed and preserves pending upload files', async () => {
  const f = custodyFixture(), controller = new AbortController(); let finish, root;
  const pending = f.publish({signal: controller.signal, client: {uploadArtifact: async (_, files, directory) => {
    root = directory; controller.abort(); return new Promise(resolve => {finish = resolve;});
  }}});
  const r = await pending; assert.equal(r.outcome, 'unconfirmed'); assert.equal(existsSync(root), true);
  finish({id: 123, digest: 'a'.repeat(64)});
  // Give asynchronous disposable cleanup a bounded opportunity to finish.
  for (let i = 0; i < 30 && existsSync(root); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(existsSync(root), false);
  assert.equal((await f.publish({maxBytes: 1})).outcome, 'failed');
});


test('manifest identity, optional archive digest and metadata mutation boundaries', async () => {
  const f = custodyFixture();
  assert.equal((await f.fresh().retrieve({ref: {...f.ref(), manifestIdentity: 'b'.repeat(64)}, expected: f.expected})).diagnostic.kind, 'manifest_identity');
  for (const field of ['repositoryId', 'runId', 'artifactId']) {
    const ref = {...f.ref(), [field]: '99'};
    assert.equal((await f.fresh().retrieve({ref, expected: f.expected})).outcome, 'failed');
  }
  f.state.change = (d, request) => d.workflow_run && !request.endpoint.includes('/runs/')
    ? {...d, name: 'changed'} : d;
  assert.equal((await f.fresh().retrieve({ref: f.ref(), expected: f.expected})).diagnostic.kind, 'metadata_changed');
  f.state.change = d => {
    const remove = a => {const b = {...a}; delete b.digest; return b;};
    return d.workflow_run ? remove(d) : d.artifacts ? {...d, artifacts: d.artifacts.map(remove)} : d;
  };
  assert.equal((await f.fresh().retrieve({ref: {...f.ref(), archiveDigest: null}, expected: f.expected})).outcome, 'retrieved');
  assert.equal((await f.fresh().retrieve({ref: f.ref(), expected: f.expected})).diagnostic.kind, 'digest');
});
