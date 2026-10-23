# Bootstrap interface version 2

This local, unreleased package owns the interface. Action and workflow wrappers
consume `invoke` from `@nibfin/core`; CLI installation code consumes
`identity` and `verifyInstallation` from `@nibfin/core/identity`.
`examples/action.mjs` and `examples/cli.mjs` are executable library examples,
checked by contract tests and an external installed-consumer smoke test.
No external repository implementation has been inspected or modified.

## Request and result

`invoke(request, trustedAdapters)` is asynchronous and requests one stage only.
There is no network client, polling, scheduling, mutation API, automatic next
stage or retry in this package. The trusted executor must settle its promise
when that stage completes or fails; cancellation and resource limits belong to
its isolated Core host. A hung adapter is not completion evidence.

Requests are plain JSON objects. Unknown top-level fields are rejected. Version
2 requires `schemaVersion: 2`, nonempty `requestId`, `stage`, `repository`
(`id`, `name` as owner/repository), `issue` (`id`, positive integer `number`,
`repositoryId` matching repository.id), `authority` (`grantId`, `digest`), and
`scopeDigest`. Stable IDs and request IDs are strings; digests are lowercase
64-character SHA-256 hex. Parsing these fields does not authenticate them.

| Stage | Required predecessor stage | Additional references |
| --- | --- | --- |
| shape | None; previous must be absent | None |
| shape-validator | shape | None |
| deliver | shape-validator | shapeDigest |
| accept | deliver | shapeDigest, candidateDigest |

These are supported invocation identifiers, not additional Skill identities or
an implementation of the complete lifecycle. Shape validation uses the shape
Skill; delivery and acceptance retain their distinct protected identities.
Publication, hooks, CI, final review and privileged writes remain separate Core
gates. In particular a validator result alone does not authorize Deliver: the
trusted verifier must independently require current published Shape evidence.
Other identifiers and schema versions fail explicitly; future incompatible
interfaces require an explicit version change and consumer integration checks.

For Actions callers, `source` contains `repositoryId`, fixed `workflow` path,
`workflowDigest`, `runId`, and positive integer `attempt`. It must identify the
actual target repository. Non-Actions interface fixtures may omit source; a
production Actions host must reject missing provenance in its trusted verifier.
Optional `components` has string values for `action`, `workflow`, `cli`, `agent`
and `platform`; these are caller metadata, never Core identity or support proof.
Absent metadata remains null/unknown, with no invented version or platform.

Every noninitial request includes `previous`: `resultId`, `digest`, `stage`,
`requestId`, `repositoryId`, `issueId`, and `source` when the prior result has an
Actions source. The predecessor request must differ from the current request.
Its source names the predecessor Run/Attempt, not the current Run/Attempt.
The digest is SHA-256 of `JSON.stringify(previousResult)` with the original
result's exact JSON property order. Preserve the original serialized result;
do not reconstruct its property order or hash raw string bytes under a competing
rule. This is content correlation, not a signature or provenance mechanism.

The trusted `verify` function receives a clone of the parsed request. Only after
it returns `permission: 'verified'` may execution proceed. This means it has
independently verified fresh Grant, native dependencies, stable identities,
Runner-set trust, isolation, stage applicability, prior gates and permissions.
For a predecessor it must also return `previousAuthenticity: 'verified'` and
`previousResult` from authenticated immutable storage. Core, rather than an
event or request, selects that storage and verifies successful source evidence.
The interface compares digest, result/request/stage IDs, repository/Issue,
source Run/Attempt, authority, Scope and succeeded status. Deliver compares
Shape; Accept also compares candidate. Structural validity alone is insufficient.

Fresh requirement verification described below is also mandatory.

`execute` receives a separate clone and is called exactly once after verification.
It returns `{status: 'succeeded'}` only for confirmed completion of that stage.
Core persists actual stage artifacts separately and binds their references to
subsequent requests; this bootstrap neither creates nor publishes them.
Adapters are trusted in-process code. Never load them from a request path or
expose these injection arguments as user permission assertions. There is no
production success adapter; deterministic adapters exist only in tests and the
explicit synthetic experiment. Requests and results must contain no credentials.
Prerequisite installation and authenticated transport confer no execution grant.

