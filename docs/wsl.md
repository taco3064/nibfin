# Windows-hosted WSL adapter

`createWindowsWslBackend` implements the six-method backend consumed by
`createAgentLifecycle`. Construction/import is inert. This is a Codex adapter
using the existing Linux backend inside a selected WSL2 distribution. It does
not execute native Windows Agents, install WSL, configure services, change WSL
defaults, log in, register Runners or establish Issue execution eligibility.
Windows-hosted WSL and native Windows support remain **Unverified**. Local
fixtures establish implementation decisions, not measured OS isolation or model
execution. WSL1, ARM64, root guest users, Windows-mounted resource storage and
unmet Linux isolation prerequisites are **Unsupported** by this profile.

## Trusted configuration

Import from `@nibfin/core`. Supply `{profile, linux, observeHost}`; `process` is an
optional raw child-process seam, defaulting to spawning the actual `wsl.exe`
client with the adapter's fixed arguments. The adapter always owns bounded
framing, correlation and request handling; tests cannot substitute backend methods. Neither observation nor process seam may read repository instructions to select configuration.
The owning Core constructs the lifecycle using the same environment/instance and
its existing `current` evidence provider. Linux guest descriptors use canonical
POSIX paths even when Core runs on Windows; lifecycle structural validation
preserves these paths without translating or performing host filesystem I/O.

`profile` has exactly these fields (no discovery or floating defaults):

| Field | Contract |
| --- | --- |
| `arch` | `x64` Windows host and Linux guest |
| `sid`, `context` | Actual Windows execution SID; `service` or `interactive` |
| `cwd` | Verified local Windows launch directory, e.g. `C:\Nibfin Host` |
| `wsl`, `wslHash` | `C:\Windows\System32\wsl.exe` and approved SHA-256 of its bytes |
| `files` | In order, `{path:cwd,identity}` and `{path:wsl,identity}`; pinned volume/file identities |
| `distribution`, `user`, `uid` | Explicit installed distribution, non-root guest username and positive UID |
| `node`, `nodeHash`, `nodeVersion` | Canonical guest Node executable path, SHA-256 and exact Node 22 version |
| `bridge`, `bridgeHash` | Canonical installed `src/wsl-guest.mjs` path and SHA-256 |

Distribution/user names and opaque file identities are ASCII alphanumeric tokens
with dots, hyphens or underscores, starting with an alphanumeric character.
SID must be an `S-1-5-...` SID. Supply verified identities from the trusted install,
not freshly trusted hashes of arbitrary repository files. Deploy the complete
exact-byte package into a trusted guest directory; preserve its module contents
and ancestor permissions. Node/bridge paths must have no symlink ancestors.
Profile checks are configuration checks, not a claim that these versions were
executed on Windows.

`linux` is the existing [Linux/Codex configuration](codex.md): `root`, immutable
`image`, rootless `socket`, `environment`, `instanceId`, optional `timeout`, and
trusted `task(execution)` returning `{prompt,inputs}`. Do not supply its `process`
callback here. All login/workspace/registration/service paths are disjoint,
canonical Linux paths beneath `root`. The rootless socket must match the configured guest UID;
Node and bridge assets must be outside the mutable resource root. The root must be on guest ext4, outside
`/mnt` and `/media`. The Linux backend additionally checks physical directories,
owner/mode, aliases, mounts, resource replacement, rootless Docker, seccomp,
cgroups, resource limits, exact image, runtime/tool versions and login. It still
performs the actual container probe; host observations cannot assert readiness.

A configuration can be assembled without side effects:

```js
import {createWindowsWslBackend, createAgentLifecycle} from '@nibfin/core';
// approvedProfile, linuxConfig, observeActualHost and currentEvidence are
// supplied by trusted Core installation/runtime code, never Issue/model text.
const backend = createWindowsWslBackend({
  profile: approvedProfile, linux: linuxConfig, observeHost: observeActualHost
});
const lifecycle = createAgentLifecycle({environment: linuxConfig.environment,
  instanceId: linuxConfig.instanceId, backend, current: currentEvidence});
```

## Observation boundary

`observeHost()` is required. It must inspect the **calling process/service**,
not an interactive user's cached installation. Return fresh raw OS observations:

```js
{
  platform: 'win32', arch: 'x64', sid: 'S-1-5-21-1000', context: 'service',
  distribution: 'Debian-Nibfin', wslVersion: 2, available: true,
  files: [
    {path: 'C:\\Nibfin Host', canonical: 'C:\\Nibfin Host',
      identity: 'volume-file-id', reparse: false, storage: 'local', kind: 'directory'},
    {path: 'C:\\Windows\\System32\\wsl.exe', canonical: 'C:\\Windows\\System32\\wsl.exe',
      identity: 'wsl-volume-file-id', reparse: false, storage: 'local', kind: 'file',
      hash: approvedWslSha256}
  ]
}
```

The trusted Windows caller owns obtaining these observations from Windows
process/token, service/session and filesystem APIs and official
`wsl --list --verbose` under that account. `reparse:false` means **all ancestors**
were checked, not just the final entry. Resolve file handles to canonical local
paths and stable volume/file IDs; hash the executable. Absence, access denial,
malformed output, aliases or unknown provenance must reject, never synthesize a
matching observation. The adapter checks every field, pins the entire observation
and rechecks before readiness, role start and cleanup. Inspection is bounded to
15 seconds. Observation callbacks have no permission/readiness return field.

