# Gemini CLI integration research

Research date: 2026-10-23. No Gemini invocation, login, native isolation test,
registration or production adapter was performed. All execution combinations
below are Unverified and ineligible for dispatch. This package addresses issue
#11's renewed research contract, not historical native acceptance or P1 E2E.

## Evidence and version ledger (G1)

Each linked source was refreshed on 2026-10-23. D means documented capability;
P means proposed Nibfin design; U means unknown. Moving documentation does not
establish behavior of a release. The selected future experimental pin is
`v0.67.0-nightly.20261023.ga713410ab`, explicitly a prerelease, not a recommended
stable release. Its full commit, package integrity, Node requirement and model
revision must be independently resolved and frozen before execution. No binaries
were downloaded. Documentation version applicability is unknown unless noted.

| ID | Official source and section | Class and finding | Version context, limitation and implication |
| --- | --- | --- | --- |
| E1 | [Authentication: choose method and headless](https://geminicli.com/docs/get-started/authentication/) | D: Google login, Gemini API key and Vertex AI are documented alternatives; headless guidance identifies API key or Vertex AI. | Moving docs, exact applicable version unknown. No account or quota was measured. P: future fixtures use a separately approved API-key account; Vertex/service-account policy needs its own validation. Login is not Core authorization. |
| E2 | [Headless: technical reference, formats, exit codes](https://geminicli.com/docs/cli/headless/) | D: non-TTY or `-p` invokes headless mode; `--output-format` selects JSON or streaming JSON. JSON describes response, stats and optional error; streams include init/message/tool/error/result events. Documented exit codes include 0, 1, 42 and 53. | Moving docs, version unknown. Full normative error object schema and duplicate/truncation behavior remain U. P: pin and validate a parser before use; CLI success cannot establish a protected result. |
| E3 | [Configuration: layers, settings, environment files](https://geminicli.com/docs/reference/configuration/) | D: settings have system, user and project layers; project settings can override user defaults. Environment-file discovery can search current, parent and home locations; extensions can load environment files. | Moving docs, version unknown. Effective defaults at the selected tag remain U. P: isolate home/parents, sanitize environment and reject unapproved executable configuration. |
| E4 | [Context: hierarchy and imports](https://geminicli.com/docs/cli/gemini-md/) | D: context discovery includes home, workspace/parents and just-in-time ancestors; imports modularize context. | Moving docs, version unknown. P: treat every discovered instruction/import as untrusted content and constrain readable roots; never derive role or permission from context. |
| E5 | [Sandbox: methods, tool sandboxing, expansion](https://geminicli.com/docs/cli/sandbox/) | D: documents multiple platform-specific mechanisms. Tool-level isolation differs from whole-CLI confinement; expansion and custom flags need examination. | Moving docs, version unknown. U: equivalence to Nibfin whole-process and descendant enforcement on every architecture. P: an external Host boundary must contain the entire CLI, configuration loading and descendants. A tool allowlist alone is insufficient. |
| E6 | [Sessions and history](https://geminicli.com/docs/cli/tutorials/session-management/) | D: documents session/history management. | Moving docs, version unknown. U: pinned storage/resume semantics and secure disposal. P: allocate fresh disposable session storage for each role and forbid resume from another role. |
| E7 | [Official selected release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.67.0-nightly.20261023.ga713410ab) | D: this named release is a prerelease. | Exact tag selected only for future case design. Release notes do not demonstrate Nibfin compatibility. Full immutable artifact identity remains a prerequisite. |

Claims about tools, custom commands, MCP, extensions and provider hooks are
limited to their configuration surfaces in E3; their secure execution semantics,
complete discovery precedence and disablement at the selected tag remain U.
No undocumented flag or fabricated runnable verification command is prescribed.
ISO-02/ISO-06 are Scope references whose definitions were not supplied; this
research does not invent them.

## Existing interface and proposed backend (G2)

Normative local owner: this Core package's [interface](../interfaces.md),
`src/agent.mjs` and `src/protected.mjs`, inspected at base
`0321811e26c4ea4dfe9e6b37c5971d07ce99db6d`. All 66 controller-supplied Git
blob identities matched before editing. This is repository observation, not
provider behavior. The package is unreleased 0.1.0. No adjacent repository was
inspected. Gemini would be a trusted Core-injected Host backend; repository code
must never select or supply Host implementation code.

| Host method | Existing contract and proposed Gemini responsibility | Evidence / future cases |
| --- | --- | --- |
| observe | Return exact assignment, environments, instances, previousEnvironments, login, capabilities, exposures and permission from trusted observations. Verify actual service account and registered instance; require isolated credentials, denied symlinks, observable termination and restricted/denied Agent egress. | `createAgentAdapter.prepare`, F01–F05, F09 |
| predecessors | Enumerate authenticated prior executions including other registrations/Runs. Never rely on Gemini history to establish absence. | F03, F13 |
| reconcile | Independently obtain prior correlated termination/disposal evidence. Safe requires confirmed termination and safe disposal before new execution/workspace IDs. | F12–F14 |
| materialize | Reconstruct each explicit repository/candidate/artifact/hook reference from immutable trusted storage, including ignored required artifacts. Validate string content using Core digest, destination and identity. | F04, F08 |
| seal | Return exact correlated mode/references after applying real filesystem controls. Only deliver has workspace-write; all other roles and Hooks are read-only. | F01–F03, F08 |
| execute | Run pinned CLI inside Host boundary with resolved instructions; preserve invokeProtected authorization, requirement, prior-role and result gates. Return correlated host references plus unchanged schema-5 RoleResult. Hooks receive null instructions and use their separate class. | F01–F11 |
| stop | Request termination of whole execution and descendants on cancellation, deadline or completion; a successful request or exception says nothing about final state. | F11–F13 |
| cleanup | Independently observe correlated termination/disposal and nonempty evidence references, including filesystem and process residue. Persist uncertainty and block replacement. | F12–F14 |

Host assignment fields are schemaVersion 1, executionId, workspaceId,
environmentId, instanceId, class, binding and references. Binding carries
requestId/resultId/sessionId, role/skill, repository/Issue stable identities,
authority and both requirement references, scopeDigest, instructionDigest,
instructionSelectionDigest, previousDigest, shapeDigest/candidateDigest,
deliveryCycle/repairCycle/incidentId, source repository/workflow digest/Run/Attempt,
and versions core/runtime/adapter/skill. Preserve explicit nulls where required.
No provider session ID substitutes for any Host identity. References carry id,
kind, digest, relative path, repositoryId, candidateDigest, runId and attempt.
Correlated Host records carry executionId, workspaceId, assignmentDigest,
operation, runId, attempt and schemaVersion. Exact comparison prevents stale or
cross-assignment substitution; hashes alone authenticate nothing.

The six roles remain shape, shape-validator, shape-diagnosis, shaper-review,
deliver and accept. The first four use Skill shape; deliver and accept each keep
their own Skill. Independent reviewers require fresh session/workspace IDs and
immutable evidence, never the Writer's conversation or mutable checkout.
Repository instructions cannot change those identities. Core resolves approved
default/extend/override instructions and binds both effective content and selection.

Proposed conversion: bounded parser consumes a complete pinned provider output
format, rejects duplicate JSON keys, multiple terminal results, unexpected
trailing bytes, missing fields, invalid UTF-8, truncated input, error-bearing or
ambiguous completion, and enforces byte/time limits. Model response content must
itself validate as the exact required RoleResult; never manufacture success from
exit code 0 or wrap arbitrary prose as accepted. Require exact trusted binding,
allowed role outcome/failureClass, references and conflicts under existing Core
validators. Reject stale candidate, wrong Run/Attempt and evidence substitution.
Keep provider transport diagnostics separate from role evidence. Preserve original
property order for Core digests; digest(string) hashes JSON.stringify(string),
including quotes, rather than raw UTF-8. Do not add a competing body hash.

Gaps: there is no Gemini parser, native Host, durable process reconciler, approved
endpoint policy or pinned provider-result schema here. Host v1 returns string
materialization; binary evidence representation must be specified separately
before use, never silently coerced. The seam does not implement complete Hook
receipts or lifecycle orchestration. Full native implementation and any required
versioned interface extension need separate authorization and consumer proof.

## Boundary and failure analysis (G3)

Everything in the enforcement column is proposed future Host/Core behavior,
not measured Gemini behavior. E numbers refer to the ledger. All remaining
uncertainties block real work. Cleanup consequence C means stop the complete
execution, independently inspect descendants/mounts/files/state, persist correlated
observations, and block replacement until termination confirmed and disposal safe.

| Risk | Asset / entry | Failure | Enforcer | Evidence / uncertainty | Rejection case / cleanup |
| --- | --- | --- | --- | --- | --- |
| R1 | Trusted assignment / model or repository instructions | Role, Skill, permission or Host-code substitution | Core assignment/instruction verification | Local schema 5; provider identity not trusted | F04; C |
| R2 | Host files / CLI, symlink, mount or descendant | Read/write escapes including reviewer writes | Whole-process OS boundary, nonprivileged identity, approved mounts, no Host socket | E5; kernel/backend behavior U | F02, F08; C, inspect mount residue |
| R3 | Configuration / home, parents, .env, context/imports | Unapproved prompts, credential/endpoint override | Isolated home/parents and sanitized environment; inspect effective config | E3–E4; exact pinned discovery U | F07; C, erase session/config state |
| R4 | Execution / custom tools, commands, extensions, MCP, provider hooks, sandbox flags | Spawn uncontrolled code, change restrictions or exfiltrate | Deny unapproved executable configuration before startup; OS controls remain mandatory | E3/E5; complete disablement U | F06–F07; C, inspect plugin children |
| R5 | Credentials / environment, files, service identity | Leak Core GitHub/signing material or another environment's login | Core secrets absent; dedicated credential domain and service account; only approved agent-login exposure | Local validateLogin/validateEnvironments, E1; provider credential attack resistance U | F05, F09; C, invalidate compromised login separately |
| R6 | Network / CLI, subprocess, telemetry or tool | Unapproved egress, proxy or local metadata access | Host-enforced restricted Agent endpoints; deny all Hook network including DNS/loopback escape routes | E3/E5; exact required endpoints U | F09–F10; C, capture deny evidence without payloads |
| R7 | Independent evidence / reused session or mutable artifact | Reviewer contamination, ignored artifact omitted | Fresh immutable materialization, seal and independent session checks | Local Host v1; production storage U | F03–F04; C, invalidate dependent evidence |
| R8 | Protected result / JSON, stream or exit code | Malformed, duplicate, truncated, stale or ambiguous success | Pinned strict parser plus existing Core validators | E2; full pinned schema U | F11; C, never infer completion |
| R9 | Exclusivity / cancellation, timeout, detached process | Surviving writer and blind retry | Host termination observer, durable predecessor reconciliation | Local cleanup contract; native tree termination U | F12–F14; C, retain admission hold |
| R10 | Support claims / research matrix | Research promoted to operational support | Core eligibility and version/evidence checks | Scope C-13; no execution evidence | F14; deny dispatch, preserve invalidation |

Approved Gemini credentials may necessarily be visible to the CLI process. They
must be the sole explicitly approved provider credential domain, never an Owner
GitHub token or signing key. Vertex service-account account/project/role and
credential-file handling remain unknown until separately pinned and tested.
A service user's successful local gh login is observed outside the Agent, not
mounted inside it; GH_TOKEN/GITHUB_TOKEN overrides must be absent. Different
Agent environments cannot share credentials; same-environment registrations may
share Agent login while retaining separate GitHub identities, services and roots.
Read-only means enforced filesystem denial even if the model asks to write.
Hooks are neither Gemini tools nor provider hooks; no Agent login and no network
are allowed in either mandatory Core Hook pass. Tool approval is only defense in
depth, never the confinement boundary.

## Compatibility matrix (G5)

Common exact bounds for rows A–E: Core source base above, package 0.1.0, Host v1,
protected schema 5, Skill source at that base (release content identities unknown);
Gemini selected prerelease E7, artifact/model/runtime identities unresolved;
proposed API-key auth, dedicated service account; independent registered Runner
required but registration identity unknown. Each row covers Public and Private
repositories separately with identical Unverified status, and all six protected
roles plus separate credential-free Hooks. Evidence is official-document research
E1–E7 and future cases F01–F14 only; no native results or content receipts exist.
These bounds describe two repository contexts per row, not arbitrary combinations.

| Row | Host OS / architecture | Guest / proposed isolation | Scope / evidence locator | Status / limitation |
| --- | --- | --- | --- | --- |
| A | Linux x86_64, distribution/kernel pin unresolved | Linux x86_64 disposable container, runtime/image/kernel pins unresolved | F01–F14/A, whole-process design | Unverified; filesystem, egress and descendants unmeasured |
| B | Windows x86_64, build pin unresolved | Native Windows x86_64 restricted process boundary, implementation pin unresolved | F01–F14/B | Unverified; no native backend or measured cleanup |
| C | Windows x86_64 with WSL2, build/kernel pins unresolved | Linux x86_64 guest container, runtime/image pins unresolved | F01–F14/C | Unverified; Windows mounts/interop and service login boundaries unmeasured |
| D | macOS Intel x86_64, release pin unresolved | Linux x86_64 VM/container, hypervisor/image pins unresolved | F01–F14/D | Unverified; native Seatbelt equivalence also unknown |
| E | macOS Apple Silicon arm64, release pin unresolved | Linux arm64 VM/container, hypervisor/image pins unresolved | F01–F14/E | Unverified; do not inherit Intel/Linux results |
| X | Any OS/architecture | Deliberately excluded unrestricted host execution with Core credentials or tool-only isolation as sole boundary | R2/R5, Scope credential and isolation boundaries | Unsupported by deliberate exclusion; not a claim that an OS is inherently incompatible |

Absent hardware/accounts are prerequisites, never evidence of inherent
incompatibility. Other authentication/backends/architectures are not covered and
remain Unverified. No row enables a live Runner. Linux CLI validation, Windows/WSL
obligations, installation/release gates and unrelated P1 E2E remain unchanged.

## Historical record and future handoff (G6)

Historical AC1, AC2, AC3, AC4, AC5 and AC6 remain unmet native-execution obligations.
Their exact definitions were unavailable in the supplied repository/context;
no historical clause is reconstructed or claimed passed. The historical
`out/gemini-validation.json` obligation remains unmet; this research does not
create a substitute file. Individual unavailable T01–T14 entries are recorded in
the [future plan](gemini-cli-test-plan.md). Scope provenance remains the R2
NBP1-20261022-01 N10 record and original pre-translation hash
`cf569e2275b2fd6882c1d7bc43bf1e8da35352a22dc7691b52280cbec858dc9c`;
these are provenance, not accepted evidence.

N07 remains the original Agent-isolation/local-interface prerequisite reference;
only Core enforces live native dependencies. No Issue or edge is created here.
Future authorized work needs an immutable CLI/model/runtime pin, native Host and
parser implementation, actual accounts/resources, kernel confinement and egress
proof, trusted durable evidence/reconciliation, consumer integration, genuine
positive/negative execution and all normal independent gates. Size is unknown:
platform termination, credential mediation, result schema gaps and durable
cross-Runner reconciliation can dominate implementation. A LOC estimate is not
a completion measure and needs investigation in separately authorized planning.
No second executor or excluded legacy dispatch system is proposed.

## English/disclosure audit and verification (G7)

Inspected README.md, LICENSE, all docs (including decisions, interfaces, Scope and
role documentation), examples, source instruction documents and all three
workflow descriptions. Existing maintained prose is English; a Han/Hiragana/
Katakana scan found no matches across README, docs, examples, .github and LICENSE.
Manual reading found no required translation, including denied policy/workflow
paths; none was edited. This is a local file audit, not an audit of unavailable
repository descriptions, remote Issues, releases or adjacent repositories.
No private source excerpts, credentials or operational logs are included.

`test/agent.test.mjs` and `test/fixtures/agent-host.mjs` were inspected as synthetic
Host evidence only. Their Node permission/VM probes do not establish native CLI,
arbitrary descendants, kernel network isolation or production login. No Gemini
case in this package was run. Build/check outcomes are reported in the Deliver
handoff; they validate local source formatting/ESM, not research completeness,
hosted CI, independent Acceptance or delivery completion.

The current package, .npmrc, file inventory and product-quality workflow contain
no repository/Husky/workspace commit-hook source. Workflow checks are separate.
No extra non-tree artifacts are required by this research Shape. Discovery of a
mandatory hook or unsupported prerequisite must block reconciliation rather than
silently omit it. Core retains both isolated credential-free/network-denied passes.
