# Core package and bootstrap contract

The root `package.json` and `package-lock.json` belong exclusively to Core.
The local package is `@nibfin/core` version `0.1.0`, ESM only, with one public
export: `@nibfin/core`. The sole runtime dependency is pinned `jose@6.2.13`. There are no install scripts,
credential reads, network lookups or execution on import. The package is private
to prevent accidental registry publication; no license grant is asserted.

## Public identity API

```js
import { githubId, repositoryCoordinates, memberRunnerLabel } from '@nibfin/core';
githubId('9007199254740993'); // exact string, never converted to Number
repositoryCoordinates('Example-Org', 'Core');
// { owner: 'example-org', repository: 'core', key: 'example-org/core' }
memberRunnerLabel('42'); // 'nibfin-user-42'
```

`githubId(value)` validates repository, user or runner database IDs. The caller
retains the semantic ID kind. Only strings matching `[1-9][0-9]*` are accepted.
Zero, leading zeros, signs, fractions, whitespace, nondecimal text and numbers
throw `TypeError`; IDs beyond JavaScript's safe integer range remain exact.

`repositoryCoordinates(owner, repository)` takes two separate strings, never a
URL or combined path. Owner syntax is 1–39 ASCII letters/digits/hyphens, with
alphanumeric ends and no consecutive hyphens. Repository syntax is 1–100 ASCII
letters/digits/underscores/dots/hyphens, excluding `.` and `..`. Both are
lowercased for deterministic comparison; the returned object has `owner`,
`repository` and `key`. Missing components, slashes, backslashes, control
characters and traversal paths throw `TypeError`. No trimming or URL parsing
occurs. Personal and organization owners follow identical syntax. Syntactic
validation does not prove a repository exists or establish ownership.

`memberRunnerLabel(userId)` validates the same decimal ID contract and returns
`nibfin-user-<ID>`. A routing label is distinct from a stable ID and from repository
coordinates. Labels prove neither registration nor identity nor authorization.
These helpers do not check permissions or implement Runner selection/scheduling.

## Reproduce installation and archive verification

Prerequisites: Node.js 22.x, npm 10.x and a writable OS temporary directory outside
the checkout. Commands run from the root, with website/ absent or present:

```sh
npm ci --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund
npm run check
npm run verify:archive
```

The separately runnable `npm run test:artifact-sdk` custody SDK regression requires the isolated test
runtime described in [custody.md](custody.md), exposed through
`NIBFIN_ARTIFACT_SDK_ROOT`. Locked installation fetches JOSE from the registry;
`npm ci --offline` is supported after provisioning its integrity-checked cache.
Archive packing and installed-consumer checks remain offline. `check` discovers only `test/*.test.mjs`.
It tests public imports, malformed inputs, real archive rejection, byte
correspondence and disposable website coexistence. `verify:archive` uses offline
`npm pack`, normalizes the output to `out/nibfin-core.tgz`, reads the actual gzip/tar
payload and enforces the exact file allowlist in `tooling/archive.mjs`:
`package.json`, `README.md`, `docs/package.md`, `src/index.mjs`,
`src/grants.mjs`, `src/evidence.mjs`, `docs/evidence.md`, `src/provider.mjs`,
`src/obligations.mjs`, `src/authority.mjs`, `docs/authority.md`,
`src/custody.mjs`, `src/custody-upload.mjs`, `src/custody-zip.mjs`, `docs/custody.md`,
`src/authorization.mjs`, `docs/authorization.md`,
`src/lifecycle.mjs`, `docs/lifecycle.md`, `src/actions.mjs`.
Every entry is mandatory and must match the producer bytes. Unexpected entries,
duplicates, links, unsupported tar types, bad checksums and absent runtime files
fail. Tests, tooling, controls, secrets, donor material, prototype commands,
website output/dependencies and producer node_modules are excluded.
Regenerate the archive after changing any packaged file. Archive output used by
these checks is disposable; required non-tree Candidate deliverables are governed
by the current Issue Shape inventory. No build transformation is required.

The same command installs that exact archive into a fresh external temporary
consumer using `npm install --offline --ignore-scripts --no-audit --no-fund`
with the Core archive and a local package of the installed pinned JOSE dependency.
It passes a minimal environment without inherited credentials, imports by package
name, verifies the installed resolution, checks success and rejection, and removes
consumer state on success or failure. npm offline mode prevents registry fetching;
the smoke program uses Node built-ins, this package and its pinned JOSE dependency. Core executes any
required hooks in its separate credential-free, network-disabled environment;
this baseline introduces no hook manager.

A manual local consumer example (run after archive verification, with the JOSE
registry tarball already cached; use the registry if its cache is absent):

```sh
archive="$PWD/out/nibfin-core.tgz"
consumer=$(mktemp -d)
(
  trap 'rm -rf "$consumer"' EXIT
  cd "$consumer"
  printf '{"private":true,"type":"module"}\n' > package.json
  npm install --offline --ignore-scripts --no-audit --no-fund "$archive"
  node --input-type=module -e "import {githubId} from '@nibfin/core'; console.log(githubId('42'))"
)
```

## Ownership and downstream handoff

