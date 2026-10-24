# Version 1 result and evidence contracts

Import these pure functions from `@nibfin/core`. They perform no I/O, lookup,
authentication, authorization, scheduling or repair. Ordinary JSON data is required;
never supply executable objects/proxies. Rejection throws TypeError with a fixed
`evidence:` diagnostic (or a JSON/serialization/ID error). No rejected value becomes
a success envelope. Callers must catch rejection and stop the dependent transition.
These helpers do not replace any independent reviewer, credential-free offline
hook, live permission, native dependency, CI, protected merge or completion gate.

`protectedSkills` is exactly shape/deliver/accept. `skillForRole(role)` maps shape,
shape-validator, shape-diagnosis and shaper-review to shape, deliver to deliver,
and accept to accept. scope is pre-delivery, never a protected runtime identity.
Customization default/extend/override changes instructions only; there is no
customizable identity, outcome or independence table.

`outcomesForRole(role)` returns the role's success followed by changes_required,
blocked, decision_required and proposal_update_required. Success is ready for
shape/deliver, approved for shape-validator/shape-diagnosis/shaper-review, and
accepted for accept. Success means only that role's reported result, never
permission, completed delivery or approval of its own work.

## Result body

`parseStageResult(objectOrJSONString)` returns a detached parsed result. Exactly
these fields are required: `{version:1, outcome, failureClass, summary, conflicts}`.
Summary is a nonempty control-free string. failureClass is none,
implementation_defect, shape_defect, authority_gap or external_failure. Only success
outcomes use none; changes_required requires implementation_defect or shape_defect;
decision_required/proposal_update_required require authority_gap. blocked accepts
any non-none class. Unknown fields (including authorized), versions and outcomes
reject. No repository, source or role claims belong in this body.

conflicts is an array, empty except for shape_defect, which requires at least one
`{scopeHash, shapeHash, scopeQuote, shapeQuote, evidenceReference}`. Hashes are
lowercase SHA-256; quotes/references are nonempty strings. A conflict is a report,
not permission to invalidate a Shape or recover Scope.

`validateStageResult(result, context)` additionally checks the trusted context's
execution/role/Skill and binding schemas and role outcome. For shape_defect it
requires context.scopeBody and context.shapeBody, checks their body digests against
binding's separate hashes, checks each conflict's hashes, and requires exact quote
substrings. Repeated implementation failures provide no conflict proof.

## Core evidence envelope

`createEvidence({expected, consumed})` returns a detached validated expected
envelope. `compareEvidence(receipt, {expected, consumed})` validates both and requires
exact canonical equality. Core must independently construct expected using fresh
trusted observations, successful upstream results and current policy, never by
copying receipt claims. consumed is an explicit array of already consumed result
IDs from Core's durable context; a matching result ID rejects. These functions do
not maintain durable replay storage, authenticate an Actions source or guarantee
exactly-once writes. Missing current context fails; there is no age/cache fallback.

Every envelope is exactly `{version:1, stage, binding, execution, inputs, result}`.
All fields are required; unsupported fields reject. binding is exactly:

- authority, grant, policy, core, runtime, instructions: immutable SHA-256 content
  identities of the approved snapshots, including effective Skill instruction text.
- repositoryId: canonical positive decimal string (never a JS number); issueId:
  exact nonempty control-free GitHub node ID string. IDs are never coerced.
- scopeHash: original frozen body digest; shapeHash: separately published body
  digest, nullable only for shape. No source signature is implied by these hashes.

execution is exactly `{role, skill, id, request, result, source}`. The first two
use the fixed mapping; id/request/result are exact nonempty control-free strings
assigned by Core. id identifies an execution, not its conversation or role label.
source is null for explicitly local executions, otherwise exactly
`{repositoryId, workflow, runId, attempt}` with canonical decimal strings and
workflow's immutable SHA-256 content identity. Core decides whether a source Run
is applicable; it must not turn an applicable Actions source into null. Expected
request, result, execution and attempt are all compared to reject foreign/replayed
results. Binding source is distinct from proving source authentication or success.

