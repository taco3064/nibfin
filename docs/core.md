# One Core stage per invocation

`createCore`, `coreStages` and `createDeliverFlow` are public exports from
`@nibfin/core`. Import and construction perform no IO. This is the production
composition surface; it does not dispatch Actions, register Runners, manage a
queue, modify dependencies or imply that a stage has run on GitHub.

The host supplies `createCore({current, provider, authorization, dependencies,
selector, owners})`. `provider` is the maintained GitHub provider;
`authorization`, `dependencies` and `selector` implement the maintained
AuthorizationBoundary, DependencyEvaluator and AssigneeSelector interfaces.
`owners` contains **constructor configuration**, not stage-success callbacks.
Core constructs the maintained flows itself. Configure only supported surfaces;
a selected stage with a missing owner blocks. Capability configuration must be
trusted code outside Issue, event, Agent and artifact content.

Call `inspect(request)` for a read-only fresh decision, then retain its `current`
as `request.expected` through authenticated custody/relay. `run(request)` repeats
all observations and executes at most one stage. Inspect is not authorization.

```js
const request = {
  version: 1,
  target: {repository: 'example/core', repositoryId: '42', issueId: 'I_existing',
    databaseId: '61', number: '101'},
  cycle: 'cycle-1', request: 'authenticated-request-1',
  run: {id: '100', attempt: '1'},
  expected: {stage: 'deliver', decision: 'a'.repeat(64)}
};
const result = await core.run(request);
```

These are exact request keys. IDs/numbers are canonical decimal strings; request,
cycle and Issue node identities are bounded identifiers. The host independently
binds `current().invocation` to `{request, run}`. An event does not authenticate
itself. Commands, environment, role, Skill, endpoint and capability fields are
not accepted in requests. A new Run must receive its own authenticated invocation.

`current()` must freshly resolve this detached trusted context:

| Field | Contract |
| --- | --- |
| `target`, `cycle`, `invocation` | Exact stable target and authenticated actual Run/Attempt |
| `visibility`, `ownership` | `public`; `personal` or `organization` |
| `scopeBody`, `shapeBody`, `binding` | Current original Scope; proposed/published Shape or null; maintained evidence binding with separate body digests |
| `authority` | `{export, context}` inputs to `verifyAuthority`; identity/cycle must match binding |
| `receipts`, `evidenceCurrent` | Stage-keyed submitted envelopes and **independently resolved** `{expected, consumed}`; never derive expectations from receipts |
| `candidate`, `base`, `head`, `ciIdentity` | Current applicable Candidate descriptor, Git identities and CI identity; null before applicable |
| `dependencyInput`, `selectionInput` | Actual maintained evaluator/selector inputs, including native authorized catalog, current registration/conditions and reconciled execution state |
| `completion`, `completionCurrent` | Full completion receipt/current chain or null; never a label assertion |
| `transition` | null, or `recovery`/`repair` from an attributed owner handoff; the owner independently checks classification and permission |
| `operationIdentity` | Retained original operation/custody identity or null before operation creation |
| `prior` | `{state:'new'}`, `{state:'resolved'}` or `{state:'unresolved', stage, request:{request,run}}` from owner execution/intent reconciliation |
| `stageInput` | Exact selected owner's data argument, null for no-argument methods; identity participates in the queued decision |

Resolve prior effects through lifecycle, controlled operations and custody owners.
The complete prior execution state and identity participate in queued decisions
and are rechecked at dispatch and owner checkpoints, including after role preparation.
Missing execution evidence is not `new`. A confirmed result yields waiting rather
than duplicate execution. An unresolved Agent role uses its retained owner's
`reconcile()` with the original request identity; a different actual Run may
collect it. Unsupported reconciliation blocks. Stateless write flows require an unchanged `operationIdentity` matching
`prior.operationIdentity`, then retain and reconcile their original operations through their configured custody/intent
owners; never invent a new correlation to retry an unknown write. Owner instances
with an active process must remain available until termination is established;
losing the instance requires host reconciliation, not construction of a new Writer.

Core reads the actual repository/Issue, compares exact body/identity/publicness,
verifies current authorization/authority, evaluates native dependencies and calls
the selector. Body is Scope until publication, Shape afterwards. Closed state and
manual labels cannot create evidence. Semantic dependency edges/completions and
member/routing enter the decision identity, alongside Scope, Shape, Candidate,
base/head, CI and evidence identities. Timestamps do not create artificial drift.
Core repeats its checkpoint before dispatch. Owner pre-operation guards remain
mandatory during subsequent awaits; these checks are not atomic GitHub snapshots.

| Selected stage | Prerequisite; maintained owner call |
| --- | --- |
| `shape` | No Author receipt; ShapeFlow `author()` |
| `shape-validator` | Current Author; ShapeFlow `validate(authored)` |
| `publication` | Current independent Validator; ShapeFlow `publish(validated)` |
| `deliver` | Current publication; DeliverFlow `run()` |
| `pre-accept-hooks` | Current Deliver/Candidate; HookRunner `execute(hookInput)` |
| `accept` | First hook receipt; AcceptFlow `run()` |
| `pre-commit-hooks` | Independent Accept; HookRunner `execute(hookInput)` |
| `pr` | Second hook receipt; CandidatePublication `run({signal})` |
| `ci` | Current PR; `observeGithubCI(stageInput)` with configured `owners.ci.provider` |
| `shaper-review` | Current exact-head CI; FinalReview `run()` |
| `merge` | Independent final review; ProtectedMerge `run({signal})` |
| `final` | Confirmed Merge; required deployment policy repository/commit must match the selected target/Merge; `verifyDeployment(stageInput)`; host retains required post-merge proof through its normative owner |
| `closure` | Complete final proof; CompletionFlow `close({signal})` |
| `delivered` | Legal closure; CompletionFlow `complete({signal})`, independently verifying/retaining full completion |
| `fanout` | Completed stage chain; DownstreamFanout `wake(stageInput,{signal})` verifies actual receipt and native blocking relationships |
| `recovery`, `repair` | Attributed owner transition; RecoveryFlow/RepairFlow `run()` |

