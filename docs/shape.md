# Shape orchestration

`createShapeFlow` advances an existing public personal or organization Issue through
Author, independent Validator, and Core publication. It never schedules siblings,
changes dependencies, assigns people, or grants permissions. Both execution roles
use the shape Skill and read-only lifecycle workspace. Original Scope and proposed
Shape are separate byte identities (`bodyDigest`, the existing JSON-string digest).

The trusted Core constructs these capabilities; none may come from checkout prose,
event payloads, Agent output or arbitrary success predicates:

- `current()` returns a fresh snapshot: target (repository, repositoryId, issueId,
  databaseId, number), original (kind `raw-scope`, body, hash), evidence binding,
  approved instruction configuration, correlation, source, operationBinding and
  decision identity. Evidence binding uses the existing evidence API fields.
  `operationBinding` uses the controlled operations contract (cycle, run/attempt,
  candidate/base/head, etc.). Source uses its existing request/event identities.
- `authorization` is `createAuthorizationBoundary`; `dependencies` is
  `createDependencyEvaluator`, with its trusted `dependencyInput` catalog/target.
  Current live native dependencies are read at every checkpoint.
- `prepareRole({role,skill,instructions,task})` returns `{lifecycle,input}` using
  `createAgentLifecycle`. Supply the exact task to the backend's trusted task
  resolver (for Codex, its `task` capability). The task contains original Scope,
  authority, target, exact proposal, Author identity and obligation observations.
  Core owns execution IDs and current expected evidence. Do not synthesize approval
  from an Agent's body or summary. `readBody(executionId)` retrieves exact Author
  output bytes; `evidenceCurrent(executionId)` independently supplies current
  expected evidence and consumed IDs for `compareEvidence`.
- `obligations()` refreshes independent evidenced Scope artifact requirements and
  complete repository hook observations for `reconcileCandidateObligations`.
  Declared ignored artifacts remain mandatory at Candidate capture; Shape does not
  require future implementation artifacts to exist during authoring.
- `operations({beforeSubmit,concurrency})` returns `createControlledOperations`
  configured with that guard. Body and shaped-label recovery require the retained boundary
  submission receipt for the exact attempt; a pre-guard attempt alone cannot
  establish publication provenance. Use the supplied native repository-write concurrency
  group on every controlled write workflow. Retain custody intent/attempt/submission/result
  and recover original references through `locate`; missing history must not be
  classified as new. The guard runs after retention, immediately before transport.
  Core supplies operation authorization independently of role results.

`propose()` returns `validated` with original, Author/Validator receipts and exact
inventory, or `blocked` with a finding. A rejected/malformed result cannot publish.
For a same-Issue correction, invoke fresh roles and independent validation again.
Never reinterpret a published Shape as raw Scope or reuse approvals after drift.

`publish(validated)` revalidates current evidence, then performs the exact body
PATCH and additive shaped-label POST through controlled operations. The new
`issue-body` operation permits only a nonblank body and the intended Issue target.
Each effect has independent repository/Issue readback; complete labels are read
separately. Publication includes original Scope, exact Shape identity, distinct
executions, validation identity, Core decision and controlled custody/readback
provenance. Matching bytes or manual labels alone cannot fabricate that evidence.

Unknown effects remain blocked. Reinvoke publication with the same retained
request to reconcile; it never blindly submits a second request. A foreign edit
stops continuation, including after a partial body or label effect. Permission
denial before transport is not an automatic retry authorization. Reauthorize and
use the controlled operation recovery contract; do not discard intent history.
GitHub offers no atomic body/label transaction: a concurrent edit can occur after
any check. Final divergent readback cannot succeed; no exactly-once or instant
revocation guarantee is claimed. Stopped executions require the backend's normal
stop/termination reconciliation before reuse.

#121 and #123 consume the exported flow and traceable publication/custody evidence
as read-only handoffs for real lifecycle and diagnosis/recovery observations.
`tooling/shape-fixture.mjs` and `test/shape.test.mjs` use recording adapters and
verifier-owned custody scratch storage. They prove module wiring and rejection
behavior only, not real models, native isolation, actual GitHub publication or
Actions success. Independent Acceptance, Candidate/Hooks, exact-head CI, protected
Merge and closure remain subsequent Core gates.
