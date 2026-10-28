# Rootless Agent, Hook and verification integration

Linux is the runtime baseline. Windows uses the maintained WSL invocation bridge
and delegates to the same Linux implementation; it is not a separate isolation
engine. Native macOS execution is unsupported. Source/contract tests are not live
host isolation, model, release or multi-account E2E certification. Those checks
remain separately owned, including #205.

## Maintained origin

The following responsibilities reuse Kairo revision
`d1b47d5e073cf15bdcdc1fbbec098401649878d9`. This public package contains its
implementation; consumers need no access to the private source repository.

| Upstream source | Maintained destination | Adaptation and tests |
| --- | --- | --- |
| `src/agent.mjs` | `src/codex.mjs`, `src/role-host.mjs`, provider entrypoints | Fixed utility mounts, role deadline, one-login-file mount and Candidate publication filter. Retain Nibfin's separate Codex/Claude/Gemini parsers, login formats, role permissions and independent member environments. `test/codex.test.mjs`, `test/claude.test.mjs`, `test/gemini.test.mjs`, `test/role-host.test.mjs`, `test/isolation-reuse.test.mjs`. |
| `src/docker-security.mjs` | `src/docker-security.mjs`, Agent and Hook builders | Explicit socket, sanitized environment, rootless/seccomp/effective systemd cgroup-v2 checks; remove legacy rootful compatibility. Verify actual role/proxy mounts, environment and resource settings. `test/docker-security.test.mjs`, `test/hooks.test.mjs`, `test/isolation-reuse.test.mjs`. |
| `src/egress-proxy.mjs` | `src/egress-gateway.mjs`, `src/egress.mjs` | Reuse exact CONNECT destination, public DNS pinning and ClientHello SNI checks. Retain stronger Nibfin IPv6/reserved-range/ECH rejection. Replace deployed allowlist with provider-scoped profiles and explicit npm dependency permission. Verify source, command, mounts, image and network membership. `test/egress.test.mjs`, `test/isolation-reuse.test.mjs`. |
| `src/agent-gh-read.mjs`, `src/agent-gh-client.mjs` | same filenames | Configure authorized public repositories from trusted host inputs, with no fixed owner/repository list. Host retains authentication; selected Agent receives only the socket client capability. `test/agent-gh-read.test.mjs`. |
| `src/credential-output.mjs` | same filename, `src/agent-session.mjs`, `src/verification.mjs` | Reuse encoded-secret filters for results, logs and Candidate surfaces, retaining nested JSON decoding. `test/credential-output.test.mjs`, adapter and verification tests. |
| `src/verification-runner.mjs` | same filename, `src/verification.mjs` | Reuse lock/receipt/deadline semantics; both Agent CLI and Core verification use the same in-container command lock. Retain custody and unresolved-state latching. `test/verification-runner.test.mjs`, `test/verification.test.mjs`, role-host tests. |
| `src/verification-prepare.mjs` | same filename, `src/node-verification.mjs` | Exact writable copy, exclude Git/old modules, locked install without scripts. Retain explicit nested projects, fresh cache, source/copy/cache identity and injected Core lane. No parallel preparation owner. `test/verification-prepare.test.mjs`, `test/verification.test.mjs`. |
| `src/process.mjs` | `src/process.mjs`, `src/verification-child.mjs`, `src/verification-supervisor.py` | Reuse bounded process execution contract; retain Nibfin's Linux kernel subreaper as the single subprocess owner because immediate process-group cleanup cannot reconcile setsid/double-fork descendants. Agent/Hook Docker client processes delegate here. `test/verification.test.mjs`, `test/verification-runner.test.mjs`. |
| `docs/rootless-hardening.md` | this document | Adapt hardening and trust boundaries to public personal/Organization repositories and member-owned model logins. No deployed grants, accounts or machine paths. |

## Configuration and migration

An explicit local rootless user socket is mandatory; ambient Docker context,
host, TLS or config overrides are never inherited by the Agent/Hook transport.
The daemon must report rootless mode, builtin seccomp, systemd cgroup v2 and
memory/PID/CPU enforcement. Containers have read-only roots, dropped capabilities,
no-new-privileges and bounded resources. Only Deliver has a writable Candidate.
Images remain pinned by digest and their inherited environment/volumes are checked.
A deployment that cannot satisfy these checks must stop; there is no rootful fallback.

Each Agent's network is an owned internal bridge with isolated gateway mode.
Only the credential-free HTTPS proxy also has its explicitly required external
bridge connection. The Agent has no such route. Provider profiles stay separate;
`egress.node: true` additionally permits the npm registry for locked preparation.
Adding a destination requires a reviewed profile change, never a download-error
fallback. Proxy observation now verifies source bytes inside the running container,
read-only source mount, command, entrypoint, image, running state and address/network
correspondence. A missing or stale observation blocks launch.

