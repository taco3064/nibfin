# Protected role host

The maintained `createProtectedRoleHost` composes Core's existing role owners,
`createAgentLifecycle`, isolated workspaces and Codex/Claude/Gemini transports.
It is inert at construction. Its `prepareRole` is bound into Core owners by
`owners(existingOwners)`. The protected-host entry also accepts a `roles`
deployment binding in execute/compute mode and performs this wiring itself.
The reviewed executable deployment module may export `roles` alongside
`capabilities` and `identity`; its source and options approvals remain mandatory.
Issue text, checkout configuration and model results never select adapters.

A protected configuration has `runner`, `profiles` and `assignments`.

The first-party `createNativeRoleBindings` supplies the role host's `bind` function
from protected Core tasks. It allocates fresh independent execution/request/result
identities, retains the request before launch, and fixes the success-result contract
before the model runs. Shape uses the native document output format; Deliver binds
its Candidate only after the trusted capture owner has observed termination.
Acceptance and final-review prompts refer to their already materialized `/work`
checkout instead of embedding the binary workspace transfer again. The retained
full task identity still covers that transfer. This metadata/prompt assembler
does not supply authentication, a model backend, service readiness or write rights.
`runner` follows `host/runner.schema.json`; the example supplies deployment-owned
account/paths, not a claim that those resources exist. `supportedRunnerDefaults`
version 1 fixes tool versions, PATH/interpreter, rootless Docker, acquisition and
network semantics. Unknown overrides fail. Each profile has `{id,agent,os,backend}`:
agent is codex/claude/gemini, os is linux/wsl, and backend is the corresponding
maintained adapter configuration. Every one of the six protected roles is assigned
one profile ID. Distinct instances/workspaces are required across roles; selected
instances can share only their authenticated environment's login directory.
Only Deliver receives a writable Candidate mount.

Linux Accept and final-review tasks containing Core's complete workspace transfer
are materialized into their configured private role directory before Agent launch.
The host verifies the separately retained expectation against the bound Candidate,
repository, Scope, Shape and policy, restores exact files/modes/ignored sources,
and retains a `role-workspace` receipt. Transfer content never selects a destination.
Nonempty destinations are preserved and require reconciliation; a successful
transfer is not an Acceptance result. WSL transfers require a guest-side owner
and are rejected by this Linux materialization path.

The trusted `bind(task)` supplies current execution/binding expectations, selected
instructions, prompt/inputs and the original absolute deadline. It cannot supply a
backend or permission override. Core independently checks authority, native
predecessors and independent role identities as before. The returned task identity
binds the complete Core task. `probe` and `observe` are external observation seams:
preflight rejects absent, failed or unprobed account, GitHub identity, tool/image,
isolation, cache and network prerequisites. Probe results must come from the selected
service/guest context. The default local account/filesystem observer rejects symlinks,
non-owned roots and GH_TOKEN/GITHUB_TOKEN substitution. Management authentication,
retention and existing stage-owner inputs stay in trusted Core.

For a native Scope/Shape document, the Shape Author binding selects
`outputFormat:'shape-author-v1'` and supplies `startCurrent` with independently
pinned execution, binding and result expectations, without a predicted body hash.
The selected entrypoint decodes `{body,result}`; only the trusted request supplies
receipt identity. After confirmed termination, the role host verifies the exact
Scope bytes, retains the actual body, and exposes `readBody()` and `current()`
with its final body hash. Collection still validates the complete result against
the independent success contract. A missing retention reference or changed Scope
invalidates collection. Validators keep their separate, fully bound output path.
The host must use these retained values rather than prefill a future Author body.

## Network migration

Linux backends now require `egress:{image,node}` to become ready. `image` is an
already-provisioned immutable SHA-256 image with the pinned Node interpreter;
`node:true` enables the explicit npm download destination. There is no fallback to
unrestricted bridge or host networking. Existing deployments must add this protected
configuration and approve the updated sources. Missing enforcement blocks readiness.
No image acquisition runs inside the Agent; the provisioning owner obtains pinned
images using its separately approved download policy.

The maintained Docker boundary creates a uniquely owned internal bridge network with Docker gateway mode `isolated` and IPv6 disabled. The bridge has no host address; roles cannot reach host services through a bridge gateway. Role DNS forwards to loopback only; the embedded resolver supplies the fixed internal proxy alias without permitting arbitrary external DNS queries.
Only a credential-free gateway has an external bridge route; roles have only the
internal network and fixed proxy address. Direct outbound connections consequently
have no external route. CONNECT allows only selected adapter hostnames on port 443.
All DNS answers must be public; the checked literal is dialed, preventing rebinding.
The TLS ClientHello must name that same host. A redirect needs another allowed
CONNECT; IP literals, private/link-local/metadata addresses, undeclared hosts, absent
SNI and ECH fail closed. No management endpoint is in a member-model profile.
Node acquisition explicitly adds registry.npmjs.org; hooks have no destinations.
Entrypoint probes perform credential-free TLS handshakes through this actual proxy.
Gateway and role networking are inspected again before use and correlated on cleanup.
A missing Docker/network/proxy/DNS/TLS capability never establishes readiness.
Before a tunnel is established, the gateway returns only fixed failure categories;
destination DNS failures remain `dns`, distinct from endpoint/private-address
`policy-denial`, resolver `timeout` and gateway `proxy` failures. Resolver messages,
addresses and sensitive URLs are never included in these diagnostics.

