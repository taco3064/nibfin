# Native dependency readiness

`createDependencyEvaluator` exports a callable, read-only planner surface. It does
not schedule Runners, dispatch work, choose priority or grant execution authority.
#103 owns this production module and retained local proof; #122 owns live graph,
readiness integration and downstream wakeup evidence. Fixtures are synthetic.

```js
import {createDependencyEvaluator} from '@nibfin/core';
const evaluator = createDependencyEvaluator({
  provider, authorize, current, retrieve, custody,
  maxNodes: 100, maxReads: 300, maxEdges: 1000, maxDepth: 100, timeoutMs: 30000
});
const decision = await evaluator.evaluate({target, issues}, {signal});
```

Native GitHub workflows select `progressSource: 'github-labels'`. In that mode,
the evaluator observes the current `scope`, `shaped` and `delivered` markers and
closed Issue state for every prerequisite. This reuses Kairo's Owner-project
progress observation while retaining Nibfin's bounded traversal and independent
per-repository authorization. Removing a delivery marker makes the prerequisite
wait, even when an old local receipt exists. Contradictory live delivery state
blocks. A new host does not have to recreate historical private completion data.
No label observation grants execution permission or fabricates a completion/Run.
`progress` contains these source observations; `completions` remains empty.

The default `progressSource: 'completion'` retains the existing portable receipt
contract for callers that explicitly consume that evidence protocol. Its
`current`, `retrieve` and `custody` capabilities below are not used by the GitHub
label mode. The selected workflow has one progress source, without a receipt or
label fallback that could override the other source's current state.

`target` and every `issues` catalog entry have canonical lowercase `repository`
(owner/repo), decimal-string `repositoryId`, `databaseId` and `number`, and a
separate stable node `issueId`. Database IDs are never converted to Number.
The trusted caller supplies the current authorized Issue catalog; catalog entries
are not dependencies. Only complete native `blocked_by` reads establish edges.
Target must exactly match its catalog entry. Duplicate identities/coordinates and
inconsistent repository IDs reject. Cross-repository upstreams must be explicitly
present in this catalog; public visibility alone grants nothing. Personal and
organization-owned public repositories share the same interface; private rejects.

All capabilities are trusted Core inputs, never obtained from Issue text, provider
responses, artifact contents or receipts:

- `provider` is `createGithubProvider(...)` or an equivalent trusted bounded
  `request`/`collection` implementation honoring `signal` and `allowPage`. Reads
  use GET for repository, Issue and native dependency endpoints. Collections must
  report `complete`; pagination may only remain on that exact dependency path
  with positive integer page/per_page parameters. Provider retries have their own
  finite limits. `maxReads` bounds logical single reads plus collection pages,
  not transport retry attempts. No mutations or credential lookup at import occur.
- `authorize(issue, {signal})` performs fresh N04 authorization using
  `createAuthorizationBoundary().eligibility(...)`. The trusted host constructs
  the N04 checkpoint from the supplied stable Issue identity and actual authorized
  member/operator/Grant context. Return the N04 result with `ok:true` and observation
  bound to repositoryId, issueId and operation `readiness`, with integer startedAt
  and observedAt. Do not adapt an old result or replace failed eligibility with
  provider claims. The host's Grant must permit the read-only readiness operation.
  The boundary owns clock/freshness policy and live public/member/Assignee checks.
- `current(issue, {signal})` independently obtains current upstream expectations:
  `{identity, expected, custody?}`. `expected` is the existing `verifyCompletion`
  full chain context, each stage `{expected: envelope, consumed: resultIds}`;
  `identity` is the independently expected completion identity. Null/missing
  expectations mean dependency waiting. Never derive them from the submitted
  receipt. Obtain current Scope, separate Shape, Grant/policy, Candidate, head/base,
  Run/Attempt, CI, merge, proofs and closure through their normative Core owners.
- `retrieve(issue, {signal})` retrieves a submitted N06 completion envelope. Its
  hash is insufficient: production `verifyCompletion` compares the full chain
  against `current` and binds the result to this upstream's repository/Issue.
- When `current` supplies `custody`, the evaluator instead calls
  `custody.retrieve({...current.custody, signal})` from `createArtifactCustody`.
  Supply its existing independent `ref`, `expected` and `evidence` inputs and a
  `path` naming the UTF-8 completion JSON payload. The extra path is selection
  metadata, not artifact authority. Retrieval must return `retrieved` with that
  payload. Missing, expired, denied or mismatched custody fails closed. Custody
  validates artifact/source bindings; the completion verifier still checks the
  full delivery chain. Trusted direct retrieval is useful for retained fixtures.

Inputs are snapshotted before asynchronous work; capability-returned current
contexts are copied before retrieval. No receipt or provider data supplies trusted
expectations or functions. All direct and recursive upstreams require valid
completion. Roots need authorization and successful complete graph reads but no
completion of their own. Shared ancestors are verified once per evaluation;
recursion-stack cycles reject. Each invocation has its own observations and no
cross-invocation cache, global barrier or imposed ordering.

Results contain `outcome` (`ready`, `waiting`, `blocked`), `target`, `observations`,
`edges`, `completions` and `findings`. Observations include stable Issue identities,
validated authorization timing/bindings, Issue read time and upstream identities.
Edges have `from`/`upstream`; verified completions have `issue`/`identity`.
Findings contain `reason` and implicated `issue`. Arrays on non-ready results can
be partial diagnostics and must never be interpreted as a complete graph.
`completion_missing` yields waiting; all other failures block. Reasons include
identity, repository, unauthorized, unauthorized_upstream, cycle, limit,
completion_invalid, completion_unavailable, custody_unavailable, invalid_input,
unavailable and sanitized provider failures (authentication, denied,
not_found_or_inaccessible, rate_limited, transport, timeout, cancelled, malformed,
pagination, incomplete). Custody failure reasons use a `custody_` prefix.
Raw provider bodies, exception messages and credentials are never returned.

Limits are positive integers. Maximum supported configuration is 10,000 nodes,
30,000 logical reads, 100,000 edges, depth 500 and timeout 86,400,000 ms; defaults
are shown above. Limits, cancellation, timeout and capability exceptions cannot
produce partial success. Capabilities must honor signals to release their own
resources: bounding the evaluator's wait does not terminate external work.

A ready result describes only this checkpoint. Added/removed edges, changed
Scope/Shape, authorization or completion invalidate previous observations. Core
must recheck at every subsequent stage/write boundary. GitHub offers no cross-API
atomic graph snapshot or instant revocation guarantee. Preserve independent
Acceptance, Candidate/Hooks, exact-head CI, protected merge and completion gates.
No live integration, model execution or host support is implied by local tests.
