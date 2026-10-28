# Host authentication and operation identities

`createHostIdentityAdapters` supplies maintained authentication, GitHub transport
and fresh authorization for the protected host. Construction performs no I/O.
Set protected host option `authentication: "actions-oidc"`, export a matching
`identity` entry from the approved deployment binding, and omit the deployment's
`authenticate` callback. Existing callback deployments remain compatible; they
must migrate to this option to use the maintained authentication implementation.
The host entry remains dependency free. Core modules are covered by the bundle
approval, package inventory and locked dependency installation.

The executable `identity[mode]` configuration contains:

- `source`: `policy`, `getToken()`, optional `getAssociation()`, and `continuation`.
  Policy uses the expected claim names from `createActionsVerifier`, plus
  `repository` (source coordinates). Supply repository/owner/actor IDs, workflow
  ref and commit, independently approved workflow content digest, ref, event,
  Run/Attempt, audience, maximum age, tolerance and explicit reusable/job/runner
  applicability. `now` is supplied internally. Optional `timeoutMs` bounds source acquisition to at most 30 seconds.
  Callbacks receive `{signal}` (token acquisition also receives `audience`).
  Token acquisition and job/runner
  association are protected capabilities, never event assertions. Production
  verification exclusively uses official Actions discovery and JWKS.
- `api`: `kind: "local"`, an `operator: {id, login}` and optional trusted
  `executable`/`organization` in member execute/compute modes; `kind: "hosted"`,
  `operator`, `getCredential()` and optional `organization` in hosted modes.
- `authorization`: the existing `getCheckpoint(intent)` and `maxCheckpointMs`
  contract. Checkpoints bind the current member, Issue, Scope, signed Grant and
  exact write intent. The adapter supplies the configured operator itself and
  requires the configured target repository ID and coordinates at every boundary.
- `operations`: an array of exact `{method, endpoint, target, operation}` bindings.
  Only implemented official endpoint classes are supported. Caller endpoint,
  identity, headers and transport overrides cannot expand this inventory.
- Optional protected `now()` supplies milliseconds, primarily for deterministic
  contract testing. It is not a workflow input.

Hosted `getCredential()` returns `{token, installationId, expiresAt, repositoryIds, permissions}`
with optional `organization` for Organization operations. `installationId` must
match the protected hosted operator ID; retain it from trusted token issuance. This information must
come from trusted credential issuance and policy, not an event or member request.
`permissions` maps official permission names to `read` or `write`. It constrains
requests; it does not certify actual rights. GitHub's endpoint response remains
authoritative. The adapter fixes the official API address, suppresses redirects,
bounds response size and never forwards credentials into host capability arguments.
Do not export a management token from hosted configuration into member deployments.

The actual process/service account's stored `gh` login is used in local mode.
Its clean environment fixes HOME from the OS account and excludes GH_TOKEN,
GITHUB_TOKEN, GH_HOST, alternate configuration directories and inherited secrets.
`/user` must match the configured operator. Missing login, 401 and 403 block;
login does not establish member eligibility, Owner authority or prior success.
Hosted mode does not discover or depend on local gh login.

Runner listing requires `administration:read`; repository registration/removal
requires `administration:write`. Organization runner operations require separate
`organization_self_hosted_runners:read/write` and the configured Organization.
Local runner management additionally requires observable repository admin rights
or active Organization admin membership; configurations without that observable
administrative account are denied. Actual endpoint token rights are still checked
by GitHub. Ordinary member Write/Maintain is never converted to runner management.
Other supported operation classes include public repository/Organization/user/Issue
reads, `metadata:read` for collaborator permission observations and `issues:write`
for Issue PATCH. Runner/group inventory GETs accept only bounded positive `page`
and `per_page` (at most 100), under an explicitly permitted base endpoint. The
existing runner observer consumes this provider without replacing its inventory
or routing logic; `expectedId` retains the provider identity check. Unsupported management operations fail closed; extend their official
mapping and tests before use. Public targets owned by users or Organizations share
the same identity checks; private targets are outside product support.

`continuation.kind` is explicitly `none`, `native-needs`, or `cross-run`. Native
needs requires protected fixed, unweakened workflow analysis (`expected`) and
`getEvidence()` returning dependency and optional Jobs observation. Matching
native success tolerates queued/null Jobs API data; failed or contradictory
completion does not pass. Cross-run requires a separate predecessor `policy`,
trusted expected receipt binding `current`, `consumerExecution`, `maxAge`, and
`getEvidence()` returning token, optional association, receipt and recordedAt.
Source and complete receipt must independently match. Same Run, stale/absent
receipts, partial output, OIDC or check-run IDs alone cannot continue work.

