# Kairo source reuse

The source baseline is `taco3064/kairo@d1b47d5e073cf15bdcdc1fbbec098401649878d9`.
The Owner-approved source archive is maintainer input, never an installation or runtime dependency.
Nibfin's Issue Scope controls product behavior. Donor tests supply cases, not inherited passing verdicts.

| Donor owner | Maintained destination and adapter | Responsibility and supporting dependencies | Material adaptations and tests |
| --- | --- | --- | --- |
| `src/core.mjs` | `src/delivery-planner.mjs`, `src/delivery-contract.mjs`; `src/core.mjs` public adapter | Per-Issue operation progression, result classification, complete Candidate/evidence guards; candidate contract, canonical identity and retained workspace sources | Nibfin v1 receipts and independent expectations remain normative. No owner-only/public-dispatch identity, global Shape barrier or cohort scheduler. Distinct CI observation, deployment disposition and completion stages. `test/kairo-reuse.test.mjs`, Core owner/process tests and `test/delivery-composition.test.mjs`. |
| `src/runtime.mjs` | `src/runtime.mjs`; Core instantiates trusted operation adapters | Selected operation dispatch; pre/post-hook recapture refuses mutation or missing outputs | The Runtime has no private controller bootstrap, grant loading, GitHub credentials, arbitrary module loader or process command dispatch. Nibfin lifecycle/custody and permission owners implement the transports. Failed Candidate checks require Deliver repair and new evidence. Core owner tests and reuse checkpoint tests. |
| `src/workspace.mjs` | `src/workspace-sources.mjs`, `src/workspace.mjs` | Declared artifact/source manifests with exact SHA-256 and byte sizes; immutable capture dependency | Retain Nibfin v1 immutable object/source wire format and bounds. Do not mutate the Candidate's real index or expose controller Git metadata. The donor's credential-bearing fetch/push/commit workspace is replaced by Nibfin's credential-free capture and separate publication transport. Workspace, Candidate-publication and ignored-output tests. |
| `src/candidate-contract.mjs` | `src/candidate-contract.mjs`, `src/candidate-schema.mjs`; `src/obligations.mjs` adapter | Strict nested inventory schema and safe paths | Nibfin additionally owns robust top-level fence parsing, empty-inventory explanations and independent hook configuration reconciliation. Candidate schema tests adapted from the donor; obligations tests. |
| `src/hooks.mjs` | `src/hooks.mjs` | Disposable Git metadata, exact staged tree/path and original message comparisons | Keep #230 rootless daemon/image checks, clean environment, per-hook container cleanup, binary-safe message bytes and host-side full source/metadata comparisons. No credential mount or network. Hook process tests execute the production shell wrapper for all three events and mutation failures. |
| `src/role-session.mjs` | `src/role-session.mjs`; `src/agent-session.mjs`, fixed Codex entry and mount inventory | Unique event session ID, bound continuity and missing/ambiguous persisted-session detection | Session continuity stays within one execution/container and never substitutes for evidence independence. Final Review gets a fresh execution. Bind adapter/version, access and complete execution context. Same-provider capacity policy remains in #230, without a new login or retry authority. Codex data is checked before resume; Claude/Gemini retain their own versioned resume/result boundaries. Reuse session tests and existing adapter tests. |
| `src/github.mjs` | `src/github.mjs`; `src/provider.mjs` adapter | Bounded read observations, fresh nested invalidation, mutation prohibition and cloned results | Keep Nibfin permission-checked transport, lossless numeric IDs, safe diagnostics and one-shot writes. Never share operation/target/correlation, context-bearing or differently cancelled requests. Each Core observation opens a fresh scope. Provider/reuse tests, continuous composed delivery and final-review tests. |

## API and ownership