For role stages, execution.role must equal stage and result is a successful parsed
result body. For Core-produced non-role receipts result is exactly null; execution
records the responsible protected execution, not a new protected Skill or role.
Failure results are validated/classified with validateStageResult instead of being
accepted into a successful stage receipt. Shape-defect confirmation still requires
Core's independent diagnosis and permission gates.

### Stage applicability

inputs has exactly the fields below; `stageApplicability` exports the same table.
All hash references below are contentIdentity of the complete upstream envelope.
Readbacks, checks, validation and receipt are SHA-256 content identities of complete
Core-chosen evidence records; their underlying provider truth is verified by Core.

| stage | exact input fields |
| --- | --- |
| shape | body |
| shape-validator | body, author |
| shape-diagnosis | body |
| publication | body, author, validator, validation, readback |
| deliver | publication, candidate |
| pre-accept-hooks | candidate, phase=`pre-accept`, receipt |
| accept | candidate, hooks, deliver |
| pre-commit-hooks | candidate, phase=`pre-commit`, accept, receipt |
| pr | candidate, accept, hooks, head, base, readback |
| ci | pr, head, base, policy, checks |
| shaper-review | candidate, pr, ci, head, base, author, validator, deliver, accept |
| merge | review, head, base, commit, readback |
| final | merge, commit, postMerge, deployment |
| closure | final, commit, state=`completed`, readback |
| delivered | closure, commit, readback |

body is a body digest; validator/diagnosis/publication body must equal shapeHash.
author/validator/deliver/accept in independence positions are execution IDs; other
accept references are receipt hashes. Validator must differ from Author, publication
must record distinct Author/Validator, Accept must differ from Deliver, and Final
Review must differ from all four. A role-name edit cannot bypass stage-role checks.
head/base/commit/tree are lowercase Git SHA-1 (40 hex) or SHA-256 (64 hex) object IDs,
never body/file digests. Consuming repository policy determines its Git object format.

candidate is exactly `{base, tree, diff, paths, artifacts, hooks, emptyHooksReason}`.
diff is SHA-256 of binary diff bytes; paths is an ordered unique array of safe
relative paths. artifacts is an array of `{path,digest}` including mandatory ignored
files. hooks is an array of `{path,event,digest}` of exact source bytes, event one of
pre-commit/prepare-commit-msg/commit-msg. Duplicate artifact paths or hook path/event
pairs reject. emptyHooksReason is a nonempty reason when hooks is empty, null
otherwise. Empty artifacts/paths are representable; the trusted expected inventory
must enforce Issue applicability. Paths reject escapes, absolute paths, backslashes,
empty/dot components and wildcards. Filesystem symlink and actual-byte inspection
remain Core Candidate responsibilities; byteDigest hashes inspected byte content.

postMerge/deployment are exactly `{mode, identities, reason}`. required uses a
nonempty unique SHA-256 array and null reason; not-applicable requires an empty
array and nonempty policy-established reason. Core's current expected proof policy
must require the actual Issue obligations. There is no default not-applicable.

## Completion and freshness

`createCompletion({version:1, receipts}, current)` validates all 12 receipts from
publication through delivered (the corresponding table rows, including both hook
phases). current has exactly those stage keys, each `{expected,consumed}`. It checks
shared authority/grant/policy/Core/runtime, repository/Issue and Scope/Shape
bindings, upstream references, identical full candidates, execution identities,
head/base correspondence, candidate base, CI policy, and merge-commit correspondence
through final proofs, closure and delivered readback. Instruction digests are
stage-specific: each remains checked against its trusted current expected receipt
and included in upstream hashes and completion identity; different Skills need not
share instruction text. Author/Validator validation
and provider truth underlying publication are independently established by Core's
expected publication/validation identity, not inferred from a hash alone.

Returns `{version:1,payload,identity}`. The first payload requires delivered readback,
not an existing completion receipt. `verifyCompletion(receipt,current)` reconstructs
and compares an existing receipt. There is no circular hash prerequisite. A changed
policy, instruction, Scope/Shape, attempt, artifact, hook, candidate, head or proof
requires new dependent evidence. Labels, closed state and aggregate COMPLETE never
satisfy the schema. Initial delivered publication must still follow Core's gates.

## Compatibility envelope

