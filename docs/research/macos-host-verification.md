# Future real macOS Host verification design

This is a proposed test specification, not a runnable harness or a report of
execution. No case below has run. All rows remain Unverified. The
[study and official source ledger](macos-host.md) define applicability and gaps.
S1–S11 below refer to that ledger. Implementation and real execution need separate
authorization; this plan grants no account, registration or external write rights.

## Independent resource lanes

| Lane | Required resources and account/service contexts | Approach repetitions and exclusions |
| --- | --- | --- |
| INTEL | Dedicated disposable physical Intel x86_64 Mac; recorded hardware model and macOS build; test administrator for authorized setup only, non-admin Core/service user, two isolated Agent environments with two registration instances in one environment; separate unprivileged observer and disposable test credentials | Execute I-D, I-S and I-L independently after each backend exists. Guest is Linux x86_64. Record actual process/helper CPU. Never accept Apple Silicon translated output as this lane. |
| ARM | Dedicated disposable physical Apple Silicon arm64 Mac; independently recorded model/macOS build; same account/resource separation established afresh; arm64 tools and a Linux arm64 guest for A-L | Execute A-D, A-S and A-L independently. A-DT and A-LT require separate translation prerequisites and records; absence blocks those variants, not native arm64 research. |

For each lane require authorized disposable Repo/Org scope, current test Member
permissions and a valid narrowly scoped execution Grant when testing real Issue
stages. Use synthetic secrets and controlled endpoints. Paid services and personal
accounts are not prerequisites of this research; future accounts/resources must be
explicitly arranged. Do not expose production Core state, Owner keys or personal
Keychains to probes. Hosted H-I/H-A can supply separate ephemeral observations
only; they cannot replace either physical lane or persistent service tests.

Prerequisite failure is recorded as **Not run: prerequisite missing**, retaining
Unverified support status. It is neither a pass nor proof of Unsupported hardware.
If an OS/API hard incompatibility is found, retain official evidence and request
an authorized compatibility decision. Do not silently omit the case or backend.

## Inputs to pin before execution

For every row and repetition, record a manifest containing hardware/model,
physical host OS build and CPU; guest OS/kernel/image digest and CPU or explicit
none; each process/helper architecture and translation mechanism/version or none;
filesystem types, mount options, case mode, ownership/ACLs and paths; SDK/Xcode,
backend/profile/entitlement bytes, signing identities (public identifiers only),
hypervisor configuration, VM shares/network interfaces, Node/npm, Git, gh,
Agent, Runner, Core/Skills/CLI/Action/Workflow versions and immutable content
identities. Unknown required pins stop the lane.

Use the repository's current supported Node/npm pins when testing this source
(22.23.3/10.9.9); refresh against the actual future candidate. Bind receipts to
repository and Issue stable IDs, Scope/Shape, Base/Candidate/artifact/hook identities,
assignment/execution/workspace/environment/instance IDs, Run/Attempt, probe source
and input identities, observer version and timestamps. Core digest(string) hashes
JSON.stringify(string); do not substitute raw-text SHA-256 as a Core body identity.
Ordinary binary hashes may be labelled as such for tools/images. Keep raw private
proof in protected storage; publish redacted observations and locators only.

## Proposed harness contract

No new Nibfin CLI command is introduced. A future test driver, not implemented in
this repository, must invoke the real injected Host operations observe,
materialize, seal, execute, stop, cleanup, reconcile and predecessors. It must
launch adversarial real subprocesses rather than returning synthetic capability
booleans. A separate trusted observer must inspect effects from outside the
sandbox, correlate receipts and reconcile processes after driver death. Probe
sources, expected results and observer output must be immutable inputs.

Probe programs must report attempted operation, target label, return/error and
correlation ID, never secret contents. For read probes, report only whether an
unexpected synthetic marker was recoverable; keep raw output private. The observer
must compare protected file bytes/modes and account/service/process/network state
before/after. A sandbox's own claim of denial is insufficient. The driver must
support deterministic barriers for replacing ancestors between validation/open,
operation deadlines, cancellation, deliberate crash and interrupted cleanup.
These are required future harness behaviors, not existing executable examples.

Existing service commands are those in GitHub S7: ./svc.sh install, start, status,
stop and uninstall, from the pinned Runner installation directory in the Mac
service context. They are attributable upstream commands, not Nibfin commands and
are not to be executed as part of this research. For customized services follow
S7's runsvc.sh entry point. Verify actual installed plist/domain/account against
S5/S7/S8; do not invent a universal launchctl teardown command for unknown versions.
Refresh official manuals and record exact approved invocations at setup time.

