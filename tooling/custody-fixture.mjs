// Local official-response transport proof only; no live GitHub success implied.
import {readFile} from 'node:fs/promises';
import {relative} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {createGithubProvider, createArtifactCustody, artifactArchiveTransport,
  prepareCustodyManifest, publishCustody, byteDigest, contentIdentity, canonicalJSON} from '../src/index.mjs';

export function zipFixture(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [path, input, mode = 0o100600] of entries) {
    const bytes = Buffer.from(input), name = Buffer.from(path), packed = deflateRawSync(bytes);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4);
    l.writeUInt16LE(8, 6); l.writeUInt16LE(8, 8); l.writeUInt16LE(name.length, 26);
    const d = Buffer.alloc(16); d.writeUInt32LE(0x08074b50); d.writeUInt32LE(crc, 4);
    d.writeUInt32LE(packed.length, 8); d.writeUInt32LE(bytes.length, 12);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE((mode * 65536) >>> 0, 38); c.writeUInt32LE(offset, 42);
    const local = Buffer.concat([l, name, packed, d]); locals.push(local); central.push(c, name); offset += local.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export function custodyFixture(repository = 'example-org/core') {
  const h = 'a'.repeat(64), calls = [], storageCalls = [];
  const expected = {repository, repositoryId: '42', issueId: 'I_101', cycle: 'cycle-1',
    scopeHash: h, shapeHash: h, authorization: h, runId: '9007199254740993', attempt: '1', stage: 'candidate', result: 'result-1',
    candidate: {identity: h, payloads: [{path: 'out/ignored.bin', digest: byteDigest(Buffer.from([0, 255, 1, 128]))}]}};
  const payloads = new Map([['out/ignored.bin', Buffer.from([0, 255, 1, 128])], ['authorization.json', Buffer.from('{}')]]);
  const manifest = prepareCustodyManifest(expected, payloads);
  const state = {bytes: null, status: 200, pages: true, expires: '2030-01-01T00:00:00Z', now: Date.parse('2026-10-24'),
    change: d => d, archiveChange: b => b, archiveStatus: 200};
  const root = `/repos/${repository}/actions`, id = '9007199254740995';
  const metadata = () => ({id, name: 'evidence', size_in_bytes: state.bytes.length, expired: false,
    expires_at: state.expires, digest: `sha256:${byteDigest(state.bytes)}`,
    workflow_run: {id: expected.runId, repository_id: '42'}});
  const transport = async r => {
    calls.push(r); if (state.error) throw Error('protected secret');
    if (state.hang) return new Promise(() => {});
    let data, headers = {'x-github-request-id': 'REQ-1'};
    if (r.endpoint === `/repos/${repository}`) data = {id: '42', full_name: repository, private: false};
    else if (r.endpoint === `${root}/artifacts/${id}`) data = metadata();
    else if (r.endpoint === `${root}/runs/${expected.runId}/artifacts?per_page=100`) {
      data = {total_count: 1, artifacts: state.pages ? [] : [metadata()]};
      if (state.pages) headers.link = `<https://api.github.com${root}/runs/${expected.runId}/artifacts?page=2>; rel="next"`;
    } else if (r.endpoint === `${root}/runs/${expected.runId}/artifacts?page=2`) data = {total_count: 1, artifacts: [metadata()]};
    else throw Error('unexpected source');
    return {status: state.status, headers, body: JSON.stringify(state.change(data, r))};
  };
  const archive = artifactArchiveTransport({api: async r => {
    calls.push(r);
    if (r.endpoint !== `${root}/artifacts/${id}/zip`) throw Error('wrong source');
    if (state.onDownload) state.onDownload();
    return {status: state.archiveStatus === 200 ? 302 : state.archiveStatus, headers: {location: 'https://storage.example/archive?secret=signed'}};
  }, fetch: async (url, options) => {
    storageCalls.push({url, options});
    const bytes = state.archiveChange(state.bytes);
    return new Response(bytes, {status: 200, headers: {'content-length': String(bytes.length)}});
  }});
  const fresh = options => createArtifactCustody({provider: createGithubProvider({transport, attempts: 1}), archive,
    now: () => state.now, ...options});
  const runtime = {facility: '@actions/artifact@2.3.2', repository, repositoryId: '42', runId: expected.runId, attempt: '1', available: true};
  const client = {uploadArtifact: async (name, paths, rootDirectory, options) => {
    calls.push({upload: {name, paths, rootDirectory, options}});
    const entries = await Promise.all(paths.map(async p => [relative(rootDirectory, p), await readFile(p)]));
    state.bytes = zipFixture(entries);
    return {id, size: state.bytes.length, digest: byteDigest(state.bytes)};
  }};
  const publish = overrides => publishCustody({manifest, payloads, expected, client, runtime,
    custody: fresh(), name: 'evidence-cycle-1-attempt-1', retentionDays: 7, ...overrides});
  const encode = (files = payloads, m = manifest) => zipFixture([...files, ['custody-manifest.json', Buffer.from(canonicalJSON(m))]]);
  state.bytes = encode();
  const ref = () => ({repository, repositoryId: '42', runId: expected.runId, artifactId: id,
    manifestIdentity: contentIdentity(manifest), archiveDigest: byteDigest(state.bytes)});
  return {expected, payloads, manifest, state, calls, storageCalls, fresh, publish, encode, ref, runtime, client};
}
