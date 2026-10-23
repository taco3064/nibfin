# Registration exchange research, version 1

Status: experimental offline design, 2026-10-23. Not approved for production use.
The normative experimental owner is nibfin; future CLI commands belong to
gh-nibfin and Action packaging to nibfin-action. This adds no installed workflow,
production export, issuer, CLI command, hosted service or delivery state machine.
Existing stage invocation schemas remain unchanged and are not registration APIs.

## Evidence classes and coverage

L means locally demonstrated with synthetic trusted adapters; D means documented
provider behavior; U means unverified live behavior. L never establishes U.

| Obligation | Design below | Reproducible evidence | Class |
| --- | --- | --- | --- |
| REG-02, Owner opt-in and current membership | Identity and issuance boundary | Authorization denial table and issuance-time revalidation tests | L; provider endpoints D; live policy custody U |
| REG-03, confidential short-lived response | Construction and return channel | Positive exchange, wrong recipient, signature, context and AEAD rejection test | L; artifact retrieval U |
| REG-04, stable binding and replay | Request schema and replay lifecycle | Concurrent duplicates, cross-binding replay, skew and unknown-outcome tests | L; distributed replay store U |
| R-01 trigger, Owner environment and issuance rights | Provider facts and trust boundary | Public sources below; untrusted workflow/ref/source tests | D/L; protected live run U |
| R-01 expiration versus revocation | Lifecycle limits | Expired request, late response and reconciliation tests | L; live removal/revocation U |
| Core/CLI boundary, success/rejection requirements | Integration operations | Fixture and test paths below; installed consumer verification | L; future consumers U |
| BOOT-02 shared baseline | Reproduction | Existing root commands, no root configuration edits | L |
| English and disclosure-safe public information | Audit | README, docs, examples, instructions and workflow prose reviewed | L |

## Provider facts checked 2026-10-23

The following are documentation observations, not calls against a live repository.
Use REST API version 2026-03-10 and application/vnd.github+json when validating a
future integration. Errors, missing fields, denied reads and inconsistent IDs fail
closed; do not translate them into a permission or policy default.