`selectionInput.operation` and its execution observation must match the selected
operation. Stage aliases use existing owner permissions: publication → publish-shape,
pr → commit-pr, ci → observe-ci, final → verify-deployment, closure → close,
delivered → mark-delivered; other stages retain their names.
Each normal stage requires a contiguous current prefix. Core compares every
receipt using actual evidence validation, shared identities, independent role
identities, Candidate correspondence, upstream content references and head/base.
A missing prerequisite selects that prerequisite, never a successor. Authenticated
queued decisions must match the fresh selection exactly. Stale work returns
`superseded` without dispatching a replacement. Invalid evidence blocks rather
than silently deleting it. Native dependencies alone determine predecessors;
unrelated siblings do not impose a Shape barrier.

Owner configurations use the existing documented constructors under keys `shape`,
`deliver`, `hooks`, `accept`, `publication`, `review`, `merge`, `completion`,
`fanout`, `recovery`, `repair`. `owners.hookInput(stage,pin)` supplies the actual
HookRunner input (protected workspace, exact phase, profile/message and required
first-pass/Accept evidence). This trusted function cannot be request content.
`createDeliverFlow` takes `{current,captureInput,prepareRole,evidenceCurrent}`:
current includes Scope/Shape/binding, publication/current, instructions and
`capture:{root,base,permittedPaths,binding}` descriptor; prepareRole binds the entire task to the actual lifecycle;
captureInput supplies the maintained captureWorkspace input after termination.
The owner confirms termination before capture and collection. When prepareRole
returns `bindCandidate(candidate)`, it passes that captured candidate through this
trusted capability before collecting the complete evidence. The maintained role
host checks the original launch context before replacing only its candidate field;
full expected-envelope comparison and capture equality remain mandatory.
Final Candidate bytes are derived after Writer termination, never required as
foreknowledge before launch. A Deliver lifecycle can use the maintained
`startCurrent` contract for launch identity; its full `current` envelope is
independently constructed from protected capture for collection. The capture descriptor fixes the allowed baseline
and paths; it does not predict the implementation. Owner current bindings must
match the entry target and Scope/Shape before owner reads/roles/writes proceed.
Owner checkpoints bind their workspace Candidate and retained upstream evidence to
the selected decision before role launch or writes. Returned stage evidence must
also correspond to that pinned Candidate, base/head and predecessor references.
Shape handoffs compare complete Author/Validator receipts with the selected chain
before validation/publication; nested role results are checked before stage success.
The seam compares lifecycle output and exact captured Candidate, never treating
exit zero or an Agent success string as sufficient.

Result version 1 has `target, cycle, request, run, requested, current, executed,
disposition, reason, inputs, owner`. `current` is `{stage,decision}` or null;
`executed` is the one invoked stage or null. `inputs` contains applicable bound
identities; stage data itself is represented by a content identity. `owner` is
null or `{outcome,identity,output}`, preserving the maintained owner's exact safe
result/evidence for custody publication. Persist that complete output through the
existing custody owner before any successor Run; its identity alone is not proof.
Invalid request syntax returns only version/disposition/reason, since it has no
trusted identity. No raw caught exception/provider body is returned.

Dispositions are `completed` (this stage only), `waiting`, `blocked`, `superseded`,
`rejected`, `unresolved`. None claims the Issue is delivered. Unknown termination,
timeout, cancellation and missing owner output cannot become completion. The
Core checks cancellation after owner reads and role preparation, and passes the signal to lifecycle start so cancellation during readiness prevents backend launch. Once launch has begun, unresolved execution retains its original reconciliation identity; cancellation cannot authorize a replacement Writer. Deliver compares its complete publication receipt with the selected predecessor before launch. The
calling host retains result/Run/Attempt and original operation references using
existing custody/relay protocols. An in-memory invocation guard refuses a second launch in the same Run; durable
execution and effects still belong to the existing owners. Core creates no second
persistent execution store.

Verification uses signed synthetic GitHub response fixtures, independent recording
lifecycle invocations and verifier-owned disposable Git/workspaces/processes.
These are local contract tests, not real models, registered Runners or Actions
Runs. Live stage execution and parallel recovery integration belong to #121–#123.
Node 22/npm 10, locked `npm ci`, `npm run check`, `npm run test:artifact-sdk` and
`npm run verify:archive` verify source, SDK and disposable installed consumers.
The mandatory `out/nibfin-core.tgz` is verified byte-for-byte against source;
independent reviewers consume it without rebuilding the protected Candidate.

The fixed donor origin, API adapters and ownership boundaries are recorded in [upstream source reuse](nibfin-reuse.md).
# Native diagnostics

A protected host may supply `onDiagnostic` to receive the stage, intake/owner
phase and a bounded internal error code after an exception. Raw provider/model
error text is never forwarded. Diagnostic failure cannot change the original
blocked or unresolved disposition, grant permission, or restart a role.