`validateCompatibility(value)` returns a detached v1 envelope;
`compareCompatibility(receipt,expected)` validates both and requires exact equality.
Every field is required, no extensions: version, content, agent, host, guest,
authentication, isolation, runner, visibility, ownership, capability, status,
evidence, limitations. content has core/action/workflow/cli SHA-256 identities and
skills with exactly shape/deliver/accept SHA-256 identities. agent is `{name,version}`;
version may explicitly be `unknown`. host/guest are each `{os,architecture}`.
authentication/isolation/capability are nonempty explicit strings. runner is
`{registration:'repository'|'organization', automatic:boolean}`. ownership is
personal/organization, independently of registration/automatic. visibility is
public/private; private can only be Unsupported.

status is Implemented/Unverified/Unsupported/Supported. evidence is a nonempty
unique array of `{kind,location,digest}`, kind research/source-tested/real-execution/
product-e2e; location is a nonempty locator and digest a SHA-256 content identity.
limitations is a unique string array, nonempty for Unverified/Unsupported.
Implemented requires source-tested evidence; Supported requires known Agent version
and real-execution or product-e2e evidence for the stated capability. Matching an
Unverified/Unsupported envelope preserves that classification. These primitives do
not inspect evidence locations or certify support: Core must establish genuine
provenance, adequate capability coverage and immutable expected content. Local
synthetic fixtures exercise Supported structure without claiming real execution.

## Serialization and vectors

bodyDigest hashes UTF-8 JSON.stringify(string), including JSON quotes/escapes.
byteDigest(Uint8Array) hashes exact bytes. Git blob IDs hash Git's blob header plus
bytes using the repository's object algorithm. None is interchangeable or a signature.
contentIdentity hashes UTF-8 `nibfin-content-v1\n` followed by canonicalJSON(value)
(sorted object keys, ordered arrays, strict JSON; see package.md).
Completion identity uses contentIdentity({kind:'nibfin-completion-v1',payload});
the identity field is outside payload. Version 1 never hashes its own identity.

Body vectors (inputs below use actual newline characters):

- `Hello\n世界`: e25356b0e259cd559cbbe5495f10b8eb613890dd47e20afbb9d2a105c3531bf7
- `"quoted"\n魚`: 25c8e296ea1d5da1c922ab22d824b23fbb8ce43be2d35212914e02e3bf9474dd

The fully specified chain() fixture in test/evidence.test.mjs reconstructs completion
vector a76b345ed708643afca57b0cf0bb57c5bb8da951309c78f3917183778f3cd96d.
Tests mutate each bound leaf independently and distinguish body, byte and envelope
hash domains. Tests are local contract proof, never GitHub/model/platform E2E.

```js
import {parseStageResult, validateStageResult, compareEvidence} from '@nibfin/core';
const parsed = parseStageResult(agentOutput); // syntax/classification only
validateStageResult(parsed, trustedRoleContext); // fixed role/conflict checks
const evidence = compareEvidence(persistedReceipt, freshCoreContext);
// Neither return value authorizes a write. Core still enforces all live gates.
```

## Actions source verification (local module contract)

`createActionsVerifier()` exposes `authenticate(token, expected, jobObservation)` and
`predecessor({source, receipt, current, now, maxAge, recordedAt, consumerExecution})`.
Imports are inert. Neither method acquires tokens, checks local login, authorizes a
stage or writes anything. An authenticated source is not a success receipt.

Production uses only `https://token.actions.githubusercontent.com`, discovery at
`/.well-known/openid-configuration`, and keys at `/.well-known/jwks`. `jose` performs
RS256 signature and required JWT claim verification. Token key URLs, embedded keys,
redirects, alternate issuers and algorithms are rejected. Discovery must advertise
that exact issuer, key endpoint and RS256. Each verifier has a lifetime budget of
three HTTP requests: discovery, initial keys, and at most one unknown-key refresh.
Create a fresh verifier at a new trusted checkpoint; this is not a permanent key
cache. Requests default to five seconds (maximum thirty), responses to 256 KiB,
key sets to 32 keys, tokens to 32 KiB. Transport injection is a trusted HTTP
capability, responsible for truthful URL/status/body observations, not token data.
The default transport uses no credentials, rejects redirects and bounds streaming.

