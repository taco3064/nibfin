# Core package and bootstrap contract

The root `package.json` and `package-lock.json` belong exclusively to Core.
The local package is `@nibfin/core` version `0.1.0`, ESM only, with one public
export: `@nibfin/core`. There are no runtime dependencies, install scripts,
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
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run check
npm run verify:archive
```

No registry installation is needed. `check` discovers only `test/*.test.mjs`.
It tests public imports, malformed inputs, real archive rejection, byte
correspondence and disposable website coexistence. `verify:archive` uses offline
`npm pack`, normalizes the output to `out/nibfin-core.tgz`, reads the actual gzip/tar
payload and enforces the exact file allowlist in `tooling/archive.mjs`:
`package.json`, `README.md`, `docs/package.md`, `src/index.mjs`, `src/grants.mjs`.
Every entry is mandatory and must match the producer bytes. Unexpected entries,
duplicates, links, unsupported tar types, bad checksums and absent runtime files
fail. Tests, tooling, controls, secrets, donor material, prototype commands,
website output/dependencies and producer node_modules are excluded.
Regenerate the archive after changing any packaged file; it is a mandatory
ignored candidate artifact, not a cache. No build transformation is required.

The same command installs that exact archive into a fresh external temporary
consumer using `npm install --offline --ignore-scripts --no-audit --no-fund`.
It passes a minimal environment without inherited credentials, imports by package
name, verifies the installed resolution, checks success and rejection, and removes
consumer state on success or failure. npm offline mode prevents registry fetching;
the smoke program uses only Node built-ins and this package. Core executes any
required hooks in its separate credential-free, network-disabled environment;
this baseline introduces no hook manager.

A manual local consumer example (run after archive verification):

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
Proposal snapshots independently of untrusted Issue content; there is no Notion
fetch/synchronization or provider verification hidden in this API.

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
