# Official source register

All sources below were retrieved and read on **2026-10-24 UTC** from official
Claude Code documentation. They are mutable pages: no immutable documentation
revision or release-bound content identity was exposed by the inspected page
representation. The dated observations below are the retained factual record,
not snapshots of complete pages. Recheck the cited sections when selecting an
implementation version. No installed CLI or SDK version was observed. Unless
explicitly stated, these pages establish no minimum/maximum release bound.
The design targets the CLI; the SDK is not a selected implementation dependency.
Each row is a **Documented capability**, not observed execution.

## S1 — Programmatic execution and structured results

[Run Claude Code programmatically](https://code.claude.com/docs/en/headless),
sections “Run basic commands,” “Start faster with bare mode,” “Get structured
output,” and “Stop a run with SIGTERM”: `-p` is non-interactive; success uses exit
0, failures nonzero. Invalid flags report on stderr; in-run failures can appear
on stdout. JSON includes metadata; schema-constrained content uses
`structured_output`, which may be absent. Schema `format` is not enforced.
Bare mode skips discovery and does not use subscription OAuth/keychain login;
API or cloud credentials are separate prerequisites. Some bare-mode behavior
changed at v2.1.286. SIGTERM can leave an unfinished turn without a result.
These are dated documentation statements, not general descendant-cleanup proof.
No full release bound for this combination is established. Unknown: exact
failure envelopes and cancellation behavior for a future pinned binary.

## S2 — Invocation, sessions, context and tools

[CLI reference](https://code.claude.com/docs/en/cli-reference), “CLI flags” and
“System prompt flags”: `--resume` and `--continue` load prior conversations;
`--fork-session` retains resumed context under a new ID. `--session-id` accepts
a UUID; `--no-session-persistence` is print-only. Prompt-file flags supply
instructions. `--tools` restricts built-ins, not MCP; `--allowedTools` concerns
prompt approval. `--settings` leaves unspecified file settings in effect.
`--setting-sources` selects sources and `--strict-mcp-config` limits MCP loading.
The newer `--restricted` option is documented from v2.1.248; it is not selected
or tested here. Unknown: complete context closure, exact flag interoperability
and minimum version of every baseline flag. A new provider ID is not independence.

## S3 — Authentication choices

[Authentication](https://code.claude.com/docs/en/authentication), “Log in to
Claude Code”: documented choices include Pro/Max, invited Team/Enterprise users,
Console access, and configured Bedrock, Google cloud or Foundry identities.
API-key use is also described. Browser callback behavior can differ in WSL,
SSH and containers. Account entitlement, organization policy and the selected
provider's setup remain prerequisites, not supplied resources. This research
uses none of them and promises no free invocation. No release bound is provided
for the complete authentication/isolation combination. Unknown: secure token
refresh and service-account credential confinement for each future backend.
Bare-mode authentication is qualified by S1; do not assume subscription reuse.

## S4 — Configuration and injection

[Settings files and precedence](https://code.claude.com/docs/en/settings),
“Settings files and who they affect,” “When edits take effect,” and “Settings
precedence”: user, shared project, local and managed configuration can affect a
session. Managed settings outrank ordinary file settings; CLI JSON overrides
specified keys, not all configuration. Some settings reload during execution,
including hooks and credential helpers. Invalid non-interactive settings can be
skipped. No complete release bound is supplied. Unknown: whether an approved
pinned launch can close every configuration/context channel. Proposed enforcement
must inspect effective inputs and freeze or deny mutable sources, not merely
provide one settings file.

## S5 — Sandbox scope

[Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing),
“What the sandbox restricts,” “What runs outside the sandbox,” and “Get started”:
shell commands and their descendants are covered; file/web tools, MCP, hooks,
plugins and helpers can run outside. Shell isolation supports macOS, Linux and
WSL2, not native Windows. Linux/WSL2 require bubblewrap and socat; macOS uses
Seatbelt. Defaults can expose reads and inherited environment; unavailable
sandboxing can fall back unless configured to fail. No exact CLI/backend version
bound for the whole system is established. Unknown: whole-process enforceability,
network closure, mount races and detached cleanup for every proposed backend.
Inference: shell-only reliance cannot satisfy Nibfin isolation requirements.

## Cross-check and unresolved evidence

Material claims were checked against each cited section, rather than inferred
from search snippets. Current documentation contains newer flags and behavior
qualifications absent from older descriptions. Do not backport them to an
illustrative release or treat the Shape's 2026-10-23 source observation as a
release pin. S1/S2 configuration controls reduce discovery but do not prove the
external enforcement required by S5. S3 login never establishes Core permission.
Exact binary, model, SDK (if later chosen), host, guest, backend and authentication
versions must be pinned and retested before a support claim. Missing documentation
bounds and untested combinations are explicit unknowns, not inherent platform
incompatibilities. No essential provider capability is assumed beyond these
bounded observations; the proposed adapter remains contingent on future proof.
