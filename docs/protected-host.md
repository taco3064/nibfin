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

`deployment` has `options` and `capabilities`, plus protected executable `identity`
when options select `authentication: "actions-oidc"`. This maintained route supplies
`authenticate`; omit that function from the capabilities bag. Older callback
deployments omit both `authentication` and `identity`. Options are serializable;
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
`capabilities`, a map of the same mode names to function bags, and optionally
`identity`, a map of precisely the modes selecting maintained authentication). This allows
one hosted Environment to configure lookup, resolve, wake and registration, and
one member Environment to configure execute and compute. Validate this variable against `configuration.schema.json#/$defs/environment`.
Cross-environment mode entries reject; each selected bag must still contain exactly its permitted functions. `NIBFIN_SOURCE_APPROVALS.deployment` independently pins both
with `optionsSha256` and `sourceSha256`. These are executable deployment
configuration, with the same trust as a reviewed host implementation; never copy
values from events, Issues, a checkout manifest or Dispatch into these variables.
Both hashes and every configured mode's option validity are checked before binding evaluation. The binding
must be inert at module evaluation and export capabilities and protected identity
configuration directly, without invoking a construction factory. Each invoked function also receives non-enumerable public `core`
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
node /verification-runner.mjs -- node /verification-prepare.mjs /work /tmp
# Run the following from the returned exact-byte writable test directory:
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

For maintained Actions, local-gh and hosted identity composition, use the protected
`authentication: "actions-oidc"` option and [authentication configuration](authentication.md).
The maintained factory replaces the deployment authenticate callback while preserving
mode-specific capabilities and the dependency-free entry approval boundary.

## Durable custody capabilities

A reviewed deployment can supply `custody` alongside `options` and `capabilities`.
The maintained entry constructs `createCustodyHost` and supplies its retain/retrieve
callbacks without I/O at construction. Omit those two callbacks from capabilities
in this mode. Approved deployment source may export a mode-keyed `custody` object.
See [durable host custody](custody-host.md) and `host/custody.example.mjs` for
provider/runtime prerequisites, original-request expectations, first-attempt
permission and read-only recovery. Events cannot supply executable custody options.

## Maintained Resolve / actual Runner composition

Set `routing: "authenticated"` alongside `authentication: "actions-oidc"` for
Resolve, Execute and compute. This additive integration uses `createHostRouting`
from the approved Core bundle. Existing deployments without `routing` retain
their explicit `verifyRunner` callback interface; that callback is not upgraded
into authenticated Runner evidence by this change.

The deployment supplies `identity`, preferably `custody`, and a `delivery`
capability returning `{request, config}`. The existing Core `config.current()`
provides its protected plan, including `selectionInput` with trusted registration
records and job conditions. Compose the maintained native dependency evaluator
with `routing.provider` and
`routing.eligibility`, plus its protected completion expectations/retrieval. Supply
stage owners and their final authorization/controlled-operation capabilities as
usual. The host replaces `config.selector`, `config.provider` and
`config.authorization` with maintained source/Grant and routing composition. Omit
`verifyRunner` and `group` callbacks: this path rejects them rather than accepting
an unconditional Boolean or deployment-defined matching rules. The protected
delivery callback receives the read-only capability in `routing`;
its existing non-enumerable `provider` and `eligibility` remain the full member
authorization interface for stage-owner construction. In member modes these bind
the verified process gh account, which must match the selected member. No provider,
credential acquisition, custody publication or stage owner runs at construction.

Identity configuration must permit the required read operations and endpoints:
Core repository/Issue reads (`core-read`), stage selection reads and
`runner-observation` repository/Runner inventory reads (including organization,
group, group membership and selected repository reads where applicable). Its
approved Grant must cover the corresponding operations, including `readiness` and
dependency endpoints when composing `createDependencyEvaluator` with the supplied
`routing.provider`/`routing.eligibility`. As in the identity adapter contract, management reads check the authenticated source and approved
signed Grant before transport, without requiring a candidate to have been chosen
before it can read Assignees. This read-only capability cannot submit mutations.
Candidate eligibility is checked separately for each current Assignee using the
same signed Grant verifier. Permission, binding, source or inventory failures block; they are
never converted into an offline fallback.

