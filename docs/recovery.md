# Post-merge incident recovery

`createRecoveryFlow(capabilities).run({signal})` is the Core-owned orchestration
interface. It returns `handoff` only after durable evidence and fresh authorization;
otherwise it returns a bounded `blocked` diagnostic. Agent/event/Comment content
cannot construct capabilities, select a target or authorize a repair.

This module implements local provider-contract behavior. Issue #123 owns live
failure injection, Comment/readback/Reopen, event delivery and the actual fresh
repair lifecycle. Fixtures do not establish any of those live observations.

## Trusted configuration

`current()` returns a stable snapshot with these fields (see the retained
`tooling/recovery-fixture.mjs` for concrete, explicitly synthetic values):

- `target`: canonical repository, repositoryId, stable issueId, databaseId,
  number and original cycle; `binding`: repositoryId, issueId, scopeHash,
  shapeHash and grant. `scopeBody`/`shapeBody` must match their body digests.
- `visibility: public`, `ownership: personal | organization`, `writerId`,
  originalGrant, previousAttempt, history, current baseRef and `next` containing
  a distinct cycle/attempt and the actual current branch Base SHA.
- `incident`: id, exact commit/environment/version/baseline, deploymentId,
  statusId, observedAt/maxAgeMs and failure (`deployment-failed`, `health-status`
  or `health-function`). `source` binds repository/ID, runId, attempt, jobId and
  pinned workflow. The module fetches exact official deployment, status, Run and
  Job resources; it never selects a convenient latest success.
- `delivery`: historical receipts/contexts through Merge; `mergeIntent` and
  confirmed `mergeOperation`; `responsibility`: exactly one independently mapped
  repositoryId/issueId/commit/Merge receipt identity. The historical chain remains
  required even if current completion has been invalidated. A Closed incident
  also supplies `completion`, `completionReceipt`, and historical
  `completionContexts`; an Open incident can explicitly supply `completion: null`.
- `evidence`: records and current envelopes keyed by content identity, as used by
  `invalidateRepairEvidence`. `source`: custody Run/Attempt. `intents.comment`
  and `intents.reopen` use the existing controlled-intent schema, the same owning
  target, writer, cycle and authorization. Comment payload is exactly
  `recoveryComment(pin, observation)` plus its controlled correlation marker;
  Reopen payload is `{state: "open"}`.
- `concurrency`: `nativeConcurrency` for repository-write, queue max, no
  cancellation. The trusted Actions caller must actually hold that configured
  group. `gates` contains current valid routing, isolation and effects checks.
  `health` uses existing deploymentHealthDisposition selectors, baselines and
  observations. Only this incident's matching environment/commit/baseline can
  receive the repair exception; dependency and other deployment failures remain.

Capabilities are trusted Core functions, never booleans from untrusted payloads.
`authenticate({incident,deployment,status,run,job,signal})` must independently
verify the pinned Workflow/source, freshness and the full failure observation,
including health-check evidence for health failures. URL syntax, OIDC identity,
a Run conclusion or arbitrary log text alone does not prove the incident.
Cross-repository evidence may inform that capability through traceable read-only
handoffs; all mutations here target the owning repository.

`authorization` is createAuthorizationBoundary; `dependencies.evaluate` and
`dependencyInput` use the native evaluator. `operations({intent,beforeSubmit})`
constructs createControlledOperations with that boundary, shared durable locator,
provider, custody and the supplied mutation guard. Do not discard the guard:
it rechecks dependencies and state after awaited authorization reads immediately
before transport. Comment and Reopen require separate permitted operation names.
GitHub Comment creation uses POST issues/{number}/comments; Reopen uses PATCH
issues/{number}. Both need appropriate official Issues write permissions.

`custody`, `publication` and `locate` use the existing artifact-custody contracts.
The locator maps identity/phase to original ref/source or positively attests
newness. Missing/expired custody is never newness. `installInvalidation` must
persist and independently read back the returned current envelopes before
returning `{outcome: "installed"}`; completion/dependency consumers must read
those installed envelopes. Historical receipts and Merge records stay intact.

`classify` independently returns failureClass, independent, incident (content
identity), issueId, effects (`reconciled`), identity, observedAt and expiresAt.
`repairAuthorization` independently verifies a fresh Owner Grant and returns ok,
grant, incident identity, repositoryId, issueId, operation `deliver-repair`,
revoked, validFrom and expiresAt. It must bind `next` and current Base, including
all applicable owner policy/repair limits. This Grant differs from originalGrant
and must have been issued for this incident, not reused from completion. Ordinary
Comment/Reopen permission, a Comment or an event cannot replace this check.

## Ordering, retries and outputs

Closed: attribute, retain original incident/lifecycle, install completion
invalidation, retain Comment intent/attempt, authorize POST, independently GET the
exact unedited Comment and retain it, separately authorize PATCH, verify actual
Reopen plus exactly one new lifecycle occurrence by the writer, retain, classify,
verify fresh repair Grant/Base/health and retain handoff. Open: retain attributed
failure and invalidation, then release the direct repair input without Comment,
Reopen or a reopened-event dependency. Unknown effects always stop continuation.

Original operation custody survives restarts. A lost write response is reconciled
with independent reads; a verified prior result is reused without duplicate
writes. Missing submission custody, edited/duplicate correlated Comments,
incomplete event/comment pages, reclose or manual/ambiguous transitions block.
There is no global exactly-once guarantee. Custody interruptions must be resolved
through the same original locator, never by creating new correlations.

Public Comments contain bounded identifier fields, hashes, an exact verified
Actions URL and a fixed failure description. Raw exceptions, logs and extra fields
are omitted; hostile Markdown, control characters, token-like labels and oversized
fields are rejected. Private details belong only in authorized protected custody.
Returned errors never interpolate provider exceptions.

Handoff contains a new cycle/attempt/Base, original Merge and provenance,
classification, fresh Grant, invalidation and mandatory downstream gates. It is
input to an independent Recovery Action, not an executed Action or dispatch.
`eventObserved: false` deliberately makes no event-delivery claim. Native reopened
or an explicitly approved equivalent dispatch must be separately observed; the
provider's GITHUB_TOKEN recursion limits still apply. Repair needs a new
Candidate/PR, Hooks, independent Accept, exact-head CI, Review, protected Merge,
fresh healthy deployment/final proofs and Closure/Completion. Shape/Scope concerns
stop for separately authorized handling; nothing restores Scope to erase a Merge.

Official transport contracts: [Issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10)
and [Issue updates](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10).
