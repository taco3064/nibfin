# Linux/Codex execution adapter

`createLinuxCodexBackend` implements the six Agent lifecycle methods. Import and
construction are inert. Use `createAgentLifecycle` for authorized execution,
N07 `selectInstructions` for protected instruction snapshots, and Core's current
N08 evidence expectations. Only Deliver has a writable workspace. Every other
role (including Shape Validator, Diagnosis, Final Shaper Review and Accept) gets
a read-only bind. Repository ownership has no effect on this boundary.

## Explicit profile: linux-amd64-codex-v1

This is an implemented profile, **Unverified for native/model support** until
#121 measures its exact configuration. No Linux/container/model test was run as
part of the retained credential-free fixture. The profile requires:

- Linux x86-64 host and local rootless Docker CLI/Engine **28.5.1**, seccomp enabled, cgroup v2 with
  memory, PID and CPU CFS limits available.
- Debian **12** amd64 guest, Node **22.23.3**, Codex CLI **0.163.0** at
  `/usr/local/bin/node` and `/usr/local/bin/codex`.
- An already present, explicitly supplied **`sha256:<64 lowercase hex>` image ID**.
  This required immutable configuration value is the exact execution pin, not a
  tag or a default image. Readiness inspects actual image identity/architecture;
  execution uses `--pull never`. No released image is claimed to exist here.
- A dedicated canonical resource root containing N08 environment login and all
  instance directories, owned by the execution user with private root permissions (normally 0700),
  with Core-exclusive host management while executing. The root and its
  descendants cannot be mountpoints; use a subdirectory of the host filesystem.
  Workspaces must be disposable copies, never Core home or signing/provider data.
- The selected member's existing file-based ChatGPT `auth.json` login. Core never
  logs in, refreshes on the member's behalf, copies login into the workspace, or
  substitutes GitHub/API credentials. A read-only auth file supports existing
  sessions; expired sessions requiring persistence must be renewed by the member
  outside execution. Agent login grants no GitHub or delivery authority.

Example trusted construction (image and task are supplied by Core):

```js
const backend = createLinuxCodexBackend({
  root: '/srv/nibfin/member-environment', image: approvedImageId,
  egress: {image: approvedImageId, node: true},
  socket: '/run/user/1000/docker.sock', environment, instanceId: 'one',
  task: execution => ({prompt: authorizedTaskText(execution), inputs: stageInputs(execution)})
});
const lifecycle = createAgentLifecycle({environment, instanceId:'one', backend, current});
```

`task` is a trusted closure returning the actual Scope/Shape/task context and N08
stage inputs. Neither repository text nor model output supplies this closure,
resource configuration, execution identity, role or mount access. The protected
instructions are stored byte-for-byte in a read-only execution input directory.
The fixed entrypoint supplies them with `model_instructions_file` and sends the
task over stdin. The model produces a StageResult; the entrypoint binds it to the
protected execution/binding/inputs. Existing lifecycle evidence validation still
checks exact expectations, freshness, independence and replay.

## Process and filesystem boundaries

The sole host executable is `/usr/bin/docker`, with a fixed argument array,
explicit local Unix socket, empty inherited environment and no host shell. Its
only environment is `PATH=/usr/bin:/bin`, `LANG=C`. No Docker user config, host
home, GitHub credentials, signing keys, registration directories or socket is
mounted inside Agent containers. Image environment must contain only PATH and
must declare no volumes. The image itself and host administrator are trusted
prerequisites; this adapter does not defend against a compromised administrator.

Containers drop all capabilities, enable no-new-privileges, retain Docker's
seccomp profile, use a read-only image filesystem, an isolated internal network with an enforced gateway, 1 GiB memory,
2 CPUs, 128 PIDs and a 64 MiB tmpfs. Native sandbox availability remains required;
Codex runs with `read-only` or `workspace-write`, never bypass mode. No privileged
mode, host network, arbitrary executable, arbitrary environment or mount passthrough
exists. Credential-free/no-network commit hooks belong to Core's separate path;
this backend executes no commit hooks and produces no hook receipts.

