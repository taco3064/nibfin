# Protected automatic Runner registration

This module issues official short-lived registration information; it does not
register a Runner, create a Runner ID or confer delivery/merge permission.
Public repositories owned by personal accounts or organizations use repository
registration. Organization registration is a separate opt-in management policy.
Private repositories and GHES are unsupported. No custom scheduler, key-exchange
service, registration Issue, email delivery or registration endpoint is introduced.

## Protected hosted Core entry

`createRegistrationHost({authenticate, policy, transport, channel, now, timeoutMs})`
returns `issue(opaqueHostHandle, {signal})`. All constructor capabilities belong to
the protected Owner host. Do not expose this constructor as a request-payload API.
The handle identifies an authenticated official workflow_dispatch request already
received by that host. No shell, request-controlled checkout or subprocess runs.
The maintained protected host composes this issuer through `createProtectedRegistration`
as described below; older explicit callback consumers remain compatible.
This module does not install a workflow or claim that deployment has occurred.

`authenticate(handle,{signal})` must freshly obtain and verify the official source
Run/Attempt, workflow immutable version/ref, target repository and dispatch actor
against the host's protected entry configuration. Return only after successful
verification: `{authenticated:true, event:'workflow_dispatch', requestId,
requester:{id,login}, repository, repositoryId, runId, attempt, level, publicKey}`.
IDs are canonical decimal strings; repository is lowercase owner/name. requestId
is a unique public-safe identifier (1–80 letters, digits, underscore or hyphen)
per source request. `level` is repository or organization. `publicKey` is the
requesting member's ephemeral RSA public PEM (2048 bits minimum), from the same
authenticated dispatch request. Do not read requester identity, run identity or
policy from arbitrary supplied JSON; dispatch inputs may request a level/key but
cannot choose the authenticated actor, host destination or trusted workflow ref.
GitHub's trusted actor and retained dispatch inputs bind that key to the requester;
public key possession alone is not identity. Member private keys stay local.
OIDC identity alone does not prove predecessor success or grant operation rights.

`policy(repositoryId,{signal})` reads current protected Owner configuration, never
the request branch. Return `{enabled:true, repositoryId, repository,
capabilities:{'administration:write':true}}` for repository issuance. Missing or off
policy denies. The host obtains the App installation identity/capability observation
independently, with Administration:write on this repository plus Metadata:read
and the access needed to read current collaborator permission/user identity.
Workflow GITHUB_TOKEN alone cannot acquire Administration permission by declaring
YAML permissions. Ordinary Write/Maintain/Admin membership permits requesting;
it never gives the member management credentials. No Assignee or delivery Grant
is required for this registration policy.

For organization issuance additionally return
`organization:{enabled:true, login:'owner', id:'7'}` and
`capabilities:{'organization_self_hosted_runners:write':true}` from independently
verified org policy and an App identity with organization Self-hosted runners:write.
Organization membership or repository ownership does not establish that capability.
The current organization ID must match the repository owner. Organization policy
and actual endpoint permissions remain required; unsupported installations deny.

