# GitHub artifact evidence custody

This callable Core module retains bytes using GitHub Actions artifacts. A local file
or cache never authorizes continuation. Local transport tests and packaged consumer
round trips prove the module contract, not live cross-Run success. #121 owns live
single-Issue lifecycle retention/retrieval; #123 owns live independent-Run/Attempt
recovery and cross-repository handoff. Those suites have not run here.

## Public inputs and results

`prepareCustodyManifest(binding, payloads)` takes a Map of safe relative paths to
Uint8Array bytes. The version-1 manifest binds every payload's exact byte length
and SHA-256. It includes ignored Candidate artifacts supplied by the caller, comparing their
bytes to the independently expected Candidate payload digests.
`validateCustodyManifest(manifest, expected, payloads)` compares the entire binding
against independent current inputs and requires exact inventory correspondence.
Both throw sanitized `custody:*` errors on invalid input. Body hashes are existing
`bodyDigest(body)` values, hashing JSON.stringify(string); `contentIdentity` keeps
its existing versioned domain. Payload byte digests do not hash JSON strings.

A binding has exactly these fields (IDs remain canonical decimal strings):

```js
const expected = {
  repository: 'example-org/project', repositoryId: '42', issueId: 'I_101',
  cycle: 'requirements-1', scopeHash, shapeHash, authorization: grantIdentity,
  runId: '9007199254740993', attempt: '1', stage: 'candidate', result: 'result-1',
  candidate: {identity: contentIdentity(candidate), payloads: [{path: 'out/candidate.bin', digest: byteDigest(candidateBytes)}]}
};
```

`repository` is canonical lowercase coordinates. Personal and organization public
repositories use the same API. `authorization` identifies the authorization record;
it does not grant permission. `candidate` is null when inapplicable. `shapeHash`
can be null only for authorization or initial Shape evidence. Stages are existing
evidence stages plus `authorization` and `candidate`. Every existing evidence stage
requires a `stage.json` payload and independent `evidence['stage.json']` input to
retrieval: `{expected: envelope, consumed: resultIds}`. Existing `compareEvidence`
checks schemas, role, independence and replay; custody additionally checks source
Run/Attempt, repository/Issue, Scope/Shape, authorization, result and Candidate.
Other retained envelopes can be named explicitly in the same evidence map. Raw
Candidate/authorization bytes are custody data, requiring the existing Core
Candidate/authorization verification gates before use.

## Official publication facility and prerequisites

The trusted Actions host installs and locks **@actions/artifact 2.3.2** in its own
runtime. `actionsArtifactUpload` composes its official RPC/ZIP facilities with
the SDK-provided Azure client, returning the client consumed by `publishCustody`. This package
does not install or silently update that runtime dependency. The host must verify
its installed version, current GitHub.com Run/Attempt/repository identity and
availability of `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL` and required Actions
network access before supplying `runtime.available: true`. This is a trusted
capability observation, never a value obtained from Issue or artifact contents.
`actionsArtifactUpload({expected})` checks these environment inputs and the exact
installed SDK version, failing before publication if unavailable. The default
upload wrapper is deliberately unused: it hardcodes five RPC attempts. The pinned
internal RPC factory is configured with `maxAttempts:1`; bounded archive upload
uses one Put Blob through the real Azure pipeline with `maxTries:1`. No global SDK
patch is applied. Both CreateArtifact and FinalizeArtifact stop on truncated or
lost responses pending Core reconciliation. The official facilities retain CreateArtifact, blob transfer and FinalizeArtifact
facility, not a REST create-artifact endpoint. Importing Core does no credential
lookup or network I/O. A plain PAT/local gh login alone cannot provide upload
runtime capability. GHES, private product repositories and v1 artifacts are outside
this module's supported configuration.

```js
import {actionsArtifactUpload, prepareCustodyManifest, publishCustody, createArtifactCustody,
  artifactArchiveTransport} from '@nibfin/core';
const payloads = new Map([['out/candidate.bin', candidateBytes]]);
const manifest = prepareCustodyManifest(expected, payloads);
const archive = artifactArchiveTransport({api: trustedBinaryApi});
const custody = createArtifactCustody({provider: trustedGithubProvider, archive});
const upload = await actionsArtifactUpload({expected});
const result = await publishCustody({manifest, payloads, expected, custody, ...upload,
  name: 'issue-101-cycle-1-attempt-1', retentionDays: 7});
// result.outcome === 'retained' only after independent archive readback.
// Persist result.ref in the traceable source Run/handoff record through Core.
```

Publication stages immutable payload copies in private disposable storage. Upload
receives only explicit regular files and retention/compression options. Names must
be unique per attempt/cycle; no overwrite/delete/retry is performed. Exceptions,
missing/unsafe returned IDs or digest, cancellation and failed readback yield
`unconfirmed` after submission (possibly with a ref), never completion. Before
submission, invalid inputs/missing capabilities yield `failed`. The SDK returns
string IDs through the composed facility; unsafe numeric results from other
capabilities are rejected rather than rounded. REST IDs
and handoff string IDs retain their full precision. `bindCustodyPublication`
binds a valid SDK result to manifest/source and archive digest without self-hashes.