Results have `schemaVersion: 2` and one of `rejected`, `blocked`, `succeeded`.
Malformed requests return rejected plus an English error and no execution.
Well-formed results carry `resultId` (requestId + ':result'), requestId, stage,
repository, issue, authority, Scope, supplied Shape/candidate/source, and
components and the verified requirement references. Each request ID must be unique within the host's work cycle;
this library provides no replay store. Missing adapters, invalid evidence,
unverified permission, exceptions or unconfirmed execution return blocked.
Blocked errors are generic to avoid leaking adapter diagnostics. An executor
exception may have unknown effects: Core must reconcile, never blindly retry.
Succeeded confirms only the requested adapter completion, never delivery,
Acceptance of a new candidate, CI, merge, publication or downstream eligibility.

## Evidence boundaries

Fixed trusted same-workflow `needs` can enforce local job ordering. Across Runs,
verify source and persistent successful results independently. Event payloads,
labels, local gh login, OIDC/source identity and partial job output cannot prove
success. This bootstrap does not validate real Actions provenance or claim C-15
E2E. Grant, Runner trust, distributed coordination, relay, recovery, deployment,
CI, review, merge and completion remain planned product implementation work.
P1 work items come exclusively from GitHub Issues.

## Local installation and pinned verification

Use Node 22.23.3 and npm 10.9.9. From a reviewed checkout:

```sh
npm ci --offline
npm run build
npm run check
npm test
npm run experiment
npm run verify-package
npm pack --pack-destination /tmp
```

There are no external dependencies. Frozen installation and all checks work
offline. From a separate temporary consumer directory with package.json, install
the resulting absolute archive path with `npm install --offline --ignore-scripts
--no-audit --no-fund /tmp/nibfin-core-0.1.0.tgz`. This is a local package, not a
published release or external installer. The maintained verify-package command
performs that flow, prints the exact archive inventory, exercises both examples
outside this checkout and removes its temporary directory.

A trusted installer must compute or obtain its expected Core identity from an
independently reviewed, pinned source/artifact record, never the installed
package's own claim. The content algorithm is SHA-256 of JSON.stringify of an
ordered array of `[path, base64(exact file bytes)]` pairs, in this order:
LICENSE, package.json, src/identity.mjs, src/index.mjs, src/requirements.mjs,
src/protected.mjs, src/agent.mjs, src/instructions/shape.md, src/instructions/deliver.md,
src/instructions/accept.md. Those regular files are
the complete Core runtime identity surface. The smoke script independently
computes it from source with Node crypto before installing, then checks installed
bytes through `checkInstalledCore({name, version, contentDigest})`. Name/version
come from reviewed package metadata; changed version or digest is rejected.
For hostile installations run an independent verifier outside the installation;
executing a modified verifier cannot establish trust in itself. Archive and
consumer examples/docs have their own review boundary; this identity is not a
signature over the complete npm archive.

Proposal specification versions are separate from Core software version 0.1.0.
Action, workflow, CLI and Agent/platform versions have independent lifecycle and
compatibility evidence; none is released or supported by this bootstrap.
No floating latest selector is used. An upgrade cannot silently replace Core,
Runtime or Skill identities bound to active authorization, take over unfinished
work, or resolve unknown side effects. The trusted host must check compatibility
and obtain applicable renewed authorization before such a transition.

## Requirement sources and snapshots (version 1)

Request/result schema 2 is an incompatible, unreleased replacement for schema 1.
Old requests are rejected; no execution path bypasses requirement verification.
The owning interface remains @nibfin/core. Maintained Action examples, synthetic
experiment and installed-consumer tests use schema 2 together. External Action
and CLI repositories were not inspected; their integrations must migrate before
using this interface. Package version 0.1.0 remains an unreleased bootstrap.

Each request requires `requirements: {productSecurity, delivery}`. Both values
are references with exactly `schemaVersion: 1`, `source: {kind: 'notion', id}`,
`revision`, `contentDigest`, and `snapshotId`. IDs/revisions are nonempty strings;
digests are lowercase SHA-256 hex. Notion is the only supported source kind.
Different sources remain different identities even when their contents match.
There is no implicit Nibfin Proposal page or external-project source default.
Product-security authority and the target delivery's requirements must each be
configured and approved for their own context, even if they share a source.

