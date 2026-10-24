import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {loadArtifactSDK, singleAttemptArtifactClient} from './custody-upload.mjs';
import {canonicalJSON, githubId, repositoryCoordinates, byteDigest, contentIdentity, compareEvidence, stageApplicability} from './index.mjs';
import {safeObligationPath} from './obligations.mjs';
import {readCustodyZip} from './custody-zip.mjs';
import {publicDiagnostic, githubApiVersion} from './provider.mjs';

const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const fail = kind => { throw Object.assign(Error(`custody:${kind}`), {kind}); };
const exact = (v, keys) => v && same(Object.keys(v).sort(), keys.split(' ').sort());
const clone = v => JSON.parse(canonicalJSON(v));
const manifestPath = 'custody-manifest.json';
function context(v) {
  if (!exact(v, 'repository repositoryId issueId cycle scopeHash shapeHash authorization runId attempt stage result candidate')) fail('identity');
  const parts = v.repository?.split('/');
  if (parts?.length !== 2 || repositoryCoordinates(...parts).key !== v.repository) fail('identity');
  for (const k of ['repositoryId', 'runId', 'attempt']) githubId(v[k]);
  for (const k of ['scopeHash', 'authorization']) if (!hash(v[k])) fail('identity');
  if (!hash(v.shapeHash) && !(v.shapeHash === null && ['authorization', 'shape'].includes(v.stage))) fail('identity');
  for (const k of ['issueId', 'cycle', 'stage', 'result']) if (typeof v[k] !== 'string' || !/^[a-zA-Z0-9_:.-]{1,256}$/.test(v[k])) fail('identity');
  if (!Object.hasOwn(stageApplicability, v.stage) && !['authorization', 'candidate'].includes(v.stage)) fail('stage');
  if (v.candidate !== null && (!exact(v.candidate, 'identity payloads') || !hash(v.candidate.identity)
      || !Array.isArray(v.candidate.payloads) || v.candidate.payloads.some(p => !exact(p, 'path digest') || !safeObligationPath(p.path) || !hash(p.digest))
      || new Set(v.candidate.payloads.map(p => p.path)).size !== v.candidate.payloads.length)) fail('candidate');
}
function entries(payloads) {
  if (!(payloads instanceof Map) || !payloads.size) fail('payloads');
  return [...payloads].map(([path, bytes]) => {
    if (!safeObligationPath(path) || /[":<>|*?]/.test(path) || path === manifestPath || !(bytes instanceof Uint8Array)) fail('payloads');
    return {path, size: bytes.byteLength, digest: byteDigest(bytes)};
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export function prepareCustodyManifest(binding, payloads) {
  context(binding);
  const manifest = {version: 1, binding: clone(binding), payloads: entries(payloads)};
  validateCustodyManifest(manifest, binding, payloads);
  return manifest;
}
export function validateCustodyManifest(manifest, expected, payloads) {
  context(expected);
  if (!exact(manifest, 'version binding payloads') || manifest.version !== 1) fail('manifest');
  context(manifest.binding);
  if (!same(manifest.binding, expected) || !same(manifest.payloads, entries(payloads))) fail('mismatch');
  if (Object.hasOwn(stageApplicability, expected.stage) && !payloads.has('stage.json')) fail('missing_stage');
  if (expected.candidate?.payloads.some(p => !payloads.has(p.path) || byteDigest(payloads.get(p.path)) !== p.digest)) fail('missing');
  return clone(manifest);
}
function reference(ref) {
  if (!exact(ref, 'repository repositoryId runId artifactId manifestIdentity archiveDigest')) fail('reference');
  const parts = ref.repository?.split('/');
  if (parts?.length !== 2 || repositoryCoordinates(...parts).key !== ref.repository) fail('reference');
  for (const k of ['repositoryId', 'runId', 'artifactId']) githubId(ref[k]);
  if (!hash(ref.manifestIdentity) || ref.archiveDigest !== null && !hash(ref.archiveDigest)) fail('reference');
}
/** Bind a toolkit result without ever converting an unsafe numeric ID. */
export function bindCustodyPublication(manifest, upload) {
  const value = upload?.id;
  const artifactId = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  githubId(artifactId);
  if (!hash(upload.digest)) fail('upload_result');
  const {repository, repositoryId, runId} = manifest.binding;
  const ref = {repository, repositoryId, runId, artifactId, manifestIdentity: contentIdentity(manifest), archiveDigest: upload.digest};
  reference(ref);
  return ref;
}
async function bounded(work, signal) {
  if (signal.aborted) fail('cancelled');
  let abort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      abort = () => reject(Object.assign(Error('custody:cancelled'), {kind: 'cancelled'}));
      signal.addEventListener('abort', abort, {once: true});
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
/** API request capability is credentialed; storage fetch is always credential-free. */
export function artifactArchiveTransport({api, fetch: storage = globalThis.fetch} = {}) {
  if (typeof api !== 'function' || typeof storage !== 'function') fail('capability');
  return async ({endpoint, signal, maxBytes}) => {
    if (signal.aborted) fail('cancelled');
    const first = await bounded(api({method: 'GET', endpoint, signal, redirect: 'manual',
      headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': githubApiVersion}}), signal);
    if (first.status !== 302) return {status: first.status, headers: first.headers};
    let url = first.headers?.location ?? first.headers?.get?.('location');
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password || u.hash) fail('redirect');
      const r = await bounded(storage(u.href, {method: 'GET', redirect: 'manual', credentials: 'omit', headers: {}, signal}), signal);
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        url = new URL(r.headers.get('location'), u).href; await r.body?.cancel(); continue;
      }
      if (r.status !== 200) return {status: r.status, headers: {}};
      const reader = r.body?.getReader();
      if (!reader) fail('incomplete');
      const chunks = []; let size = 0;
      try {
        while (true) {
          const {done, value} = await bounded(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) fail('limit');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const declared = r.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== size)) fail('incomplete');
      return {status: 200, headers: {}, bytes: Buffer.concat(chunks)};
    }
    fail('redirect');
  };
}
/** All capabilities/expectations come from trusted Core, never from the artifact. */
export function createArtifactCustody({provider, archive, now = Date.now, maxBytes = 16 * 1024 * 1024,
  maxFiles = 256, timeoutMs = 30000} = {}) {
  if (!provider?.request || !provider?.collection || typeof archive !== 'function'
      || ![maxBytes, maxFiles, timeoutMs].every(n => Number.isSafeInteger(n) && n > 0)) fail('configuration');
  async function retrieve({ref, expected, evidence = {}, signal: caller}) {
    const diagnostic = {operation: 'custody_read', correlation: 'artifact', kind: 'unknown'};
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(caller ? [caller] : [])]);
    try {
      reference(ref); context(expected);
      ref = clone(ref); expected = clone(expected); evidence = clone(evidence);
      if (Object.hasOwn(stageApplicability, expected.stage) && !Object.hasOwn(evidence, 'stage.json')) fail('expected_evidence');
      if (ref.repository !== expected.repository || ref.repositoryId !== expected.repositoryId || ref.runId !== expected.runId) fail('source');
      const root = `/repos/${ref.repository}/actions`, options = {operation: 'custody_read', correlation: ref.artifactId, target: ref.repositoryId, signal};
      Object.assign(diagnostic, {correlation: ref.artifactId});
      const request = async endpoint => {
        const r = await bounded(provider.request({...options, endpoint}), signal);
        if (r.outcome !== 'read') { Object.assign(diagnostic, publicDiagnostic(r).diagnostic); fail(diagnostic.kind); }
        return r.data;
      };
      const repo = await request(`/repos/${ref.repository}`);
      if (repo.id !== ref.repositoryId || repo.full_name?.toLowerCase() !== ref.repository || repo.private !== false) fail('source');
      // Guard every pagination request against a Link escaping the authorized source.
      let total;
      const listPath = `${root}/runs/${ref.runId}/artifacts`;
      const listing = await bounded(provider.collection({...options, endpoint: `${listPath}?per_page=100`, envelope: 'artifacts',
        allowPage: p => p.split('?')[0] === listPath, validate: d => {
          if (!Number.isSafeInteger(d?.total_count) || d.total_count < 0 || total !== undefined && total !== d.total_count) return false;
          total = d.total_count; return true;
        }}), signal);
      if (listing.outcome !== 'complete') { Object.assign(diagnostic, publicDiagnostic(listing).diagnostic); fail(diagnostic.kind); }
      if (listing.data.length !== total || new Set(listing.data.map(a => a.id)).size !== total) fail('pagination');
      const matches = listing.data.filter(a => a.id === ref.artifactId);
      if (matches.length !== 1) fail('missing_or_ambiguous');
      const metadata = await request(`${root}/artifacts/${ref.artifactId}`);
      function check(m) {
        if (m.id !== ref.artifactId || m.workflow_run?.id !== ref.runId || m.workflow_run?.repository_id !== ref.repositoryId) fail('source');
        if (m.expired !== false || !Number.isFinite(Date.parse(m.expires_at)) || Date.parse(m.expires_at) <= now()) fail('expired');
        if (!Number.isSafeInteger(m.size_in_bytes) || m.size_in_bytes <= 0 || m.size_in_bytes > maxBytes) fail('limit');
        if (m.digest !== undefined && m.digest !== null && !/^sha256:[a-f0-9]{64}$/.test(m.digest)) fail('digest');
        if (ref.archiveDigest !== null && m.digest !== `sha256:${ref.archiveDigest}`) fail('digest');
      }
      check(matches[0]); check(metadata);
      if (!same(matches[0], metadata)) fail('metadata_changed');
      const downloaded = await bounded(archive({endpoint: `${root}/artifacts/${ref.artifactId}/zip`, signal, maxBytes}), signal);
      if (downloaded.status !== 200) {
        Object.assign(diagnostic, publicDiagnostic({diagnostic: {status: downloaded.status, requestId: downloaded.headers?.['x-github-request-id']}}).diagnostic);
        fail(({401: 'authentication', 403: 'denied', 404: 'not_found_or_inaccessible', 410: 'expired', 429: 'rate_limited'})[downloaded.status] ?? 'transport');
      }
      if (!(downloaded.bytes instanceof Uint8Array) || downloaded.bytes.length !== metadata.size_in_bytes) fail('incomplete');
      const digest = byteDigest(downloaded.bytes);
      if (metadata.digest && metadata.digest !== `sha256:${digest}` || ref.archiveDigest && ref.archiveDigest !== digest) fail('digest');
      check(metadata);
      const files = readCustodyZip(downloaded.bytes, {maxBytes, maxFiles});
      if (!files.has(manifestPath)) fail('missing');
      const manifest = JSON.parse(files.get(manifestPath).toString('utf8'));
      files.delete(manifestPath);
      validateCustodyManifest(manifest, expected, files);
      if (contentIdentity(manifest) !== ref.manifestIdentity) fail('manifest_identity');
      for (const [path, current] of Object.entries(evidence)) {
        if (!files.has(path)) fail('missing');
        const receipt = compareEvidence(JSON.parse(files.get(path).toString('utf8')), current);
        if (receipt.binding.repositoryId !== expected.repositoryId || receipt.binding.issueId !== expected.issueId
            || receipt.binding.scopeHash !== expected.scopeHash || receipt.binding.shapeHash !== expected.shapeHash
            || receipt.binding.grant !== expected.authorization || receipt.stage !== expected.stage
            || receipt.execution.result !== expected.result || receipt.execution.source?.runId !== expected.runId
            || receipt.execution.source?.attempt !== expected.attempt || receipt.execution.source?.repositoryId !== expected.repositoryId
            || expected.candidate && contentIdentity(receipt.inputs.candidate) !== expected.candidate.identity) fail('evidence_binding');
      }
      return {outcome: 'retrieved', ref: clone(ref), manifest, payloads: files};
    } catch (e) {
      diagnostic.kind = signal.aborted ? (caller?.aborted ? 'cancelled' : 'timeout') : e.kind ?? 'invalid_evidence';
      return publicDiagnostic({outcome: 'failed', diagnostic});
    }
  }
  return Object.freeze({retrieve});
}
/** Explicit host preflight; nothing is loaded or observed at module import. */
export async function actionsArtifactUpload({expected, environment = process.env, load = loadArtifactSDK}) {
  context(expected);
  const e = environment;
  if (e.GITHUB_ACTIONS !== 'true' || e.GITHUB_SERVER_URL !== 'https://github.com'
      || e.GITHUB_REPOSITORY?.toLowerCase() !== expected.repository || e.GITHUB_REPOSITORY_ID !== expected.repositoryId
      || e.GITHUB_RUN_ID !== expected.runId || e.GITHUB_RUN_ATTEMPT !== expected.attempt
      || typeof e.ACTIONS_RUNTIME_TOKEN !== 'string' || !e.ACTIONS_RUNTIME_TOKEN
      || typeof e.ACTIONS_RESULTS_URL !== 'string' || !/^https:\/\/[^/]+/.test(e.ACTIONS_RESULTS_URL)) fail('runtime');
  try {
    const loaded = await load();
    return {client: singleAttemptArtifactClient(loaded), runtime: {facility: '@actions/artifact@2.3.2', available: true,
      repository: expected.repository, repositoryId: expected.repositoryId, runId: expected.runId, attempt: expected.attempt}};
  } catch { fail('runtime'); }
}
/** Official @actions/artifact 2.3.2 client supplied by the trusted Actions host.
 * No implicit dependency, credential lookup or network operation at import time.
 * A failed/in-flight upload is never retried here; Core must reconcile it first.
 */
export async function publishCustody({manifest, payloads, expected, client, runtime, custody,
  name, retentionDays, evidence = {}, signal: caller, timeoutMs = 30000, maxBytes = 16 * 1024 * 1024}) {
  let root, started = false, ref, pending;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(caller ? [caller] : [])]);
  try {
    validateCustodyManifest(manifest, expected, payloads);
    manifest = clone(manifest); expected = clone(expected); evidence = clone(evidence);
    payloads = new Map([...payloads].map(([p, b]) => [p, Buffer.from(b)]));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || Buffer.byteLength(canonicalJSON(manifest))
        + [...payloads.values()].reduce((n, b) => n + b.length, 0) > maxBytes) fail('limit');
    if (signal.aborted) fail('cancelled');
    if (runtime?.facility !== '@actions/artifact@2.3.2' || runtime.repository !== expected.repository
        || runtime.repositoryId !== expected.repositoryId || runtime.runId !== expected.runId || runtime.attempt !== expected.attempt
        || runtime.available !== true || typeof client?.uploadArtifact !== 'function') fail('runtime');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) fail('configuration');
    root = await mkdtemp(join(tmpdir(), 'nibfin-custody-'));
    const files = new Map([...payloads, [manifestPath, Buffer.from(canonicalJSON(manifest))]]);
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(root, path)), {recursive: true});
      await writeFile(join(root, path), bytes, {flag: 'wx', mode: 0o600});
    }
    if (signal.aborted) fail('cancelled');
    started = true;
    pending = Promise.resolve().then(() => client.uploadArtifact(name, [...files.keys()].map(p => join(root, p)), root, {retentionDays, compressionLevel: 6}));
    const upload = await bounded(pending, signal);
    ref = bindCustodyPublication(manifest, upload);
    const readback = await custody.retrieve({ref, expected, evidence, signal});
    if (readback.outcome !== 'retrieved') return {outcome: 'unconfirmed', ref, diagnostic: readback.diagnostic};
    return {outcome: 'retained', ref};
  } catch (e) {
    return {outcome: started ? 'unconfirmed' : 'failed', ...(ref ? {ref} : {}), diagnostic: {kind: started ? 'publication_unknown' : e.kind ?? 'runtime'}};
  } finally {
    if (root) {
      const cleanup = () => rm(root, {recursive: true, force: true});
      // Toolkit has no abort API: preserve its files until the in-flight call settles.
      if (pending && signal.aborted) void pending.then(cleanup, cleanup).catch(() => {});
      else await cleanup();
    }
  }
}