Trusted Core constructs `expected` independently from current authorized policy
and official observations, never by decoding a token, copying a receipt, or trusting
Agent output. Required claim expectations are `repository_id`,
`repository_owner_id`, `actor_id`, `run_id`, `run_attempt`, `workflow_ref`,
`workflow_sha`, `ref`, `event_name`, `repository_visibility` (`public`) and `audience`.
IDs are canonical positive decimal strings without Number conversion. Workflow ref
contains the caller repository/path/reference; workflow SHA is its immutable Git
revision. `workflowDigest` is the independently pinned 64-character content digest
used by existing v1 evidence `execution.source.workflow`; Core must resolve that
digest and SHA to the same approved workflow bytes. Ownership may be personal or
organization; it does not select a Runner registration level.

`reusable` and `job` each explicitly select `required` or `not-applicable`.
Reusable execution requires separate `job_workflow_ref` and `job_workflow_sha`
expectations; unexpected reusable claims fail closed. Required job association
requires `check_run_id`, `jobId`, `runner_environment`, and `runner` applicability.
The independent official `jobObservation` must match repository/run/attempt/check
and job IDs, plus `runnerId` when `runner: required`. A signed runner environment
is not physical Runner identity. Missing observations never make a gate optional.
Core owns the authenticity and freshness of these observations.

`now` is trusted epoch seconds; `maxAge` is an integer from 1–3600 seconds and
`tolerance` an integer from 0–60 seconds, both mandatory. Issued-at age and future
issuance, expiration and not-before are checked; `sub`, `jti`, `iat`, `nbf`, `exp`
are required. Tolerance permits the stated clock skew, including the max-age
boundary. Tokens cannot have expiration before issuance or not-before after
expiration. All rejected sources return only `source-rejected`, never tokens,
claims, key material, provider response bodies or exception text.

The explicit `createSyntheticActionsVerifierForTest(jwks)` facility uses local
synthetic keys and marks authenticated results `synthetic: true`. It is for retained
cryptographic tests only; production callers must never select it or accept its
results as production proof. Each verifier privately recognizes only its own
successful authentication objects; copying `{ok:true}` cannot manufacture one.

`predecessor` requires that recognized source, a complete durable v1 envelope,
Core's independently constructed `{expected, consumed}` context, finite receipt
freshness, and an independent consumer execution. It delegates all complete schema,
result, stage inputs, Candidate/artifacts/hooks, upstream references and exact
comparison to `compareEvidence`, preserving v1 hash domains. The envelope source
must match authenticated repository, workflow digest, run and attempt. Failed,
missing or incomplete evidence never becomes success. `recordedAt` is an
independently verified durable publication time, not a timestamp supplied by the
receipt author; it must fall within token validity and current receipt freshness.
Core must persist consumed result IDs atomically with its controlled continuation,
revalidate current expectations and authorization, and preserve role independence.
The helper does not persist replay state or confer write permission. Arbitrary
self-derived expectations are unsupported and cannot replace trusted Core inputs.

`verifyNativeNeeds({expected, dependency, jobsObservation})` establishes only the
local success prerequisite. Trusted fixed-workflow analysis supplies exact
repository/workflow/run/attempt/predecessor-job/consumer-job identities and
`fixedWorkflow: true`, `unweakened: true`. It must verify actual native `needs`
and absence of continuation after failure/cancellation/skip, not accept these
booleans from workflow output. The trusted dependency observation must report
`result: success`. This relation cannot bridge Runs or Attempts. A lagging
queued/null Jobs response with matching identity does not override that trusted
native prerequisite. Completed failure or any identity contradiction returns
`waiting-or-blocked`; partial logs never prove success or nonexecution. Callers may
perform bounded independent rereads under their policy; there is no implicit retry
or universal immediate Jobs-completion requirement. Stronger exact-head CI,
review, merge and completion gates remain separate and mandatory.

Retained tests demonstrate local cryptography, official-shape transport fixtures
and installed package consumption only. No live Actions/OIDC acquisition, hosted
fixture account, deployment or `actions-source-proof.json` is claimed or required
here. #121 owns live Actions/OIDC/predecessor integration; #123 owns actual rerun,
attempt separation and rejection/recovery scenarios.
