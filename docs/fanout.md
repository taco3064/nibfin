# Verified native downstream fanout

`createDownstreamFanout` and `resolveFanoutWakeup` are inert public Core APIs.
They consume Completion and controlled-operation interfaces; they do not publish
completion, start stages, mutate dependencies or supply a second scheduler.

## Producer and trusted capabilities

Call `fanout.wake({source, issues}, {signal})` after Completion's final receipt
publication/readback. Each Issue identity contains canonical `repository`, lossless
string `repositoryId`, `issueId` (node ID), `databaseId` and `number`. `issues` is the
authorized destination/upstream catalog, excluding source. It creates no edges.
Duplicate/conflicting identities reject the call before discovery.

The factory takes these trusted capabilities, never values from Issue/event prose:

- `provider`: the official provider's `request` and `collection` read methods.
- `currentSource(source, {signal})`: independent current complete chain `expected`
  (the production `verifyCompletion` context), `identity`, `cycle`, and original
  `provenance` (`event`, `repositoryId`, `runId`, `attempt`, `actorId`). Rebuild
  expectations from current authority/proofs, never from submitted receipt bytes.
- `retrieveReceipt(source, {signal, expected:{cycle,identity}})`: retrieve exact
  published receipt bytes through authenticated custody, independently binding the
  requested cycle/identity. Return `{bytes:Uint8Array, cycle, identity}` only after
  successful readback. Missing, expired, inaccessible or conflicting receipt custody
  throws; receipt-intent is not a receipt. Neither labels nor closed state qualifies.
- `currentTarget(target, {signal})`: check current per-target authorization; return
  `{ok, binding, workflow}`. `binding` is the recipient's controlled-operation binding,
  including original recipient operation Run/Attempt, Scope/Shape and authorization.
  Preserve that original binding on retry. `workflow` is trusted `{id,path,ref,sha,digest}`:
  numeric workflow ID, `.github/workflows/*.yml` or `.yaml` path, a branch or tag name such as `main` or `v1.0.0`, expected commit SHA and SHA-256 workflow bytes.
- `operations({request,beforeSubmit,concurrency})`: provide recipient-bound
  `createControlledOperations`, installing `beforeSubmit` in its constructor.
  Use `createAuthorizationBoundary` for actual target member/Assignee/Grant and
  Actions write permission. Keep lookup, request custody and execute inside the
  supplied official repository-write concurrency group. The controlled dispatch
  mutation guard reruns `beforeSubmit` after awaited authorization reads.

The retained intent's `payload.handoff` contains source stable identity, complete
receipt identity/cycle/original provenance, recipient identity and workflow pin.
Together with the recipient binding it derives the `fanout-<digest>` request ID.
Controlled-operation custody retains these exact bytes; lookup can reconstruct
`{id,source,origin,target,intent}` from that intent without an additional outbox.
Missing history must never attest a new request. Changed bindings produce a
separate identity; reusing an old correlation fails validation/recovery.

## Discovery, transport and results

Only the complete native `dependencies/blocking` collection discovers targets.
Every row is validated before any POST; malformed/duplicate/conflicting identities,
foreign pagination or an incomplete later page stop discovery. Unlisted targets
are reported denied. Each listed recipient is independently checked public (User
or Organization owner), identity-matched, authorized and currently blocked by B.
The source receipt and recipient configuration are checked again at submission.
D can receive a hint when C is denied or still waiting for another predecessor.

The official destination request is POST
`/repos/{recipient}/actions/workflows/{id}/dispatches`, with a documented branch/tag name `ref` and
`inputs:{nibfin_request,nibfin_correlation}`. Metadata is retained, not transmitted.
The workflow path, ref commit and exact content digest are independently read
before submission. Source repository permissions cannot authorize the recipient.
Target credentials need applicable Actions write permission; read capabilities
need Issue dependencies, repository, workflow and content access. See GitHub's
[dependencies API](https://docs.github.com/en/rest/issues/issue-dependencies) and
[workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

`discovered` means collection processing finished, with independent `outcomes`;
it does not mean every target succeeded. Empty discovery is a no-op. Each result
retains controlled-operation refs and safe observations, including unknown effects.
A confirmed dispatch observes a correlated Run, never successful recipient execution.
Response loss is reconciled with original custody/official Run reads; missing or
ambiguous Runs/history never cause blind resubmission. Earlier confirmed effects
remain in results when later checks fail. No rollback or exactly-once is promised.

Defaults: 10 pages per collection, 100 targets/parents per collection, 500 fanout
provider reads and 30 seconds total. Constructor limits have finite upper bounds;
controlled operations/custody/provider also apply their own limits. Cancellation
propagates; deadlines bound even capabilities ignoring signals. Host capabilities
must honor cancellation before external effects. Diagnostics omit exception text.

## Recipient and integration handoff

The configured workflow declares required string Dispatch inputs and run name
`nibfin-operation:${{ inputs.nibfin_correlation }}`. Pass only those opaque inputs to
`resolveFanoutWakeup({inputs,authenticate,lookup,dependencies,dependencyInput,signal})`.
`lookup` independently recovers the retained request. `authenticate` must verify
actual destination Actions identity, workflow content pin, ref/SHA, actor, Run and
Attempt against trusted policy/current request. An input flag is not authentication.
`dependencies` is the production `createDependencyEvaluator`; its current catalog,
authorization, completion expectations and custody capabilities recheck every
current direct/recursive predecessor. `ready` is dependency eligibility only:
Runner, applicability, Owner Grant and all stage gates remain the host's duty.

Branch/tag movement between checks and GitHub receipt is an accepted native race;
recipient execution must recheck its workflow pin. Legacy within-repository relay
SHA intents remain compatible, but fixtures do not prove raw SHA dispatch support.
Official Actions concurrency/queue semantics apply: no cross-repository lock,
atomic graph snapshot, instant revocation or guaranteed execution of every trigger.
No Webhook receiver, polling controller or Runner registration is installed here.

`tooling/fanout-fixture.mjs` exercises production orchestration, dependency evaluation,
signed authorization and artifact custody using disposable synthetic transports.
`test/fanout.test.mjs` also consumes the first-completion/recovery producer fixture.
Installed-archive verification runs these contracts against the installed exports.
These are local proofs, not real Dispatch/native event/Runner observations. #122
owns live cross-repository dependent wakeups; #123 owns live invalidation/recovery.
