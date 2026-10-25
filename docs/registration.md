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
#122 must connect this adapter to its protected entry and verify that integration.
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
It re-reads policy immediately before a single POST, with a default 30-second
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
#122 owns live Core/source authentication and actual response-channel integration;
gh-nibfin #27/#28 own supported-profile local registration/lifecycle proof.
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
