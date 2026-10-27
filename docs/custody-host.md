# Durable host custody

`createCustodyHost` composes the maintained Actions artifact publisher, bounded ZIP
reader and authenticated provider reads. `configure` from `@nibfin/core/protected-host`
accepts its options as protected `deployment.custody`; omit the `retain`/`retrieve`
callbacks from capabilities in that mode. Construction and imports perform no I/O.
See `host/custody.example.mjs` for an approved embedding that calls `configure`
directly. Its inert factory returns the supported deployment object; it is not a
`loadProtectedDeployment` source export. For that loader export mode-keyed
`capabilities` and `custody` objects (plus `identity` for OIDC), whose exact source
and options approvals are required before evaluation. Load any
executable deployment only through approved source/options bytes, as described in
[protected host](protected-host.md). Options and callbacks never come from events.

## Independent binding and reconstruction

The trusted `expect({kind,key})` capability supplies `{kind,key,binding}`. Binding
contains source `{repository,repositoryId,revision,runId,attempt}`, target
`{repository,repositoryId,issueId}`, requirements `{revision,scopeHash,shapeHash}`,
`authorization`, `cycle`, `role`, `stage`, `request`, `result`, and `candidate`
(`{identity,payloads:[{path,digest}]}` or null). IDs are strings. Revisions are exact source Git SHA-1 and
requirement snapshot SHA-256. Scope and Shape hashes retain their existing
JSON.stringify(string) convention. A null Shape is allowed only before Shape.
The independently authenticated source Run/Attempt must identify the actual
producer of these public bytes. OIDC is source identity, never success evidence.

`custodySlotIdentity(slot)` is a stable opaque workflow reference. A trusted fresh
host reconstructs the same slot from original request/Run identity and CURRENT
requirement authority, including for a reference whose final process output was
lost. It does not need a local receipt, producer object, temporary directory or
latest artifact. `expect` must resolve both original correlation keys and these
opaque references independently. A wrong/stale reference must not select a new
expected identity. Discovery uses the original Run, an exact deterministic name,
complete bounded listing, immutable artifact ID and SHA-256 archive digest.
The archive manifest is checked against independent context, and the existing
custody verifier checks fresh repository, listing, metadata, expiry, bytes and
manifest identities before anything is returned. Candidate attachments supplied as a
`payloads` Map must match every independently pinned path/digest; missing or changed
bytes fail. `recover` returns verified attachments separately from the JSON value.
The [official Run-attempt endpoint](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt)
also checks the original Attempt and source revision; Run success is not inferred. Payload metadata never selects
its own authority. Public personal and organization repositories use the same API.

`retain` returns retained/recovered or unresolved. Failures preserve the stable
slot key and already obtained artifact references where available. `recover` only reads; it NEVER
uploads. `retainValue` returns the opaque workflow key or throws a generic error;
`retrieve` returns exact JSON value or throws. Host workflow catches these errors
and prevents continuation. The storage API may recover rejected/diagnostic values;
only original validation gates can interpret them as stage evidence.

## Publication and restart semantics

Before result upload, retain AND read back a separate immutable intent containing
the result digest. Before the first intent upload, `authorizeNew(slot,{signal})`
must positively attest that the original publication was never attempted, using
independently authenticated durable Core/native Run history. It must consume or
reserve that permission durably BEFORE returning true. An empty artifact list,
a local Set, a new process, a different wakeup or a cancelled Run cannot provide
this attestation. All writers to the same slot use the installed official Actions
concurrency group with cancellation disabled. This is not a CAS/lease service.
A deployment lacking durable original-attempt history or native serialization is
unsupported for new publication; read-only recovery remains possible.

The maintained protected workflow also calls `beginStage` before role/owner
execution. Configure independent `stage-attempt` and `stage-result` slots for that
request. A retained stage result is returned without relaunch; an existing attempt
without final output blocks for original-operation reconciliation. The attempt is
retained/read back before Core execution, so a fresh host cannot rely on a stale
new checkpoint or process-local duplicate Set to launch another role.

The retained intent records the immutable slot and exact result digest. Once
attempted, missing intent/result evidence stays unresolved. On restart a matching
result may be recovered; an intent without result stops. Duplicate/out-of-order
wakeups discover confirmed bytes and cannot change them. Ambiguous intent upload,
submission with lost response, missing/expired evidence, conflict, 403, cancelled
readback or a timeout never grants permission to retry. A listing absence cannot
prove no external effect. Keep original correlation in Core history even if final
output is lost. GitHub expiry/deletion can make continuation unavailable.

