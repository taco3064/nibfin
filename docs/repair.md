# Local repair and diagnosis contract

`createRepairFlow` is the Core-owned local continuation interface. It consumes
independent rejected Accept/Final Review collections and trusted failed CI
observations. It releases a retained handoff, never a successful delivery receipt
or a GitHub write capability. #123 owns Actions repair/recovery integration,
restoration operations, dispatch, post-Merge recovery and fresh delivery gates.
Fixtures prove local contracts only; no live provider, model or repair cycle is
claimed here.

Construction requires these trusted capabilities:

- `current()` returns the complete current pin described below. `workspace()`
  supplies the protected workspace handle; `evidenceCurrent(executionId)` supplies
  current successful-envelope expectations and consumed result identities.
- `authorize(intent)` rechecks the existing authorization boundary for the exact
  repository, Issue, operation and policy. It must independently verify signed
  repair settings against `intent.repairPolicy`, including the policy identity,
  expiry and revocation. Returning `{ok:true}` is permitted only after that check.
  Pass the mapped intent to `createAuthorizationBoundary().eligibility()`; its
  trusted checkpoint owns the request, Grant and permissions. A generic successful
  login or unrelated operation observation cannot satisfy this capability.
- `dependencies(intent)` invokes the existing native dependency evaluator for
  this Issue and returns its current `ready`/waiting/blocked outcome. Both this
  capability and authorization run at each transition checkpoint.
- `retain({manifest,payloads})` uses `publishCustody` with the existing protected
  Actions artifact adapter; `retrieve({ref,expected})` uses `createArtifactCustody`.
  The flow validates manifest correspondence, all bytes and workspace import on
  readback. References and upload status alone cannot establish preservation.
- `prepareRole({role,skill,instructions,task})` supplies an independently assigned
  lifecycle and its input. Use `createAgentLifecycle` with `collectFailures:true`,
  exact bodies in `resultContext`, and a read-only backend. Bind the complete task
  through the trusted adapter task channel, as for Shape/Accept. Never derive an
  execution identity, capability or expectation from reviewer output.

The pin contains `repository`, `visibility:public`, `ownership:personal|organization`,
`binding` (the existing evidence binding), exact `scopeBody`/`shapeBody`, workspace
`expected` as `workspace`, `attempt:{id,candidate,deliverExecution}`, a fresh
`nextAttempt`, prior `history`, all prior role identities as `executions`, and
approved instruction configuration as `instructions`. Preserve separate Scope and
Shape identities using the existing `bodyDigest`; there is no replacement body hash.
`policy` has `identity`, `mode`, `maxRepairs` for bounded mode, numeric `expiresAt`
and boolean `revoked`. Missing policy fails closed. Version 1 Grants may now
optionally sign `policy.repair:{mode,maxRepairs}`; `until-conformant` uses null,
`bounded` uses a nonnegative safe integer. Existing Grants without this field
remain valid for their existing operations, but provide no implicit repair policy.
Grants carrying the new field require this verifier; older strict v1 verifiers
reject it. Pin the updated Core and obtain fresh applicable Owner authorization;
there is no automatic migration of active Grants.
The authorization adapter must bind the explicit repair selection to the signed
Grant/Owner policy; it must reject an unsigned or changed selection.

`gates` is the Core-selected list of applicable prerequisite observations, each
with `status:valid`. `effects:{execution:terminated,writes:reconciled}` means prior
execution termination and external write results have been independently resolved.
Unknown effects block before replacement. `merged` is an explicit boolean;
pre-Merge recovery also needs `recovery.allowed` and current `invalidate-shape`
permission. No restoration adapter is implemented here: `scope-recovery` returns
the exact original body and `stopCycle:true` for separately authorized recovery.
Already-merged work is blocked with `repair:merged`, preserving the Merge fact.