- [Manual workflow execution](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow): workflow_dispatch needs a workflow in the default branch and repository Write access. Dispatch accepts a ref; therefore triggering alone cannot establish trusted execution. The proposed member trigger is workflow_dispatch with a fixed protected default-branch ref.
- [Runner endpoints](https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2026-03-10): POST /repos/{owner}/{repo}/actions/runners/registration-token requires repository administration; fine-grained credentials need Administration write. The 201 response contains token and expires_at; documented lifetime is one hour. Runner read-back needs Administration read. Organization issuance uses separate organization Self-hosted runners write authorization. These are not delegated by repository Write.
- [Workflow authentication](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token): grant minimal workflow permissions; use a suitable GitHub App when additional permissions are needed. Do not assume default GITHUB_TOKEN has Runner administration rights.
- [Collaborator permissions](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user): GET /repos/{owner}/{repo}/collaborators/{username}/permission supplies permission and user identity. Fine-grained access needs Metadata read. Interpret provider write/maintain/admin explicitly, reject read/triage/none and unknown/custom roles unless their effective Write capability is independently established by an approved integration.
- [Repository identity](https://docs.github.com/en/rest/repos/repos#get-a-repository): GET /repos/{owner}/{repo} supplies stable id; fine-grained private reads require Metadata read. Names alone are insufficient.
- [Authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user): GET /user identifies the local applicant under their own credential. Its result alone does not authenticate a later self-asserted request.
- [Artifact API](https://docs.github.com/en/rest/actions/artifacts): result retrieval uses artifact IDs and Actions read permission for fine-grained access; deletion needs Actions write. Treat download redirects and artifact bytes as untrusted until bound to the expected run and signature.

## Identity and issuance boundary

Future CLI generates a fresh X25519 key pair, random request ID and nonce (at least
128 random bits each), retaining the private key only locally. It authenticates
with its own local gh account and confirms /user. Only public request data enters
dispatch. No Owner PAT, Agent credential or member private key is transmitted.

The trusted Owner integration must obtain the original GitHub-authenticated
initiating actor ID and exact dispatch inputs from a protected, authenticated run
observation, bind them together and reject reruns attributed to a different actor.
It must compare the submitted user ID against that actor and the permission API's
user ID. A request digest and key fingerprint cover the exact received bytes, not
CLI claims. The fixture's observe callback MODELS this binding; it does not prove
GitHub supplies an adequate input attestation. A public key or key-possession
proof alone does not establish which applicant authorized its submission.

This is a mandatory live feasibility gate: demonstrate that a member cannot
replace another applicant's key or input/run binding, including reruns and
member-controlled refs. If the chosen GitHub path cannot provide authenticated
actor-to-input correlation, reject that design before production; do not silently
trust a workflow input named userId or add an unapproved hosted identity service.

The Owner installs and protects an exact workflow content revision on the default
branch. Trusted code and dependencies are fixed; no member ref or checkout code
runs in the privileged job. Treat workflow edits, public PRs, shell interpolation,
inputs, labels and response substitution as hostile. Parse bounded data directly;
do not evaluate it as shell. Do not pass Owner credentials into untrusted jobs,
Agent processes or artifacts. A narrowly installed short-lived App credential for
the target repository is the proposed issuer credential, held only inside the
protected Owner job. Signing keys are separately pinned by trusted installation;
a response cannot select its own trusted signer. Custody, rotation and protected
workflow enforcement remain U. No workflow is installed by this research.

Before each issuance the Owner independently reads stable repository/user IDs,
current permission and explicit Owner opt-in policy from protected configuration.
Default is disabled. No personal allowlist or per-request human approval exists.
The model reads twice, with the second read immediately before issuance; disable
or downgrade at that point prevents issuer invocation. A production integration
must not cache these successful reads. GitHub does not supply a demonstrated
transaction combining all reads and issuance: a residual permission/policy race
remains between the last check and POST. Bound that interval and validate it live;
do not promise instantaneous revocation or atomic provider authorization.

## Experimental wire schema and construction

All values below are research version 1, not released interoperability promises.
`experiments/registration-exchange.mjs` owns the model. `src/` exports are untouched.
Future compatibility changes require a new construction identifier and coordinated
Core/CLI tests; unknown constructions must fail closed.

Request fields are id, nonce, scope (repository only), userId, repositoryId,
publicKey (canonical X25519 SPKI PEM), created/deadline (safe integer UTC epoch
milliseconds), workflow, revision, runId and attempt (positive safe integer).
Identifiers are bounded ASCII strings; fixture values are explicitly synthetic.
The full request serialization and public-key fingerprints are SHA-256 correlation
values, not signatures or Core body digests. The trusted observation must bind
these values, stable identities, original actor, workflow/revision and Run/Attempt.
All submitted fields remain untrusted until that observation is verified.

Response header has construction, context, ephemeral (sender X25519 SPKI), salt
(32 random bytes) and iv (12 random bytes). Context contains version 1, request
ID/nonce, user/repository IDs, recipient public key, times and workflow/revision/
Run/Attempt. Ciphertext and tag are base64, as is signature. The plaintext is
{context, issued, expires, token}; expires is the provider token expiry. Scope is
fixed by the repository-only endpoint and construction; organization input fails.

The explicit construction is X25519 key agreement, HKDF-SHA256 with random salt
and the exact JSON header as info, 32-byte derived key, AES-256-GCM with a 16-byte
tag and exact JSON header as associated data. Ed25519 signs the UTF-8 JSON encoding
of {header,ciphertext,tag} in that order. Use the built-in Node crypto operations;
this is a composition experiment, not a new primitive or an audited protocol.
The receiver verifies the independently pinned Owner signature before decryption,
compares the complete expected request context, checks matching recipient key and
checks request/token deadlines. AEAD alone cannot authenticate the Owner: anyone
with the public recipient key could otherwise encrypt a substituted result.
Tests re-sign tampered ciphertext/tag with the fixture Owner key to independently
exercise AEAD rejection rather than only signature rejection.

Derived shared secrets, AES keys and temporary plaintext Buffers are zeroed in
finally blocks. JS strings and KeyObjects cannot guarantee physical memory erasure;
production process isolation and ephemeral key custody require separate review.
The CLI must dispose its private key after completion, cancellation or deadline.
The experiment writes no sensitive temporary file, including on assertion failure;
only fixed safe outcome text is printed. Synthetic plaintext is inspected in memory.

## Return channel and integration operations

The bounded design selects one encrypted, signed Actions artifact per request,
retrieved by exact repository/run/attempt/artifact identity. This transport is
DESIGNED, not exercised locally. No issue, form or email carries a token. Assume
artifact visibility may include every repository reader (including public readers);
confidentiality must depend on the ephemeral recipient key, not artifact secrecy.
Artifact names and logs expose only safe correlation IDs, never plaintext or keys.
Do not put redirect URLs bearing temporary access capabilities in logs. Fetch only
GitHub-authorized result locations and reject substitutions before opening data.
The member rechecks its own current access for retrieval; the signing/context and
request correlation gates still apply even when GitHub download authorization passes.

Proposed retention is the minimum supported artifact setting, requested one day,
with explicit deletion as soon as acknowledgment, cancellation or request expiry
is reconciled. Verify the actual platform minimum, deletion rights and backup
retention live; deletion is not cryptographic revocation. Late artifacts are never
accepted after the request deadline even if their token remains usable elsewhere.
Retain only protected nonsecret request/run/state fingerprints for audit and replay
prevention. No retained artifact is required for this offline candidate.

Future CLI operations: create key/request, dispatch bounded inputs, correlate the
trusted run, retrieve exact artifact, verify/decrypt, pass token locally to the
Runner configuration process without printing it, dispose secrets and acknowledge.
Future Core/Owner operations: read authenticated actor/input/run binding, read
policy/identity/permission, atomically reserve replay keys, revalidate immediately
before POST, record issuance intent, encrypt/sign, publish correlated result and
reconcile unknown outcomes. These are minimum integration responsibilities, not
new CLI commands or a second Core lifecycle. Error outputs must be safe English
categories and never raw provider exceptions. The model returns only encrypted,
rejected or unknown results; it has no credential/network access implementation.

## Replay lifecycle and deadlines

Requests last at most 60 seconds; creation may be at most 5 seconds ahead of the
trusted clock. Expiration is exclusive. Future production must use a trusted clock,
bound clock drift, cap provider/retrieval waits and reject invalid timestamps.
The receiver also rejects token expiry. Tests use deterministic clocks except a
15ms local timer case proving hung issuance terminates. Lookup waits and issuance
waits are bounded by the remaining deadline and respond to cancellation.

The single-process Map and Set reserve both request ID and nonce synchronously
before any await. Entries survive local duplicate delivery, concurrent calls and
cross-user/repository substitution. No failed entry is freed for retry. Before
issuance a failure is rejected; after issuance is attempted, exceptions, cancellation,
late responses and timeouts are unknown. Unknown never releases a usable result or
mints again. Underlying issuance may still complete after the local timer fires;
Promise cancellation cannot revoke a provider request or its side effects.

Production needs durable atomic unique reservation and conditional transitions
across processes/hosts, a persistent issuance intent before POST, original outcome
read-back and crash-safe reconciliation. A restarted in-memory fixture provides
none of those guarantees. Never treat a missing response as evidence no token was
minted. Where the provider cannot enumerate/recover that issuance, quarantine the
request until a conservatively proven maximum expiry plus clock margin; if that
bound is unavailable remain blocked. The synthetic reconcile method accepts only
a trusted verified expiry observation after its time, marks expired, returns no
token and leaves ID/nonce consumed. The callback/boolean is a test seam, not a
production evidence verifier. A new request requires a fresh key/nonce/ID and
fresh policy/permission checks after safe reconciliation; no automatic retry exists.

## Lifecycle limits and threat assessment

| Threat | Required boundary | Local evidence / remaining work |
| --- | --- | --- |
| Impersonation or stale membership | Independent actor/user/repository lookup and current Write gate | Denial table, two reads; live authenticated lookup U |
| Key substitution | Authenticated actor-to-exact-input binding plus signed context | Wrong key/fingerprint/context rejected; dispatch input attestation U |
| Replay/racing duplicates | Both indexes atomically consumed, durable production intent | Single-process concurrency L; distributed storage U |
| Hostile workflow/ref/code | Protected pinned workflow, no untrusted privileged checkout | Source/ref fixtures L; actual protection U |
| Ciphertext or sender substitution | Pinned Ed25519 signature and AEAD | Positive and tamper tests L; signing custody U |
| Credential disclosure | Only encrypted result, safe errors, local secrets | Safe returned envelope and output L; live logs/artifacts U |
| Timeout/lost response | Unknown outcome, no blind retry, expiry reconciliation | Hung, cancelled, late and lost response tests L; provider reconciliation U |

Request expiry stops result acceptance; provider expiry stops future uses of that
token according to provider behavior. Policy disablement or permission downgrade
stops NEW issuance, not already issued token use. This research establishes no
immediate per-token revocation endpoint. Runner removal is separate: after actual
registration, read back Runner ID, repository/organization scope, labels and trusted
member binding from GitHub; do not trust local success or a label alone. Deleting
an existing Runner or using a separately authorized removal operation needs its
own rights and result read-back. Test real expiry, removal, stale registration and
revocation behavior in separately authorized live work. Repository auto never
routes organization requests into its issuer.

Registration and local gh login grant no Issue execution, Owner Grant, Assignee,
Runner-set trust, Merge or delivery authority. Existing Runners are not removed
merely by disabling automatic registration. All native dependency, independent
Shape/Accept, Candidate/Hooks, CI, review and publication gates remain applicable.
No live token was requested, registered or revoked in this research.

## Reproduction and public audit

Run offline with Node.js 22.23.3 and npm 10.9.9, without credentials or network:

```sh
npm ci --offline
node experiments/run-registration-exchange.mjs
node --test test/registration-exchange.test.mjs
npm run build
npm run check
npm test
npm run experiment
npm run verify-package
```

The bounded runner must print encrypted response, replay rejected and disabled
policy rejected; assertions exit nonzero on an invariant failure. It retains no
private state. Shared npm test discovers test/registration-exchange.test.mjs;
inputs live in test/fixtures/registration-exchange.mjs. The existing sample
experiment and installed consumer package verification remain unchanged.

The maintained public README, docs, examples, source instructions, workflow prose
and license were reviewed for English consistency; no remaining non-English prose
was found. New research surfaces use English and synthetic identities only.
Protected operational files and other repositories are unchanged. There are no
new hooks, dependencies, generated distribution files or required ignored outputs.
The candidate inventory remains empty for non-tree artifacts and hooks.

Live workflow dispatch, protected Owner execution, App permissions, authenticated
input provenance, encrypted artifact lifecycle, end-to-end Runner registration,
revocation and distributed replay/crash behavior remain unverified. Production
use requires separately scoped implementation and authorized live security proof.

Local verification on 2026-10-23 used the pinned Node/npm versions above:
after integration with the newer shared baseline, offline npm ci, build and
check passed (26 ESM modules); npm test passed all 210 tests, including
39 registration research cases. Both the existing sample
experiment and the new bounded runner passed. verify-package passed installed
v4/v5 signed-consumer, instruction, rejection and tamper checks; its archive
inventory includes this record and excludes experiments/tests as intended by the
unchanged package files contract. Existing Core content identity is unchanged.
No hosted CI, live GitHub E2E, independent Acceptance or publication is claimed.