Exported `validateSource`, `validateReference`, `validateSnapshot`, and
`captureSnapshot` provide the shared contract. A snapshot is exactly
`{reference, content}`. Content is the exact captured string, including whitespace.
Its digest is `digest(content)`: SHA-256 of JSON.stringify(string), not raw bytes.
The snapshot ID is digest of the canonical object constructed in this order:
`{schemaVersion: 1, source: {kind, id}, revision, contentDigest}`. References are
canonicalized before comparison; structured snapshot contents must be serialized
by the trusted reader into a documented stable string before this boundary.
Snapshot serialization itself is not used as the content digest.

Trusted host configuration supplies `adapters.requirements` with exactly
`productSecurity`, `delivery`, `storage`, and `verifyApproval`. Each context is
`{source: {kind: 'notion', id}, read}`. The host obtains approved stable page
identities from its authenticated configuration, never repository prose or
request-selected code. `read(source)` must make a fresh authority observation
and return exactly `{source, revision, endRevision, content, complete, unavailable}`.
It must assemble every required paginated/nested block and supported attachment
representation. `complete` is true only if all required content is readable;
`unavailable` lists inaccessible or unsupported required material and must be
empty to verify. Unsupported embeds cannot silently disappear from the capture.
The reader must revalidate the provider revision after assembling content, or
obtain equivalent consistent-read evidence; revision and endRevision must match.
The host must implement that revision protocol, freshness and complete supported
representation in its provider adapter. This library rejects incomplete evidence
but cannot authenticate a dishonest trusted reader's claims.

`captureSnapshot(contextConfiguration, storage)` observes and validates content,
then calls `storage.putIfAbsent(snapshotId, snapshot)` and reads it back through
`storage.get(snapshotId)`. Storage must atomically insert only when absent,
retain immutable protected records and never replace an existing identity.
Altered or different readback is rejected. Capture alone authenticates no approval.
No capture or storage write happens during invoke; there is no retry or reapproval.

Before each executor call, Core reads both current sources and stored snapshots,
compares their full references and exact content, and calls
`verifyApproval({schemaVersion: 1, context, reference, authority, repository, issue})`.
Only literal true passes. The trusted verifier must independently authenticate
Owner approval for that exact context/source/version/content, Grant and target;
it must reject stale, revoked, unauthenticated or inapplicable approval records.
It selects approval history from protected authenticated storage; the request
cannot submit its own approval or verifier. A timestamp, URL, hash or snapshot
is insufficient authorization. The complete signing system remains outside this
bounded interface. Production has no default success verifier or reader.

Success carries the approved references, never source content or raw provider
errors. Core persists the result and authenticated approval history. Successor
correlation requires identical requirement bindings in authenticated predecessor
results; updated bindings require fresh applicable authorization and new stage
evidence rather than reuse of an old predecessor. Historical A records remain
identifiable after B is observed. Reader, permission, approval and executor inputs
are cloned so mutations cannot change subsequent execution or result references.
Adapters are trusted in-process code, not a hostile-code isolation boundary.

`test/requirements.test.mjs` and `test/fixtures/request.mjs` implement an executable
synthetic Notion-shaped capture/approval/current-read integration. They use a
separate external-project delivery source. No real Owner approval, private
handoff record, Notion transport, credential, or live Provider E2E was inspected
or shipped. Actual Notion support requires a trusted provider reader satisfying
the protocol above and separately verified live evidence. Unreadable current
authority blocks even with a previously approved offline snapshot.

## Protected interface version 3

The same package now exports `invokeProtected(request, trustedAdapters)` and
`validateProtectedRequest`, `validateBinding`, `validateRoleResult`,
`validateLifecycle`, `roles`, `failureClasses`, `skillForRole`,
`resolveInstructions` and `instructionApproval`. The normative owner is this
Core package. Action/CLI hosts consume these exports; no external repository
integration or real Actions execution is claimed. The current baseline schema-2 invocation and requirement-source gates
remain supported. Protected schema 3 requires explicit construction from
authenticated host observations; schema-1/2 results are not valid protected
schema-3 evidence. There is
no automatic migration. Unsupported versions fail explicitly at either boundary.