The maintained host projects public target identity and Run/Attempt only. Protected
capabilities receive non-enumerable `provider` and `eligibility` capabilities, not
credential configuration. Use that provider for controlled operations: it checks
source and current signed authorization again, including management reads.
Local gh login checks and hosted mutation credential acquisition finish before
the final authorization checkpoint. Each uses a request-local transport closure;
local dispatch launches only gh api, without a second gh auth status subprocess.
Hosted mutation credentials are acquired into that closure before
the final authorization checkpoint, with no reacquisition before dispatch. Credential
expiry and endpoint rights are still checked at dispatch. The final mutation guard checks the already verified source deadline locally,
including JWT expiry, maximum token age and applicable predecessor source/receipt
age limits (with the verifier's whole-second age and tolerance semantics); it
performs no awaited source/API work after the last signed-Grant checkpoint. Delivery
and runner checks also recheck eligibility. API results are trusted internal data;
only `publicDiagnostic` and the host's fixed public projection may be retained or
published. Never publish successful registration-token response bodies.

A mutation is submitted once by the provider. `unknown` is not success: retain the
intent and reconcile with a permitted GET binding and exact result predicate using
`provider.reconcile`. Do not blindly replay unknown writes. 401/403 diagnostics
preserve safe status/operation/correlation fields, excluding raw provider bodies,
fetch errors and credentials. These object and transport boundaries do not establish
OS isolation; Agent, Reviewer, hook and checkout isolation remain separate gates.

`createHostIdentityAdaptersForTest` explicitly injects local signing roots and an
in-memory transport for credential-free contract tests. It reports synthetic
provenance, and cannot be selected by a production deployment option. These tests
are source evidence only; E01/E02/E07 own later real platform/provider/host checks.

Official endpoint semantics: [GitHub runner REST API](https://docs.github.com/en/rest/actions/self-hosted-runners).
These permission classes follow the official API; token metadata never replaces its
actual access-control response.

`memberEligibility(member, intent, settings)` applies the existing authorization
boundary to a protected routing candidate, preserving operator identity, target,
current source and signed Grant checks. `observeExecution({signal})` exposes only
the authenticated target, source repository/ID, local operator ID, Run/Attempt and actual Runner ID after a policy requiring
the Job/check-run/Runner association passes. It throws a fixed diagnostic when
Runner proof is missing. This is protected host data, never an environment or
caller assertion; it does not itself authorize a stage. See the maintained
[routing integration](protected-host.md#maintained-resolve--actual-runner-composition).

For `routing: "authenticated"`, the additive read-only `routing.provider` checks
the same authenticated source, exact endpoint inventory, official management
rights and approved signed Grant before every GET/page. `routing.eligibility`
provides source/Grant authority for Core inspection and native dependency reads;
the maintained selector then requires `memberEligibility` for the actual chosen
Assignee. No member is assumed before that list can be read. Existing `provider`
mutation and member eligibility predicates remain in force for their supported
interfaces, and stage owners retain their final authorization guards.

The provider's optional `authorizeRead(intent)` runs for every normalized GET and
pagination page, within its bounded/cancellable request path. It cannot authorize
a mutation; writes still require the separate existing final `authorize` path.
Routing uses this guard for source/Grant checks and endpoint rights.
## Registration authorization is separate

Maintained registration mode uses the same official OIDC verifier and hosted
credential transport, but does not invoke the delivery checkpoint boundary.
`authorization` may be omitted for this mode; other modes still require it.
Its provider does not expose delivery operations. `registrationSource` verifies
Run/Attempt and official attempt actor/event/repository/revision against protected
source expectations and captured request inputs. Only `createProtectedRegistration`
receives the mode-bound registration transport. The existing issuer rechecks
source, public repository, stable User ID and current Write/Maintain/Admin rights,
then Owner opt-in immediately before one permitted token POST. Credential
preparation occurs before that final checkpoint. Organization Runner capability
is separately required; Org-owned public Repository Runners use the Repository
endpoint. No Issue assignment, delivery Grant or per-request whitelist is needed.
See [registration.md](registration.md) for protected request capture and custody.