`source.kind` is `accept`, `shaper-review` or `ci`. For reviewer sources, pass the
complete rejected collection to `run(collection)`, not the reduced outcome returned
by a UI. The existing validator binds role, execution, all stage inputs, Issue,
Candidate, policy, bodies and replay state. For CI, Core supplies
`source.observation:{status:failed,binding,candidate,...trusted observation fields}`;
pass that exact value to `run`. Without `source.classification` containing a current
independent reviewer rejection for the same Candidate, failed CI selects external
wait. Check failure alone never establishes a code defect.

`evidence:{records,current}` supplies retained stage envelopes and current
expectations keyed by `contentIdentity(receipt)`. `custody` supplies the existing
candidate-stage custody binding (repository/Issue, cycle, authorization, Run and
Attempt). The flow sets custody result to the repair-record identity and binds the
complete exported workspace payload; a caller's placeholder result has no authority.
The record retains source identity/execution, Candidate, predecessor, next attempt,
policy, diagnosis and targeted invalidation. Prior history and Candidate bytes,
including mandatory ignored artifacts and hook sources, are retained alongside it.
Keep these custody payloads private when they contain private reviewer diagnostics;
only safe category codes belong in public logs.

Dispositions are `repair`, `scope-recovery`, `replan`, `wait`, `blocked` and
`reconcile`. A Shape concern first runs fresh read-only `shape-diagnosis` under
Skill `shape`. The reporter and all previous execution/request/result identities
are excluded. A valid Shape approval returns concrete corrections in the retained
diagnosis to ordinary repair policy. Exact conflict hashes, substring quotes and
reference validation are mandatory before recovery. `conflictReferences` is the
Core-supplied allowlist of concrete, currently verified Scope/Shape conflict proof
sources. A diagnosis reference outside that inventory cannot authorize recovery. Repetition never selects it.
`reconcile()` resumes unresolved diagnosis collection/termination; `stop()` requests
termination and then collects. Failed or unknown retention latches reconciliation;
Core must independently resolve retained state before constructing a fresh flow.
Arbitrary provider errors are never returned. Authority/external results persist
classified handoffs without launching a repair or performing a GitHub mutation.

A bounded repair start is charged when its durable `repair` reservation is released,
before #123 starts its replacement Writer. Count unique attempt identities under
the same signed policy. Durable reservations are conservative: a checkpoint failure
after persistence must be reconciled, not refunded by a blind retry. `replan`,
`wait` and diagnosis requests do not consume repair starts. Replayed source results
or reused next attempts cannot release another start. In-memory reservations also
count while Core history catches up. Across processes, Core must recover/validate
custody records and include every prior reservation in `history` before constructing
the flow; official Actions concurrency supplies serialization, not a custom lock.
Each history entry includes repositoryId, issueId, attempt, predecessor, policy,
disposition and source. An actual successor Candidate must use the released attempt
identity, retain its predecessor link and acquire fresh workspace/evidence bindings.

Before starting the next stage, #123 must persist/install `record.invalidation.current`
and the reservation/history through existing custody. `invalidateRepairEvidence`
retains original receipts and adds consumed result identities to affected current
envelopes. Drift in a stage or its inputs invalidates it and stages referencing its receipt,
execution or delivered Candidate under the same shared binding. Separately bound
fresh chains of the same Issue remain valid. Explicit repair invalidates Deliver onward; Scope recovery starts
at publication. `verifyCompletion` and the native dependency evaluator then reject
old completion, leaving unrelated Issues eligible. Missing currents also fail
existing evidence validation. Neither old Accept nor old CI/Review authorizes a
repaired Candidate. Both hook phases, independent Acceptance, PR, exact-head CI,
Review, protected Merge and final/closure/completion gates remain required.

Local proof: `node --test test/repair.test.mjs` uses disposable Candidate files,
existing Accept/lifecycle validators, custody publication/retrieval through recorded
official response adapters, connected completion receipts and native dependency
verification. `npm run check` and `npm run verify:archive` cover regression and the
installed public package. No submitted Candidate file is used as test scratch space.