Root tooling does not aggregate a workspace or install/govern website dependencies.
Future website work owns `website/package.json`, its separate lockfile and local
configuration. `.github/workflows/core-ci.yml` checks the root package on relevant
PRs and main pushes using GitHub-hosted runners and read-only contents permission.
The separately owned `website-ci.yml` handles website checks/deployment; this
baseline does not create it. Root ignore rules cover only root generated output
and node_modules. The coexistence fixture includes failing website tests and
uninstallable website dependencies to detect accidental coupling.

Future nibfin-action and gh-nibfin consumers use this reviewed package boundary
and public entry instead of copying Core or importing checkout-relative modules.
This Issue writes neither repository. The archive is a local integration contract;
formal immutable release identities, compatibility metadata, official Action/CLI
installation, upgrades and publication remain later work. A future consumer must
verify its approved immutable version/content and compatibility before execution;
floating latest must not silently replace an authorized runtime. No private donor
repository is an installation or runtime dependency.

## Grant API v1

The public entry also exports `bodyDigest`, `canonicalJSON`, `prepareGrant`,
`signGrant` and `verifyGrant`. These are synchronous, local Node-crypto APIs.
Preparation/import performs no provider operation, credential discovery or signing.
No function reads environment login state, local keys or tokens. Callers pass
explicit observations and approved policy; newly discovered Issues are never
implicitly included. This is a bounded predicate library, not a delivery engine.

`prepareGrant(payload)` returns `{draft, summary}` with an independent JSON copy
and a readable work/powers/policy summary headed DRAFT ONLY. Neither result grants
execution permission. The Owner must review the exact payload and separately
invoke `signGrant(approvedPayload, {keyId, privateKey})`. The latter returns a
JSON-serializable `{version:1, algorithm:'Ed25519', keyId, payload, signature}`.
The key must be an Ed25519 PKCS#8 PEM private key supplied by trusted calling code;
returned values never contain that key. Preparation/signing throw `TypeError`
with a fixed category on invalid inputs; do not log raw caller inputs or keys.

Required payload schema (all named fields required; no additional fields):

- `version`: integer 1; `recordId`, `revision`, `revocationId`: explicit nonempty,
  control-free, wildcard-free strings. The caller assigns a unique record and
  revision and maintains their revocation association.
- `validFrom`, `expiresAt`: safe integer epoch milliseconds, with validFrom strictly
  less than expiresAt. Authorization is inclusive at validFrom, exclusive at
  expiresAt. Time is always injected, never read from the host clock.
- `authority`: snapshot, described below.
- `work`: nonempty ordered array of work records. Each contains `repository`,
  `issueId` (stable GitHub node ID string), `number` (canonical positive decimal
  string), `scope`, `currentBody`, `shape` and `observation`. All except repository,
  issueId and number are snapshots; shape may instead be null. Duplicate Issue
  identities, repository/number pairs and conflicting repository identities fail.
- `permissions`: nonempty array of `{repository, paths, operations}`, one entry
  per work repository. Each paths/operations array is explicit, nonempty and
  duplicate-free. No wildcard or implicit root access is supported.
- `policy`: `{core, runtime, agent, skills, ci, merge, maxParallel}`. The first
  three are caller-approved immutable content identity strings. `skills` has
  exactly `shape`, `deliver`, `accept`; each value is
  `{identity, mode, instructions}` where identity equals the property name, mode
  is default/extend/override and instructions is the complete approved snapshot.
  `ci` is `{requiredChecks, trustedAppIds, workflow}` with nonempty unique arrays
  of names and canonical decimal App IDs, plus the approved workflow snapshot.
  `merge` is `{baseBranch, method, protected}` with method merge/squash/rebase and
  protected exactly true. maxParallel is a positive safe integer. These fields
  bind policy; this library does not execute or prove CI/protection/parallelism.

A repository is exactly `{id, name, visibility}`: canonical decimal ID string,
lowercase `owner/repository` coordinates and visibility exactly public. Personal
and organization public owners use identical predicates; ownership never selects
Runner registration level or enables automatic registration. Private targets fail.
A snapshot is exactly `{source, revision, body, hash}`: nonempty source/revision
strings, exact body string and `bodyDigest(body)`. Use approved immutable source
locators and revisions. Hashing arbitrary Issue prose does not establish product
authority, approval or truthful GitHub observations. The caller supplies approved
Proposal snapshots independently of untrusted Issue content. The Grant API has
no hidden Notion fetch or provider verification. The explicit approved-export
interface and pure synchronization transition are specified in
[authority.md](authority.md); they reuse these full signed snapshots.

`scope` always preserves the frozen original body and hash. `currentBody` records
an independent Issue-body observation; `shape` records an independently published
Shape and source, or null before publication. A later signed snapshot can preserve
scope while recording currentBody/shape separately. A Shape identity never
replaces Scope or approves a requirement change. `observation` preserves the
source/revision and exact serialized read evidence chosen by the trusted caller.
The library validates integrity and compares independent expectations; it does not
certify that supplied read evidence came from GitHub.