`transport` is the bounded GitHub provider transport interface in package.md. It
holds the management credential solely in the trusted host, supports AbortSignal,
and must not log raw request/response secrets. The entry reads repository, user and
current effective collaborator permission through official endpoints per request.
It re-reads authenticated source, target and member rights after credential
preparation, then policy immediately before a single POST, with a default 30-second
whole-operation deadline. Native races remain possible; no atomic freeze or instant
revocation is promised. Repository POST is
`/repos/{owner}/{repo}/actions/runners/registration-token`; organization POST is
`/orgs/{org}/actions/runners/registration-token`. Both send `{}` with the provider's
pinned Accept/API-version headers. GitHub's returned expires_at is preserved;
[GitHub documents a one-hour registration-token lifetime](https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2026-03-10#create-a-registration-token-for-a-repository). Invalid/expired data fails.

## Encrypted standard Actions artifact response

Use `createRegistrationArtifactChannel({client, runtime, read})`. Obtain the genuine
single-attempt SDK client/runtime from existing `actionsArtifactUpload` (custody.md)
on the protected source Actions host. Its exact @actions/artifact 2.3.2 production
runtime remains required and version checked; missing runtime is an environment
failure, not an invitation to synthesize an SDK. The `expected` custody context
passed to that loader must be the independently verified host context.
`runtime` must match repository ID/name, Run and Attempt. Do not send these runtime
credentials or the App credential to members, agent processes or checkout code.

Artifacts can be visible to other repository readers, so only an RSA-OAEP-SHA256
wrapped AES-256-GCM envelope is uploaded. Context (request, requester, repository,
registration level/ID, Run/Attempt, public-key fingerprint) is authenticated GCM
associated data and repeated inside the ciphertext. This uses Node standard crypto;
there is no custom registration handshake. Only ciphertext is staged, in a private
0600 file under a disposable 0700 directory, and removed after upload settles.
Name is `registration-{requestId}-{attempt}`, sole entry `response.json`, retention
one day; token expiry independently limits usability. Never log the token, key,
provider body or successful decrypted member result.

Supply `read: registrationArtifactReader({provider,archive})` using a credentialed
Actions:read provider and the existing `artifactArchiveTransport` binary adapter.
The reader checks fresh repository/Run identity, exact Run-scoped artifact name/ID,
Attempt, expiry, bounded ZIP and sole response entry. No latest-name fallback.
Publication confirms exact encrypted bytes after readback. A lost upload response
may reconcile by that unique name; absent, duplicate or inaccessible results stay
unconfirmed. No POST/upload is automatically repeated. Preserve the source handle,
request ID and public-safe result in trusted host records for unknown-effect handling.

`issue` returns delivered with `{context, expires_at, url, ref}` only after readback;
otherwise denied, expired, unavailable, unknown (issuance effect uncertain), or
unconfirmed (channel/cleanup effect uncertain), with fixed sanitized diagnostics.
It returns no plaintext token. A successful SDK upload alone is insufficient.
Cleanup failure/pending cleanup prevents delivered. A cancelled SDK can still
finish; host process supervision must allow pending cleanup and reconcile effects.

Members retrieve the exact ref via authorized official artifact download and pass
response.json to `openRegistrationResponse(bytes,{privateKey,expected,now})`.
Expected context comes from the authenticated request and trusted host result,
not the downloaded envelope. Success is `{outcome:'available',token,expires_at,url,
context}` for the official local Runner configurator only. Wrong key/context,
tampering and expiry return unavailable without token release. Recheck expiry
immediately before local configuration. If protected delivery is unavailable,
use GitHub's official manual registration route with a legally authorized manager;
never fall back to plaintext outputs, logs, Issue/PR text or Owner PAT sharing.

Turning policy off or losing permission stops new issuance. Existing tokens expire
according to GitHub; existing Runner removal is a separate official operation.
The maintained source is `src/registration-host.mjs`, `src/host-identity.mjs` and
`src/custody-host.mjs`. E02 (nibfin #206), E05 (gh-nibfin #48) and E06
(gh-nibfin #49) own later real provider/host/registration verification.
The maintained local fixtures prove neither live authorization nor transport.

## Reproducible local verification

With Node 22/npm 10, copy the candidate into verifier-owned disposable scratch,
then run `npm ci --ignore-scripts --no-audit --no-fund`,
`node --test test/registration.test.mjs test/provider.test.mjs test/custody-upload.test.mjs`,
`npm run check` and `npm run verify:archive`. Packaged consumers run the same
registration contract suite against the installed archive. Scratch contains all
package outputs/test fixtures; submitted candidate bytes need not change.
Routine checks require no artifact SDK download. `npm run test:artifact-sdk` is the
separate real-SDK transport regression, requiring an existing approved genuine
runtime via NIBFIN_ARTIFACT_SDK_ROOT; CI still provisions it. Do not claim that
suite or live integration ran when its required runtime/resources were absent.

## Maintained protected composition and durable recovery

Use `authentication: "actions-oidc"` in the protected registration options. Export
mode-keyed `identity`, `custody`, `registration` and `capabilities` from the approved
executable deployment binding. For registration, the callback functions `registration` and `retain` are
omitted from that mode's capability bag (`capabilities = {registration: {}}`). The dependency-free host
constructs the maintained identity adapter, registration adapter, issuer and
provider-backed custody channel without I/O. The loader pins the exact executable
source and options bytes; JSON event fields cannot select modules or transports.

`registration.registration` in that binding contains:

```js
{
  request: {
    input: {nibfin_registration: requestId, public_key: memberPublicPEM, level: 'repository'},
    requester: {id: dispatchActorId, login: dispatchActorLogin}
  },
  policy: async (repositoryId, {signal}) => readProtectedOwnerPolicy(repositoryId, signal)
}
```

This is an executable configuration excerpt, not a complete deployment. The
protected integration captures `request` from the original approved dispatch
Run/Attempt before invocation. Bind it to the independently expected source policy;
do not take this protected object, actor, policy or source expectations from an
arbitrary request body. Source repository/ID must equal the target repository/ID;
Run/Attempt, workflow/ref/immutable source and actor are verified by official
Actions OIDC. The official attempt read must match that actor, event, repository
and source revision. All three workflow inputs must match the captured request.
The key and level are thus part of this authenticated source, not identity on their
own. Source acquisition remains bounded/cancellable. A new request is a new
explicit dispatch; never generate one automatically to hide an uncertain attempt.

The corresponding `custody.registration` supplies exactly `provider`, `archive`,
`publication` and `authorizeNew`, optionally storage limits, retention and redaction
sentinels. Unlike delivery custody it supplies no `expect` callback: maintained
code derives registration-only slots from original repository/Run/Attempt/revision,
approved workflow/ref and a digest of captured request and requester. There is no
Issue, Assignee, Scope, Shape, delivery role or Grant in these bindings.
`provider` and `archive` are protected Actions read/download capabilities;
`publication({slot,phase,signal})` supplies the existing official SDK `client` and
`runtime`. The response phase is named `response`; metadata retention phases are
`intent` and `result`. Runtime source must match the original repository/Run/Attempt.
Credentials stay in these closures. `authorizeNew(slot,{signal})` must positively
check durable original-attempt history under the workflow's native repository-write
concurrency group. A missing artifact list alone is never a first-attempt grant.
Missing storage/runtime/permission fails closed; it does not enable a callback or
plaintext fallback. Do not share the management capabilities with member jobs.

The maintained flow retains `registration-intent` (captured original request), then
invokes the existing issuer at most once. Before response upload it retains only
the encrypted `registration-response` bytes, binding and expiry. It retains a
`registration-publication` record after channel readback/cleanup, and a final safe
`registration-result`. Each record uses N03's intent/result publication and exact
provider-backed verification; process memory is not restart evidence.

On restart, fresh adapters authenticate the same source and read retained records.
A confirmed result is checked against freshly downloaded ciphertext. Missing final
result with an original intent can recover from retained ciphertext and publication
records without another token POST or response upload. Readback may reconcile an
unknown upload only when the retained publication outcome establishes completed
cleanup; `cleanup_pending` or `cleanup_incomplete` remains unknown. An intent with
no response, lost token POST response, conflicting records, missing/expired or
inaccessible required history remains unresolved. Deleting artifacts cannot
manufacture a first attempt because independent durable `authorizeNew` still applies.
There is no instant revocation of previously issued tokens or existing Runners.

### Public v1 request and result schema

`host/registration.schema.json` documents the unchanged workflow inputs, fixed
status outputs, context and encrypted envelope. IDs are canonical decimal strings;
request IDs are 1–80 ASCII letters/digits/underscore/hyphen. PEM input is at most
8192 characters, RSA at least 2048 bits. The reusable workflow defaults `level`
to `repository`; a direct `createWorkflowEntry` invocation supplies it explicitly.
Encrypted envelopes are at most 65536 bytes; the exact single-file ZIP read is
bounded to 131072 bytes. GitHub's returned `expires_at` is preserved and checked
before publication, recovery, decryption and local official configuration.

| Status | Meaning |
| --- | --- |
| delivered | This invocation issued and confirmed ciphertext publication and cleanup. No Runner is created by this result. |
| retained | A fresh read recovered the same confirmed encrypted response without reissuing. |
| denied | Owner policy or management/member authorization denied this invocation. |
| unavailable / blocked | Required source, configuration, channel or observations failed; no success is inferred. |
| expired | The returned short-lived information is no longer usable. |
| unknown | Issuance/history/result effects cannot be established. Preserve original identity; do not resubmit automatically. |
| unconfirmed | Response publication or cleanup is uncertain. Upload acknowledgement alone is insufficient. |

Only `status` and optional opaque `response` leave the workflow. For the maintained
adapter, `delivered`/`retained` references the `registration-response` custody slot;
other returned references identify `registration-result`. The public-safe slot
identity is `custodySlotIdentity(slot)`, with the original expected binding, not a
latest-name lookup. Existing callback consumers retain their original reference
semantics. Resolve the retained encrypted record through `createCustodyHost.recover`
with independent original slot expectations (derive them with
`registrationCustodySlots({source,workflow,ref,request})` from the original approved
source revision/Run/Attempt, workflow ref, Git ref and captured requester/inputs), then use the exact response artifact
reference and trusted context to download/decrypt as above. Retained ciphertext
can also be decrypted locally with the member key and independent expected context;
it contains no plaintext management credential. Do not trust envelope context as
its own expectation. Decrypted values must go only to the official local Runner
configurator, never logs, shell outputs or public records.

When policy is off or protected delivery is unavailable, a legally authorized
Runner manager may use GitHub's official manual registration path. Ordinary Write
collaborators do not gain management permission by selecting manual mode. Local
synthetic tests do not certify live registration, Runner IDs or platform support.

The slot helper is a read-only derivation, not authentication. It returns all four
kind-keyed slots; use the `registration-response` slot to check a delivered/retained
`response` via `custodySlotIdentity`. Do not derive expectations from retained bytes.
GitHub's [official artifact schema](https://docs.github.com/en/rest/actions/artifacts#list-workflow-run-artifacts)
provides the repository and workflow Run identities checked by the response reader.