For member modes, the protected Actions source policy must require the Job,
check-run association and actual Runner ID (`job: "required"`,
`runner: "required"`, `runner_environment: "self-hosted"`). `getAssociation`
supplies independently trusted Job/Run/Attempt/Runner observations under that
policy. The maintained identity verifier authenticates the signed source and its
association before exposing the Runner ID and source repository identity. Repository
registrations require that source to be the target repository; organization
registrations require a source in their organization and verified target access.
Neither `RUNNER_NAME`, environment variables, Issue/event fields, labels nor workflow inputs can supply that proof.
The executing process's stored gh User ID must match the selected member, and its
login must have the official endpoint rights needed for current inventory checks; lack of management visibility blocks
instead of silently accepting cached registration data. Hosted management
credentials stay in their protected transport, outside Agent/hook/member inputs.

Resolve preserves the API Assignees order, skips trustworthy unavailability before
dispatch and preserves online-busy priority. Its retained resolution includes the
observed candidate IDs, source and times, exact request and native AND route.
Execute binds the retained member before inspecting the current Core decision.
A mere order change cannot move queued work to a different member. Any currently
valid matching instance of the selected member can run; no instance ID is placed
in `runs-on`. Organization group names and access are read from current inventory.
Repository Runners work for both personal and organization public targets.

The initial Execute gate, subsequent Core observations, owner checkpoints,
maintained lifecycle start after readiness, and controlled-operation
`beforeSubmit` guards recheck routing. These additive checks preserve the owners'
existing final authorization guards. Authenticated routing requires the maintained
`createAgentLifecycle` so its final checkpoint cannot be silently ignored by a
custom lifecycle. Supply custom process adapters as its backend; an unsupported
lifecycle stops before launch. Native dependencies and the pinned Core plan
are rechecked at those controlled boundaries as well. Known permission, Assignee,
Grant, registration or access loss stops the next protected operation. Stage
results retain the exact route/member and authenticated execution observation in
`routing`, alongside the existing target/cycle/request/Run/Attempt/decision fields. Recovery
requires that retained execution observation to match the authenticated original
execution, including Runner and local member IDs; a different instance cannot
substitute for an already attempted stage's result.

Use durable custody's original-attempt expectations and first-attempt permission
for restart recovery. Missing/expired/substituted resolution blocks. A result
publication failure after an attempted stage reports `unresolved` with the original
request; a fresh host reconciles that attempt and cannot blindly launch it again.
No timer or reassignment service is created. Waiting needs a later lawful event or
manual retrigger, which rechecks current authority and native dependencies.
GitHub still selects/queues instances using all labels and any verified group;
these checks do not freeze Runner administration, instantly revoke dispatched
jobs, cancel queues or recall data already delivered to a host.

`test/host-routing.test.mjs` runs this path through the public protected host,
maintained identity/provider/selector/Runner checks, Core owners and N03 custody.
The archive verifier repeats it against the installed package. Its signed local
fixtures and synthetic Linux/Windows/macOS/organization inventory are reproducible
source contracts, not live platform, provider or two-member E2E certification.
E02 and E08 own those later claims. Independent Acceptance, isolated hooks,
exact-head CI and protected delivery gates remain required.

Native dependency list GETs (including pagination) follow the public-resource
semantics in [GitHub issue dependency REST documentation](https://docs.github.com/en/rest/issues/issue-dependencies).
Their read permission mapping grants no dependency mutation capability.
## Maintained registration composition

For registration use maintained `identity`, `custody` and `registration` entries
in approved deployment source, with `capabilities = {registration: {}}`.
The loader accepts `registration` only for that mode. The host constructs
`createProtectedRegistration`; deployment supplies the captured original request,
Owner policy and storage capabilities, without implementing authentication,
issuance or restart classification. Registration custody uses its own truthful
source/request bindings; no delivery Issue/Grant is fabricated. See
[registration.md](registration.md) and `host/registration.schema.json` for required
configuration, exact references, status meanings and safe recovery. Legacy explicit
registration callbacks remain compatible. Source/schema changes require fresh
bundle, host and executable deployment approvals before installation.


The maintained [role host](role-host.md) can now be supplied through the reviewed
`roles` executable binding for execute/compute. It binds existing Core role owners
to authenticated profiles, lifecycle, enforced network transport and bounded
verification. Existing capability-only composition remains available; it does not
by itself establish that a deployment supplied the new runtime obligations.