`bodyDigest(string)` is lowercase SHA-256 over UTF-8 `JSON.stringify(string)`.
For `Hello\n世界` (one actual newline), the fixed vector is
`e25356b0e259cd559cbbe5495f10b8eb613890dd47e20afbb9d2a105c3531bf7`.
It is not SHA-256 of the raw body bytes. `canonicalJSON(value)` sorts object keys
lexicographically, preserves array order and uses JSON string/number encodings.
It rejects undefined, symbols, functions, bigint, nonfinite numbers, negative zero,
cycles, non-plain objects, accessors, sparse arrays and hidden/extra array fields.
Inputs must be ordinary JSON data, not executable objects/proxies. Signing bytes
are UTF-8 of `nibfin-grant-v1\n` followed by canonicalJSON of
`{keyId, payload}`. Signatures are standard Ed25519, encoded as canonical base64
of 64 bytes. Both envelope version/algorithm and payload version are fixed at v1;
unknown versions/algorithms fail closed. Every payload field and key selector is
signed. No untrusted embedded public key establishes trust.

`verifyGrant(grant, context)` returns only `{ok:true, category:'authorized'}` or
`{ok:false, category}`; errors never echo input/key material. Required context:

- `trustedKeys`: independently configured Map from keyId to Ed25519 SPKI PEM
  public key. Keys embedded in an untrusted grant are not consumed.
- `now`: current safe integer epoch milliseconds.
- `revocation`: `{id, available:true, revokedRecords:[recordId, ...]}` from the
  current trusted revocation source; id must equal the bound revocationId.
  Missing/unavailable/malformed data or a revoked record fails. The caller is
  responsible for freshness at each checkpoint; no instant revocation is promised.
- `expectedAuthority`, `expectedPolicy`, `expectedWork`: complete independently
  observed/approved payload counterparts, compared using canonicalJSON, including
  all original Scope, current body, published Shape and source identities. Array
  order is significant. A valid signature cannot override a mismatch.
- `request`: `{repository, issueId, number, path, operation}` for one concrete
  operation. Extra routing/registration claims have no effect. Stable identities
  must match signed work and permissions. All context inputs are mandatory.

Paths are lexical relative component sequences of ASCII letters, digits, dot,
underscore and hyphen. Empty paths, absolute/drive paths, backslashes, empty
components, `.`/`..`, control characters and wildcards fail. Permission for `src`
authorizes `src` and `src/file`, never `src-other`. Paths are case-sensitive;
filesystem symlink resolution and platform alias safety remain the caller's
separate Candidate gate. Operations must exactly match a signed listed string.
Missing permissions do not default to broad access. Failure categories include
signature/trust, version, time, revocation, authority, policy, work, membership,
operation, path, visibility and malformed/schema categories.

Safe calling sequence in trusted application code:

```js
const {draft, summary} = prepareGrant(explicitApprovedInputs);
// Present summary and exact draft for explicit Owner review; preparation stops here.
const grant = signGrant(ownerApprovedPayload, {keyId, privateKey});
// At each checkpoint, independently obtain fresh observations and trusted keys.
const result = verifyGrant(JSON.parse(JSON.stringify(grant)), currentContext);
if (!result.ok) throw new Error(`Grant rejected: ${result.category}`);
// Still require live Member/Assignee/Runner eligibility, native dependencies,
// independent Shape/Accept, Candidate/Hooks, exact-head CI and protected merge.
```

There is no automatic signing callback or implicit provider write. Do not pass
private keys or credentials in payload/provenance fields. The result is not an
Owner approval UI, Runner qualification, evidence receipt or permission to skip
any subsequent Core gate. Package handoff uses the byte-verified archive and
public entry only; consumers must retain independent trusted keys and policy.
The offline archive consumer generates real ephemeral Ed25519 keys, prepares two
Issue records, serializes/signs/verifies a Grant and rejects an expanded operation.
No real provider, Runner or model E2E is claimed by these local checks.

## Authenticated GitHub provider

`createGithubProvider`, `localGhTransport`, `parseGithubJson`, `publicDiagnostic`
and `githubApiVersion` are exported from the same inert entry. The maintained
provider supports JSON REST on `https://api.github.com`, API `2022-11-28`, with
`application/vnd.github+json`. Enterprise hosts, binary transfers, GraphQL,
encoded endpoints and arbitrary headers are unsupported. No platform or live
provider certification follows from fixture tests. Endpoint paths begin with `/`
and use ASCII letters, digits, `_/?=&.-`; placeholders, percent escapes,
traversal, fragments, userinfo and external URLs are rejected. Personal and Org
repository coordinates use identical paths; database IDs and node IDs are distinct.

```js
import {createGithubProvider, publicDiagnostic} from '@nibfin/core';
// The application owns this callback and the identity-bound approved context.
const provider = createGithubProvider({authorize: request =>
  approvedContexts.has(request.context) && policyAllows(request)});
const request = {endpoint:'/repos/example/core/issues/1', operation:'close',
  correlation:'attempt-1', target:'42'};
const submission = await provider.request({...request, method:'PATCH',
  context: approvedContext, body:{state:'closed'}});
const completion = await provider.reconcile(submission, request,
  data => data.state === 'closed' && observationIsCurrent(data));
console.log(publicDiagnostic(completion));
```