`createCore`, `createDeliverFlow`, `createGithubProvider`, the protected host export and the v1 receipt/workspace formats retain their public signatures.
The provider additionally exposes `readObservation(work)` and `freshReadObservation(work)` for trusted read-only observer scopes. Writes inside either scope throw before transport. No observation survives its callback or a mutation. Requests with `expectedId`, payload validators or other additional options bypass the observation cache so the provider applies their current constraints on every request, including repeated calls with the same validator.

To consume GitHub-enforced CI without requiring separate strict-base/protection APIs, configure the trusted Core owner as `owners.ci: {provider, mode: 'github-repository'}` and use `observeFinalReview({...inputs, ciMode: 'github-repository'})` in the final-review/merge observation capability. The CI stage returns `outcome: 'observed'`, `status: 'pending'` and `qualifies: false` when it has no explicit required-check proof. That completes observation only; it never reports that CI passed. A GitHub-blocked PR with explicit failed checks blocks progression. GitHub still authorizes or denies the conditional rebase/merge request. Omitted mode retains the previous signed-policy observation API; explicit signed-policy configurations retain their exact-head/provenance gates.

The old inline Core stage selector and dispatch are removed and delegate to the maintained planner and Runtime. There is no alternate stage dispatch in those wrappers.
`shape`, `accept`, `candidate-publication`, `final-review`, `completion`, `repair`, `operations`, `authorization`, `dynamic` and `selection` retain non-overlapping responsibilities: Nibfin's public receipt/custody, role, member-permission, native-dependency and official-GitHub transport contracts. They are not independently selectable lifecycle planners. The composed fixture uses actual predecessor receipts throughout Author, Validator, publication, Writer capture, both Hook checkpoints, pre-commit Accept, Git commit/PR read-back, CI observation, fresh Final Review, rebase Merge, deployment disposition, causal Close and completion custody read-back.

Personal and Organization public repository eligibility, current Assignees, effective Write/Maintain/Admin permissions, independently managed member model logins and GitHub-native Runner matching/queues remain in their existing owners.
Source-only completion requires an explicit authorized deployment disposition. Required deployment proof, exact-head CI, protected merge and read-back-bound closure remain separate gates.

The source tests use disposable Git repositories and stub external transports. They do not certify live isolation, real model execution, published releases or external multi-account E2E.


Candidate mismatch observations from the Runtime enter the existing repair owner
as `source.kind: 'candidate'` with protected `source.observation`. They bind the
exact Candidate, authority and Hook checkpoint. A proven byte mismatch invalidates
the affected chain and returns through Deliver, both Hook checkpoints and fresh
independent Accept. Unavailable capture or unsupported Hook execution remains an
external failure and cannot grant a replacement Writer. Host adapters persist the
original result and install the authorized repair handoff only after termination
and side-effect reconciliation; Issue or model content cannot supply that source.

## #231 recovery origin mapping

The approved read-only PR57 source archive is revision
`2f726d174b3b43699030f6558681751f17501dac` (archive SHA-256
`40da4817d312b3d4ea134d364ce576c6c4a90a9029556038328748076a37d2b8`).
Unified Rescue behavior originates at merged PR54,
`710a92306ed0d5d28162ce0c0c3ea4ebcbcb8028`; PR57 supersedes completion routing.
Unrelated mechanisms retain `d1b47d5e073cf15bdcdc1fbbec098401649878d9`.
No unrelated bytes from PR57 are relabeled as that baseline. PR56 display-title
work is not used. The archive is source input, never inherited test evidence.

