# Final fidelity review and protected merge

`@nibfin/core` exports `observeFinalReview`, `createFinalReview` and
`createProtectedMerge`. These compose the existing workspace, hook, publication,
CI, lifecycle, authorization and controlled-operation contracts. They do not
close Issues, create completion receipts, or establish post-merge final proofs.

Core supplies all capabilities and current expectations. Candidate content,
repository prose, reviewer output and copies of receipts cannot grant access.
The production wiring and live Agent/GitHub evidence belong to #121; live stale,
failed and recovery integration belongs to #123. The retained fixtures are local
contract evidence, including a stubbed reviewer, not actual independent model
review, native isolation measurement or a real protected merge.

## Input and review API

`createFinalReview({current, workspace, observe, prepareRole, evidenceCurrent})`
returns `run()`, `reconcile()` and `stop()`. `current()` supplies a fresh protected
snapshot with these fields:

- `repository`, `visibility: 'public'`, `ownership: 'personal' | 'organization'`,
  `binding` (the existing evidence binding), exact `scopeBody`, `shapeBody`,
  `decisions` array and approved `instructions` selection configuration.
- `workspace`: protected workspace expectations; `workspace()` supplies the
  complete transfer verified against these expectations. The binary diff, Git
  objects and required ignored artifact and hook bytes enter the review task.
- `target`: publication target (`repository`, `repositoryId`, `issueId`, Issue
  `number`, `cycle`, `headRef`, `baseRef`, publication paths), plus `prId` and
  `prNumber`. GitHub IDs are canonical decimal strings.
- `evidence`: `{value, current}` for `author`, `validator`, `publication`, `deliver`,
  `accept`, `secondStage`, `pr`, and `ci`. `current` is the independently held
  evidence expectation and consumed-result list. `publication` at the top level
  is the verified accepted-candidate publication value. PR evidence binds its
  readback to `contentIdentity(publication.pr.observation)`.
- `hooks`: the second-pass inputs/receipts from accepted-candidate publication,
  including both original receipts, first stage and independent expectations.
  `obligations` retains Scope artifacts and inspected hook configuration.
- `observation`: the result of `observeFinalReview`; CI evidence binds
  `inputs.checks` to `contentIdentity(observation.ci)`. This is an observation
  envelope even when native CI is pending, never a fabricated successful check.
- For the later merge: `method`, `ciMode`, `mergeCorrelation` and original `source`
  Run/Attempt identity. These also enter the protected review context.

`observe()` calls `observeFinalReview({provider,target,head,base,actions})` with a
read-only trusted GitHub provider, exact published Head/Base and any signed
Actions/source requirements. It refreshes official PR, commit tree, repository,
branch, checks and protection/ruleset observations using the existing CI producer.
It excludes changing observation timestamps from the semantic identity. Missing,
unsupported or ambiguous policy is rejected. Ownership and Runner registration
level are separate; personal and organization public repositories are eligible.

`prepareRole({role,skill,instructions,task})` must bind the entire serialized task
through its trusted backend channel, reject unsupported transport limits and
return `{lifecycle,input,taskIdentity}`. The identity must acknowledge the exact
transferred task with `contentIdentity(task)`. Never acknowledge a truncated task.
The selected role is `shaper-review`, Skill `shape`; lifecycle readiness requires
read-only access and verified isolation. Credentials and write capabilities do
not enter the task. Core owns the fresh execution and exact successful envelope
returned by `evidenceCurrent(id)`, including input correspondence and replay state.
Every upstream Author/Validator/Deliver/Accept ID, request and result identifier
must be distinct from the new reviewer. Backend exit, valid structured output
and confirmed termination are all required. Pending/unknown execution retains a
reconciliation requirement; it cannot be replaced by a new run in that flow.

Approval returns existing `shaper-review` evidence and a `context` digest binding
the complete protected review snapshot. Retain both. Validated rejection returns
its original failure classification and provides no merge approval.