All objects below have exactly their listed keys; optional fields are identified
explicitly. No permission assertion is accepted in requests or role results.
Strings are nonempty unless otherwise specified. Hashes are lowercase SHA-256
hex; positive integers are safe integers greater than zero. `digest(value)` is
SHA-256 of UTF-8 `JSON.stringify(value)`, including JSON quoting for strings.
Equality uses that serialization and its property ordering. Preserve original
objects/order; this is not canonical JSON, authentication, or a signature.

### Requests and execution bindings

Request: `{schemaVersion: 3, binding: Binding, previous: Reference[]}`.
Reference: `{binding: Binding, digest: Hash}` where digest covers the complete
prior RoleResult, preserving original order. Duplicate result IDs are rejected.
A Binding has all of the following fields; none may be omitted:

| Fields | Required value |
| --- | --- |
| requestId, resultId, sessionId | Distinct host-assigned request, result and execution-session identities, each a string |
| role, skill | See the role table below; request claims must equal trusted assignment |
| repository | `{id: String, name: "owner/repository"}` |
| issue | `{id: String, number: PositiveInteger, repositoryId: repository.id}` |
| requirements | `{productSecurity, delivery}` references using the shared requirement-source schema above |
| authority | `{grantId: String, digest: Hash}` |
| scopeDigest, instructionDigest, instructionSelectionDigest | Hashes of original Scope, effective instructions and full selection identity |
| previousDigest | Hash of the complete ordered request.previous reference array |
| shapeDigest, candidateDigest | Hash or explicit null when inapplicable |
| deliveryCycle, repairCycle, incidentId | String or explicit null when inapplicable |
| source | `{repositoryId: String, workflow: String, workflowDigest: Hash, runId: String, attempt: PositiveInteger}` |
| versions | `{core: Hash, runtime: Hash, adapter: Hash, skill: Hash}` |

Shape is mandatory for every role except Shape author; a successful Deliver
candidate result requires Candidate identity, and Candidate is mandatory
for Accept/final review. Delivery cycle is mandatory for Deliver/Accept/final
review. Repair requires delivery cycle; incident requires repair cycle. Target
repository and Actions source repository are distinct. Every current, prior and
lifecycle source requires an explicit trusted source/target relationship, even
when their IDs are equal. A predecessor Run need not equal the current Run.

| Execution role | Protected Skill | Successful outcome | Required role evidence |
| --- | --- | --- | --- |
| shape | shape | proposal | None inherently; trusted operation may require more |
| shape-validator | shape | approved | shape |
| shape-diagnosis | shape | not-confirmed (none), confirmed (shape_defect) | shape |
| shaper-review | shape | approved | shape, shape-validator, deliver, accept |
| deliver | deliver | candidate | shape-validator |
| accept | accept | accepted | deliver |

These minimum role-evidence requirements are not an operational lifecycle or
permission table. The trusted host must include all operation-specific prior
gates (including publication and hooks) and all relevant author/reviewer
sessions. Validator, diagnosis, Accept and final review reject reuse of any
supplied predecessor session. Core must provide stable authenticated session
identities and cannot omit relevant historical participants to claim independence.
Scope, deployment, completion and recovery are not privileged agent roles.

### Trusted verification and instructions

`verify(clone(request))` must return exactly `{permission, assignment,
configuration, instructionContext, relationships, prior, lifecycle,
lifecyclePolicy, conflicts}`. This is trusted adapter output, never event input.
Both requirement sources are freshly verified through the existing
`adapters.requirements` reader/storage/approval interface before execution, using
the target and authority in Binding. Missing or stale requirement evidence blocks
every protected role, including customized instructions.
Permission must equal `verified` after fresh Grant, native dependencies, Runner
trust, isolation and all applicable gates. `assignment` is the full expected
Binding, compared to the claim. Missing/invalid permission blocks execution.

`configuration` is `{repository: SkillEntries, shared: SkillEntries,
approved: Hash[]}`. SkillEntries maps protected Skill names to approved entries
`{mode, content}`. Content is a string (empty permitted); mode is `default`,
`extend` or `override`. Default requires empty custom content. Repository entry
presence replaces shared; absent repository falls back to shared, then built-in.
Malformed/unapproved selected entries fail closed. Default returns built-in
content; extend returns built-in + newline + custom; override returns custom.
Arbitrary files in participating repositories are never discovered or loaded.