## Ordered procedure for each lane and approach

1. Obtain separate implementation/test authorization and resolve the study's
   official API/entitlement/version gaps. Record the complete pin manifest and
   approach row. A missing backend is Not run, not a simulated success.
2. Snapshot disposable machine/account/service/volume state. Create authorized
   workspace and immutable input roots, neighboring environment and instance
   roots, synthetic Core/registration/Agent credential sentinels, and an
   outside-root control file. Hash bytes/modes with the trusted observer.
   Include names with spaces, case aliases and Unicode; repeat on case-sensitive
   and insensitive disposable volumes. Confirm probes can read/write control
   fixtures before confinement, without using real secrets.
3. Establish actual service context independently of an interactive terminal:
   UID/groups, home, launchd domain/plist, executable/helper paths and CPU,
   working directory, allowed environment and credential availability. Exercise
   interactive session, service after login, locked Keychain, logout and reboot
   contexts separately. Capture only safe availability/identity facts (S5–S8).
4. For Linux guest rows, boot a pinned image and record guest facts separately.
   Disable host home/Core/credential sharing. Inventory every shared folder,
   socket, disk and export channel. Verify guest account identity does not imply
   host Keychain or gh login. For translation rows confirm the actual translator
   and helpers before running; no inferred availability from S4.
5. Reconstruct the exact candidate and required ignored artifacts through
   materialize; verify identities, then seal in Writer, Reviewer and Hook modes
   separately. Reject missing/changed inputs and stale assignment receipts.
6. Execute every applicable probe below with outside observations, including
   positive controls. Record each expected denial and protected sentinel
   comparison. Repeat race cases across a predetermined recorded iteration
   count; a clean finite run is evidence for that build, not proof against all
   possible races. A single escape fails the configuration.
7. Run lifecycle/authentication cases and normal completion, cancellation,
   timeout, driver crash and forced stop failures. Reconcile from a fresh
   observer/process before any replacement assignment. Attempt replacement while
   cleanup is unknown and require rejection.
8. Stop/uninstall only test services, revoke/remove only authorized disposable
   registrations, terminate test descendants and VM helpers, detach test shares,
   remove test disks/workspaces/credential fixtures and inspect for leftovers.
   Compare neighboring roots and service inventory with the baseline. Preserve
   protected receipts; never erase an unknown state to make cleanup appear safe.
9. Have an independent reviewer assess raw protected observations and redacted
   receipts against each criterion and exact row. Any source/backend change
   invalidates its dependent results. Promotion remains a separate decision
   with applicable lifecycle gates; no row is automatically enabled by a pass.

## Probe definitions and verdicts

Every case uses disposable fixtures, pinned probe code and correlated external
observations. Unless explicitly allowed, a denied operation must fail without
reading the synthetic marker or changing protected bytes, permissions or services.
A missing observation is Unknown, never Pass.

