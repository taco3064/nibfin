# Native Issue and approved Dispatch relay v1

`createEventRelay` and `issueWakeup` are inert public exports of `@nibfin/core`.
Importing them neither authenticates nor starts work. This module implements local
adapter behavior; #123 owns deployed event integration and #122 owns graph fan-out.
No local fixture demonstrates a live Actions Run, webhook subscription or delivery.

## Event contract

`relay.wake({name, payload})` accepts exactly these two envelope keys.
`name` is `issues`, `workflow_dispatch`, or `suppressed`. Raw webhook events,
`repository_dispatch`, `ping`, comments and command/role/target inputs reject.
Dispatch payload has exactly `nibfin_request` and `nibfin_correlation`, both opaque
1–80 character ASCII letters/digits/underscore/hyphen strings. They select a known
Core request and its existing correlation; neither supplies a command or authority.

Issue payload is a bounded projection with exactly `action`, `repositoryId`,
`issueId`, `number`, `label`, `stateReason`. Database IDs are canonical positive
strings; issueId is the stable GitHub node ID. The trusted host extracts these
from the official repository.id, issue.node_id/number, label.name and
issue.state_reason fields. For opened events, label is `scope` only when the
actual Issue labels contain scope; otherwise null. Absent label/stateReason is
explicit null. The host must authenticate this projection against its real event;
a JWT proves Actions context, not arbitrary payload bytes or predecessor success.
The adapter cannot reconstruct a real event from an untrusted supplied projection.

| Official Issue action | Condition | Core hint |
| --- | --- | --- |
| opened / labeled | scope | resolve |
| labeled | shaped | deliver |
| closed | completed state reason | completion |
| reopened | any | recovery |
| edited, unlabeled, assigned, unassigned, milestoned, demilestoned | any | reevaluate |
| labeled | delivered | observation only, ignored by this relay |
| other actions/labels, non-completed closure | any | ignored |

`issueWakeup` performs only this pure mapping. A hint proves no prior stage,
publication, closure, recovery or current execution eligibility. Delivered hints
never perform graph fan-out. Ignored hints perform no lookup, write or stage work.

## Trusted configuration and capabilities

Construct `createEventRelay({authenticateEvent, loadRequest, loadPredecessor,
verifier, currentGate, operations})` outside untrusted checkout/payload control.
All are trusted Core capabilities; functions cannot be supplied through JSON.
`verifier` is the existing Actions verifier; `operations` is the existing
`createControlledOperations` with authorization, provider and artifact custody.

- authenticateEvent receives a copied envelope, independently validates the event
  projection and authenticates its current Actions source. Return the Actions
  verifier's authenticated result. Expected policy must come from current Core
  authority, never token claims or event booleans. Source matching requires public
  visibility, exact repository/workflow/ref/content and allowed actor; provenance
  retains actual observer Run/Attempt separately from the original operation.
- loadRequest receives `{request}` for Dispatch or `{hint, repositoryId, issueId,
  number}` for native/suppressed hints. Return the independently configured request;
  unknown, missing or inaccessible mapping throws. Never infer a new operation
  from missing history. Native selectors must agree with the resolved binding.
- loadPredecessor(request) retrieves persisted evidence and independent current
  expectations, returning arguments to `verifier.predecessor`: authenticated
  source, complete receipt, current expected/consumed results, freshness times
  and independent consumer execution. The module compares the verified receipt's
  content identity, original request/result, repository, Issue and Scope/Shape.
  Core's lookup binds that exact receipt to the current lifecycle cycle. An
  unsuccessful, stale, consumed, forged, partial or mismatched result blocks.
- currentGate receives `{request, wakeup, source}` and must freshly check current
  authorization, native dependencies, upstream completion, stage/Candidate
  applicability and Runner eligibility. Return each of `authorization`,
  `dependencies`, `upstream`, `applicability`, `runner` as true only after existing
  Core checks pass. This is a capability result, never a payload assertion.
  Required Issue changes additionally require `mutationReadback:true` after
  verifying the actual publication/Close/Reopen and its applicable proof. Recovery
  and Completion hints enter their Core reevaluation without inventing success;
  all required proof remains part of applicability. Denial causes no operations
  call. Operations independently rechecks its existing authorization before writes.