`target` is the canonical decimal stable target ID, never the issue number.
`operation` and `correlation` are trusted, public-safe labels (1–80 ASCII
letters/digits/underscore/hyphen); do not put private material in these labels.
The trusted `authorize` callback receives a frozen `{method, endpoint, target,
operation, context}`. It must bind every field to current authority; `context`
is an opaque application capability, not a provider or Agent payload. Without
this callback returning exactly true, mutations send no requests. The adapter
cannot establish Grants, permissions, dependencies or lifecycle eligibility.

`request` defaults to GET and accepts POST/PUT/PATCH/DELETE, JSON `body`, optional
AbortSignal `signal`, `expectedId` for singular resources and a trusted
`validate(data)` predicate for endpoint-required identities and schemas. Singular
resource consumers must supply `expectedId` and validate all relevant nested
identities; endpoints without singular IDs use an explicit schema predicate.
IDs present as `id` or `*_id` (except `node_id`) are converted to canonical
strings, with invalid forms rejected; numeric identity spellings are recovered from Node 22's JSON reviver source
without rounding; fractional/exponent ID spellings fail. Array order remains unchanged. Missing identities must be
required by the endpoint schema, never guessed from coordinates.

Results distinguish `read`, `submitted`, `unknown` and `failed`; no HTTP response
alone is `verified`. Trusted `data`, `link` and `observedAt` are separate from
safe `diagnostic`. Status categories are authentication, denied,
not_found_or_inaccessible, invalid_request, rate_limited, malformed, transport,
server, unsupported, unauthorized, cancelled and timeout. Runner-list diagnostics
identify `administration:read`; other capability requirements explicitly remain
unknown. None requests broader credentials or probes with writes. Only publish
`publicDiagnostic(result)`, which drops trusted response data and links.

`collection({...request, envelope:'runners'})` supports collection envelopes;
omit `envelope` for arrays. Every item must have a canonical database `id`.
`validate` applies to each complete page before envelope extraction. Actual Link
`rel="next"` controls traversal; all links must parse, and next destinations must
remain on the API origin. It returns `complete` with ordered data only after the
last page; any failure, cycle or limit returns `incomplete` without partial data.
Pagination is not an atomic snapshot. Defaults: 100 pages (configurable 1–1000),
3 attempts per safe read (1–10), 30 seconds total request/collection time.
Backoff starts at one second, doubles to eight seconds; provider Retry-After and
primary reset delays are honored even when larger. Secondary limiting without
explicit timing waits at least 60 seconds with exponential increases. Insufficient
remaining time returns failure/wait timing without an early retry. Only GETs
retry transport/server/rate failures; denials and malformed data never loop.
Cancellation interrupts both requests and delays. `now` and `delay(ms, signal)`
are trusted test seams; production uses the wall clock and abortable timers.

Writes submit once, without retries. Loss, timeout, malformed success or server
error remains `unknown`; successful submission (including 202) stays `submitted`.
Both unknown and submitted result objects carry an internal reconciliation binding.
`reconcile(originalResult, readOptions, matches)` performs a separate GET, requires
the same target, a matching returned `id`, and a true caller-owned final-state
predicate. That predicate must also reject stale revisions/observations using the
endpoint's actual semantics. Failed, contradictory or inconclusive reads remain
unknown; reconciliation never replays a write. Dispatch acceptance cannot prove
workflow completion. Reconciliation bindings are process-local, not durable
Write Intents; Core owns persisted reconciliation/manual handling after restart.

The local transport invokes the actual account's stored-login `gh` with a minimal
environment, outside the checkout, using argument vectors and stdin JSON. It
checks `gh auth status --hostname github.com` without exposing its output. No
login or token extraction occurs. Only PATH, account HOME and fixed noninteractive/
no-update/color flags pass through: inherited GH_TOKEN/GITHUB_TOKEN, enterprise
tokens, host/repo/config overrides, proxy and debug variables are excluded.
The request uses an absolute API URL to avoid gh repository/API-host defaults.
Use a trusted GitHub CLI 2.65+ executable supporting `auth status`, `api --include`,
`--hostname`, `--method`, headers and `--input -`; `executable` overrides are trusted
configuration, never repository input. The process-account home, PATH, gh config,
OS credential store and installed executable remain administrator trust premises.
CLI-native official redirects/authentication semantics remain those of that
trusted gh version; this adapter does not implement another credential transport.
Responses over 8 MiB fail explicitly. Missing executable/login/nonzero exits,
HTTP failures and truncated output are reported without subprocess output.
Hosted execution must explicitly inject a trusted transport and set
`identity:'hosted-authorized'`; it supplies its separately authorized identity,
raw `{status, headers, body}` and must honor cancellation, origin confinement,
no write retries and secret-free errors. It never requires member local login.

Fake process tests need a writable executable filesystem for temporary scripts
in the test working directory (OS temporary directories may be mounted noexec).
They use no installed gh credentials or network. External archive consumers still
run outside the producer checkout with offline installation.

## Candidate obligation API v1

The public entry exports `parseCandidateObligations(body)`,
`reconcileCandidateObligations(parsed, evidence)`, `validateHookObservation(observation)`,
`validateCandidateFiles(inventory, {root, permittedPaths})`, `safeObligationPath(path)`,
`hookEvents` and `hookConfigurationAreas`. Results have `ok` and `diagnostics`:
structured `{code, path, reason}` entries. Parsing also returns `inventory` and
`explanations` once JSON is readable. Never use a failed result to qualify work.
These APIs neither authorize execution nor execute hook scripts or produce receipts.

