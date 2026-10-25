import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {actionsArtifactUpload, byteDigest} from '../src/index.mjs';
import {loadArtifactSDK} from '../src/custody-upload.mjs';
import {custodyFixture} from '../tooling/custody-fixture.mjs';

// Required test resource; never skip the actual SDK transport regression.
test('pinned official publication transport never replays ambiguous writes', async () => {
  assert.ok(process.env.NIBFIN_ARTIFACT_SDK_ROOT, 'Supply the installed @actions/artifact 2.3.2 test runtime (see docs/custody.md)');
  const require = createRequire(resolve(process.env.NIBFIN_ARTIFACT_SDK_ROOT, 'package.json'));
  const sdkRequire = createRequire(require.resolve('@actions/artifact/package.json'));
  const {HttpClient} = sdkRequire('@actions/http-client');
  const {createHttpHeaders} = sdkRequire('@azure/core-rest-pipeline');
  const {toHttpHeadersLike} = sdkRequire('@azure/core-http-compat');
  const core = sdkRequire('@actions/core'), logs = ['debug', 'info', 'warning', 'setSecret'];
  const previousLogs = logs.map(k => core[k]); logs.forEach(k => {core[k] = () => {};});
  const keys = ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL'], before = keys.map(k => process.env[k]);
  process.env.ACTIONS_RUNTIME_TOKEN = `a.${Buffer.from(JSON.stringify({scp: 'Actions.Results:run-backend:job-backend'})).toString('base64url')}.c`;
  process.env.ACTIONS_RESULTS_URL = 'https://results.example';
  const original = HttpClient.prototype.post;
  try {
    for (const failure of [null, 'CreateArtifact', 'FinalizeArtifact', 'blob', 'CreateTransport', 'FinalizeTransport']) {
      const f = custodyFixture(), counts = {CreateArtifact: 0, FinalizeArtifact: 0, blob: 0}; let uploaded;
      HttpClient.prototype.post = async function(url, text) {
        const method = url.split('/').at(-1), request = JSON.parse(text); counts[method]++;
        assert.equal(request.name, 'evidence-cycle-1-attempt-1');
        assert.equal(request.workflow_run_backend_id, 'run-backend');
        assert.equal(request.workflow_job_run_backend_id, 'job-backend');
        assert.equal(counts[method], 1, `replayed ${method}`);
        if (failure === method.replace('Artifact', 'Transport')) throw Error('response lost');
        const response = failure === method ? '{' : JSON.stringify(method === 'CreateArtifact'
          ? {ok: true, signed_upload_url: 'https://storage.blob.core.windows.net/container/evidence?sig=fixture'}
          : {ok: true, artifact_id: f.ref().artifactId});
        if (method === 'CreateArtifact') assert.equal(request.version, 4);
        else {
          assert.equal(request.hash, `sha256:${byteDigest(uploaded)}`);
          assert.equal(request.size, String(uploaded.length));
        }
        return {message: {statusCode: 200, headers: {}}, readBody: async () => response};
      };
      const sdk = loadArtifactSDK(require), BlobClient = sdk.BlobClient;
      // Real Azure pipeline and serialization, replacing only its HTTP transport.
      sdk.BlobClient = class extends BlobClient {
        constructor(url, credential, options) {
          assert.deepEqual(options.retryOptions, {maxTries: 1});
          super(url, credential, {...options, httpClient: {sendRequest: async request => {
            counts.blob++; assert.equal(counts.blob, 1); assert.equal(request.method, 'PUT');
            uploaded = Buffer.from(request.body); f.state.bytes = uploaded;
            return {request, status: failure === 'blob' ? 503 : 201, headers: toHttpHeadersLike(createHttpHeaders()), bodyAsText: ''};
          }}});
        }
      };
      const expected = f.expected, environment = {GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: expected.repository, GITHUB_REPOSITORY_ID: expected.repositoryId,
        GITHUB_RUN_ID: expected.runId, GITHUB_RUN_ATTEMPT: expected.attempt,
        ACTIONS_RUNTIME_TOKEN: process.env.ACTIONS_RUNTIME_TOKEN, ACTIONS_RESULTS_URL: process.env.ACTIONS_RESULTS_URL};
      const capability = await actionsArtifactUpload({expected, environment, load: () => sdk});
      const result = await f.publish(capability);
      assert.equal(result.outcome, failure ? 'unconfirmed' : 'retained', JSON.stringify(result));
      assert.deepEqual(counts, {CreateArtifact: 1,
        blob: failure?.startsWith('Create') ? 0 : 1,
        FinalizeArtifact: failure?.startsWith('Create') || failure === 'blob' ? 0 : 1});
      assert.doesNotMatch(JSON.stringify(result), /sig=|response lost|Actions.Results/);
    }
  } finally {
    HttpClient.prototype.post = original; logs.forEach((k, i) => {core[k] = previousLogs[i];});
    keys.forEach((k, i) => {if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i];});
  }
});
