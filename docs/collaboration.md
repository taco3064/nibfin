# Public collaboration adapter, version 1

Nibfin owns the maintained public implementation. The approved source reference
is `taco3064/kairo` at `d1b47d5e073cf15bdcdc1fbbec098401649878d9`.
No private repository is needed to install or run the package. This mapping names
source and adapted assertions, not inherited test verdicts.

| Donor source | Maintained production owner and adaptation | Adapted assertions |
| --- | --- | --- |
| `src/owner-identity.mjs` | `src/collaboration.mjs` `verifyRepositoryIdentity`, used by `host-identity.mjs` and `runners.mjs`: independent expected stable repository identity; public personal and Organization ownership replace the fixed source/Owner anchor | `test/collaboration.test.mjs`, `test/host-identity.test.mjs`, `test/host-routing.test.mjs` |
| `src/authority.mjs` | `verifyOwnerSignature` in `collaboration.mjs`, consumed by the sole signed-grant owner `grants.mjs`; retain Nibfin's domain-separated signed bytes, schema, current revocation and expiry checks | `test/grants.test.mjs`, `test/authorization.test.mjs`, `test/collaboration.test.mjs` (donor signature/revocation assertions span dynamic/dispatch tests) |
| `src/runner-binding.mjs` | `validateMemberBinding`, called by `runners.mjs` and `runner-lifecycle.mjs`: versioned registry descriptor, current member/target/scope, explicit revocation; remote ID/label/access reconciliation remains in `runners.mjs` | `test/collaboration.test.mjs`, `test/runners.test.mjs`, `test/runner-lifecycle.test.mjs`, adapted donor `test/dispatch.test.mjs` mismatch/rotation assertions |
| `src/runner-operations.mjs` | `runner-lifecycle.mjs`: non-stealable local mutation lock, unknown-effects preflight and readback before reuse; standby checks local login and registration without an Issue Grant; local instance lifecycle stays separate from delivery authority | `test/runner-lifecycle.test.mjs`, adapted donor `test/runner-operations.test.mjs` service-check/crash-lock assertions |
| `src/dynamic.mjs` | `prerequisiteTraversal`, used by the sole dependency evaluator `dynamic.mjs`: visiting/visited traversal, cycle detection and target-scoped prerequisites; Nibfin supplies bounded native GitHub reads and independently verifies each upstream completion | `test/dynamic.test.mjs`, `test/collaboration.test.mjs`; donor `test/dynamic.test.mjs` cycles, external/missing prerequisites, unrelated work and fake closure assertions |
| `src/owner-issue-session.mjs` | `verifySessionResult`, called by `workflow.mjs` on recovered results: exact original request/run/operation/target; existing custody/beginStage owns durable intents, duplicate recovery and unknown-effect reconciliation | `test/workflows.test.mjs`, `test/host-routing.test.mjs`, `test/collaboration.test.mjs`; donor `test/action-integration.test.mjs` duplicate/interrupted-session assertions |

The donor's deployed Owner identity, repository allowlist, machine root keys,
HMAC public dispatch, local delivery Store/leases, private polling, service
installation, deployment grants and single-Run role loop are excluded. Nibfin
retains native Actions concurrency and independent per-stage Runs, its existing
Candidate/Hooks, Shape/Accept/final review, exact-head CI and protected writes.
There is one selector, registration issuer, grant verifier and dependency owner.

`collaborationVersion` is 1. `verifyRepositoryIdentity` requires explicit version
1 and independently configured repository identity. `validateMemberBinding`
accepts the existing unversioned descriptor as version 1 for public compatibility;
explicit unsupported versions and inactive records fail closed. These functions
check observations, never grant execution or management permission.

`createLocalRunnerLifecycle({version:1, root, member, checkLocal, registration})`
is the Core onboarding contract. It introduces no CLI commands. The protected
local caller supplies an existing, private, current-account-owned root and fixed
capabilities; Issue/event JSON cannot supply them. `create({name, agent, count})`
accepts Codex, Claude or Gemini and defaults to exactly two unregistered instances.
Registration capabilities may be omitted for creation/listing; no registration API, target, ID or credential is needed. Count is a positive integer, with no string coercion. A failed preflight removes
partial creation or reports incomplete cleanup. Each environment has its own
login directory; its instances share only that login, with separate work,
registration and service directories. An existing environment is never overwritten.
The caller's `checkLocal` performs tool and actual-account GitHub/model login
checks using the existing runner preflight facilities and returns
`{status:'ready', memberId, agent}`. It receives no Issue-specific Grant at create
or standby. No model credentials are collected by the Owner or serialized here.