The request has exactly `{id, hint, intent, sourcePolicy, predecessor, fallback,
mutation}`. `intent` is an existing controlled dispatch intent, with fixed source,
repository, destination workflow ID, immutable SHA ref, original request identity,
Scope/Shape/cycle/authorization/Candidate binding and correlation. Its two inputs
are the same opaque request ID and correlation; source.request initially equals
id. This version supports within-repository stage relay only.
`sourcePolicy` is exactly `{repositoryId, workflowRef, workflowSha, workflowDigest,
ref, actorIds, suppressionEvent}`. The last field identifies the actual writer's
Actions event (`issues` or `workflow_dispatch`) for suppression recovery; it does
not assert receipt of a native successor event. `predecessor` is null for a pure
eligibility hint, otherwise exactly `{identity, request, result}` for the complete
persisted receipt. Deliver and substage requests always require a predecessor.
`mutation` is `required` or `not-applicable`; Deliver, Completion and Recovery
require mutation/readback. `fallback` is exactly `{approved, reason}`; approved
Dispatch requires a nonblank independently approved reason.

## Dual wakeups and recovery

The canonical wakeup is `contentIdentity({version:1, request})`, using the complete
resolved configuration, not event transport or new observer Run. Its binding
includes original source/request, predecessor identity, cycle, Scope/Shape and
destination. The controlled operation source.request becomes `relay-<wakeup>`;
its inputs retain the original selector. Thus immutable retained intent/custody
binds the relay identity too. Reusing a correlation with changed bindings fails
existing intent recovery rather than bypassing dedup. New valid cycle/result
requests use new correlations. Core must retain original request lookup and
operations references across independent Runs; missing custody is blocking.

Official concurrency must enclose the complete relay invocation, including
lookup, gates, retention, submission and reconciliation. Use the existing
Issue group at workflow level and repository-write group for the relay job, both
with cancel-in-progress false. All controlled writers of that repository must
share its write group. `relayConsumerConfiguration` in the retained executable
fixture produces those real fields, the Issue filters, Dispatch-only opaque inputs
and the required correlation run-name. Its job executes the retained relay tests
with controlled capabilities; `executeRelayConsumer` calls the real API;
it is tested both in the source tree and installed archive. It is a local
configuration fixture requiring trusted host wiring, not a deployable workflow.
No custom scheduler, outbox, lock, lease or arbitrary-failure exactly-once claim
is introduced. Pending capacity/cancellation remain official Actions behavior.

Results are ignored, blocked (fixed safe reason), waiting (including unknown
operation outcome), or run-observed. Top-level continuation is always false:
run-observed proves only an independently read correlated Run exists, never that
its stage succeeded. The nested operation retains existing reconciliation refs
and its operation-level continuation semantics, not stage permission. Recovery
re-observes effects with the original intent and new observer provenance. Lost
submission responses, interrupted artifact retention, missing/ambiguous Runs,
failed/partial pagination, expired artifacts and denied readback never authorize
blind resubmission. No arbitrary provider body or exception text is published.

## Provider limits and retained proof

GitHub documents [GITHUB_TOKEN event suppression and official Dispatch exceptions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
For a known suppressed Issue change, pass `name:'suppressed'` with the same
projection through authenticated Core context. An approved fallback dispatches;
otherwise it returns waiting. Provenance records suppressed, not native delivery.
Dispatch replaces only the wakeup; it never substitutes the actual Issue mutation
and independently verified readback.

[issue_dependencies is a separate webhook event](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_dependencies).
This module offers no webhook receiver or optional integration. Without an already
authorized official integration there is no immediate dependency-change delivery.
Use manual/approved Dispatch reevaluation or upstream completion's targeted wakeup
and recheck current native dependencies. No webhook server is required for Dispatch.
A raw signature, Delivery ID or ping cannot authenticate this adapter input.

Fixtures retain adapted official Issue fields, synthetic RSA/JWT verification,
signed synthetic Grants and real local operations/custody/provider mechanisms.
They do not claim live integration. Public individual/organization ownership is
independent of Runner registration level and optional registration convenience;
no private-product support or registration behavior is added.

Verify with Node 22/npm 10: `npm ci --ignore-scripts --no-audit --no-fund`, then
`node --test test/relay.test.mjs`. The full `npm run check` uses local boundary doubles without an SDK download.
The separate `npm run test:artifact-sdk` requires the genuine runtime described
in [custody.md](custody.md) via NIBFIN_ARTIFACT_SDK_ROOT. Run
`npm run verify:archive`; it writes local out/nibfin-core.tgz. The current
Issue Shape determines whether that output is a required Candidate artifact.
Archive verification compares all included bytes and runs the relay contract
suite using the installed public package in credential-free offline scratch.
Independent reviewers use their own disposable files/processes; submitted
Candidate bytes remain protected. Missing prerequisites are failures/limitations,
never skipped successes. No new hook configuration is introduced.