| ID | Stimulus and positive control | Required negative/positive observations |
| --- | --- | --- |
| F1 | Writer creates/edits/deletes a file only in its authorized root; same program writes outside root and neighboring instance/environment roots | Authorized edit succeeds and appears in candidate export; outside writes fail with unchanged sentinels. Permission-only denial is insufficient: use probe-account-readable control sentinels outside the sandbox. |
| F2 | Reviewer attempts create, append, rename, chmod and delete in candidate and outside roots; allowed read of assigned evidence | Assigned read succeeds; every write denied, input bytes/modes unchanged. Reviewer cannot gain Writer mode from request prose. |
| F3 | Writer and Reviewer read outside-root Core, registration and other-environment secret fixtures; attempt environment, inherited descriptor, helper IPC and credential-store access | No synthetic secret recoverable. Allowed environment Agent domain only where policy permits; Hooks expose no Agent/Core/GitHub login. Use independent observers to detect helper-mediated access. |
| F4 | At deterministic barriers replace leaf symlink and each ancestor with symlinks/renames; attempt hard links and special files, path traversal and alternate casing | All unauthorized reads/writes/capture rejected; correct authorized non-racy control succeeds. Repeated races never capture outside bytes. Test both case modes and paths with spaces/Unicode. |
| F5 | Attach disposable volume/alias at a candidate ancestor; add unauthorized shared-folder/export target; attempt guest-to-host and host-to-neighbor writes | No mount/share grants additional authority. Authorized immutable transfer succeeds and hashes match; writable host escape fails. Include guest and host observer records for I-L/A-L. |
| F6 | Remove read/write permission, change ownership/ACLs and replace executable/helper paths under actual service account | Safe failure, no fallback to administrator/home or alternate unpinned tool. Allowed tool control succeeds. Record Intel/arm64 helper architecture individually. |
| N1 | Hook attempts DNS plus IPv4/IPv6 TCP/UDP to controlled reachable listeners and host gateway; try descendant/helper forwarding | Listener and packet/DNS observations show no Hook traffic. Outside-Hook control reaches the exact endpoints immediately before and after. If controls fail, verdict Unknown, not denial. Include loopback/local sockets where they could reach credential/network helpers. |
| N2 | Writer/Reviewer attempt permitted and forbidden destinations under restricted egress policy, including redirected/proxied/helper traffic | Permitted control succeeds; forbidden destinations and credential-bearing helpers remain inaccessible. Test absent or unknown network capability rejects preparation before execution. |
| P1 | Spawn child, grandchild, detached/reparented process and a process that attempts service persistence; allowed short child exits normally | Observer tracks all identities beyond leader exit. On stop/timeout no descendants or persistence remain, and no late sentinel writes occur. Denied service creation is verified outside sandbox. |
| P2 | Cancel at execution, materialization and export; crash driver; fail stop/cleanup; interrupt VM shutdown and simulate launchd relaunch | Record termination/disposal separately. Running/failed/incomplete/unknown blocks replacement. Fresh reconcile must establish confirmed termination and safe disposal; no timeout-only assumption. |
| E1 | Modify/miss ignored artifact, hook source, result reference, candidate bytes, Run/Attempt or assignment ID | Real Core rejects mismatches; valid control binds all evidence. Test immutable output export and stale receipt rejection, not a handcrafted success report. |
| A1 | Actual service login unavailable, locked Keychain, wrong account/User ID, Agent login absent; inject synthetic GH_TOKEN/GITHUB_TOKEN overrides; produce sanitized 401/403 | Preparation blocks, safe operation/Run/Attempt/status diagnostic only. S10 override cannot silently substitute identity. Correct account/login control proceeds only when all other gates pass. |
| A2 | Two instances in one environment share allowed Agent login; then attempt shared registration credentials, workspace/service identity or cross-environment Agent domain | First arrangement preserves separate instance resources; every forbidden sharing attempt rejected. Neighboring credentials/state unchanged. |
| A3 | Create unregistered instances, then register, standby and request an Issue in distinct phases; remove current Repo permission/Assignee/Grant in separate runs | Create does not need Runner ID; register needs proper target authority/readback; standby needs binding/login but no Issue Grant; Issue needs fresh permission/dependencies/Runner-set trust. No online/label-only bypass. |
| R1 | Lose response to a controlled privileged write in authorized test environment, then request retry/replacement | Persist intent, independently read back actual effect, reject blind replay while unknown. Distinguish performed, not performed and unknown. Do not use real production side effects. |

For N1, no DNS resolution alone proves no networking: include direct IP sockets
and listener health controls. For P1/P2, absence from one process listing alone
proves neither termination nor disposal; correlate lifecycle handles, service
state, disk/share inventory and post-stop observations over a recorded interval.
A VM shutdown result alone does not settle host helper cleanup.

## Verdict and evidence format

Each case receipt must include row/lane/context, immutable manifest/probe/input
identities, expected policy, actual attempted operations, return status, external
observer references, before/after protected sentinel identities, listener control
results, descendant/service inventory, cleanup observation and replacement
admission result. Preserve safe diagnostic HTTP status and intent/readback links
for R1. Do not include tokens, Keychain values or raw private provider output.

Use four distinct outcomes: Not run (missing prerequisite), Fail (observed escape,
wrong permission or other required behavior violation), Unknown (incomplete or
contradictory observations), and Pass (all expected positive and negative effects
and cleanup established for the pinned case). Each incomplete lane stays
Unverified. A Pass for a probe is not formal platform support, registration
eligibility, product E2E or completion of another Issue.

Independent review must explicitly reject these misleading conclusions:
arm64 translation proves Intel hardware; Linux guest traversal proves Darwin
capture; hosted ephemeral success proves persistent launchd cleanup; unreachable
listener proves Hook denial; fixture-host tests prove native containment; missing
Mac proves Unsupported; or research acceptance permits real dispatch. Verify the
README links, source-versus-inference labels, matrix fields and empty candidate
inventory against repository configuration before pre-commit Acceptance.
