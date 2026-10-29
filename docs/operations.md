# Controlled effects and official concurrency (v1)

`controlledIntent` and `createControlledOperations` are inert public Core APIs.
They cover Workflow Dispatch, PR creation, head-conditional Merge, completed Issue
Close, exact Issue Body updates and additive Label writes. PR update is not exposed by this version. These
are module contracts with local fixture proof, not live integration evidence.
#122 owns real native exclusion/queue/cancellation observations; #123 owns live
independent-Run recovery. Neither suite was run for this module.

## Capabilities and exact identity

Construct `createControlledOperations({authorization, provider, custody,
publication, locate, execution, beforeSubmit})` with trusted Core capabilities. `authorization` is an
existing `createAuthorizationBoundary` instance; `provider` supplies independent
GET/collection readback; `custody` is `createArtifactCustody`. `publication` returns
`{client,runtime}` from the existing Actions artifact upload adapter, optionally
its supported timeout/size bounds. Imports never read credentials or perform I/O.
`execution:{runId,attempt}` is the independently observed current Run/Attempt;
original request provenance stays unchanged during recovery from later Runs.
Use public repositories with personal or organization owners. Registration level
and optional automatic registration are independent of repository ownership.

The input has exactly `version:1`, `kind`, `correlation`, `source`, `binding`,
`target` and `payload`. `source` contains `request,event,repositoryId,runId,attempt,
actorId`. `binding` contains `repository,repositoryId,issueId,number,cycle,scopeHash,
shapeHash,authorization,runId,attempt,candidate,base,head`. Decimal IDs are canonical
strings. Repository coordinates are lowercase. Scope/Shape and authorization hashes
retain their existing identity conventions; request payloads use `contentIdentity`
and canonical JSON. `candidate` is its content identity (or null when inapplicable),
Merge additionally requires `binding.baseRef`, the intended destination branch;
it has no inferred default, so older Merge inputs without it reject.
The `base/head` fields are exact Git SHAs (or null when inapplicable). No new body hashing
scheme is introduced. Exact retained source, binding, target and payload comparison
rejects correlation reuse with different bytes or provenance.

`target` always contains `id,number,workflow`. Dispatch uses workflow ID, null
number and exact workflow ID (also in `workflow`); PR creation uses repository ID
and null number/workflow. Merge uses PR database ID/number; Close/Label use Issue
database ID/number. Null workflow applies outside Dispatch. Supported payloads:

- Dispatch: `{ref: exactCommitSHA, inputs: {nibfin_correlation: correlation, ...}}`;
  inputs are strings. The consuming workflow must set its official `run-name` to
  `nibfin-operation:${{ inputs.nibfin_correlation }}` and declare that input.
- PR creation: `{title,body,head,base}`. The body ends in
  `\n<!-- nibfin-operation:CORRELATION -->`; both branches belong to this repository.
- Merge: `{sha: binding.head, merge_method: 'merge'|'squash'|'rebase'}`.
- Close: `{state:'closed',state_reason:'completed'}`.
- Label: `{labels:[...exact requested names]}` (additive, no replacement/removal).

Every mutation passes through a fresh authorization checkpoint. Configure its
`getCheckpoint` to bind the exact current request and payload to the currently
approved Candidate, Base/head, original source and applicable product gates.
Intent data is never a Grant or eligibility result. Existing native dependencies,
Runner observations, independent Acceptance, Hooks, CI, Review and protected Merge
remain Core-owned gates.

## Retention, reconciliation and continuation

`locate({identity,correlation,binding})` is Core's trusted source-handoff resolver.
It returns `{outcome:'new',identity}` only after independently establishing a new
original request, or `{outcome:'found',refs:{intent,attempt?,result?}}`. Missing/inaccessible
history must yield another outcome and block. Do not implement it as a local
success cache or treat an empty artifact listing as newness. Each ref entry is `{ref,source:{runId,attempt}}`, with its source independently
held by Core, never taken from artifact payloads. Core records returned
refs in its existing traceable Run/handoff evidence. This is not a new journal,
lock, scheduler or atomic reservation service. Official concurrency encloses lookup,
intent retention, submission, readback and result retention.

The constructor accepts `timeoutMs` (default 30 seconds) to bound execution waits.
`execute(intent,{signal,retryAfterNoEffect:false})` publishes exact intent bytes
through `prepareCustodyManifest`/`publishCustody` and independently retrieves them
before the first write. A separately retained attempt record precedes each submission,
including an explicit retry; results bind that attempt ref so an old no-effect
receipt cannot authorize replay after an interrupted retry. Missing facilities or failed/unconfirmed retention prevents
submission. Each immutable artifact contains `operation.json` and the existing
custody manifest. Subsequent result/observation provenance uses the same facilities.
Unique publication names include intent identity and avoid artifact overwrite.
Core can recover those named artifacts from the original Run using verified
source/handoff metadata; missing history is never evidence of a new request. Recovery uses independent
expected binding and the real custody verifier; it rechecks provider state rather
than trusting an old success receipt. Missing/expired/corrupt artifacts block.