`instructionContext` is exactly `{repository, authority, versions, requirements}` from the
assignment. Approval is `digest({context, source, skill, mode, content})` in that
order, computed by `instructionApproval(context, source, skill, entry)`.
Sources are `repository`, `shared`, `builtin`. Every selected nonbuilt-in entry,
including default, must have that digest in trusted `approved`. Editing bytes,
mode, source or context requires renewed approval. Resolver output is exactly
`{skill, source, mode, approvalDigest, content, contentDigest, selectionDigest}`; contentDigest
hashes the effective string. SelectionDigest hashes
`{skill, source, mode, approvalDigest, contentDigest}` in that order, and must
equal binding.instructionSelectionDigest. Thus equal effective bytes cannot
hide a mode or source change. Built-in files ship under `src/instructions/` and
are pinned by installation identity. Customization changes instructions only.

`relationships` is an array of `{sourceRepositoryId, targetRepositoryId}`.
`prior` is an authenticated operation-specific inventory of
`{reference, result, authenticity, completion, conflicts}`. The request's
previous array must equal its references exactly. Authenticity must be `verified`;
complete RoleResult digest/binding/outcome is checked. Target, Issue, authority,
Scope, requirement-source bindings and applicable cycles/artifacts must correlate. Null inapplicable Shape
cycles do not forbid reference by a later Deliver cycle; prior Deliver/Accept/
final-review cycles must match exactly, including null. Component/instruction and
source identities are checked against each predecessor's own authenticated
Binding, rather than incorrectly forcing prior role/source versions to current.
Completion is `authenticated-result` or `same-workflow-needs`; the latter also
requires identical source (workflow, version, Run and Attempt). Trusted host
policy must establish fixed native needs without bypass conditions. Source/OIDC,
login, partial logs and claimed status alone are rejected completion mechanisms.
There is no universal immediate Jobs REST API requirement.

### Role results and lifecycle references

`execute(clone(request), clone(resolvedInstructions))` runs once after all
checks. It returns exactly `{schemaVersion: 3, binding, outcome, failureClass,
references: String[], conflicts: Conflict[]}`. The Binding must equal the trusted
assignment. Success outcomes in the table use classification `none`, including a diagnosis
that does not confirm a Shape defect, except
confirmed diagnosis uses `shape_defect`. Every role can return `concern` with
any non-none classification; validator/Accept/final review can also return
`rejected` with any non-none classification. Classifications are exactly `none`,
`implementation_defect`, `shape_defect`, `authority_gap`, `external_failure`.
Unknown/contradictory combinations and permission fields fail. Success requires
nonempty artifact/evidence references. References are locators, not permission.

Only confirmed diagnosis carries nonempty conflicts. A Conflict is exactly
`{scopeHash, shapeHash, scopeQuote, shapeQuote, explanation, evidenceReference}`;
hashes must equal original Scope/current Shape, other values are strings, and
the complete array must equal independently authenticated `proof.conflicts`.
The verifier must authenticate exact quoted clauses, not merely repeat an
allegation. All other results require empty conflicts. Classification never
selects another operation, restores Scope or dispatches work.

`lifecycle` is an array of `{evidence, expected, authenticity: 'verified'}`.
Evidence must exactly equal its independently authenticated expected record and
correlate to current repository/Issue/cycles/incident. The record has exactly
`{kind, repositoryId, issueId, deliveryCycle, repairCycle, incidentId, mergeSha,
version, environment, source, state, references, reason}`. Source uses the schema
above; mergeSha is 40 or 64 lowercase hex characters; version/environment are
strings. Repair/incident may be explicit null. References are string arrays.

| Kind | States |
| --- | --- |
| deployment | healthy, failed, not-applicable |
| completion | valid, invalidated, unknown |
| recovery | open-failure, closed-incident |

