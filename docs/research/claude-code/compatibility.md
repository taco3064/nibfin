# Research compatibility rows

Every row is individually identifiable. These are proposed test targets, not a
Runner manifest or an exhaustive OS × architecture × auth product. Evidence is
**official-documentation research**, with dated factual content locators
[S1–S5](sources.md), observation 2026-10-24. No installed CLI/SDK or provider
execution content identity exists. Core interface correspondence is baseline
`0321811e26c4ea4dfe9e6b37c5971d07ce99db6d`, as mapped in
[architecture](architecture.md). Core/Runtime/Skills/Action/Workflow/CLI release
versions and digests for an operational deployment are **unknown**, not package
0.1.0 support. Exact Claude CLI/model/backend versions must be pinned later;
SDK is not selected. No row is eligible for real work.

Shared assumptions for R1–R7: all six protected roles, separate Core Hook class,
valid Writer and independent read-only review, result/evidence correlation,
cleanup, registered self-hosted instance with per-instance GitHub isolation,
and hostile Public/Private checkout handling. Shared unknowns: actual authenticated
execution, outer containment, effective context closure, credential confinement,
process-tree disposal and all product gates. Each uses the full test family in
[verification](verification.md); auth-specific setup must be separately qualified.
Host and guest versions are unknown and must be pinned before execution. A listed
architecture is a target, not a provider package-availability claim.

| ID | Claude version / authentication | Host / guest OS and architecture | Isolation backend proposal | Context / additional limits | Status and evidence |
| --- | --- | --- | --- | --- | --- |
| R1 | Unknown CLI; Console API key | Linux x86_64 / Linux x86_64 | External container plus kernel filesystem/network/process policy, exact versions unknown | Registered local service; disposable user; Public and Private tested separately; bare-mode candidate requires S1 qualification | Unverified; S1–S5; no native evidence |
| R2 | Unknown CLI; subscription OAuth | Linux x86_64 / Linux x86_64 | Same outer design as R1 | Separate auth family: cannot assume bare mode reuses subscription login; refresh/key storage and context suppression unresolved | Unverified; S1, S3, S4, S5 |
| R3 | Unknown CLI; Bedrock identity | Linux arm64 / Linux arm64 | Outer VM/container, exact backend unknown | Scoped cloud identity and endpoint/refresh broker require independent evidence; no broad cloud credentials | Unverified; S1, S3, S5 |
| R4 | Unknown CLI; Google cloud identity | Windows x86_64 / WSL2 Linux x86_64 | Outer WSL guest containment plus host boundary, exact versions unknown | Windows/WSL credential and mount separation unproven; service account differs from interactive user | Unverified; S3, S5 |
| R5 | Unknown CLI; Foundry identity | Linux x86_64 / Linux x86_64 | Outer VM/container, exact backend unknown | Endpoint/token scope and helper confinement separate from R3/R4; no cross-provider evidence substitution | Unverified; S1, S3, S5 |
| R6 | Unknown CLI; invited Team/Enterprise login | macOS Intel x86_64 / macOS x86_64 | Proposed whole-process OS containment or VM, backend unknown | Seatbelt shell capability alone insufficient; keychain/service identity unproven | Unverified; S3–S5 |
| R7 | Unknown CLI; Console API key | macOS Apple Silicon arm64 / macOS arm64 | Proposed whole-process OS containment or VM, backend unknown | Separate architecture; no reuse of Intel or Linux execution evidence | Unverified; S1, S3–S5 |
| X1 | Any unpinned CLI/auth | Native Windows x86_64 / same | Provider shell sandbox alone | Deliberately excluded design: fails required whole-process isolation; not a declaration that Windows can never be supported | Unsupported; S5 and architecture safety requirements |
| X2 | Any CLI/auth | Linux/macOS/WSL2; architectures unspecified | Shell sandbox only, no outer boundary | Deliberately excluded: tools/helpers outside boundary. Applies to all roles and both repository visibility classes | Unsupported; S5; exact unsafe design, not platform-wide exclusion |
| X3 | Any CLI/auth | Any Host/Guest/architecture | Prompt/tool restrictions only; persistent credentialed Runner exposed to untrusted checkout | Deliberately excluded deployment: no trustworthy credential/process boundary | Unsupported; architecture threat analysis and Core host contract |

Unverified means missing proof, not known incompatibility. Unsupported above
identifies a hard unsafe design or deliberate exclusion, not account/host absence.
No synthetic test result, package install, documentation revision, research
completion or local interface check supplies native/product support.

Downstream release/support material may copy these stable row IDs, source date,
explicit unknown component versions and limitations into immutable compatibility
records. Bind each released record to its own content identity and research
artifacts; do not silently rewrite published versions. Consumers must distinguish
documentation research, local synthetic evidence, CLI lifecycle evidence, native
Agent isolation evidence and product E2E. Promotion requires fresh separately
authorized real evidence for the exact version/OS/architecture/auth/backend/role/
Runner/visibility combination and all mandatory gates. Unknown compatibility
cannot enable dispatch. Linux CLI evidence cannot promote Claude/macOS rows;
research cannot satisfy unrelated P1 completion or external Quick Start.