Outcomes are `confirmed-success`, `confirmed-no-effect`, or `unknown`. Only confirmed
success permits the affected dependent continuation. Operation-specific success
rules use fresh GETs and exact repository identity, not a caller predicate:

- Dispatch: one fully paginated workflow Run with the exact correlation run-name,
  workflow ID, dispatch event, target SHA and repository; exact-ID detail agrees.
  This proves a correlated Run exists, not that the Run/stage succeeded.
- PR: exactly one fully paginated PR matches title/body correlation, head/base
  refs and SHAs and both repository IDs; exact-number detail agrees.
- Merge: exact PR identity/head/repository and destination branch (`binding.baseRef`)
  agree with independent merged/closed PR readback and resulting-commit retrieval.
  The retained `binding.base` is the reviewed pre-merge Base, not the destination's
  post-merge tip. An independent destination branch read and exact-SHA GitHub
  comparison must prove the resulting commit belongs to that history. Rebase and
  squash may produce a SHA different from Head; later destination advances are
  allowed when membership is proven. Missing, retargeted or contradictory history
  remains unknown, including during recovery. Before a fresh submission Core
  revalidates changed Base/Candidate and invalidated gates; it never rewrites an
  old intent. See [final-review.md](final-review.md) for the complete composition.
- Close: exact Issue ID/node ID/number/repository is closed with completed reason
  and a closure timestamp. A not-planned closure cannot match.
- Label: exact Issue identity plus a complete separate labels listing contains
  every requested exact label. Unrelated labels do not establish the effect.

Close/Label are desired-state effects: confirmed success includes an already
confirmed requested effect, without claiming who caused it or exactly-once
execution. No causal attribution to an unrelated change is inferred. Dispatch/PR
require their explicit correlation handoff. Duplicate correlations, wrong targets,
read failures, missing/unchanged state, incomplete lists and acknowledgment alone
remain unknown. Lost transport responses can reconcile matching effects without
resubmission. A generic Boolean predicate is not accepted anywhere.

The affirmative no-effect rule for all five operations is deliberately narrow:
the *current* authorization boundary explicitly rejected before calling mutation
transport (`failed/unauthorized`). Thus that attempt cannot later take effect.
No remote absence, 404, HTTP failure, elapsed time, cancellation or unchanged state
is sufficient to prove an attempted remote mutation cannot still take effect.
Where GitHub provides no conclusive no-effect evidence, the API returns unknown.
An explicit `retryAfterNoEffect:true` requires verified retained no-effect evidence
of this pre-transport rejection and performs fresh authorization; it never retries
a remotely attempted operation automatically. Later denial does not prevent
read-only recognition of an already confirmed effect. No-effect itself grants no
permission to continue or write.

Retained intent with no result is potentially attempted, including a stop between
retention and submission. Timeout/cancellation can leave an external request still
running; result-retention failure returns unknown with known intent refs. Caller
cancellation is not termination proof. Reconcile with a fresh instance before
continuation; unknown refuses blind replay and requires later readback/manual
handling. There is no exactly-once or instant revocation claim.

## Consumer integration and official limits

`nativeConcurrency` returns official `{group,'cancel-in-progress':false,queue}`.
Supply trusted resolved repository coordinates/ID and `scope:'issue',issue` or
`scope:'repository-write'`. Version-1 names use stable repository IDs, preserving protection across renames
and case differences, and exclude workflow,
event, stage and Run ID. Every Dispatch/PR/Merge/Close/Label path takes the same
repository-write job group; each Issue execution uses its distinct workflow group.
Never recursively acquire the same group at workflow and job boundaries.

`nativeExecutionPlan` returns workflow Issue concurrency, a compute matrix strategy,
and a separate write job concurrency. Its `maxParallel` (1–256) is **only** the
`workflow-matrix` scope's `strategy.max-parallel`, not a quota across Runs or repos.
Compute work on independent Issues remains parallel; only controlled writes share
the repository group. `parallelIssueWorkspace` gives separate branch/directory
names by repository ID, Issue number and cycle. A single Issue's active workspace
is protected by the Issue group. Core still refreshes/revalidates a Candidate when
Base advances; naming does not replace any Gate.

The executable generator `tooling/operations-fixture.mjs:concurrencyConsumer`
imports actual package exports and produces the official workflow/job fields.
The archive verifier runs it against the installed package. It is a local handoff
fixture, not a deployed reusable workflow. Its echo steps are fixture markers;
production consumers must invoke the authorized Core boundary in the write job.
Dispatch, PR, Merge, Close and Label all map to that write job. Compute remains
outside the write group; whole execution stays inside its separate Issue group.

