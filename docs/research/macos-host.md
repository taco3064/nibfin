# macOS Host feasibility research

Research date: 2026-10-24. Scope: nibfin #13, Proposal
v0.11.0+research-20261024. This is a design study, not an adapter, support
certification, installation guide or execution result. Every configuration below
is **Unverified** and ineligible for real work. No Mac, account login, service
installation or native containment test was used. See the
[future verification design](macos-host-verification.md).

## Evidence ledger and reading rules

D means documented in content actually retrieved; I means an engineering inference
or proposed requirement, not a vendor guarantee; U means unknown. All sources were
requested on 2026-10-24. Living documentation is not an immutable platform pin.
Where a page does not specify a minimum OS or architecture, applicability is
unknown until the future lane records its actual SDK, OS build and hardware.
No search snippet is used as capability proof.

| ID | Official source, section and direct URL | Observed content, version and architecture applicability | Classification and limit |
| --- | --- | --- | --- |
| S1 | Apple, [Protecting user data with App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox), overview | HTML required JavaScript; linked Markdown could not be read by the available tool. No OS/architecture guarantee extracted. | U: exact entitlements, distribution requirements, permitted resources and inheritance must be refreshed before implementation. |
| S2 | Apple, [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app), helper inheritance | Same content-access limitation as S1; applies as a research lead to Darwin helpers, not Linux guests. Exact SDK/version and Intel/arm64 behavior unknown here. | U: do not infer that wrapping an arbitrary CLI establishes inherited confinement. |
| S3 | Apple, [Virtualization](https://developer.apple.com/documentation/virtualization), framework overview | HTML/Markdown content unavailable to this reader. Host-specific availability and entitlement details not established from direct content. | U: Intel/Linux and arm64/Linux feasibility candidates require API availability and entitlement confirmation on the selected SDK. |
| S4 | Apple, [Running Intel binaries in Linux VMs](https://developer.apple.com/documentation/virtualization/running-intel-binaries-in-linux-vms), Rosetta integration | Content unavailable as for S3. No current minimum OS, installation or translation guarantee established here. | U: translated x86_64 process in an arm64 Linux guest is a separate proposed row; not an Intel host or Darwin result. |
| S5 | Apple, [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), startup process and job requirements | Archived OS X guide discusses system jobs and per-user agents, including login-dependent lifetime. Architecture-neutral historical guidance, not current macOS validation. | D: service contexts differ. I: collect actual launchd domain/account and restart state; stopping one process is insufficient cleanup evidence. |
| S6 | Apple, [If your Mac keeps asking for your keychain password](https://support.apple.com/en-ca/guide/keychain-access/kyca1242/mac), login Keychain locking | Living Mac user guide describes inactivity/sleep locking and password mismatch. Both architectures are unspecified; no headless service guarantee. | D: login Keychain can lock. I: interactive login cannot establish service credential availability. U: exact service access/ACL behavior. |
| S7 | GitHub, [Configuring the self-hosted runner application as a service](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application), Mac installation/customization | Mac service lifecycle and launchd customization are documented; custom service uses runsvc.sh. Runner/OS version and CPU-specific enforcement are not specified. | D: service management exists. U: Nibfin isolation and descendant cleanup. |
| S8 | GitHub, [Monitoring and troubleshooting self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/monitor-and-troubleshoot?platform=mac), status, logs and launchd | Documents status inspection and service diagnostics; not an account-isolation certificate. Both Mac architectures need their own observations. | D: operational diagnostics; I: sanitize logs before publication. Do not copy credential-bearing connectivity examples into probes. |
| S9 | GitHub, [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), standard runners | Retrieved table separates Intel macos-15-intel/macos-26-intel labels and arm64 macOS labels; ordinary hosted jobs receive fresh VMs. Labels/images can change. | D: hosted architecture distinction. I: ephemeral hosted results cannot prove persistent self-hosted service cleanup or physical-host virtualization capability. |
| S10 | GitHub CLI, [gh environment](https://cli.github.com/manual/gh_help_environment), authentication environment | GH_TOKEN then GITHUB_TOKEN override stored github.com credentials. CLI version unspecified; applies to both architectures when using gh. | D: override precedence. I: trusted Core rejects unexpected overrides rather than relying on an interactive user's prior login. |
| S11 | Apple, [Keychain services](https://developer.apple.com/documentation/security/keychain-services), API overview | JavaScript-only content unavailable; exact OS, item accessibility and service behavior not established. | U: API title alone proves no service access guarantee. |

External Seatbelt research attempted the Apple-owned Seatbelt source URL
https://github.com/apple-oss-distributions/Seatbelt/blob/main/sandbox.h; it returned
404. Public search results about sandbox-exec deprecation are not direct official
API proof. Therefore the exact deprecation version, supported profile language,
future availability, descendant inheritance and supported replacement are **U**.
Obtain the selected macOS SDK headers and local Apple manual pages, record their
versions/content identities and verify them before choosing this backend. This
uncertainty is a lifecycle/support risk, not evidence that either CPU is inherently
Unsupported. S1/S2 do not establish that App Sandbox replaces arbitrary external
process sandboxing. No private Kairo or adjacent repository was inspected.

## Configuration matrix

All rows cover feasibility only, use source-ledger research evidence (S1–S11),
and have no real-host evidence. Exact Core candidate is the future implementation;
this study inspected source base a2ad3d4050a3616984f23fa19fd2af3d923e775a,
package 0.1.0. Future Agent, CLI, Workflow, Action, Runner, SDK and OS build versions
are unknown and must be pinned separately. Public and private repository cases
are distinct future subcases of every row; neither is eligible now.

| Row | Physical host OS / CPU | Guest OS / CPU | Process CPU / translation | Backend and capability scope | Authentication / execution context | Version/evidence limits | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I-D | macOS / Intel x86_64 | None | x86_64 / none | Native Darwin + proposed App Sandbox integration; workspace safety and arbitrary Agent confinement unknown | Dedicated self-hosted service account; separate Core gh, environment Agent login, instance registration | S1,S2,S5–S8,S10,S11; exact macOS/SDK unknown | Unverified |
| A-D | macOS / Apple Silicon arm64 | None | arm64 / none | Native Darwin + proposed App Sandbox integration; signed helper/entitlement feasibility unknown | Same separation, independently tested arm64 service | S1,S2,S5–S8,S10,S11; exact macOS/SDK unknown | Unverified |
| I-S | macOS / Intel x86_64 | None | x86_64 / none | Proposed external Seatbelt process policy; supported API/profile and complete confinement unknown | Self-hosted launchd service, explicit UID/home; no assumed user-session credentials | External evidence gap plus S5–S8,S10,S11 | Unverified |
| A-S | macOS / Apple Silicon arm64 | None | arm64 / none | Proposed external Seatbelt; independent arm64 policy/launcher assessment | Separate arm64 service/account observations | Same sources as I-S; no transfer of Intel result | Unverified |
| I-L | macOS / Intel x86_64 | Linux / x86_64 | x86_64 / none | Proposed Linux VM; existing Linux filesystem seam could run inside guest, host shares remain new boundary | Guest Core/service identity and Agent domains; host Keychain not assumed forwarded | S3,S5–S11; hypervisor/image/kernel/guest isolation unknown | Unverified |
| A-L | macOS / Apple Silicon arm64 | Linux / arm64 | arm64 / none | Proposed Linux VM; arm64 tools and guest containment require independent proof | Independent guest login, registration and services; no host credential mounts | S3,S5–S11; all guest/host build pins unknown | Unverified |
| A-LT | macOS / Apple Silicon arm64 | Linux / arm64 | x86_64 / proposed translation | Translation research variant of A-L, not native Intel/Linux VM proof | Guest service; translator/helper access part of boundary | S4 unavailable; translator availability/version unknown | Unverified |
| A-DT | macOS / Apple Silicon arm64 | None | x86_64 / translation unknown | Translated Darwin tool variant; never counts as I-D | Actual process/helper architecture must be observed | No direct translation capability evidence retrieved | Unverified |
| H-I | GitHub-hosted macOS environment / underlying physical host unknown | Hosted macOS VM / Intel per S9 | x86_64 / verify per binary | Ephemeral hosted test context only; backend availability unknown | Job identity, not persistent Member service login | S9; pin label and observed image, no nested virtualization assumption | Unverified |
| H-A | GitHub-hosted macOS environment / underlying physical host unknown | Hosted macOS VM / arm64 per S9 | arm64 / verify per binary | Ephemeral hosted test context only | Hosted workflow credentials kept outside probes | S9; no inference to A-D/A-L or self-hosted Keychain | Unverified |

Unknown configurations are rejected, not silently mapped to a nearest supported
row. Unsupported is reserved for a known hard incompatibility or authorized
exclusion with attributable evidence; unavailable hardware/accounts is neither.
The existing Candidate library deliberately rejects native Darwin filesystem
capture (see below); that current library limitation does not classify all future
Mac approaches as inherently Unsupported. No production backend is selected.

## Safety assessment by approach and architecture

The following are I requirements and U enforcement questions, not observed
platform capabilities. Each cell applies independently to both listed rows;
a future pass for one never fills the other. Ordinary ownership, POSIX permissions
or a separate user alone do not establish complete containment.

| Boundary | Intel I-D / Apple Silicon A-D | Intel I-S / Apple Silicon A-S | Intel I-L / Apple Silicon A-L |
| --- | --- | --- | --- |
| Filesystem roots | Replace Linux capture with race-safe Darwin traversal; investigate App Sandbox container, explicit read inputs and Writer-only output roots. Entitlement/resource exceptions unknown (S1/S2). | Prove deny-by-default root rules, ancestor replacement resistance and sealed inputs; policy syntax/stability unknown. | Guest descriptor traversal does not protect host shared folders. Disable shares by default; explicit immutable transfer and export validation needed. |
| Paths/tools | Resolve executable and helper paths under actual account; pin bytes and CPU. Intel binary success does not prove arm64 helper compatibility. Do not assume package-manager prefixes. | Same CPU-specific tool inventory; launch every helper under intended policy, including shell and subprocess tools. | Pin guest tools for x86_64 or arm64 independently; host tool paths are not guest paths. Translation is A-LT only. |
| Permissions/case | Record owner, group, ACLs, volumes and case-sensitive/insensitive behavior, spaces and Unicode aliases. Deny symlinks and hard-link/special-file escapes. | Same checks plus replacement during policy/path resolution; permission denial alone may be a vacuous policy test. | Test guest paths and host transfer paths independently; host/guest case and mount semantics can differ. |
| Mounts | Verify volume aliases, mounted external images and ancestor replacement cannot expand access. Container appearance is not proof. | Attempt mount/shared-directory and alternate-path escape; do not assume pathname rules cover aliases. | Test virtio/shared folders, writable disks and guest-to-host export. VM disk isolation is insufficient if secrets are shared. |
| Descendants | Verify helper entitlement/inheritance and detached descendants rather than assuming it from S2. | Fork/exec, detached/reparented and service-spawned helpers require independent tracking; lifecycle API guarantee unknown. | Track guest descendants and hypervisor/helper processes; guest shutdown must not leave writable host helpers. |
| Network | Writer/Reviewer may have only approved restricted egress; Hooks must have none, including DNS, sockets and helpers. Exact enforcement unknown. | Prove policy reaches all children, IPC helpers and network paths. | Disconnect/deny Hook guest networking including host gateway and IPv6; host VM helper must not proxy denied traffic. |
| Identity/secrets | Separate trusted Core state and gh login from sandbox; actual service Keychain availability unknown (S6/S11). Protect other environments and each instance's registration secrets. | Same separation; inherited environment, descriptors, helper IPC and Keychain access require leakage probes. | Never mount host home/Keychain/Core state. Separate guest Core credentials, Agent domain and instance secrets; account equality across OSes is not implied. |
| launchd/cleanup | Pin actual launchd domain, UID, home and restart policy (S5/S7); logout, lock, cancellation and restart may change context. Prove all descendants stopped and storage disposed. | Include launcher/profile failure, policy errors, launchd relaunch and crash reconciliation. No success from leader exit alone. | Reconcile guest shutdown, disk/export disposal, host helper termination and launchd restart; no replacement while any result is unknown. |

App Sandbox (S1/S2) is an application/entitlement research option. External
Seatbelt is a process-launch/policy research option. Distribution outside an App
Store, signing, provisioning, entitlement availability, inheritance and supported
API lifetime need direct SDK/vendor evidence for each; none is established by
this study. A Linux guest is a Mac-hosted Linux execution option, not native
Darwin support. Neither virtualization nor translation inherently supplies the
required network, credential, Reviewer or cleanup policy.

## Current Core correspondence and future work

All 68 controller-provided Git blob identities matched exact workspace bytes
before editing. The delivery base above supersedes Shape's older inspected base.
No Git metadata or controller credentials were needed for that comparison.

After the default branch advanced, Core restored this complete candidate on
base f615e4031603efd75dbd71ec52a1e9c58fb59f90 without conflicts. All 75 supplied
restored-tree blob identities matched the workspace before repair edits. The
original source observation above is preserved; the Agent/Host, filesystem,
Candidate, obligation and toolchain files retain their inspected identities.
The new upstream Claude research and README content are preserved and do not
change this study's macOS support classifications. Its provider-specific rows
are not native macOS evidence and cannot promote any row here. The local English
audit also covers the five newly supplied Claude research documents. Fresh local
checks and independent Core gates apply to the restored candidate; old Acceptance,
Review or CI results are not reused.

| Current location | Observed behavior | Required future integration |
| --- | --- | --- |
| src/workspace.mjs, pinned/read (lines 32–65) | Linux guard, O_NOFOLLOW/O_DIRECTORY and /proc/self/fd ancestor traversal; regular-file and mutation checks | Darwin approaches need equivalent race-resistant capture and reconstruction, not deletion of the guard. Linux guests retain guest prerequisite and must validate host transfers. |
| src/workspace.mjs, boundary and filesystemIdentity | Fresh authorization, requirements, approved inventory, hook configuration, Base and workspace identities | Every backend preserves identities, mandatory ignored artifacts and immutable Candidate binding; no Agent-produced authorization. |
| src/agent.mjs, validateEnvironments | Same environment Agent-login domain may be shared; instance workspace, service, GitHub credential/registration identities independent | Native service or guest provisioning must produce trustworthy observations; never share credentials between environments. |
| src/agent.mjs, validateLogin | Phase/account/User ID/Run/Attempt match, Agent availability, local gh availability, absent token override, safe HTTP status | Actual service account observation on each CPU, including locked/loginless context. Hosted caller does not require local gh. |
| src/agent.mjs, createAgentAdapter.prepare | observe/materialize/seal; verified permission; Writer workspace-write, Reviewer/Hook read-only; denied symlinks, isolated credentials, Hook network denied; observable termination | Implement trustworthy host operations per backend. Absent or unknown capability rejects preparation. Advertised booleans cannot substitute for tested enforcement. |
| src/agent.mjs, correlation/execute/cleanup | Assignment, workspace, execution, Run/Attempt and references correlate; stop/cleanup/reconcile/predecessors block uncertain replacement | Collect outside-sandbox lifecycle evidence; reconcile crashes and detached processes, disk disposal and restart. |
| test/fixtures/agent-host.mjs; test/agent.test.mjs | Bounded synthetic host and rejection cases | Not native containment evidence. Future probes need real malicious subprocesses and independently observed effects. |
| docs/interfaces.md, Agent host and Candidate sections | Version-1 injected Host; version-2 Candidate, fixed protected role/gates and inventory contract | Core remains normative owner. CLI/Action consume versioned compatibility and diagnostics; they must not duplicate policy/state logic. |

Nonbinding future packages, after separate authorization:

| Package | Rough engineering effort | Prerequisites and uncertainty |
| --- | --- | --- |
| Darwin filesystem proof/prototype | 2–6 engineer-weeks | Intel and arm64 hosts, chosen OS/SDK, descriptor/volume semantics; may reveal no acceptable design. |
| Native App Sandbox adapter investigation | Unquantifiable until entitlement/helper feasibility is established | S1/S2 direct content and distribution decision, signed prototype, all adversarial probes. |
| External Seatbelt prototype | 2–5 weeks for feasibility only; maintenance unquantifiable | Supported API/profile/lifecycle evidence currently missing; may be rejected rather than shipped. |
| Linux guest adapter and transfer boundary | 3–8 weeks | Both hardware lanes, pinned hypervisor/guest, account provisioning and host-helper containment. Translation extra and unestimated. |
| Trusted observation/network/credential/cleanup integration | 3–8 weeks per selected backend family | Independent observers, restart reconciliation, service/Keychain behavior; overlaps prototypes, not additive commitment. |
| Independent real-host validation and consumer contract review | 2–6 weeks plus unknown remediation | Approved implementation, real disposable accounts/hosts, reviewers, versioned compatibility outputs. |

These are uncertainty ranges, not priorities, dependency changes, LOC commitments
or support dates. No legacy fixed Controller/Public Dispatch infrastructure or
second CLI Core is required. Public/serialized Host changes require explicit
versioning, producers and consumers to be tested together before promotion.

## Permission, authentication and promotion

Creation checks tools, the actual local account's gh and Agent login and isolation;
it creates the requested total of unregistered instances (default two, positive
count), not Runner IDs. Registration independently verifies target scope and
registration authority and reads back identities; adding a Repo does not add
instances. Standby verifies service-account login and registration/binding without
requiring an Issue Grant. Specific-Issue execution additionally verifies current
Repo Write-or-higher access, Assignee, Owner Grant, native dependencies, full
Runner-set trust, fresh permission and stage evidence. These are Proposal
requirements, not implemented Mac CLI claims.

Trusted Core gh login, environment Agent login and per-instance GitHub registration
credentials are three domains. Agent login sharing within one environment does
not permit sharing instance workspaces/services/registration secrets or crossing
environments. GH_TOKEN/GITHUB_TOKEN precedence (S10), account mismatch, unavailable
Keychain, unknown capabilities and 401/403 must block with sanitized operation,
Run/Attempt and HTTP diagnostics. Do not print credentials, provider responses or
secret sentinels. An unknown privileged-write result requires independent readback
and intent reconciliation, never blind retry. The local Host interface validates
these observations; it does not implement the complete distributed recovery engine.

Promotion requires separately authorized implementation, independent real-host
filesystem, network, account, credential and cleanup evidence for the exact row,
and all applicable Candidate/Hooks, independent Accept, exact-head CI, review,
permission and lifecycle gates. Research acceptance cannot enable routing,
registration, service installation or delivery. Linux CLI, Windows/WSL and unrelated
P1/product E2E obligations retain their original requirements.

## Publication audit and candidate obligations

The local English audit covered README, LICENSE, all docs, src instructions and
user-facing strings, examples, scripts, experiments and .github text. A Unicode
Han/Hiragana/Katakana scan found no matches; manual reading of maintained prose
and changed surfaces found no non-English text requiring correction. A scan is
not by itself proof of language correctness. Repository descriptions, hosted
website content, releases and historical Issue/PR prose were not accessible as
local maintained surfaces and were not audited. No adjacent repository was
inspected or changed.

Both linked research documents and README are tree deliverables. No required
ignored/non-tree artifacts exist for this research; future Mac receipts are design
outputs only. package.json, .npmrc, .github configuration and the supplied file
inventory reveal no applicable hook source or hook installer; installation scripts
are disabled. The approved empty artifacts/hooks inventory remains applicable.
Core independently captures the candidate and rechecks effective hook configuration;
this observation does not waive hidden applicable prerequisites or Core gates.