An executable inventory opens on an unindented line of three or more backticks
or tildes followed by exactly `kairo-candidate` (surrounding whitespace allowed).
It closes with the same character and at least the opening length, whitespace only
following. Other fenced regions (including fences indented up to three spaces)
are opaque: an inventory inside an illustrative outer fence does not count.
Indented code and blockquoted inventories do not qualify. Exactly one complete
executable inventory is required; unterminated inventories reject.

The JSON object has exactly `artifacts` and `hooks` arrays. Entries have exactly
`{path, purpose}` or `{path, event}` respectively. Purposes must be nonblank strings.
Paths are canonical relative POSIX file paths without controls, backslashes,
drive prefixes, empty components, `.` or `..`. Each array forbids duplicate paths;
a source can independently be both an artifact and a hook. No existence check
occurs while parsing: future ignored build output can be declared before generation.

Each empty array requires a distinct prose line outside fences:

```text
Candidate artifacts applicability: Scope requires no extra artifacts.
Candidate hooks applicability: Complete configuration review found no applicable hooks.
```

For compatibility with existing published Shapes, the explicit prose sentence
`Hooks is empty because <nonblank reason>` (or `Artifacts is empty because ...`)
is also recognized outside fences. Repeated canonical explanation lines reject
empty applicability. Author prose alone never proves hook absence.

```js
const parsed = parseCandidateObligations(shapeBody);
const checked = reconcileCandidateObligations(parsed, {
  scopeEvidenceReference: 'frozen-scope:revision-and-identity',
  requiredArtifacts: [{path:'out/core.tgz', purpose:'Distribution',
    evidenceReference:'scope:required-distribution'}],
  hookObservation: trustedObservation
});
// Later, after generating every required output:
const candidate = validateCandidateFiles(parsed.inventory, {
  root: approvedRepositoryRoot, permittedPaths:['out', '.githooks']
});
```

The independent trusted caller translates frozen Scope into the complete
`requiredArtifacts` list, including approved applicability for every declaration;
it supplies evidence references and nonblank purposes. Missing or extra declarations
block. Purposes may differ in wording; the independent caller reviews their semantics.
An empty list still requires a Scope evidence reference. The API cannot certify
that references are authentic, complete or current, or interpret arbitrary Scope prose.
Callers must independently establish provenance, identity and freshness.

The observation adapter accepts `{areas, hooks}`. Each area is exactly one record
with `area`, `status:'resolved'`, nonblank `detail` and `evidenceReference`.
All six areas exported in `hookConfigurationAreas` are mandatory, including
explicit absence findings. Build observations from repository configuration and
trusted effective configuration as follows; a partial directory scan is insufficient:

- `effective-git`: caller-provided effective Git settings and origins, including
  `core.hooksPath` and signing settings. Do not read hidden controller metadata.
- `hook-directories`: full relevant tracked hook inventory, applicable default
  hooks and every configured hooksPath target, including chained sources.
- `repository-setup`: repository-managed Git configuration/setup scripts, their
  effective paths and source order; dynamic or unresolved setup blocks.
- `package-lifecycle`: root package scripts and lifecycle installation/setup effects.
- `husky`: Husky setup, configured source paths and chained event handlers, or
  explicit absence. A package name alone does not prove effective applicability.
- `workspaces`: every workspace manifest and hook manager configuration, chained
  handlers and their effective ordering, or explicit absence of workspaces.

Each applicable source becomes a hook record `{path, event, applicability,
evidenceReference, prerequisites}`. Hooks must exactly match the inventory in
source order within events and in event order `pre-commit`, `prepare-commit-msg`,
`commit-msg`. Wrapper/chained sources must be accounted for; do not discard a hook
because its prerequisite is unavailable. Pre-commit has no message arguments;
prepare-commit-msg uses the applicable message-file/source/commit inputs;
commit-msg uses the message-file input. The future executor must preserve these
semantics; this API describes obligations only.

`prerequisites` is an explicit array of `{name, status, evidenceReference}`.
Only `available-offline-credential-free` passes. Missing tools, required installation,
signing, credentials, network or external effects must be named and reported as
`unresolved` or `unsupported`; neither status passes. This is trusted caller
assessment, never permission supplied by repository text. Configuration too dynamic
to resolve must keep the corresponding area unresolved and block qualification.
No built-in scanner claims to statically understand arbitrary shell or hook managers.

For example, no hooks requires all six absence/configuration observations and
`hooks:[]`. A Husky prepare script plus workspace handlers requires observations
of both setup sources and the effective ordered hooks; without effective Git
configuration evidence `configuration` diagnostics block even if the array is empty.
An omitted configured source produces `hook-correspondence`; missing output
produces `file`; unsupported signing produces `prerequisite` naming signing.