To enable GitHub observations, trusted deployment code calls
`startGithubReadBroker({directory, repositories, environment})` with a new dedicated
directory, current authorized public repositories and the host service account's
HOME/PATH. Keep this server alive until all correlated Agent containers stop;
close it and remove its dedicated directory only afterwards. Each selected backend
receives `githubRead: {directory, repositories}`. The directory must contain only
`read.sock`; it is mounted read-only along with the fixed executable `gh` client.
Every read rechecks exact public repository identity. No checkout text chooses the
broker allowlist. Writes, arbitrary GraphQL, downloads and non-GET API methods are
unavailable. The broker deliberately does not inherit GH_TOKEN/GITHUB_TOKEN.
Hooks receive neither broker access nor model login and use network-none.

Mounted model login material remains readable to code inside that Agent container.
Filtering known secrets is a publication defense, not credential invisibility or
protection against a compromised host/member model account. Different member
login spaces remain independent. Host GitHub write authentication, Owner signing
keys and Docker sockets never enter Agent/Hook mounts.

All roles and customizations receive the fixed verification command and deadline
in their request. Use `node /verification-runner.mjs -- <absolute executable> ...`;
`node`, `npm`, `git` and `sh` have fixed convenience paths. Receipts and filtered logs
are under `/verification/commands` in the selected instance's retained service
resources. Core-requested commands also retain their existing custody receipts.
The shared lock is retained on unresolved cleanup or retention failure. A busy,
failed, cancelled or exhausted receipt is not a pass. Prepare Node projects with
`node /verification-runner.mjs -- node /verification-prepare.mjs /work /tmp [project]`.
Required nested projects need explicit preparation. Source edits require a new copy.
Preparation success is not a test verdict or independent review evidence.
Core-prepared manifests retain host paths; a fixed read-only input maps only the
Candidate and verification mounts into the container namespace before rechecking
original source, prepared bytes and cache identities.

A lost Docker response retains correlated ownership and blocks blind replay.
Cleanup never deletes Hook scratch while its container is unresolved. The Linux
subreaper must prove all owned children reaped before a command can pass; otherwise
the enclosing container must be reconciled. This implementation introduces no
scheduler or additional delivery-state authority. Candidate/Hooks, independent
Accept/final review, exact-head CI and protected merge remain mandatory.

Read-only Node roles attempt guarded preparation before their model invocation,
recording `/verification/node-preparation.log` without changing Candidate access.
The protected role host imports completed CLI receipts/logs into its existing
custody capability before instance cleanup. Missing, modified, credential-bearing
or incompletely retained evidence blocks resource deletion. Direct backend users
must retain `verificationEvidence(execution)` and acknowledge the returned
identities before cleanup; acknowledgement is a trusted Core operation, never an
Agent instruction or test verdict.


Read-only Claude and Gemini utility access
---------------------------------------

Read-only roles use the fixed `nibfin` stdio MCP server in
`src/readonly-tools.mjs`. Claude's strict MCP configuration permits only
`mcp__nibfin__verify` and `mcp__nibfin__github_read`; Gemini's administrator
policy permits the same two operations by server and tool name. Shell and
file-writing tools remain disabled for these roles. Writer invocations retain
their existing tool policy. The server source is mounted read-only independently
of the Candidate; checkout MCP configuration is never loaded.

`verify` accepts an absolute executable, an argument array, a writable scratch or
verification-copy working directory, and an optional shorter timeout. It does
not accept environment overrides or shell command strings. For Node preparation,
call it with `/usr/local/bin/node`, arguments
`["/verification-prepare.mjs", "/work", "/tmp"]` and working directory `/tmp`.
Run tests from the returned prepared directory. The existing verification runner
owns sequential admission, fixed deadline, exact prepared-input checks, process
cleanup and retained receipts/logs. Failed, busy, cancelled and exhausted commands
remain non-passes. MCP cancellation and server EOF abort owned verification work.
Commands receive a fixed environment without provider or GitHub tokens.

`github_read` accepts native `gh` argument arrays, including explicit `--repo`,
and uses only the mounted read broker socket. The host broker revalidates the
repository and operation; the server receives no host authentication. Hooks do
not receive this server or broker. Mounted model login remains readable to code
inside the Agent container, including verification code; filtering does not make
it invisible.

This Nibfin adaptation closes the provider tool-policy integration gap; it adds
no supervisor or delivery authority. `test/readonly-tools.test.mjs` starts each
actual read-only backend builder, checks its generated provider policy and mounts,
and invokes the mounted server through real stdio subprocesses, including broker
reads, real guarded commands, overlap, cancellation and rejected requests. These
are credential-free adapter contracts, not real model or deployed isolation E2E.
Configuration follows the provider-owned MCP contracts:
https://code.claude.com/docs/en/mcp and
https://geminicli.com/docs/reference/policy-engine/.
