# Linux / Gemini CLI adapter

`createLinuxGeminiBackend` implements readiness, start, collect, stop,
termination and cleanup through `createAgentLifecycle`. Import/construction is
inert. All six Core roles use independent invocations; only Deliver has a
writable workspace. Personal and organization public repositories use the same
contract. Private product targets remain unsupported.

## Selected runtime and authentication

`linuxGeminiProfile` pins Gemini CLI **0.65.0** at `/usr/local/bin/gemini`.
This is an implementation compatibility pin, checked against published package
source, not an installed-CLI or native support certification. No installation,
upgrade or interactive login occurs. The trusted caller supplies an existing
immutable image ID (`sha256:<64 lowercase hex>`) containing the selected binary.
The shared [Linux transport](codex.md) requires rootless Docker CLI/Engine
28.5.1, built-in seccomp, cgroup v2/resource limits, Linux x86-64, Debian 12 amd64
guest and Node v22.23.3. Image volumes and image environment other than PATH are
rejected. No default or released Gemini runtime image is supplied here.

Select an environment with `agent: 'gemini'`. Its private `loginSpace` must
contain a regular, single-link `gemini-api-key.json`:

```json
{"auth_mode":"gemini-api-key","api_key":"MEMBER_SELECTED_KEY"}
```

The value above is a placeholder. A member supplies an existing legitimate
Gemini API key separately; protect the environment root with 0700 and login
file with 0600. Only this selected file enters the container, read-only at
`/login.json`. The CLI receives `GEMINI_API_KEY` in its explicit environment,
never arguments. OAuth/browser login, ADC, Vertex AI, keychains and other
credential routes are unsupported; their selection is rejected without fallback.
Local readiness checks storage, version and features; it does not contact the
provider to prove key validity. A rejected/expired key is diagnosed during
execution. Renewal is the member's responsibility. Cleanup preserves shared
login and sibling instance resources.

```js
import {createLinuxGeminiBackend, createAgentLifecycle} from '@nibfin/core';
const backend = createLinuxGeminiBackend({
  root: '/srv/nibfin/member-environment', image: approvedImageId,
  egress: {image: approvedImageId, node: true},
  socket: '/run/user/1000/docker.sock', environment, instanceId: 'one',
  task: execution => ({prompt: authorizedTask(execution), inputs: stageInputs(execution)})
});
const lifecycle = createAgentLifecycle({environment, instanceId: 'one', backend, current});
```

The variables are trusted Core configuration and current execution expectations,
not checkout/model input. Resource paths, aliases, symlinks, hardlinks, special
files, mount escapes and resource bounds retain the shared transport checks.
No host home, GitHub/controller/signing credential, registration space, Docker
socket or sibling workspace enters the container. Host/image administrators are
trusted; these checks are not a replacement isolation platform.

## Headless execution and permissions

Readiness runs bounded, shell-free `gemini --version` and `gemini --help` inside
the selected image. Exact version and required prompt, JSON output, approval and
admin-policy flags must be present. `/etc/gemini-cli` configuration is rejected.
The image must not embed alternate automatic configuration or executable
customizations. Availability, feature and version mismatches prevent role launch.

Execution uses an argument array:
`--prompt 'Complete the task supplied on stdin.' --output-format json --approval-mode default --admin-policy /input/gemini-policy.toml`.
Task text goes literally through stdin with cwd `/work`. Protected instructions
and the Core schema are supplied by `GEMINI_SYSTEM_MD=/input/gemini-system.md`.
Gemini does not guarantee Core schema output; the schema is instruction input,
and independent validation remains mandatory.

Read-only `/input` also contains system settings (selected through both official
system-settings environment paths) and an admin-tier policy. System settings
disable CLI hooks, MCP, extensions, skills, subagents, auto-update, telemetry,
local .env loading. Before launch, nested `.gemini`,
`GEMINI.md`, `.env` and `.codex` entries are conservatively rejected. This rejects
hostile project settings, environment overrides, policy/session stores, extension,
MCP and hook sources rather than executing them. Settings disable these features
even if a writer later creates project configuration. GEMINI.md discovery cannot
be disabled by an empty context filename list in this pinned version; preflight
rejects existing context files, and the protected system instructions explicitly
treat any subsequently created context as untrusted task data. Such data cannot
change the immutable policy, role mounts or selected authentication. No resume option is used;
each container has a fresh tmpfs home, session storage and independent invocation.

The immutable admin policy denies every tool at priority 900 and permits only
read_file, read_many_files, list_directory, glob and grep_search at priority 999.
Deliver additionally permits write_file, replace and run_shell_command. Unknown,
MCP, delegation and mode-changing tools remain denied. This uses official policy
enforcement, not mutable planning mode. Read-only roles also receive a read-only
workspace bind. The root filesystem is read-only, capabilities are dropped,
no-new-privileges is set and CPU/memory/process/output limits remain enforced.
Provider access uses the enforced isolated internal gateway described in [role host](role-host.md); Core commit hooks are separate
and must run without credentials or network.

## Results, diagnostics and reconciliation

