# Assignee selection contract

`createAssigneeSelector` is the public Core owner of pre-dispatch member selection.
It composes the provider, signed authorization boundary and Runner observations;
GitHub owns instance matching and queueing. It does not dispatch or authorize writes.
Import and construction perform no IO. Public repositories with personal or
organization owners can use repository registration. Private support is excluded.

```js
import {createAssigneeSelector} from '@nibfin/core';
const selector = createAssigneeSelector({
  provider, // createGithubProvider with a trusted read-only transport capability
  authorizationFor: (member, checkpoint) => core.boundaryFor(member, checkpoint),
  now: core.clock,
  maxCheckpointMs: core.maxCheckpointMs,
});
const decision = await selector.select(input, {signal});
```

All configuration and `input` are supplied by trusted Core, never parsed from Issue
prose, comments, event data or caller-selected Labels. `authorizationFor` returns
an existing `createAuthorizationBoundary`; its getCheckpoint must bind the supplied
member ID/login, repository, Issue, operation and current Grant/dependency/phase
checks to this attempt. Do not return a cached eligibility result or success stub.
The selector checks the returned observation identity and time. The boundary
re-reads member membership, effective permission, repository identity and public
visibility and verifies the signed Grant. See [authorization](authorization.md).
The selector first reads effective permission with matching stable ID/login;
verified Read/Triage/none can be skipped. A 404 is ambiguous and blocks.

`input` is snapshotted before asynchronous reads:

- `target`: `{owner, repository, id, ownerId, ownerType}` as in `observeRunners`.
  IDs are canonical decimal strings; ownerType is `User` or `Organization`.
- `issueId`, `number`, `operation`: stable Issue node ID, decimal number string
  and authorized operation identifier, matching the authorization checkpoint.
- `registration`: the existing repository or organization observation contract.
- `records`: complete applicable trusted local registration records, including
  offline and nonmatching platforms; never infer records from remote Labels.
- `conditions`: `{platform, labels, groupId?, workflow?}`. Platform is linux,
  windows or macos. Labels are cumulative, case insensitive, bounded nonempty strings.
  Member Labels are rejected here; the selector derives exactly one from User ID.
  Group/workflow restrictions use the existing Runner contract.
- `execution`: `{repositoryId, issueId, operation, observedAt, state}` from Core's
  reconciled execution evidence for this attempt, not an event assertion.
  `new` means Core has proved a new legal attempt; queued/running/completed work
  waits without reassignment. `unknown` waits for reconciliation. This creates
  no independent execution store, lock or exactly-once guarantee.

Core configures the clock and freshness bound. All reads and eligibility must
complete inside the checkpoint bound with monotonic, nonfuture observation times.
Execution evidence must be no older than that bound. Failure, cancellation or
clock regression blocks. Each new selection reads the current Issue. The initial
array order is recorded verbatim; candidate authorization checks current membership
again. Independent reads are not an atomic snapshot. Later stage/write checkpoints
must run their own Core authorization and dependency checks; this decision cannot
be reused as a capability. No operation promises instant revocation.

## Decisions and native consumption

`{outcome, reason, observation?}` is the common result. Observation records stable
repository/Issue identity, source `github-api`, checkpoint times and exact candidate
ID order (at most 100). Raw provider data, credentials, local registration secrets
and arbitrary exception messages are never returned. Diagnostic reasons are fixed
codes. Invalid observations produce `blocked`; trustworthy absence/ineligibility
produces `waiting`. Neither result contains `routing` or `memberId`.

`selected` additionally returns one `memberId` and:

```json
{"runnerLabel":"nibfin-user-42","platform":"linux","labels":["self-hosted","linux","x64","nibfin-user-42"],"groupId":"31"}
```

`groupId` is present only if requested. This is a Core routing decision, not a
literal GitHub YAML object. #121 must preserve every `labels` condition as an AND
array and resolve a group ID to the current verified native group name for
`runs-on: {group: NAME, labels: [...]}`; never drop or put the group ID into Labels.
Runner group names and access must be revalidated at that consumer checkpoint.
No Runner ID or Agent choice is emitted. A matching online Busy instance retains
member rank; GitHub queues the job if no matching instance is idle. Member fallback
only precedes dispatch. Queued/offline work cannot automatically move to another
member. Waiting creates no timer/poller; a later legal wakeup supplies new trusted
execution evidence and repeats fresh reads. It is not a started/completed claim.

`observeRunnerBindings` is an additive producer interface in `runners.mjs` for
reconciling identity/access across a member's different platforms. It retains all
registration, record-platform, member Label, inventory, group and workflow checks;
it omits only comparison of remote platform with the requested job platform.
Its result alone never establishes job suitability. The selector separately requires
all emitted Labels, requested platform and online status. Existing `observeRunners`
retains its strict job-platform behavior. Neither API reclassifies aggregate binding
mismatches or incomplete inventories as offline.

## Reproducible handoff for #121 and #122

`tooling/selection-fixture.mjs` exports `selectionFixture()`, returning callable
`select`, public `selector`, trusted `input`, synthetic REST `routes`, request
`calls`, signed synthetic Grant context and `expected` selected member. Run in the
source checkout after the locked dependency install. For example:

```js
import assert from 'node:assert/strict';
import {selectionFixture} from './tooling/selection-fixture.mjs';
const fixture = selectionFixture();
const decision = await fixture.select();
assert.equal(decision.outcome, fixture.expected.outcome);
assert.equal(decision.memberId, fixture.expected.memberId);
```

`test/selection.test.mjs` supplies retained positive/negative expected outputs:
fresh `[B,A]` then `[A,B]`, Busy versus idle, offline/nonmatching platform and Label,
multi-instance/group/workflow access, all-unavailable and later wakeup, changed
membership/permissions/Grant, malformed/stale/denied reads and duplicate/unknown
execution. Fixtures use the same REST response shapes and lossless decimal parser
as provider/authorization/Runner tests, with local Ed25519 signatures and synthetic
identities only. They establish no real collaborators, registrations or live proof.
#122 owns real multi-member fallback proof; #121 owns actual Workflow consumption.
The fixture is a test handoff, not an npm runtime dependency or execution authority.

Commands on Node 22 with npm 10:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test test/selection.test.mjs test/provider.test.mjs test/authorization.test.mjs test/runners.test.mjs
npm run check
npm run verify:archive
```

Archive verification inspects actual payload bytes and imports the installed public
package in disposable scratch. It runs the selection fixture through that installed
interface. Core independently captures the candidate and runs Acceptance/hooks;
local test success does not claim CI, Acceptance, publication or live integration.
No required non-tree artifacts or configured commit hooks belong to this module.

Native routing syntax and cumulative matching follow
[GitHub workflow routing](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow).
Default labels may be disabled during Runner registration, so an online instance
must actually carry every emitted label; OS metadata alone cannot satisfy a Label.