`createWslGuest` and `observeWslGuest` in the fixed packaged guest asset expose the
lower OS/process seams for tests. Production uses actual Linux observations:
UID/username, platform/architecture, WSL2 kernel, canonical Node/bridge paths,
byte hashes and guest root filesystem. They are pinned and rechecked on every
operation. Tests inject these external facts and Docker process responses; they
cannot replace lifecycle evidence, protected role selection, Linux physical
resource checks or readiness decisions.

Windows, service, WSL guest and container logins are distinct. Service readiness
requires no Issue/Grant. Starting a role still uses Core/lifecycle evidence gates.
This module never calls `gh`, copies credentials or substitutes `GH_TOKEN` for a
local login. Service installation and Windows observation collection belong to
the trusted consuming host, not to Agent task content.

## Paths, arguments and credentials

The exported lexical helpers `windowsLocalPath`, `windowsToWslPath` and
`wslToWindowsPath` support absolute local drive paths (default approved drive C),
spaces and Unicode. An explicitly supplied single drive selects a different
lexical mapping only; it does not enable that drive for launch/resources. They
preserve component case; drive letters normalize to uppercase on Windows and
lowercase under `/mnt`. The reverse mapping requires the exact lowercase mount
prefix. Host observations must use the configured canonical component spelling;
this intentionally rejects alternate Windows case aliases rather than treating
Linux filenames as case-insensitive. Only the fixed C-drive launch paths are
accepted by this adapter. A helper conversion establishes no physical identity,
mount safety or authorization and is never used to place resources on DrvFs.

Reject relative/drive-relative paths, traversal, empty components, UNC (including
WSL aliases), extended/device namespaces, streams, control characters, reserved
Windows names, trailing dot/space/separator and shell metacharacters. Guest
resource/executable paths reject spaces and shell metacharacters; Linux backend
restrictions also apply. Option-like distribution/user values reject. Task text
including shell syntax remains JSON data, never a launch argument.

The launch vector is fixed: `wsl.exe --distribution DIST --user USER --exec
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C NODE BRIDGE`. No shell is invoked. The
Windows client gets only `SystemRoot=C:\Windows` and `WINDIR=C:\Windows`;
`WSLENV`, host HOME/login paths, tokens, signing data and provider configuration
are not inherited. Guest Node gets only the stated PATH/LANG. Linux Docker calls
use their existing clean environment. Only selected Agent auth is mounted
read-only, never the login directory, sibling registration or host credentials.
Only Deliver gets a writable workspace; all other protected roles are read-only.

## Failure and recovery

The single persistent guest process keeps the Linux backend's owned container
and execution state across calls. JSON-line requests/replies are correlated,
sequential and bounded to 2 MiB; Docker results retain their tighter bounds.
Initialization/readiness have 30/60-second transport bounds; other calls have
30 seconds. Linux role execution remains asynchronously tracked under its
configured timeout. Client stderr is discarded. Public diagnostics are fixed
categories: `not-checked`, `host-context`, `launch-unresolved`, `guest-context`,
`guest-backend`, `ready`, `transport-unresolved`. Linux unavailable capability
classifications remain failures. Arbitrary OS errors, raw stdout/stderr, provider
responses and credential-bearing paths do not become diagnostic strings.

A lost Docker create/start response retains ownership **in the live guest
session**; collect/stop/termination/cleanup can reconcile that same container.
Stop acknowledgment alone is insufficient. Missing/failed inspection or removal
keeps residual resources unresolved. Repeated backend stop/cleanup is safe;
the lifecycle separately rejects invalid repeated transitions.

Losing the bridge/client, timing out its protocol, receiving malformed/oversized
output or failing guest context makes the session unresolved. Never reconnect,
reinitialize or blindly repeat start. Windows client exit/kill does not prove
container termination. Selected resource paths and execution correlations remain
available to Core; preserve them and the guest resources for trusted manual
reconciliation through the existing Docker ownership labels/guest observations.
The adapter deliberately does not recover an in-memory backend after process
loss or certify clean resources from a replacement session. It blocks reuse and
successful cleanup until that external reconciliation, rather than deleting
unknown work. Ordinary cleanup never shuts down, terminates or unregisters a
WSL distribution. Shared login, sibling instances and unrelated distributions
survive; selected resources are removed only by the existing Linux backend after
owned workloads terminate and removal is confirmed.

## Verification and read-only integration handoff

On Node 22/npm 10, use `npm ci --ignore-scripts`,
`node --test test/wsl.test.mjs`, `npm run check`, and `npm run verify:archive`.
The latter retains `out/nibfin-core.tgz`, checks exact packaged bytes including
both WSL modules and this document, installs outside the source tree and runs
the same local WSL contracts using the public package and installed guest asset.
Fixtures are in `tooling/wsl-fixture.mjs`, reusing `tooling/codex-fixture.mjs`.
No native host transcript or login/isolation proof file is produced or required.

For taco3064/gh-nibfin#28, consume the Core-published repository revision and
immutable package/archive identity for this candidate; do not use the old Shape
baseline as the delivered revision. Its existing platform harness owns actual
Windows/guest/account measurements, writable/read-only access, credential/path
denials, timeout/termination and cleanup. Reproduce the profile/observation
contract above under each intended service account and preserve truthful version
and evidence identities. This is a read-only handoff, with no modification of
that repository or duplicate platform harness here. Personal/organization public
repository ownership, Runner registration level and optional automatic
registration remain separate; this adapter grants none of them. Unrun platform,
model and host combinations remain Unverified.

Official interfaces: [WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands),
[WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config), and
[Windows/Linux filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems).

The maintained guest selects Codex, Claude or Gemini from its protected environment
profile and shares the Linux transport's internal-network gateway. See
[protected role host](role-host.md) for migration and verification ownership.
Native Windows/WSL and real-model execution remain Unverified.