Only a zero exit with a JSON envelope containing a nonempty string `response`
and no `error` field reaches inner JSON parsing. Prose, empty/missing responses,
malformed, truncated or oversized output fail. Only the inner object becomes
StageResult; untrusted session IDs cannot select Core identity. Trusted state
binds execution/request, role/Skill, instructions, stage inputs and evidence.
Core independently validates fields, types, outcomes, freshness and replay.
A valid failure StageResult remains a parsed failure payload; Core's existing
success-evidence gate rejects it as completion evidence. Transport/provider
failure instead yields no StageResult and a fixed diagnostic.

Raw stdout/stderr and provider messages are never retained or forwarded. Both
are bounded to 1 MiB. The whole decoded envelope and inner result, including
keys, nested values and JSON escapes, are scanned for the selected key. The
backend retains the original execution key filter across login rotation and
delayed collection. This filters the known selected secret; it cannot identify
arbitrary private text. Diagnostics are fixed codes:

- `login-absent` / `login-invalid`: supply the supported selected login file.
- `cli-unavailable` / `unsupported-version` / `unsupported-features`: repair the
  selected runtime outside the adapter, without automatic upgrades.
- `unsafe-configuration` / `unsafe-mount`: remove unsupported configuration or
  fix the authorized resource layout.
- `login-rejected`: renew the member's key outside execution.
- `provider-failure`: inspect provider availability/permissions privately; no
  successful role result is claimed.
- `invalid-result`: correct the model/result contract and rerun independently.
- `cleanup-unresolved`: reconcile the original owned containers before reuse.

Timeout/killed attach clients and stop acknowledgments do not prove termination.
The shared backend reconciles the original container name, label, image and
state and reads back removal/absence. Lost create/start/stop responses never
cause duplicate launch. Unknown/running state blocks reuse and cleanup. Only
confirmed removal permits selected-instance resource deletion; sibling resources
and shared login remain. Do not recreate a backend to forget uncertain work.

## Verification and separately authorized native procedure

Use Node 22/npm 10 and `npm ci --ignore-scripts`, then:

```sh
node --test test/gemini.test.mjs test/claude.test.mjs test/codex.test.mjs test/lifecycle.test.mjs test/evidence.test.mjs
npm run check
npm run verify:archive
```

Tests use real credential-free child processes and synthetic Docker/provider
responses. They capture production args/stdin/env/cwd, protected settings/policies
and mounts, and exercise parsing, identity, timeout, cancellation, uncertainty,
secret filtering and cleanup. Archive verification compares exact bytes and runs
the exported adapter in an installed consumer outside the producer tree.
Fixtures establish process contracts, not native filesystem denial or inference.

Installed Gemini checks: unavailable/unrun (`command -v gemini` found no binary).
Native isolation and real model execution: unrun / **Unverified**. No legitimate
selected login/native image was supplied. No support claim follows from fixtures.
Any mandatory native proof still blocks its applicable completion/support gate.
For a separately authorized run:

1. Record Core/package content identity, selected image, CLI/Docker/Node versions,
   Linux host/guest architecture, environment/instance IDs and permitted disposable
   public target. Provision runtime and the member's legitimate login separately.
   Core supplies valid execution/binding, instructions and current stage inputs.
2. Start Deliver with `lifecycle.start(input)`. Task it to write a harmless marker
   in the permitted workspace and return a Core result. Collect by execution ID;
   verify normalized role/result bindings, actual marker and sanitized diagnostics.
3. Use separate fresh executions and independent authorized contexts for all five
   read-only roles. Verify reads and actual attempted workspace write denial with
   a controlled native access probe; record before/after hashes and denial results.
   Inspect policies/mounts and absence of unrelated credential spaces without
   printing secrets. A policy/mount fixture observation is not this native proof.
4. Run a disposable long task, request stop and observe termination of the original
   container. Repeat timeout/cancel and unknown-response reconciliation; an unknown
   state fails the step. Cleanup must confirm owned container absence and selected
   instance deletion while sibling resources/login remain.
5. Record exact commands/profile, run/execution IDs, normalized outcomes, native
   write/denial observations, timeout/cancel/removal evidence and limitations in
   the protected safe evidence channel. Record real model execution separately.
   Core independently supplies hook receipts and later Acceptance/CI gates.

Official references inspected 2026-10-25:
[headless](https://geminicli.com/docs/cli/headless/),
[CLI](https://geminicli.com/docs/cli/cli-reference/),
[authentication](https://geminicli.com/docs/get-started/authentication/),
[system instructions](https://geminicli.com/docs/cli/system-prompt/),
[configuration](https://geminicli.com/docs/reference/configuration/),
[policy](https://geminicli.com/docs/reference/policy-engine/).
The published `@google/gemini-cli@0.65.0` source tarball (npm shasum
`ef9f1d54cf56cbb9dfde7c38a8155fd64d69015c`) was inspected read-only for
settings keys, environment paths, flags, auth type and policy names. It was not
installed or invoked and is not a Candidate artifact. Dependency versions in
this repository were not changed.

The maintained [protected role host](role-host.md) adds explicit absolute deadlines, bounded capacity recovery, the selected enforced gateway and one custody-backed verification lane with fresh Node preparation. Existing deployments must approve the new sources and add the required egress configuration. Native/model support remains Unverified.