Mounts use private propagation and disable recursive submount exposure. Before
launch the adapter checks canonical ancestors, symlinks, inode aliases, hardlinks,
special files (including sockets), resource overlap, changed directory identities,
and cross-device entries. Linux mountinfo also rejects existing bind/mount
aliases within the root, including aliases that realpath cannot detect. The scan is bounded to 50,000 entries. All resources
must be dedicated, non-overlapping directories below the configured root. The
trusted host must prevent concurrent remount/replacement; filesystem observations
are not an atomic defense against host administrators. Symlink-heavy or mounted
working trees, project `.codex` configuration directories and unsupported
platforms/runtimes are rejected, without fallback.

Only the selected auth file is mounted read-only; the workspace has role-specific
access; execution input and the package's fixed entrypoint are read-only. Temporary
session files stay inside bounded container tmpfs. Verification copies use dedicated writable instance scratch. Input files are opened without following symlinks and are capped at 1 MiB. Codex JSONL must contain the current thread, a successful terminal turn and exactly one structured result. No last-message file establishes success. Only validated final JSON is emitted; raw model/CLI logs are discarded.
Missing, malformed, truncated, oversized, foreign or unsuccessful output fails
validation. Results containing known selected-login values are also rejected;
each execution retains its own login-value filter through delayed collection and
later login rotation. Decoded JSON strings and property names are checked, so JSON
escaping cannot conceal those values from the filter.
CLI errors never become diagnostics. No previous execution result file is reused. Instruction files are
bounded to 1 MiB, task text to 512 KiB and stage inputs to 256 KiB.

Each probe and role container has an internally generated UUID name and matching
label, reserved before the create operation. Inspection binds name, label and
immutable image. Lost create/start responses cannot cause duplicate launches.
Readiness removes completed probes but retains role containers until instance
cleanup so results remain collectable after termination and subsequent starts.
Running or uncertain prior work still blocks readiness. CLI timeout is not container termination: explicit inspect/stop/reconciliation is
required. Stop acknowledgment alone does not establish termination. Cleanup
requires ended processes, matching owned containers removed and absence read back
from Docker's full container list. Failure or uncertainty remains unresolved;
retry retains the original identities. Only then are the selected instance's
workspace, registration and service directories removed and absence verified.
Shared login and sibling resources survive. Keep the backend object while
reconciling an attempt; external durable recovery belongs to Core, not a new local
scheduler. Do not recreate a backend to forget unknown operations.

## Retained fixture and #121 handoff

Run `node --test test/codex.test.mjs`, `npm run check`, and
`npm run verify:archive` with Node 22/npm 10. `tooling/codex-fixture.mjs` invokes
the exported backend and lifecycle with selected instructions, real temporary
files and real credential-free child processes. It substitutes only Docker's
external command responses/containers/login observation. Its credentials and
results are explicit synthetic sentinels. It does not run Docker, authenticate
Codex, measure sandbox denial or prove model availability. Archive verification
checks exact packaged bytes and repeats the controlled tests in an installed
consumer outside the producer directory.

#121 should consume the released backend/package and this retained fixture through
a read-only, version/digest-bound handoff. It supplies a legitimate member login,
the exact ready native profile/image and authorized public target, then exercises
the same backend through the existing released single-Issue lifecycle. It records
real write/read-only access and denial probes, exact execution/result binding,
termination/cleanup, host/guest architecture, tool and immutable image identities.
It also verifies actual credential-free/no-network Core hooks independently.
#121 retains native observations and failures for the downstream support matrix.
Unrun native cases remain Unverified; #92 requires no native transcript or login
proof file. No provisioning, separate research Issue or new lifecycle is added.

Interface references checked for this implementation:
[Codex CLI options](https://learn.chatgpt.com/docs/cli/reference),
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/),
[rootless Docker](https://docs.docker.com/engine/security/rootless/).
The local installed `codex-cli 0.163.0 --help`/`exec --help` were inspected without
login or model invocation. Documentation and help are interface evidence only.

The maintained [protected role host](role-host.md) adds explicit absolute deadlines, bounded capacity recovery, the selected enforced gateway and one custody-backed verification lane with fresh Node preparation. Existing deployments must approve the new sources and add the required egress configuration. Native/model support remains Unverified.