Recovery requires repair and incident identities. Non-not-applicable records
require nonempty references and null reason. Not-applicable requires a nonempty
reason exactly matching trusted `lifecyclePolicy.deploymentNotApplicableReason`.
If `lifecyclePolicy.requireValidCompletion` is true, unknown/invalidated completion
blocks. The trusted host must supply every required lifecycle record and current
expected version, Merge, Environment, Run/Attempt and invalidation state. Empty
inventory means the host verified no lifecycle proof applies, never absent proof
masquerading as not-applicable. `conflicts` and lifecyclePolicy are trusted inputs;
untrusted recovery comments/events/logs cannot populate them as authority.

Malformed requests return `{schemaVersion: 3, status: 'rejected', error}`. Missing
adapters, verification failures, exceptions or invalid executor output return
`{schemaVersion: 3, status: 'blocked', error}` with safe English diagnostics.
Confirmed role execution returns `{schemaVersion: 3, status: 'succeeded', result}`,
including a completed concern/rejection as data. Transport success is not role
approval, permission, successful prior evidence, or delivery completion. No retry,
persistence, network, dispatch, privileged write or state transition is performed.
The host owns replay protection, authentication, isolated execution and fresh
independent evidence; deterministic tests do not establish production security.

## Agent host interface version 1

`src/agent.mjs`, exported from `@nibfin/core`, owns the version-1 Agent host
interface. It composes protected schema 3; schemas 2 and 3 remain unchanged and
explicitly supported. There is no default production host, checkout-discovered
plugin, Agent/OS support claim, registration transport or additional lifecycle.
Action/runtime hosts consume this interface; onboarding callers can consume the
standalone environment and login validators. No external consumer repository was
inspected or changed. All records reject missing or unsupported fields/versions.
Identity comparison uses the existing `digest(value)` JSON.stringify semantics,
including property order. String content hashes JSON.stringify(string).

### Environments, instances and phased login

`validateEnvironments(environments, instances, previousEnvironments = [])`
validates the entire observed local inventory. Environment records have exactly
`{schemaVersion: 1, id, agent, credentialDomain}`. All identifiers are nonempty
strings matching `[A-Za-z0-9][A-Za-z0-9:._/-]*`; these are logical identities,
not permission to use them as filesystem paths. Environment IDs and Agent
credential domains are unique. A previously observed environment must remain
byte-identical, including its fixed Agent type and credential domain. Core must
supply authenticated historical records, not a checkout's account of history.

Instance records have exactly `{schemaVersion: 1, id, environmentId,
agentCredentialDomain, githubIdentity, githubCredentialDomain, workspace,
service, runnerId}`. The Agent domain must match the referenced environment.
GitHub credential domains cannot equal any environment's Agent domain. Instance
IDs, workspaces, services, GitHub credential domains, non-null GitHub identities
and non-null Runner IDs must each be unique. `runnerId` and `githubIdentity` are
both null for unregistered local instances, or both nonempty identifiers after
registration. No Runner ID is invented by create or login. Registration must
bind existing instances: create's count is the total local instance inventory
(default 2, positive integer), not a per-repository multiplier. This interface
validates observations; it neither creates instances nor implements count/CLI
orchestration. Trusted hosts must independently establish actual separation,
including ancestor/mount aliases and OS credential/service boundaries.

`validateLogin(observation, expected)` validates a secret-free host observation:
`{schemaVersion: 1, phase, operation, runId, attempt, account, userId, agent, gh,
tokenEnvironment, httpStatus}`. Expected contains exactly `{phase, operation,
runId, attempt, account, userId, caller}`. Caller is `local` or `github-hosted`.
Phase is `create`, `register`, `standby` or `issue`; attempt is a positive integer.
Operation, Run, OS/service account and stable GitHub user must match expectation.
Agent and gh states are `available`, `unavailable` or `unknown`. Agent must be
available; local callers also require available gh. Hosted callers use their own
trusted authentication and need no member-local gh login. Token environment must
be `absent`, and HTTP status must be null or 200. In particular GH_TOKEN or
GITHUB_TOKEN cannot silently substitute for the actual service account's login.
401/403, unknown identity and missing login block without login or retry.

Create's login check requires no registration, while standby needs neither an
Issue nor its Grant. Passing either validator grants no registration or execution
permission. The Issue adapter separately requires a registered instance and fresh
Core permission. Trusted host diagnostics must never include raw provider
responses or credentials; safe status observations are retained by Core with
operation/Run/Attempt correlation.

### Assignment, immutable input and trusted host methods

