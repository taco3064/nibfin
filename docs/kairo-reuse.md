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
