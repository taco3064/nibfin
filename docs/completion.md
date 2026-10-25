# Closure and first Completion

`createCompletionFlow` is a callable Core module. Its `close()` and `complete()`
methods return `closed`, `completed`, or sanitized `blocked` results. These are
module results, not independent Acceptance or permission grants. Importing the
module performs no credential lookup, remote mutation or downstream fanout.
Personal- and organization-owned public repositories follow the same gates;
private targets are excluded. Runner registration level and automatic registration
are unrelated to repository ownership.

Core injects trusted capabilities; Issue/event/agent content cannot supply them:

- `current()` returns a current snapshot with `binding`, `target`, `visibility`,
  `ownership`, authenticated decimal `writerId`, original `scopeBody`, published `shapeBody`, `decision`, Candidate
  identity `candidate`, and canonical `receipts`/independent `contexts` through
  `final`. Binding uses existing evidence identities, including Grant/policy and
  runtime. Target contains canonical `repository`, `repositoryId`, `issueId`,
  `databaseId`, decimal `number`, and `cycle`.
- The snapshot also contains original controlled `intents.close`, `intents.label`,
  `mergeIntent`, the custody-backed protected `mergeOperation`, current
  `postMerge` policy, `deployment` policy, original producer `deploymentObservation`,
  optional `health` configuration, and
  publication `source: {runId, attempt}`. Persist original intents and decision
  across retries; a new Run must not invent replacement correlations.
- `authorization.eligibility`, `dependencies.evaluate` and `dependencyInput`
  refresh existing authorization and native dependency gates. `provider` supplies
  independent official GET/collection readback. `observe({signal})` should call
  `observeClosure({provider,target,mergeIntent,signal})`; it checks actual Merge
  destination membership and retrieves full Issue lifecycle events. Actor ID,
  occurrence ID, completed semantics and closure time are independently checked.
  The close event actor must match `writerId`, independently of the triggering
  event actor. Incidental actor profile fields do not define closure identity.
- `postMerge({policy,commit,target,signal})` independently verifies every current
  policy-required post-merge proof and returns the existing proof schema. For
  not-applicable policy its explicit reason must match. It must never return a
  cached success or a repair-health exception. Required deployment is read and
  verified using the existing deployment producer, including bounded health
  checks, commit/environment/version, source Run/Attempt and applicability.
  Fresh native observations must agree with the retained producer observation;
  its original timestamp is checked for freshness and retained in the proof
  identity, so a reread never silently creates a different Final Proof.
- `operations({intent,beforeSubmit,concurrency,causalClose})` constructs existing
  `createControlledOperations` with its custody, authorization and original
  request locator. Forward mandatory `causalClose:true`, the guard and repository-write native concurrency
  configuration. Close/label guards run after authorization reads immediately
  before transport. The returned operations instance must expose `causalClose:true`;
  Closure rejects an adapter missing this mode before mutation. The low-level
  Close default preserves its prior noncausal transport recovery contract.
  No credentials or mutation capability enters reviewers.
- `custody.retrieve`, `publication({phase,identity,expected})` and
  `locate({phase,identity,target})` retain/recover `completion.json` with existing
  `prepareCustodyManifest`/`publishCustody`. Publication returns the official
  artifact client/runtime facilities. Locator returns `{outcome:'found',ref,
  source:{runId,attempt}}` for the original artifact, or `{outcome:'new',identity}`
  only after positively establishing no prior attempt. Persist publication
  intent/reference discovery in the trusted host before upload; reconcile lost
  responses using the exact phase/source/manifest, never latest-name guessing.
  Missing/expired custody or unknown upload effects must return unavailable,
  never new. The module does not retry unknown uploads or overwrite conflicts.
- `stageCurrent(stage,record)` returns independently expected evidence context
  for `closure` or `delivered`, binding `inputs.readback` to
  `contentIdentity(record)`. Core authenticates source and current expectations;
  hashes alone do not authenticate records. `now` optionally supplies a clock.

Close validates the linked chain through Final Proofs, retains the open-state
`close-start`, submits completed-close through controlled operations, reads back
and retains causal `closure`, then constructs Closure evidence. Already manually
closed Issues cannot start this process. Reclose occurrences invalidate old
records, including same-second reclosures. Ambiguous same-timestamp close events block;
event ID ordering is never treated as time authority. Later unrelated Issue metadata updates
are not closure occurrences. Base advancement is acceptable when official readback
still proves the exact resulting merge commit belongs to destination history.

First Completion requires this retained Closure, refreshes current gates, publishes
and reads back delivered, retains `delivered`, constructs canonical v1 completion,
retains exact `receipt-intent`, publishes `receipt` and retrieves/verifies its exact
canonical bytes. It never requires an existing delivered stage or receipt first.
Fresh instances recover original records; matching current receipts are reused
without duplicate confirmed publication. Existing labels alone cannot establish
completion. Unknown effects, unauthorized reads, changed proofs, revoked authority
or stale closure block success. Consumers still independently call
`verifyCompletion` and the native dependency evaluator with current expectations.
`verifyEvidenceChain(payload,contexts,'final'|'closure'|'delivered')` validates
prefixes with the same linkage rules without inventing a new receipt hash domain.

Run `node --test test/completion.test.mjs`, `npm run check` and
`npm run verify:archive` on Node 22/npm 10. The archive includes this public API and
is checked byte-for-byte against source, then installed into disposable storage.
Tests use synthetic provider/custody data and a disposable loopback health server;
they never establish real completion, unlock actual work, or mutate real Issues.
#121 owns actual first Closure/Completion/receipt readback; #123 owns live duplicate,
recovery and invalidation evidence. Downstream Dispatch, deployment execution,
Recovery Comment/Reopen and unsupported artifact runtimes remain outside this API.

Provider field contracts: [GitHub issue event schemas](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)
and [Issue event collection](https://docs.github.com/en/rest/issues/events).