`createAgentAdapter(host)` takes trusted Core-injected functions only:
`observe`, `predecessors`, `reconcile`, `materialize`, `seal`, `execute`, `stop`,
and `cleanup`. These functions run outside the sandbox. Their return values
must be freshly authenticated host observations, never Agent assertions with an
added authenticity flag. Functions receive clones; no method is loaded from a
repository, event, path or instruction. Host enforcement and evidence provenance
cannot be established by structural validation alone.

`adapter.prepare(assignment, expectedLogin)` returns an opaque, process-local
handle. Assignment is exactly `{schemaVersion: 1, executionId, workspaceId,
environmentId, instanceId, class, binding, references}`. Class is `agent` or
`hook`; Binding is the existing complete schema-3 Binding, including role, Skill,
repository/Issue, source Run/Attempt and component/instruction identities. Hooks
are a separate execution class and never become a protected Skill. Input
references are a nonempty array of exactly `{schemaVersion: 1, id, kind, digest,
path, repositoryId, candidateDigest, runId, attempt}`. Kinds are `repository`,
`candidate`, `artifact` or `hook`. Candidate, target repository and destination
Run/Attempt must match Binding. The reference ID names an independently
authenticated immutable object; a URL/path or digest alone is not authentication.
No mutable-checkout fallback exists. Paths are portable relative destinations
without empty, dot, parent, absolute, backslash or NUL components; overlapping
and duplicate destinations fail. Required ignored artifacts belong in this
inventory just like repository content. This version materializes exact UTF-8
strings; a host needing binary/unsupported inputs must block rather than decode
lossily or omit them. Storage, retention, transport and N57 are outside this seam.

`observe(assignment)` returns exactly `{assignment, environments, instances,
previousEnvironments, login, capabilities, exposures, permission}`. Assignment
must match the separately authenticated complete expected assignment, including
all required evidence. The inventories use the validators above. Permission must
be `verified`, established by Core, never inferred from login. Agent login must
match expected Issue phase and Binding Run/Attempt. Hooks have `login: null` and
use `expectedLogin: null`; they need no Agent login or credentials.

Capabilities has exactly `{filesystem, symlinks, credentials, network,
termination}`. Filesystem must be `workspace-write` for Deliver Agent and
`read-only` for every other protected role and Hooks. Symlinks, credentials and
termination must be
`deny`, `isolated` and `observable`. Network must be `denied` for Hooks; Agents
may use `denied` or `restricted` with trusted Core-approved egress enforcement.
These values represent
actual host-enforced controls, not requested flags. Unsupported/unknown controls
block, even with approved override instructions. Exposures is an empty array or
`['agent-login']` for Agents; it must be empty for Hooks. Controller keys, signing
keys, Core gh authentication and GitHub credentials cannot enter any sandbox.
The host must enforce path/mount/symlink boundaries against concurrent changes,
prevent cross-workspace access, restrict network and prevent credential leakage.

`predecessors(assignment)` supplies all relevant previous executions as
`{assignment, observation}` records from trusted durable Core state, including
other registrations/Runs. `reconcile(record)` returns an independently obtained
current cleanup observation for that predecessor. Unknown/failed termination or
disposal blocks preparation. Every predecessor execution and workspace must
differ from the new assignment. The adapter also refuses reuse within its own
process, including after failed materialization or successful cleanup. These
local reservations are not distributed exclusion. Core must retain all relevant
predecessors and reconcile unknown preparations across process/host loss; a new
adapter or Run does not clear their obligations.

`materialize(assignment, reference)` retrieves authenticated immutable content
and returns the exact string. The adapter checks its expected digest before
sealing/exposure. The trusted materializer must stage privately and enforce safe
destinations, verify identities before any exposure and never use surviving
mutable data as fallback. `seal(assignment)` makes the complete verified input
visible with actual role restrictions and returns the correlation record below
plus `mode` and exact `references`. Missing/altered inputs or stale seals block.
Partial preparation requires Core reconciliation; no callback is run or retried.

### Execution, results, diagnostics and cleanup

All host execution, seal and cleanup records share exactly this correlation
prefix: `{schemaVersion: 1, executionId, workspaceId, assignmentDigest, operation,
runId, attempt}`. Assignment digest binds the complete input; operation is the
protected role or `hook`. Additional keys depend on the method.