Candidate file validation checks every declared artifact and hook as a regular
file, rejects symlinks in every component (including root ancestors), and enforces
explicit component-boundary permitted paths. It ignores tracking/ignore status:
required ignored output remains mandatory. Roots must be approved by the trusted
caller; platform alias handling and concurrent filesystem changes require Core's
isolated immutable capture gate. Local checks are observations, not snapshots.
Actual sandboxed hooks, two-stage execution, receipts, independent Accept and
lifecycle E2E remain Core responsibilities and are not claimed by these tests.

The versioned role/result/evidence/completion and compatibility API is specified in
[evidence.md](evidence.md). Its pure comparisons preserve authentication,
authorization and success as separate responsibilities. Both that document and
src/evidence.mjs are included in the exact archive boundary.

The public `createAuthorizationBoundary` API composes fresh GitHub observations
with signed Grant verification. See [authorization checkpoints](authorization.md)
for trusted inputs, provider integration, freshness and failure semantics.

The public Agent environment and lifecycle contract is documented in `docs/lifecycle.md`; both it and `src/lifecycle.mjs` are included in the archive.

GitHub-backed artifact custody and the callable #121/#123 handoff are specified in
[custody.md](custody.md). Offline archive consumers also perform an injected
official-response publication/readback round trip, discard producer state and
reject a changed Attempt. Live GitHub artifact custody remains separately tested.

The Actions verification API is exported from `@nibfin/core`; `src/actions.mjs`
is included in the exact archive allowlist. Its sole runtime dependency is pinned
`jose@6.2.13` (also integrity-pinned in the lockfile). Archive verification rejects
other dependency declarations and compares every included source byte. The
credential-free disposable consumer installs the exact local JOSE package and
Core archive offline, imports the public API, performs actual synthetic JWT
verification and rejects invalid source and predecessor input. Dependency caches
belong to the supported build/test environment, not the offline hook contract.

Deployment verification, scoped health dispositions and the semantic final-proof
handoff are documented in [deployment.md](deployment.md). Live deployment and
Recovery integration belongs to #123.

## Runner observation API v1