| Donor path / family | Maintained Nibfin owner / adapted tests | Revision and adaptation |
| --- | --- | --- |
| `src/action-stage.mjs`, `src/action-lifecycle.mjs` | `src/workflow.mjs`, `src/core.mjs`, `src/runtime.mjs`; workflows, core-owners, delivery-composition tests | Original baseline; existing v1 stage receipts, native needs and independent role owners retained |
| `src/action-outbox.mjs` | `src/operations.mjs`, `src/relay.mjs`; operations, relay, fanout tests | Original baseline; retained intent/attempt/custody/readback replaces private local outbox, no second queue |
| `src/action-event.mjs`, `src/action-provenance.mjs` | `src/actions.mjs`, `src/host-identity.mjs`, `src/relay.mjs`; actions, host-identity, relay tests | Original baseline; public repository, per-member eligibility, pinned OIDC source and distinct event/dispatch observations |
| `src/dynamic.mjs`, `src/dependency-event.mjs` | `src/dynamic.mjs`, `src/fanout.mjs`, `src/collaboration.mjs`; dynamic, fanout, rescue-composition tests | Original baseline; actual native dependency consumers and independently current completion |
| `src/recovery.mjs` | `src/recovery.mjs`, `src/completion.mjs`; recovery, completion tests | Original baseline; source-only disposition, incident/comment/reopen owners remain authoritative |
| `src/rescue.mjs`, `src/rescue-detection.mjs` | `src/rescue.mjs`, `src/rescue-records.mjs`; rescue tests | PR54 as supplied in PR57; bounded case transitions and shared cycle budgets adapted to existing host state/custody capabilities, no private Store or owner-only grant schema |
| `src/rescue-policy.mjs` | `src/rescue-policy.mjs`; rescue-completion tests | PR54; exact source/attempt, workflow pins and provider timeout annotations; parameterized public repository and actor policy |
| `src/rescue-ai.mjs`, packaged `skills/rescue/SKILL.md` | `src/rescue-ai.mjs`, `src/rescue-agent.mjs`, `skills/rescue/SKILL.md`; rescue, rescue-agent tests | PR54; typed plan validation, read-only capture comparison, retained diagnosis and bounded existing adapter process |
| `src/rescue-writer.mjs`, `src/role-session.mjs` | `src/rescue-continuation.mjs`, `src/rescue-session.mjs`, `src/role-session.mjs`, `src/role-host.mjs`; rescue-continuation tests | PR54; preserved UNACCEPTED workspace and original member conversation with distinct execution, Codex session restore; unsupported cross-container adapter resume is explicit |
| `src/rescue-continuation.mjs` | `src/rescue-continuation.mjs`; rescue-continuation tests | PR54; latest precise verification receipt and current exact-head CI predicates, never convert interruption to pass |
| `src/rescue-remedies.mjs` | `src/rescue-remedies.mjs`; rescue tests | PR54; dead PID/source/time/inode checks and race guards; private Docker/sudo/service values removed, availability reads only |
| `src/rescue-result.mjs`, `docs/rescue.md` | `src/rescue-result.mjs`, `docs/rescue.md`; rescue tests | PR54; truthful outcomes and sanitized metrics, no broad cancellation token; unsupported neutral reporting fails visibly |
| `src/rescue-wakeup.mjs`, service/sudoers templates | `src/rescue-wakeup.mjs`, `host/templates/nibfin-rescue-wakeups.service`, `src/rescue-install.mjs`; rescue-completion/install tests | PR54 updated by PR57; existing host subscription/due timers only, no polling Action or arbitrary privileged command interface |
| `src/rescue-completion.mjs`, dispatch-only workflow | `src/rescue-completion.mjs`, `src/rescue-host.mjs`, `workflow/templates/nibfin-rescue.yml`; rescue-completion, rescue-workflow tests | PR57; signature over exact bytes, zero allocation for normal green Runs, provider rereads, durable bounded inbox and uncertain-dispatch reconciliation |
| `src/verification-runner.mjs` | `src/verification-runner.mjs`, existing child/supervisor; verification-runner tests | PR54 EPIPE guard adapted to Nibfin's stronger kernel-subreaper process owner; failed receipt and owned-lane release |

Relevant upstream cases are adapted against maintained public owners instead of
copying the donor runtime or private deployment constants. Process/model/provider
boundaries in source fixtures are synthetic; no live delivery or member-isolation
verdict is inherited. Installation, release and live E2E remain separately owned.