`adapter.execute(handle, protectedAdapters)` consumes a handle once. For Agents,
protectedAdapters contains `request`, `verify`, and `requirements` as documented
for schema 3. The adapter supplies its own executor to `invokeProtected` and
preserves every instruction, requirements, permission, prior-evidence,
independence and RoleResult gate. The request Binding must equal the prepared
Binding. `host.execute(assignment, resolvedInstructions)` returns correlation
plus `result` (unchanged schema-3 RoleResult) and nonempty identifier `references`.
Returned adapter output has correlation plus `status`, `references` and
`protected` containing the schema-3 transport response. Top-level `references`
retain the validated trusted host execution evidence for that exact assignment;
`protected.result.references` retain the distinct RoleResult evidence unchanged.
Host references are empty if no valid correlated host execution record was
obtained. They can accompany a blocked response when RoleResult validation fails;
evidence presence never overrides protected status or result gates.
Succeeded transport can still contain a role
concern/rejection; callers must inspect RoleResult, never infer acceptance.

For Hooks, host.execute receives null instructions and returns correlation plus
`status: 'succeeded'` and nonempty identifier `references`. This is a bounded
execution seam, not full hook orchestration, approval or a hook receipt protocol.
Core still enforces isolated no-network/no-credential execution and both mandatory
hook passes. A Hook callback cannot invoke Agent execution through this seam.

Preparation errors have a fixed English message and a `diagnostic` with version,
operation `prepare`, blocked status, syntactically valid input Run/Attempt or
null, and bounded host-observed `httpStatus` (integer 100–599 or null). These input locators are diagnostic hints, not verified source proof.
Execution exceptions return a generic correlated blocked record without raw host
errors. No error triggers retry or implies termination/cleanup success.

`adapter.cleanup(handle)` consumes the handle, requests `stop(assignment)` once
per call, then independently observes `cleanup(assignment)`. Cleanup records
contain correlation plus `{termination, disposal, references}`. Termination is
`confirmed`, `running`, `failed` or `unknown`; disposal is `safe`, `failed`,
`incomplete` or `unknown`. References are nonempty identifier arrays.
`validateCleanup(observation, assignment)` returns `{safe, observation}`; safe
requires confirmed termination AND safe disposal. Failed stop does not establish
termination; only independently authenticated observation can resolve it.
Unverifiable cleanup returns `{safe: false, observation: null}`. Core must persist
these records and block replacement Writers, even on another Run/registration,
until independently reconciled. Timeout and a new Run cannot clear uncertainty.

### Verification and support limits

`test/agent.test.mjs` applies common boundary checks to all six protected roles
and Hooks through `test/fixtures/agent-host.mjs`. The tested backend is a local
Node 22.23.3 JavaScript test host on this Linux execution container. Child-process
filesystem probes use Node's experimental permission model: Reviewer writes,
outside-workspace reads/writes and credential-file access are actually rejected;
Deliver can write its approved workspace. Host path checks reject escapes and
symlinks. An empty child environment and restricted VM evaluator exercise denied
credential globals and network entry points without sending network traffic.
The VM exposes no imports, process, fetch or sockets and disables dynamic code.

This is NOT a secure general-purpose VM or native Agent sandbox. It does not
prove kernel network isolation, malicious native-code resistance, mount-race
safety, production credentials, arbitrary child processes or real Agent login.
No concrete production backend or Agent/OS combination is advertised as supported.
Other platforms/Agents need equivalent independently measured enforcement before
support can be claimed; unavailable capabilities fail closed now.

Successful test-host cleanup actually removes the workspace. Failure/running/
unknown cleanup observations are synthetic fault injections, not live process
termination experiments. The Run A/B fixture uses a synthetic immutable
in-memory store and separate
filesystem roots. It deletes the Writer root before reconstructing Reviewer
content and required ignored artifacts; this is not N57 storage or Actions E2E.
Package smoke checks installed exports and independently detects new module
tampering. Root build/check/test/experiment/verify-package establish local source
and package behavior only, never hosted CI, Acceptance, production isolation,
GitHub/Actions E2E or publication. No additional non-tree candidate artifacts or
commit hooks are introduced.