For first-party API writes continue using `createControlledOperations`: its
original intent/attempt/submission/result custody and operation-specific fresh
readback predicates are mandatory. This host is not a replacement success
predicate or a reason to replay an unresolved write. `createCustodyCurrent` can
hydrate independently named `prior`, `stageInput` or `receipts.<stage>` from these
retained values. Its `load()` supplies `{pin,records}` from protected current
observations; each record supplies destination, custody query, expected content
digest. Receipt destinations additionally pass `compareEvidence` against the
independently supplied `pin.evidenceCurrent`. It never replaces authorization,
invocation, source or current requirement expectations from a payload.

## Role output, verification and repair input

`createRetainedRoleBackend` wraps a maintained role backend's `collect` boundary.
It retains the original complete `{status,exitCode,evidence}` before returning to
`createAgentLifecycle`. A fresh wrapper first recovers those exact bytes without
calling the producer. Lifecycle independently validates them again. Failed
retention returns pending, preventing cleanup/completion. No process is started
by recovery. Pending or partial output is never retained as success. Termination
and cleanup remain the existing backend's responsibility and gates.

`retainedRoleRecord` stores explicit diagnostic, capacity-failure,
validation-failure, unknown-write or validated status, original output, bounded
verification receipts/logs and unaccepted repair input. These records are inputs,
not stage receipts or Acceptance. A validated status only records a producer's
observation; recovered data must pass fresh applicable validation. The role
wrapper deliberately records zero-exit output as diagnostic until lifecycle
validates it. `recoverRoleCollection` revalidates the original complete output
against independently supplied current expectations after restart, without
relaunching a role. It returns validated evidence, a rejected collection, or
blocked. Replay/consumed results and wrong current bindings fail. This allows
protected current-state reconstruction to reuse exact source bytes while
preserving independent role/result validation. Capacity/unknown-write observations must be explicit from their
owning runner/operation, never inferred from a timeout as successful completion.

Only authority-approved public data may be retained. The host rejects configured
secret sentinels, credential patterns, private keys and signed/query URLs rather
than silently changing exact role bytes. Deployment must classify public-safe
inputs before calling retention; this pattern check is not a general secret
scanner or permission to publish private material. Exceptions/provider response
bodies are never forwarded. Defaults: 1 MiB archive/payload, 8 files, 30 seconds,
7 days; maxima 16 MiB, 256 files, 5 minutes and 90 days. Discovery caps a Run at
1,000 artifacts. Verification logs cap at 8 KiB each, 32 receipts, output at
128 KiB. Bound failures are unresolved. Authenticated API and credential-free
storage download remain separate. The maintained hosted transport grants only
`actions:read` to exact artifact/listing and Run-attempt GETs, with bounded
pagination. Only an artifact ZIP GET uses a manual authenticated redirect; its
returned location is downloaded credential-free by `artifactArchiveTransport`.
No Actions write permission or arbitrary authenticated redirect is introduced. Official upload calls that outlive timeout
retain temporary files until settlement, using the existing cleanup owner.

## Approved inputs before Shape

`loadApprovedInputs({source,approval,expected})` reuses `verifyApprovedSource`.
`source` fixes root, allowedRoot, repository and commit. Independent `expected`
fixes repository, commit, requirements `{revision,scopeHash}`, role and exact
paths. Trusted approval binds the same repository/commit/requirements, explicit
roles, visibility `public` and exact `{path,sha256}` files. No approval is inferred
from a file or a producer verdict. Ancestors/path components must not be symlinks;
unsafe paths, missing/changed bytes and stale requirements block before role
preparation. The API returns read-only reference data `{path,sha256,bytes}`, never
imports it as code. It does not disclose a new private source/configuration path.

`createCore` optionally takes protected `referenceInputs({role,scopeHash})`.
It must return the loader spec for the actual role; its requirement revision must
match independent `current().requirementRevision`. When authority requires inputs,
current state also supplies `referenceInputApproval` (the approved snapshot's
`contentIdentity`); this pins the exact approval in the decision and blocks an
omitted loader or substituted approval before role preparation. All bytes are checked before
`prepareRole` runs and are passed as `referenceInputs` to the trusted role
preparer, which mounts/copies them read-only with the role's existing isolation.
Current decisions are checked again after loading. Missing/stale bytes prevent
role launch. There is no requirement for a producer verdict or separate handoff
specification.

## Runtime and evidence boundary

Use Node 22/npm 10, authenticated provider read capability and the explicitly
prepared official `@actions/artifact@2.3.2` runtime matching the original source
Run/Attempt. No fallback filesystem/in-memory backend is selected. The caller
must supply the official-interface client/runtime via `publication`. Actual
pinned upload implementation is unchanged. Local provider and upload-interface
fixtures exercise public package, protected host and restart behavior. They are
not real Actions storage, provider E2E, independent Acceptance, CI or release
certification. E01/E03 own those later claims.
