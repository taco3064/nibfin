import {createRequire} from 'node:module';
import {byteDigest} from './evidence.mjs';

// Pin the internal SDK composition: its public upload client hardcodes retries.
// No process-global monkey patches; each RPC client and blob client is single-shot.
export function loadArtifactSDK(require = createRequire(import.meta.url)) {
  const base = require.resolve('@actions/artifact/package.json');
  const sdk = createRequire(base), get = p => sdk(`./lib/internal/${p}`);
  return {version: sdk('./package.json').version,
    rpc: get('shared/artifact-twirp-client').internalArtifactTwirpClient,
    backend: get('shared/util').getBackendIdsFromToken,
    specification: get('upload/upload-zip-specification').getUploadZipSpecification,
    zip: get('upload/zip').createZipUploadStream,
    expiration: get('upload/retention').getExpiration,
    BlobClient: sdk('@azure/storage-blob').BlobClient};
}
export function singleAttemptArtifactClient(sdk) {
  if (sdk.version !== '2.3.2' || ['rpc', 'backend', 'specification', 'zip', 'expiration', 'BlobClient']
    .some(k => typeof sdk[k] !== 'function')) throw Error('custody:runtime');
  return {async uploadArtifact(name, files, root, options) {
    const ids = sdk.backend(), rpc = sdk.rpc({maxAttempts: 1});
    const created = await rpc.CreateArtifact({workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId, name, version: 4,
      expiresAt: sdk.expiration(options.retentionDays)});
    if (created.ok !== true) throw Error('custody:create');
    const stream = await sdk.zip(sdk.specification(files, root), options.compressionLevel);
    const chunks = []; let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw Error('custody:limit');
        chunks.push(chunk);
      }
    } finally { stream.destroy(); }
    const bytes = Buffer.concat(chunks), digest = byteDigest(bytes);
    // This bounded archive uses one Put Blob request, never a multi-block replay.
    const blob = new sdk.BlobClient(created.signedUploadUrl, undefined, {retryOptions: {maxTries: 1}}).getBlockBlobClient();
    await blob.uploadData(bytes, {maxSingleShotSize: 32 * 1024 * 1024, blobHTTPHeaders: {blobContentType: 'zip'}});
    const finalized = await rpc.FinalizeArtifact({workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId, name, size: String(size), hash: {value: `sha256:${digest}`}});
    if (finalized.ok !== true || !/^[1-9][0-9]*$/.test(finalized.artifactId)) throw Error('custody:finalize');
    return {id: finalized.artifactId, size, digest};
  }};
}