`observeRunners(provider, input)` is an async read-only reconciliation API exported
from `@nibfin/core`. Pass a trusted `createGithubProvider` capability; imports and
input construction perform no authentication or I/O. Only GET requests are used.
The provider retains its own cancellation, bounded retry and safe error semantics.
Supported official schemas/endpoints are the GitHub
[Runner REST API](https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2026-03-10)
and [Runner Group REST API](https://docs.github.com/en/rest/actions/self-hosted-runner-groups?apiVersion=2026-03-10).
Repository inventories require Administration read; organization Runner and group
inventories require organization Self-hosted runners read and applicable official
administrative access. Missing permission is unavailable evidence, never offline.

```js
const result = await observeRunners(provider, {
  target: {owner:'example', repository:'core', id:'42', ownerId:'7',
    ownerType:'Organization'},
  registration: {level:'repository', id:'42'},
  records: [{instanceId:'local-1', runnerId:'91', memberId:'8', repositoryId:'42',
    platform:'linux', registration:{level:'repository', id:'42'}}],
  conditions: {labels:['self-hosted','linux','X64'], platform:'linux'},
  correlation:'attempt-1', signal:abortController.signal
});
```

All database IDs are canonical positive-decimal strings, including IDs larger
than JavaScript's safe-integer range. Target coordinates, ID, owner ID/type and
public visibility must agree with the current repository response. An Org-owned
public repository can use Repository Runners without organization administration.
For Organization Runners instead use
`registration:{level:'organization', organization:'example', id:'7'}` in both
the request and records. Each local organization coordinate is required, validated
and compared case-insensitively with the requested organization; a matching stable
ID cannot compensate for a missing or conflicting coordinate. This path verifies
the organization identity and all Runner/group/member inventories; selected-repository policies require their
repository inventories. `conditions.groupId` optionally requires one exact group.
Public access must be allowed. Workflow-restricted groups require trusted
`conditions.workflow`, an exact official selected-workflow identifier such as
`example/core/.github/workflows/build.yml@refs/heads/main`. No context yields
`workflow_unresolved`; a nonmatching identifier yields `workflow_denied`. This
API expects the caller to supply the actual workflow identity, never Issue prose.
Inherited or otherwise inaccessible group endpoints fail explicitly; they are
never assumed permissive. Unsupported host/enterprise configurations cannot match.

Records come from trusted Core local state, never provider Labels or Issue text.
Each requires a distinct instanceId and Runner ID, member ID, actual repository ID,
registration level/ID and platform (`linux`, `windows`, `macos`). Records are never
mutated. Several instances may share a member's canonical `nibfin-user-ID` Label.
A matching Label/name cannot repair an absent or replaced Runner ID. Contradictory
or duplicate local IDs/scopes fail; wrong/conflicting member Labels, missing IDs,
platform/required-Label mismatch and unmatched registrations carrying a known
member Label have separate diagnostic codes. Labels compare case-insensitively,
with all requested conditions applied together. Conflicting platform Labels fail.
Online idle, online busy and offline are independent observable states; a matched
offline registration remains offline. Matching registration is not availability
selection, member permission, dispatch or Owner authorization.

Results have `outcome` (`matched`, `mismatch`, `unavailable`, `unsupported`),
`inventory` and fixed-schema `diagnostics`. Complete inventories also return
normalized `runners` and per-record `instances` with outcome, diagnostics and any
matching `observation` (ID, name, lowercase Labels, platform, status, boolean busy).
An empty complete inventory produces missing-ID diagnostics for bound records;
empty records with empty inventories can match vacuously and confer no authority.
Unavailable results contain no partial instances/runners. Provider failures retain
safe categories in `diagnostics[].provider`; arbitrary error text, response fields
and secret-bearing local record fields are omitted. Treat normalized observations
as trusted operational data; public logging should use only the fixed diagnostics,
never entire provider responses or local records. correlation must be a public-safe
provider identifier, not a secret. Local secret fields do not enter the output.

Every inventory must finish, have a stable total_count and unique exact IDs.
Continuation is confined to the same endpoint/origin, page and per_page parameters;
malformed links, inconsistent counts, duplicate IDs, cycles and exhausted bounds
fail closed. `maxPages` defaults to 100 (1–1000) per collection; per-page reads use
the existing provider time budget. Pass an overall AbortSignal deadline when the
caller needs a whole-operation deadline across multiple collections. No cache is
used. Re-read at each applicable Core checkpoint: inventories across APIs are not
an atomic snapshot, and status/Labels/access may change after observation. The
API neither freezes membership nor proves identity from Labels; administrator and
host trust premises and all independent delivery/permission gates still apply.
Fixtures validate response contracts, not live registration, host-platform support,
routing, deployment or full-product completion. #121/#122 own live integration.

Local immutable Candidate capture and bounded transfer APIs are documented in
[workspace.md](workspace.md), shipped with the package. No hook manager or lifecycle
installation script is introduced by this module.

The public native Issue/approved Dispatch relay is documented in
[relay.md](relay.md). Its inert exports reuse Actions predecessor verification,
controlled dispatch, retained custody and current Core gates. Installed archive
consumers exercise the real adapter; these fixtures establish local contracts,
not live event delivery or stage success.

Protected Owner-side registration and encrypted response consumption are exported
through [registration.md](registration.md). Archive consumers run positive and
negative registration cases through the installed package. This proves a local
module contract; #122 retains actual protected-host/channel integration proof.

The archive also includes the pre-delivery Scope instructions, version 1 local
portfolio checker, template/reference (docs/scope.md) and examples/scope.json.
`scopeInstructions` and `checkPortfolio` are exported from @nibfin/core; Scope
is separate from protected Skill selection. Archive verification runs real
positive and rejection cases through a fresh installed consumer.

## Current branch policy and exact-head CI observations

`observeGithubCI({provider, expected, actions = [], maxPages = 50})` is exported
from the inert package entry. Supply a `createGithubProvider` instance; all reader
traffic uses GET. The reader is an observation capability, separate from
protected evidence creation, Owner authorization and Merge eligibility.

`expected` binds `repository` (`owner/name`), decimal-string `repositoryId` and
`prId`, positive integer `pr`, 40-character lowercase SHA-1 `head` and `baseSha`,
`baseRepositoryId`, and `baseBranch`. Public individual and organization owners
use the same contract. The target base must belong to that repository. Supported
branch spelling is ASCII letters, digits, `_`, `.`, `-`, `/`, without `..`;
unsupported inputs fail before requests. IDs are never converted to Numbers.

Each optional `actions` item supplies trusted `context`, decimal-string `appId`,
`sourceRepository`, `sourceRepositoryId`, immutable `revision`, Git `blob` SHA-1,
`path` (`.github/workflows/*.yml` or `.yaml`), `event`, decimal-string `runId`,
positive integer `attempt`, and `job` name. This bounded verifier supports local
workflow files executed from the exact head revision in the expected repository.
Reusable/cross-repository workflow sources require another verification
capability; they cannot silently satisfy a pin here. The caller selects trusted
requirements, never provider text. Source bytes are fetched through Contents at
that immutable revision and independently hashed using Git's blob header.

```js
import {createGithubProvider, observeGithubCI} from '@nibfin/core';
const observation = await observeGithubCI({
  provider: createGithubProvider(), // trusted process-account stored gh login
  expected: {
    repository: 'example-org/project', repositoryId: '42', prId: '43', pr: 7,
    head: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    baseRepositoryId: '42', baseBranch: 'main'
  }
}); // illustrative coordinates; no claim these provider resources exist
```

The result contains `qualifies`, `status`, `policy`, `evaluations`, `provenance`
and `checkpointOnly: true`. Invalid/unreadable observations also include a fixed
`reason`. Status is `satisfied`, `pending`, `failed`, `stale`, `unsupported` or
`unknown`. Every evaluation identifies its requirement, reason and selected
identity/conclusion evidence. Policy includes required contexts/App identities,
classic/ruleset provenance, `strict` latest-base requirements, non-CI
`limitations`, and an identity of the effective observed policy. Provenance
records requested endpoints, times and sanitized provider diagnostics. Raw check
output, URLs, provider error bodies and logs are not returned as diagnostics.
These observations are not authenticated Core CI receipts.

Classic checks and applicable active branch rules are combined. Explicit null
App/integration bindings mean unrestricted source. Legacy contexts without check
bindings remain required. Unrestricted competing Apps or duplicate check results
are unknown, rather than choosing a green result. Status histories use the latest
`created_at`; conflicting same-time results are unknown. Where both a status and
check share an unrestricted context, both must succeed under native policy.
A pinned App cannot be satisfied by an unassociated commit status. The Checks API
`filter=latest` supplies native latest check runs; unresolved duplicates fail
closed. Neutral/skipped conclusions satisfy native policy but cannot satisfy
pinned Actions actual-success requirements. Run, attempt, head, source content,
job and the job API's `check_run_url` association must all match a successful
execution. Job attempt provenance comes from the attempt-specific jobs endpoint
and the verified current run attempt, not a mandatory per-job `run_attempt`
field (absent from the documented response). Contradictory attempt metadata, if
supplied, is rejected. Details URLs, OIDC and logs supply no alternative success path.

Permissions follow the endpoints: repository metadata, Pull requests read,
Administration read for classic protection, Checks read, Commit statuses read,
Actions read and Contents read for pinned workflow bytes. Applicable branch
rules require Metadata read. See the official [protection API](https://docs.github.com/en/rest/branches/branch-protection),
[active branch rules API](https://docs.github.com/en/rest/repos/rules?apiVersion=2026-03-10),
[check runs API](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10),
[workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10)
and [jobs API](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2026-03-10).
The fixtures in `test/ci-fixture.mjs` cite these response contracts and document
synthetic substitutions; all tests use the actual provider's raw HTTP boundary.

A protection 404 is accepted as absent only with a fresh unprotected branch
observation and successful applicable-rules read. On protected branches it
remains unknown, including configurations with rulesets but no readable classic
protection. A readable classic protection with no required status checks allows
rulesets to supply the entire CI policy. Known non-CI rules are observable
limitations, never claims that every Merge gate is met; unknown rule types or
unknown status-check parameters prevent qualification.

Each collection follows same-endpoint pagination with fixed filters, page bounds
and count checks where the API supplies totals. Failed later pages, malformed
links, loops, truncation and exhausted bounds cannot qualify. The reader refreshes
PR/base/policy and each pinned run before returning success. Each invocation
reads afresh; cross-API atomicity, permanent approval and future success are not
guaranteed. Native strict/base requirements are reported for the protected Merge
consumer to enforce. Local fixture and installed archive tests verify this
reader; live protected-PR/CI integration and recovery belong to #121 and #123.

## Scope publication journal

`publicationManifest(manifest)` and `openPublicationJournal(options)` are exported
from `@nibfin/core`. The installed [journal contract](publication.md) specifies
explicit durable POSIX storage, exact plan/correlation binding, intent before
submission, independent readback and restart recovery. The journal has no
provider or authorization capability. `src/publication.mjs` and
`docs/publication.md` are mandatory archive entries; installed-consumer checks
run the retained publication/restart tests against the installed package.

The Linux/Codex backend is documented in [codex.md](codex.md). Its package includes
the fixed container entrypoint and explicit version/profile checks. Installed
consumer tests use credential-free controlled process fixtures; native support
remains Unverified pending #121's actual integration observations.

## Raw Scope publisher

`publishPortfolio(options)` composes the installed provider and durable journal.
The [publisher contract](publisher.md) defines authenticated full-plan approval,
protection/disclosure capabilities, exact raw Issue requests, native reciprocal
dependency reads and recovery/handoff schemas. Its retained composition tests
also run against a fresh installed archive. Local fixtures are not live GitHub
publication evidence; that observation remains owned by #124.

The public package also exports `createLinuxClaudeBackend` and `linuxClaudeProfile`;
see [Claude adapter](claude.md) for the explicit API-key selection, fixed CLI and
Linux prerequisites, process contract, and unrun native/model evidence.

See [workflow bundle v1](workflows.md) for `workflowInstallation`, shipped YAML/entry inventory, protected host capabilities and source/installed-consumer proof.

## PR-scoped staged CI

The `Core package` workflow keeps the required `core` check. On pull requests,
`tooling/ci-tests.mjs` compares the exact PR base/head merge-base diff, checks
changed module syntax, then runs changed suites and transitive module/fixture
consumers. Public barrel exports are mapped to their defining modules; namespace
and dynamic consumers are included conservatively. The Action summary lists the
selected suites and SDK/archive/website decisions. Invalid or unavailable Git
comparison fails the job; an empty diff uses full verification.

An unrelated root suite, the official artifact SDK test and installed-archive
verification need not run on an ordinary narrow PR. Recursive package-consumer
suites (`archive.test.mjs` and `release.test.mjs`) run for direct suite changes
or full gates; ordinary module changes defer that integration stage to main.
SDK consumers run when their
dependencies change. Website-only PRs need no root suite; core-only PRs retain a
successful `website` scope check without rebuilding the site. Documentation
changes also exercise the website. Both workflow names and completion wakeups
remain stable for Kairo and branch protection.

Shared package settings, the public barrel, host/skill/workflow assets, shared
tooling, removed suites/modules and unclassified or uncovered inputs select full
verification. This is deliberately conservative rather than a promise that every
PR is small. Main pushes and formal release verification retain the full root,
SDK and installed-consumer gates. Scoped PR success proves the selected tests for
that candidate; it does not replace live integration or release evidence.