`register({name,target,method})` consumes one existing unused instance. Target is
`{version:1,repository,repositoryId,ownerId,ownerType,level,registrationId}`.
Repository ownership, registration level and automatic policy are independent.
The fixed registration capability supplies fresh `authorize`, `acquire`,
`configure`, and `observe` operations. `authorize` returns current repository
identity, member/registration identities, effective `memberPermission`, official
`management` capability and (for auto only) `policyEnabled:true`. Repository
registration needs `administration:write`; Org registration needs
`organization_self_hosted_runners:write` and the Org ID. This is separate from
subsequent dispatch eligibility and protected write authority.

For auto, `acquire` consumes the maintained #198 protected issuer/channel/readback
path (`createProtectedRegistration` / `createRegistrationHost` and
`registrationArtifactReader`), returning `{bytes, privateKey, expected}` only to
the local member. Core verifies it with `openRegistrationResponse`, checking
requester, repository, scope and expiration before official local configuration.
For manual, the caller uses its official management-authorized API path and
returns `{outcome:'available',token,expires_at,url}` locally. Neither a model
login nor ordinary membership supplies management permission. `configure` is the
fixed official Runner configurator, and `observe` reads the actual official
registration/labels and returns `{confirmed:true,runnerId,memberId,repositoryId,
registration,platform,labels}`. Tokens are passed only to that configurator,
never returned by the lifecycle, persisted in its manifest, or sent to role/hook
inputs. Registration does not create instances. Disabling auto policy stops new
auto issuance; it does not invalidate manual or existing lawful registrations.

A pending intent is persisted before acquisition. Any subsequent failure returns
`unknown` and blocks repeated registration, including after restart. `reconcile`
only reads official registration; it never reacquires a token or reruns configuration.
A remaining lock is never stolen. `standby` rejects pending or mismatched state;
waiting for work requires no Issue Grant. Actual Execute/new stages/privileged
operations still go through the existing fresh host-routing and authorization
checkpoints. Local registration/readiness is never an execution permission.

All contract/process evidence uses disposable directories, synthetic official
API/process boundaries and test keys. The archive verifier executes these
contracts against candidate package bytes. Live multi-account/model/Runner
isolation, official queueing, Org enrollment and external E2E remain Unverified
until separately authorized tests run. No release or live certification is claimed.
## Shared personal-repository execution pool

An explicit protected `executionPool` can route several public repositories owned
by the same personal account through one public execution repository. Register
each physical Runner only with that execution repository; logical target bindings
reuse its actual Runner IDs. Two instances therefore remain two registrations,
even when three logical repositories have bindings for each instance.

The version 1 pool contains `source` and a finite `targets` array. Every identity
has `version: 1`, canonical `repository`, stable string `repositoryId`, `ownerId`
and `ownerType: "User"`. The source must appear in the target set, every target
must have the same owner, and names and stable IDs must be unique. Put this value
in protected deployment options, never workflow event inputs or model output.
Repository-level registration remains the actual source repository. A pooled
member record explicitly uses `version: 2`, retains its logical `repositoryId`,
and adds `executionRepositoryId` equal to the source registration ID. Legacy
records and organization routing keep their existing checks.

The selector still reads the logical Issue's assignees and permissions and checks
its own Grant. Only the source repository identity and exact paginated Runner
inventory receive a cross-repository read capability. Actual source visibility,
stable identity, owner and inventory are rechecked. Hosted credentials must cover
both repositories; local management reads require administration at the real
source. No source mutation, collaborator query or arbitrary file read is added.

After protected deployment options are approved, `projectExecutionContext`
checks that the real `workflow_dispatch` belongs to the configured source and
projects its logical target for the Core invocation. It preserves the actual
event and Run and does not authenticate Actions or authorize an Issue. OIDC,
retained request, Grant, member and actual Runner checks remain independent.
The dependency-free host bootstrap receives the pure pool validator from the
approved Core package; it does not import an unchecked adjacent source graph.

This describes the Core contract. CLI onboarding, the Action consumer and actual
Runner/service installation must install a matching producer set and supply this
protected configuration before a pool is operational. Source fixtures alone do
not certify that installation or a maintainer cutover.

