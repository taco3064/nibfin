# Linux / Claude Code adapter

`createLinuxClaudeBackend` is a callable implementation of readiness, start,
collect, stop, termination and cleanup. Use it with `createAgentLifecycle`, the
selected protected instruction snapshot and Core's current evidence expectations.
Construction and import execute nothing. Only Deliver gets a writable workspace;
all other roles use read-only binds and a separate fresh CLI invocation. Personal
and organization public ownership use the same boundary. This does not support
private product targets or certify a complete product delivery configuration.

## Explicit profile and authentication

`linuxClaudeProfile` identifies `linux-amd64-claude-v1`. It reuses the existing
Linux/Codex Docker transport and resource reconciliation code, with Claude-specific
entrypoint, authentication, tools and parsing. Requirements are Linux x86-64,
rootless Docker CLI/Engine 28.5.1 with built-in seccomp, cgroup v2 and resource
limits, Debian 12 amd64 guest, Node v22.23.3 and Claude Code
**2.1.285 (Claude Code)** at `/usr/local/bin/claude`. The version is an explicit
implementation pin, not a claim that this version/image was executed here.
A caller supplies an already available immutable `sha256:<64 lowercase hex>`
image ID. No default, released image or provisioning operation is provided.
Image environment may contain only PATH, and image volumes are rejected.

The member explicitly selects an environment with `agent: 'claude'` and
`loginSpace` containing `anthropic-api-key.json`, a regular single-link JSON file:

```json
{"auth_mode":"anthropic-api-key","api_key":"MEMBER_SELECTED_KEY"}
```

The example value is a placeholder, never a supplied credential. The member
provides their own legitimate Anthropic Console API key outside this adapter.
Use a private environment root (0700) and protect the credential file (0600).
Only that selected file is mounted read-only, at `/login.json`; the entrypoint
sets `ANTHROPIC_API_KEY` for the CLI without passing it in arguments. Core never
initiates login or asks an Owner to provision credentials. Browser/subscription
credential stores, keychains, OAuth tokens, API key helpers and third-party
providers are unsupported in this profile and rejected; no host-home mount,
ambient provider fallback or account substitution is performed. An absent file
reports `login-absent`, invalid/unsupported storage reports `login-invalid`, and
CLI authentication rejection reports `login-rejected`. Renew a revoked key
outside execution; cleanup preserves shared login and sibling instances.

```js
const backend = createLinuxClaudeBackend({
  root: '/srv/nibfin/member-environment', image: approvedImageId,
  egress: {image: approvedImageId, node: true},
  socket: '/run/user/1000/docker.sock', environment, instanceId: 'one',
  task: execution => ({prompt: authorizedTask(execution), inputs: stageInputs(execution)})
});
const lifecycle = createAgentLifecycle({environment, instanceId:'one', backend, current});
```

These variables come from trusted Core, including the fixed execution/binding,
role and task inputs. Checkout text cannot configure the adapter. The same
resource ownership, canonical-path, symlink/hardlink/special-file/mount rejection,
resource bounds, private mounts and cleanup prerequisites described in
[codex.md](codex.md) apply. No GitHub/controller/signing credentials, registration
space, host socket, host environment or sibling workspace enter the container.
The image/host administrator is trusted; this is not a new isolation platform.

## CLI contract

Readiness probes the exact version, bounded `--help` feature observations and
`auth status` JSON (`loggedIn: true`, `authMethod: api_key`). Missing executable,
unsupported version/features and unusable authentication fail before role launch
with fixed diagnostics. No inference is requested by these probes. Managed
configuration directories `/etc/claude-code` and `/usr/local/etc/claude-code` are
unsupported and cause `unsafe-configuration`. The trusted image must not embed
other automatic configuration or executable customizations.

Each role uses `--print --bare`, JSON output and a schema read from protected
input. Trusted instructions use `--system-prompt-file`; task text uses stdin,
not shell interpolation. `--tools` selects available tools; `--allowedTools`
separately supplies non-interactive approvals. Deliver has Read, Glob, Grep,
Edit, Write and Bash. Read-only roles have Read, Glob and Grep. `dontAsk` denies
unapproved operations. Empty setting sources, disabled hooks, strict empty MCP
configuration and denied `mcp__*` prevent extra MCP tools and automatic permission
extensions. Every call has a new UUID session and disables session persistence;
no resume/continue is used. Bare mode is context control, not a sandbox.