Upload defaults to a 30-second caller wait and 16-MiB total uncompressed input
limit. `signal`, `timeoutMs`, `maxBytes` can be supplied. The SDK has no abort API:
a timed-out upload may still finish. Files stay until it settles; Core must
reconcile the external operation before retry or host termination. No retry or
successful cancellation is inferred. The host must enforce process cleanup.

## Independent retrieval and read-only handoff

`createArtifactCustody({provider, archive, now, maxBytes, maxFiles, timeoutMs})`
requires trusted injected capabilities. Defaults are 16 MiB compressed **and**
uncompressed, 256 files and 30 seconds. Its `retrieve({ref, expected, evidence,
signal})` performs fresh source repository lookup, Run-scoped paginated listing,
exact-ID metadata lookup and binary download. A ref has exactly `repository`,
`repositoryId`, `runId`, `artifactId`, `manifestIdentity`, `archiveDigest`; the last
can be null for a source without an archive digest. Expected context is always
independent of retrieved data. Metadata's digest, when present, is still verified.
The Run list uses the `artifacts` envelope, checks total counts and duplicates,
and forbids pagination leaving its exact Run endpoint. No latest-name selection.

`trustedBinaryApi` accepts `{method, endpoint, headers, signal, redirect:'manual'}`
and returns `{status, headers}` with lowercase header keys. It authenticates only
the api.github.com request, returning the official 302 Location without following
it. The adapter follows HTTPS storage redirects with fresh empty headers,
`credentials:'omit'`, bounded streamed bytes and cancellation. Never forward API
authentication to storage. The general JSON provider is insufficient for this
binary contract. Read permissions are Actions:read on the source when required;
public artifact metadata may be public, but archive retrieval capability must be
supplied explicitly. Permission is rechecked by fresh provider outcomes.

A successful result is `{outcome:'retrieved',ref,manifest,payloads:Map}`. Archive
processing performs no filesystem writes. Only complete declared regular files
are returned; CRC, archive digest, sizes, manifest identity and payload identities
are checked independently. Missing/extra/duplicate files, symlinks, unsafe paths,
truncation, corruption and bombs reject. ZIP64, multi-disk, encrypted and unusual
ZIP compression formats reject explicitly; stored/deflated official ZIP streams
with data descriptors are supported within the configured bounds.

Failures return `{outcome:'failed',diagnostic}` and no payloads. Categories include
source/mismatch, missing_or_ambiguous, pagination, expired, authentication, denied,
not_found_or_inaccessible (404 does not prove deletion), rate_limited, transport,
timeout/cancelled, incomplete, digest, limit and invalid_evidence. Safe operation,
artifact correlation and available HTTP/request IDs are retained; provider bodies,
credentials and storage URLs are excluded. Passing a cache cannot change outcomes.
GitHub retention settings can shorten requested retention; artifacts may expire,
be deleted or become inaccessible. No permanent or tamper-proof custody is promised.

For #121, publish and retain the returned ref, then retrieve with independently
held expected inputs and compare the payload bytes. For #123, start a new Run
with a fresh custody instance and the traceable ref; it must recover the same
bytes. Expected Attempt `2` against Attempt `1`, an obsolete cycle, changed
Candidate or missing/expired evidence must fail. Cross-repository handoff uses the
explicit source ref and authorized read capability; every request remains GET on
that source. Publication is restricted to the actual owning Actions runtime.
No role success, authorization, independent Acceptance or completion follows from
artifact existence or custody success.

Routine `npm run check` uses narrow official-interface client doubles and requires
no artifact SDK download. The separately runnable actual-SDK regression is
`npm run test:artifact-sdk`; it requires a genuine host-installed @actions/artifact
2.3.2 runtime via NIBFIN_ARTIFACT_SDK_ROOT (directory containing node_modules).
Missing runtime fails explicitly in that suite. Core CI continues to provision
and run it. This separation does not remove or replace the production dependency,
its exact version check or actual SDK integration.

```sh
NIBFIN_ARTIFACT_SDK_ROOT=/path/to/approved-sdk-runtime npm run test:artifact-sdk
npm run check
npm run verify:archive
```

The SDK regression uses real generated RPC, ZIP and Azure serialization with HTTP
transport interception. Local boundary tests prove module contracts, not live
artifact transport. Do not claim the optional local SDK suite ran without its
actual runtime. Production hosts still need the pinned SDK and network access.

## Maintained protected-host integration

[Durable host custody](custody-host.md) composes this publisher/verifier with
provider-backed original-request discovery, retained role/verification/repair
inputs and independently bound current expectations. It documents restart and
unknown-publication behavior; existing artifact integrity rules remain mandatory.