## Results, recovery and verification

The selected adapter keeps credential values private and supplies the verification
lane with a rejection capability. Linux and the WSL guest check command arguments,
environment and evidence against the launch and current selected credentials,
including encoded forms, before execution, custody retention and receipt return.
Credential-bearing commands fail closed; subprocess log redaction alone is not
permission to execute or retain them. WSL rejection invalidates that host session.

Each container starts with a fresh session. Codex 0.163.0 uses JSONL events and a
successful terminal turn plus a unique structured result, rather than a last-message
file. Claude 2.1.285 uses a successful JSON result/structured_output; Gemini 0.65.0
uses its JSON response envelope. Nonzero exit, malformed/missing output and credential
sentinels fail. Core validates the terminal result against its current role, execution,
request, instructions and binding independently of CLI metadata.

Deliver launch inputs describe the starting workspace. After confirmed Writer
termination, the existing Core Deliver owner captures the resulting workspace and
calls the prepared role's trusted `bindCandidate(candidate)` handoff. The bridge
first requires the returned launch inputs to match exactly, then substitutes only
that captured candidate. It preserves the terminal result, publication, execution
and authority fields. Both lifecycle and Core compare the complete final envelope
against deployment-owned current expectations; those expectations must use the
post-termination candidate, not the initial tree. Binding before termination or
rebinding to another candidate fails. Reviewers have no handoff. No model result
or checkout can supply this capability, and capture remains in its existing owner.

Recovery is disabled by default. The trusted backend `recovery` policy contains
`attempts` (1–4), `delayMs`, `model`, `models` and `fallbacks`. Every model capability
has `{id,adapter,provider,version,resume:true}` and must match the selected adapter and
pinned CLI. Only recognized structured capacity errors can resume, within the same
container/session/workspace and absolute deadline. Fallbacks require explicit model
capabilities and remain inside the same provider/authentication boundary. Missing
session IDs, arbitrary model prose, generic 403, authentication failure, transport
uncertainty and unknown external writes cannot trigger replay or switching.
Session files live in container scratch and are removed with that container.

`createRoleBudget` reserves formal-result time. `createVerificationLane` admits one
command at a time and rejects overlap; preparation and tests use the same lane and
cutoff. Commands retain exact declared input identities, command, start/end,
status/exit/signal and sanitized logs through the supplied existing custody `retain`
capability. Only a passed receipt for identical inputs in the same role can be reused.
Cancelled, busy, failed, unresolved and exhausted commands are never passes.
`prepareNode` copies the selected workspace into writable instance verification
scratch and installs locked dependencies with lifecycle scripts disabled. Every
execution has a fresh home/cache; required nested projects are prepared explicitly.
Commands execute inside the original role's enforced container through the fixed
verification-child entry. The source is checked again on use; stale preparation
blocks. The copy and cache are test inputs, never a Candidate replacement or verdict.
Command reuse hashes the complete prepared tree, including installed and nested
dependencies, generated fixtures and npm executable links. Dependency changes
invalidate a previous pass; links escaping the prepared copy block execution.
Candidate copying still excludes old installations and Git metadata.
Dependency failure retains diagnostics and blocks dependent regressions.

Verification commands require `/usr/bin/python3` 3.11 and Linux child-subreaper/procfs
support. The fixed supervisor is packaged and mounted read-only; actual entrypoint
preflight probes it before readiness. Missing prerequisites block with
`verification-supervisor-unavailable`. The supervisor adopts and kills/reaps orphaned
descendants even after detached sessions or double forks. Completion requires its
kernel ECHILD reconciliation proof. Missing proof latches the lane unresolved and
forbids further commands; enclosing container termination/reconciliation is required.
Production cancellation stops the owned container/process tree. A lost Docker/WSL
reply leaves the original attempt unresolved; it does not start a replacement.
Cleanup removes only selected-instance resources after verified process termination,
leaving sibling instances and shared authorized login intact. Candidate capture,
hook execution and independent Acceptance remain their existing Core owners.

## Interface sources and evidence boundary

Pinned version probes and local injected/credential-free process tests establish
source contracts. Real model, rootless Docker and native Windows/WSL combinations
remain **Unverified** until phase-B evidence exists; macOS is not a runnable profile.
No paid account, live host, release or external E2E result is claimed here.

Official interfaces: [Codex noninteractive](https://developers.openai.com/codex/noninteractive)
(JSONL and explicit session resume; the selected 0.163.0 local help also exposes
exec/resume JSON/schema/config flags),
[Claude programmatic execution](https://code.claude.com/docs/en/headless),
[Claude permissions](https://code.claude.com/docs/en/permissions),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Gemini headless](https://geminicli.com/docs/cli/headless/) and
[Gemini policy engine](https://geminicli.com/docs/reference/policy-engine/).
Current documentation can describe newer releases; exact version/help probes and
fail-closed feature checks remain required. These references do not certify model
availability or authentication and do not authorize a version upgrade.

Local verification uses `npm run check` and `npm run verify:archive` from a current
prepared copy. In bounded delivery environments run preparation and both commands
through the supplied verification runner, sequentially. Writer command receipts
never replace independent Acceptance or exact-head CI.

The selected bridge options follow [Docker gateway modes](https://docs.docker.com/engine/network/port-publishing/#gateway-modes); plain internal mode alone still exposes host services on the bridge address and is rejected.