Checkout `.claude`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` and `.codex`
configuration are conservatively rejected before execution, including nested
copies. This profile does not silently execute their hooks/plugins or rely on
prompt instructions to suppress them. Containers retain the existing read-only
root, dropped capabilities, no-new-privileges, resource limits and role bind
access. Agent networking uses the enforced isolated internal gateway described in [role host](role-host.md). Core's
commit hooks remain separate, credential-free and network-disabled.

The entrypoint requires a zero CLI exit and a JSON result envelope with
`type: result`, `subtype: success`, `is_error: false` and object
`structured_output`. Text results and CLI session metadata cannot substitute for
role evidence. The trusted entrypoint binds only the payload to protected
execution/binding/inputs; existing Core validators enforce role/schema/outcome,
freshness and replay checks. Missing, malformed, truncated, oversized and error
output fails. stdout/stderr are bounded to 1 MiB and raw provider errors are
never forwarded. The decoded whole envelope, including nested values and property
names, is checked for selected-key disclosure before discarding metadata. The
backend retains its execution-specific key filter across delayed collection and
login rotation. This is filtering of known selected secrets, not a general
proof that arbitrary generated prose contains no confidential information.

Timeout or killing the attach process does not prove container termination.
Stop acknowledgment does not either. Original names, labels and image identities
are reconciled with inspect and removal/absence observations. Running/unknown
work blocks reuse and completed cleanup. Failed/lost create/start/stop/removal
responses retain original identities; do not recreate the backend to forget
uncertain work. Only verified removal permits deleting the selected instance's
workspace, registration and service directories. Shared login survives.

## Verification and native procedure

Run `node --test test/claude.test.mjs test/codex.test.mjs`, `npm run check` and
`npm run verify:archive` with Node 22/npm 10 after `npm ci --ignore-scripts`.
The maintained fixture uses synthetic Docker/provider/login observations and
real credential-free local child processes. CLI construction is captured through
a local substitute process; the production parser consumes synthetic envelopes.
These checks establish process/configuration contracts, not measured OS denial
or inference. Archive verification compares exact runtime bytes and repeats the
exported adapter tests in an installed consumer outside the producer directory.

Installed selected-CLI version/help checks: **unrun** (no `claude` executable
available in this execution). Native Docker/Claude and real model execution:
**unrun / Unverified**. No selected legitimate login, approved native image,
Docker execution capability or disposable target authorization was supplied for
native execution. No live-provider success or platform support is claimed.
Missing mandatory native/provider evidence blocks a later support/completion
claim at the stage where that evidence is required.

For a separately authorized native run:

1. Record the installed package content digest, immutable image ID, fixed CLI,
   Docker/Node versions, host/guest architecture and selected environment/instance
   IDs. Use the profile above and a dedicated disposable **public** repository
   target with explicit permitted actions; do not use a production checkout.
   Core supplies valid role execution/binding, instruction snapshots and current
   expected stage inputs. Provision prerequisites outside this adapter.
2. With the member's legitimate selected key, start a Deliver invocation through
   `lifecycle.start(input)`. Record readiness diagnostics. The task writes a
   harmless marker in its authorized workspace and returns the schema payload.
   Collect with its execution ID; verify valid Core evidence and the marker.
3. In separate invocations, use fresh executions/results and the independent
   role's own authorized instance/context. For each read-only role, verify reads
   succeed and actual attempted workspace writes fail (using a controlled native
   access probe as well as tool availability observations). Record host file
   hashes before/after and actual denial results. Never reuse writer sessions as
   independent evidence. Check absent controller/GitHub/signing credentials and
   sibling mounts without printing secrets.
4. Exercise a long-running disposable invocation: request stop, poll termination
   until the original container is confirmed stopped, then cleanup. Also cancel
   after attach timeout and reconcile unknown responses. Verify owned containers
   and selected instance directories are gone while shared login and sibling
   resources remain. An unknown observation fails this step.
5. Record each actual run's configuration, role, execution/result binding,
   observations, failures and limitations separately in protected stage evidence.
   Core independently executes its isolated hook gates; adapter fixtures provide
   no hook receipt. Missing authorization/login/runtime leaves this procedure
   unrun; never replace native results with fixture outputs.

Official interface references inspected 2026-10-25:
[CLI](https://code.claude.com/docs/en/cli-reference),
[programmatic execution](https://code.claude.com/docs/en/headless),
[authentication](https://code.claude.com/docs/en/authentication),
[permissions](https://code.claude.com/docs/en/permissions).
These references establish interface expectations, not executed compatibility.

The maintained [protected role host](role-host.md) adds explicit absolute deadlines, bounded capacity recovery, the selected enforced gateway and one custody-backed verification lane with fresh Node preparation. Existing deployments must approve the new sources and add the required egress configuration. Native/model support remains Unverified.