## Merge API and supported configuration

`createProtectedMerge({current,workspace,observe,authorization,dependencies,
dependencyInput,operations,mergeCurrent}).run({signal})` consumes the same snapshot
plus `review: {value,current,context}`. The context must match the reviewed
snapshot with `review` omitted; changed decisions, methods or policy need a fresh
review. Core must preserve original operation correlation and source on recovery.

`authorization` is the existing Grant/permission boundary; `dependencies.evaluate`
must revalidate live native dependencies. `operations(options)` constructs
`createControlledOperations` with the supplied `beforeSubmit` guard and native
repository-write concurrency configuration. Core must actually apply that group
to its Actions execution. The merge operation requires the authorization boundary's
`withMutationGuard` facility, which checks the guard after awaited authorization
reads and before transport. The signed Grant's approved method/Base are enforced
there too. No administrator bypass or force option is exposed. Configurations without
strict classic protection enforced for administrators block with
`final-review:direct-protection-bypass-or-unsupported`; ruleset-only protection is
not currently a supported direct-merge configuration. Applicable rulesets remain
observed and enforced by GitHub in addition to that classic baseline.

Direct merge uses GitHub REST API version `2022-11-28`, `PUT /repos/{owner}/{repo}/pulls/{number}/merge`,
with only the approved `merge_method` and expected Head `sha`. It requires readable
native policy with strict classic up-to-date Base status-check protection enforced
for administrators (`enforce_admins.enabled: true`), known
mergeability, repository merge permission and an enabled method. GitHub-managed
CI may be pending: GitHub enforces its native checks at submission, and rejection
or an acknowledgment alone never confirms merge. `ciMode: 'signed'` additionally
requires all CI to qualify. Any supplied signed Actions/source requirements must
be satisfied under either mode. Unknown CI modes block.

Required native merge queues are **unsupported by this direct REST provider**:
`final-review:unsupported-required-merge-queue:REST-direct-only` blocks before any
mutation, regardless of pending/admitted/failed queue state or chosen method.
No queue is provisioned, bypassed or replaced with direct merge. Future queue
support needs authorized expected-head admission, applicable ownership/plan and
native ruleset configuration, compatible queue-selected method, merge-group CI
and independent completed-merge readback. Queue admission alone cannot succeed.

Base/Head, Candidate, artifact/hook, Scope/Shape, CI/source and policy drift block
stale submissions. Read checkpoints are not an atomic Base condition: GitHub's
native strict protection provides the supported concurrent-merge boundary.
There is no custom CAS, scheduler or distributed transaction guarantee.

## Readback and reconciliation

The existing controlled-operation custody retains original intent and attempt
before transport. Lost responses, interrupted result retention and duplicate or
fresh-instance invocation reconcile official state; they never blindly resubmit
an uncertain attempt. Missing custody is unknown, not proof of new work.

Confirmation independently retrieves the exact closed/merged PR and provider's
actual resulting commit, then reads the intended destination branch and compares
`resultingCommit...destinationTip`. The resulting commit must be the merge base
and the comparison must show identical/ahead history with zero commits behind.
Thus rebase/squash can return a different SHA from the reviewed Head, and the
destination may advance further without confusing its tip with the reviewed
pre-merge Base. Unavailable or contradictory history blocks confirmation.

`mergeCurrent(operationResult)` supplies the independent existing `merge` evidence
expectation. It must bind the Review, reviewed Head/Base, actual resulting commit
and `contentIdentity(operationResult)` readback. Success returns that envelope
and the custody-backed operation result. It implies no Closure or final proof.

Local verification: `node --test test/final-review.test.mjs`, `npm run check`,
`npm run verify:archive`, on Node 22/npm 10. Archive verification exercises the
same public API from an isolated installed package using verifier-owned disposable
Git/process files. `out/nibfin-core.tgz` remains a mandatory Candidate artifact.