Selected queue mode is `max` (up to 100 pending); `single` is also supported and
replaces the sole pending entry. In-progress writes are never canceled by this
contract. Full queues can cancel additional entries; cancellation is not delivery
or no-effect proof. GitHub orders by time work starts waiting, not dispatch order,
and offers no unbounded/fair/global queue guarantee. Reawakening requires a lawful
event and fresh gates. See [official concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Local verification

Retained operation tests use actual authorization checks and signed synthetic
Grants, existing artifact publication and real custody ZIP/source/digest validation
with local provider transports. They cover each effect, loss, denial, recovery,
identity drift, missing evidence and interruption without credentials or mutations
on GitHub. Concurrency tests exercise actual configuration outputs. Installed
consumer tests reject mismatched recovery identity. Run the complete suite with
Node 22/npm 10 and the isolated SDK runtime described in `docs/custody.md`, then
`npm run verify:archive`. The ignored `out/nibfin-core.tgz` is mandatory Candidate
content. No repository-managed hooks are configured; Core's two isolated hook
gates remain applicable. Live #122/#123 observations remain separately owned.

Issue Body publication uses kind `issue-body`, an Issue database target/number,
and payload `{body}` only. Nonblank exact bytes must hash to binding.shapeHash
using bodyDigest. Readback checks the target Issue and exact body bytes. A retained
intent or pre-guard attempt is insufficient publication provenance. Body and additive Label writes
retain a separate submission receipt only after the authorization boundary returns,
binding its outcome to the exact attempt. Recovery for both effects requires this receipt; missing
or mismatched receipts block even when remote bytes or labels match. Known denied no-effect
submissions cannot later be promoted from matching bytes, even if final result
retention failed. Lost responses with retained submission receipts can reconcile
independently observed effects without resubmission. Interruption before receipt
retention remains unknown and requires trusted investigation, not automatic replay.

The optional trusted beforeSubmit(intent) guard runs after durable intent/attempt
retention and before authorization.request, including explicitly authorized retries.
A thrown guard blocks transport and preserves unknown/partial recovery history.
Shape publication uses it for live Scope/body/evidence/dependency checkpoints.
GitHub body and label effects remain separate; see shape.md for continuation.

The same receipt rules apply to every additive Label operation, including shaped.
Legacy Body/Label history without a submission receipt remains unknown; matching
remote state cannot upgrade it. A prior denial applies to its exact attempt. An
explicitly authorized retry receives a new attempt and submission receipt, so an
interrupted final-result retention can reconcile the later submitted effect.

Accepted-Candidate publication opts into `reconcileExistingPR:true`. Before a new
PR POST, complete discovery and single-PR readback reconcile an existing exact PR.
Related correlation/head-ref mismatches and duplicate PRs remain unresolved.
Discovery failure is never treated as absence. After an empty complete discovery,
the pre-submit guard runs again before the guarded provider request. Re-entry of
an attempted operation only reads back; it does not repeat an uncertain POST.

Merge also requires `authorization.withMutationGuard`: the existing operation
guard runs again after awaited authorization reads, immediately before transport.
The boundary enforces the signed method and destination Base policy. Recovery
with an existing attempt remains read-only and uses the original custody records.

Post-merge recovery also uses controlled `comment` (POST Issue comments) and
`reopen` (PATCH Issue state open). Both retain submission custody and run the
post-authorization mutation guard. Comment readback checks the stable Issue,
exact unedited body, authorized writer, full correlated collection and detail GET.
Reopen's `open-present` observation alone is noncausal; the recovery flow additionally
requires original closed lifecycle, submission custody and the new writer-bound
reopened occurrence. See [Recovery](recovery.md) for ordering and authorization.

Pre-Shape wakeups retain `shapeHash: null` and `candidate: null` rather than
inventing a Shape or Candidate identity. This is an additive v1 dispatch case;
all non-dispatch writes and dispatches naming a Candidate still require an actual
Shape hash. The existing custody owner binds such dispatch records to its `authorization`
stage (which already supports a null Shape). Rescue is a producer, normal Core
is the consumer, and source/custody/authorization/readback checks remain unchanged.
A wakeup never supplies Shape publication or downstream completion evidence.

Dispatch intents may also retain a bounded `display` of the authenticated target
repository and Issue number. Run readback still requires the exact immutable
operation marker, pinned workflow/head and repository ID. Only the displayed
repository spelling is case-normalized; display text cannot select a request or
grant authority. Older dispatches retain their original exact title contract.

For a personal-account shared execution pool, an installed `poolDispatch` policy
pins one logical repository/ID, actual source workflow ID, named ref, commit SHA
and workflow digest. `createControlledOperations` requires both `executionPool`
and that policy. A dispatch intent additionally retains `payload.executionSource`
with the actual source repository and ID, plus its existing `refIdentity`. The
destination is part of immutable intent custody; changing deployment configuration
cannot reinterpret a previously retained dispatch. No event input selects a policy.

The Issue binding, signed Grant, assignee and Write checks remain on the logical
repository. Only the dispatch POST and independent source Run readback use the
physical source. Hosted transport separately requires the protected policy, exact
workflow/ref and credentials covering both repository IDs. Pool membership alone
does not admit any source mutation. A missing/conflicting Run or lost retention
remains unknown and never causes an automatic second dispatch. This API is a
composition capability; its tests do not certify a deployed shared Runner pool.
