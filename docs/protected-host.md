# Protected host v1

The maintained entry is `host/entry.mjs` in `taco3064/nibfin`. It has a separate,
dependency-free package and lock. Install that directory with `npm ci
--ignore-scripts --no-audit --no-fund`. It is also shipped in the Core package;
no private Kairo runtime or fourth official repository is involved. Installed
consumers import `configure`, `validateHostOptions` and `hostModes` from
`@nibfin/core/protected-host`.

This is a source composition contract. Local injected-capability verification
is distinct from a running Actions installation, provider authentication, Runner,
platform, registration or release certification. E01 (#205) and E08 (#209) own
later live verification. An unconfigured checkout safely blocks. Source delivery
does not install deployment-specific authenticated capabilities or credentials.

## Inert public entry

```js
import * as core from '@nibfin/core';
import {configure} from './host/entry.mjs';
// deployment is a trusted host object, NOT an event/Issue/Dispatch field.
const host = configure({core, mode, context, deployment});
const entry = core.createWorkflowEntry(host);
const result = await entry.invoke(mode, input, context);
```

`deployment` has exactly `options` and `capabilities`. Options are serializable;
validate against `configuration.schema.json` (use `$defs[mode]` for mode-specific
validation) and `validateHostOptions(options, mode)`. The example has synthetic
identities. Set the real repository/ID/environment only in protected GitHub
Environment configuration. There are no module, shell, ref, credential or arbitrary
path options. Options require version 1, canonical lowercase public repository,
positive decimal repository ID and the exact environment below. `groupId` is
optional only for delivery modes; when set it requires the group capability and
must equal the current selector's group requirement. A discovered group cannot
silently bypass this check.

`context` contains repository, repositoryId and run {id,attempt}, with optional
eventName/event. Context is an observation, never authentication. The maintained
host forwards only these fields to capabilities, excluding extra environment,
management credentials or embedding fields. Keep credentials in capability
closures at their authorized boundary, never in context/input or result data.
Construction validates without calling a capability, reading process environment,
discovering credentials, writing, spawning, registering or contacting a provider.
A configured host is bound to one mode and one repository/Run/Attempt.

| Mode | Exact required capabilities | Environment / owner |
| --- | --- | --- |
| lookup | authenticate, lookup | nibfin-hosted; retained request correlation |
| resolve | authenticate, delivery, retain | nibfin-hosted; existing Core inspect and retained AND route |
| execute | authenticate, delivery, retain, retrieve, verifyRunner | nibfin-member; existing Core run, writer decision |
| compute | authenticate, delivery, retain, retrieve, verifyRunner | nibfin-member; existing Core run, compute decision |
| wake | authenticate, relay | nibfin-hosted; createEventRelay |
| registration | authenticate, registration, retain | nibfin-hosted; createRegistrationHost with retained intent/result |

Delivery modes additionally require `group` exactly when `groupId` is set. All
capabilities are functions. Extra, missing, accessor-valued and incorrectly typed
capabilities fail construction with the same fixed diagnostic. There is no
optional catch-all capability bag and no permissive default implementation.

Capability argument/result contracts are the “Required protected host interface”
in [workflows.md](workflows.md). These implementations are trusted executable
configuration supplied by the deployment owner, distinct from JSON options. Use
actual Core provider, authorization, dependency, selector, custody and lifecycle
owners; do not implement a second state machine. `delivery` returns the actual
`createCore` config and retained queued request. `relay` and `registration` return
the existing public constructors' configs. The maintained workflow entry invokes
these owners, checks source/identity/queued decision/route/Runner, and retains
results. Unknown registration prior values reject; unresolved and resolved prior
issuance never automatically issue again. Missing custody or denied authentication
blocks, and failed result retention after execution preserves the original request
as unresolved. Deployment owners must retain and reconcile original attempts.

The `workflowMain(env, {deployment})` embedding interface supplies the same trusted
object. For the standalone CLI, protected Environment variables supply
`NIBFIN_HOST_OPTIONS` (exact JSON bytes mapping mode names to their options) and
`NIBFIN_HOST_CAPABILITY_SOURCE` (reviewed executable ES module bytes exporting
exactly `capabilities`, a map of the same mode names to function bags). This allows
one hosted Environment to configure lookup, resolve, wake and registration, and
one member Environment to configure execute and compute. Validate this variable against `configuration.schema.json#/$defs/environment`.
Cross-environment mode entries reject; each selected bag must still contain exactly its permitted functions. `NIBFIN_SOURCE_APPROVALS.deployment` independently pins both
with `optionsSha256` and `sourceSha256`. These are executable deployment
configuration, with the same trust as a reviewed host implementation; never copy
values from events, Issues, a checkout manifest or Dispatch into these variables.
Both hashes and every configured mode's option validity are checked before binding evaluation. The binding
must be inert at module evaluation and export functions directly, without a
construction factory. Each invoked function also receives non-enumerable public `core`
namespace and validated `options` properties (excluded from retained record bytes); functions obtain their own authorized credentials
only when invoked. No credential value is passed by this module. Protect changes
to the source, approvals and options under Environment administration/review.
Member and hosted Environments have separate sources and approvals: the member
source must contain only member interfaces and no management credential access.
The module uses no untrusted import path and needs no handwritten replacement
entry. A checkout without approved bindings/options safely blocks.

## Source approval and installation

`loadProtectedHost({bundle,host})` verifies both approvals before evaluating the
maintained entry. Each argument has `root`, independently fixed `allowedRoot`,
`repository`, immutable `commit`, and a protected approval:

```json
{"repository":"taco3064/nibfin","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":[{"path":"host/entry.mjs","sha256":"<approved SHA-256 of exact bytes>"}]}
```

This is illustrative, incomplete and intentionally invalid. Host inventory must
include every `protectedHostFiles` entry. Bundle inventory must include package.json,
package-lock.json, README.md and every packaged file. Obtain expected hashes and
commits from independently approved source, not from an untrusted checkout's own
claim. A matching 40-hex string is not approval. Bundle and host approvals remain
distinct even at the same repository/commit. Wrong repository/ref, mutable pin,
missing/duplicate inventory, altered source, traversal, absolute paths and symlinks
(including checkout ancestors) reject before entry evaluation. The maintained
entry is evaluated from verified bytes and has no import/dependency graph. The
host package rejects dependencies and lifecycle scripts. The caller and protected
checkout must remain trusted; this does not authenticate the loader's own bootstrap
or claim to defend against a malicious host administrator.

For the workflow CLI use protected `NIBFIN_SOURCE_APPROVALS` JSON with `bundle` and
`host` approval objects, plus separate protected bundle/host repository and commit
variables. Roots are fixed to `$GITHUB_WORKSPACE/nibfin-bundle` and
`$GITHUB_WORKSPACE/nibfin-host`; the host entry is always `host/entry.mjs`. The
composite installs the host's own locked subdirectory, not the repository root.
The maintained loader currently accepts only the first-party nibfin host layout.
The generic workflow installation planner still renders other explicitly chosen
host repositories for older consumers; that is syntax/rendering, not source
approval or compatibility with this maintained loader.

`workflowInstallation` is a deterministic read-only plan. Inventory includes the
host, lock, schema and example. Compare existing files and identities before any
authorized write. No planner response grants installation authority or validates
a GitHub checkout merely because its supplied pin is well formed. Changing source
or pins needs new approvals and the usual compatibility/Grant checks. No future
release asset of this Issue is needed for local packaging.

## Credential and recovery prerequisites

Configure required protection on `nibfin-hosted` and `nibfin-member` Environments.
Hosted read/management/artifact capabilities must never be installed in the member
capability set or forwarded to an agent, hook or subprocess. This module does not
spawn any of those processes or pass them an environment. The composite installs
with scripts disabled before exposing hosted credentials; member jobs have neither
host_token nor read_token. Supplying management fields in serializable options
fails, as does adding a management capability to a member host. Authentication
must independently check public visibility, current personal/organization ownership,
source identity, Runner/service account, permissions and Owner Grant. Private
repositories remain outside support. Online Runner status and OIDC do not grant
execution or prove predecessor success.

Use the existing source/custody contracts for unknown outcomes; never fabricate a
new queued request, missing predecessor evidence or new registration intent to
hide uncertainty. Public outputs are fixed categories and opaque references;
provider errors and raw configuration must never be logged.

## Reproducible local checks

Run focused tests while implementing:

```
node --test test/protected-host.test.mjs
```

Dependency preparation and final regression/installed consumer verification run
sequentially through the supplied guard (when executing under Core):

```
node /verification-runner.mjs -- npm ci --ignore-scripts --no-bin-links --no-audit --no-fund
node /verification-runner.mjs -- npm ci --prefix host --ignore-scripts --no-bin-links --no-audit --no-fund
node /verification-runner.mjs -- npm run check
node /verification-runner.mjs -- npm run verify:archive
```

Use `--no-bin-links` for dependency preparation in the candidate workspace: npm's
optional executable links (including `node_modules/.bin/yaml`) are symlinks, which
the isolated candidate handoff does not support even in ignored directories.
This does not change the locked dependency contents or skip source path rejection
checks. Before handoff, inspect the whole workspace for remaining symlinks.

The archive verifier installs outside the producer source tree with lifecycle
scripts disabled and invokes the maintained packaged host. Archives and temporary
consumers are verification intermediates, not Candidate obligations. Tests and
author observations do not substitute for fresh independent Acceptance, isolated
Core hooks or required exact-head CI.
