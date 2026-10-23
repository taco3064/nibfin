# Runner-set feasibility research

## Decision and evidence boundary

Finding: **inconclusive for production safe dispatch**. The deterministic model
supports the required selection semantics and refutes snapshot-only and
post-start-only protection within its stated adversary model. It does not prove
GitHub enforcement. Dependent implementation must remain blocked from treating
these proposed interfaces as a proven safe dispatch solution. This is bounded
research, not a production Resolver, registration service or recovery engine.
Research closure is neither execution authority nor a feasibility certificate.

No authenticated provider experiment, private provider response, real attack,
workflow run, receipt observation or cross-repository implementation was supplied
or inspected. No controller credentials are required or requested. A positive
finding would require separately authorized safe resources and protected proof
storage. No deployment or release is part of this research.

## Reproduction and revision

Use Node 22.23.3 and npm 10.9.9, the dependency-free N01 root workflow:

```sh
npm ci --offline
node experiments/runner-set/run.mjs
npm run build
npm run check
npm test
npm run experiment
npm run verify-package
```

Tests also execute the research command so the existing clean-checkout test
entry point needs no root configuration change. They compare the generated
artifact against current sources and expectations. The command deterministically replaces
`out/runner-set/evidence.json`; no timestamp, network or credentials are used.
Keep that file in the candidate even if an external ignore rule excludes it.
The shared sample experiment still disposes its separate temporary output.

Experiment revision is `runner-set-model-v1`; exact source SHA-256 references
(including fixtures, tests and this record) are embedded in the evidence file.
These are file-content references, not Core body hashes or immutable Acceptance.
Investigation reference: `1e617281842cb484a140e45ebed2fcac654bc7b9`.
Original implementation base: `3c9ef4bad510f94b415a09ddd987855057bfbaf2`.
Current integration base: `0ed433a11a2a72091e2152f165fe578092e75461`.
The original 38 baseline blobs matched before implementation. On base repair,
all 49 supplied restored-candidate blobs matched before editing; restoration
reported no conflicts or implementation findings. The newer base adds separate
offline registration-exchange research and its README description. Those
synthetic exchange tests do not establish Runner-set closure or live registration
authority. Existing bounded authorization and Agent interfaces still provide
no complete routing or change-control enforcement. Base advancement requires
fresh candidate evidence and independent Acceptance; old evidence is not reused
as permission.
Root scripts, locks, workflows and production exports are untouched.

Inputs live in `test/fixtures/runner-set/cases.mjs`: every inventory ID identifies
its input and explicit expected status/member/recipient IDs. Trace IDs combine
an attack ID and protection mode. The artifact retains expected results,
observations, phases, assumptions, harmless markers, revision and environment
references. Tests pin the required inventory independently and compare the
artifact with a fresh run. A synthetic `candidate` means a clean snapshot only;
it never authorizes dispatch. The fixtures' `complete`, `fresh`, `binding`,
`permission`, `authorized` and `isolated` fields are stipulated normalized facts,
not claims accepted from a caller or a raw GitHub response.

## Documentation and permission/visibility assessment (AC1)

Public documentation retrieved 2026-10-23; API examples use version 2026-03-10.
These are documented requirements, not measured token behavior.

| Read surface | Trusted identity and minimum fine-grained permission | Visibility obligation |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/actions/runners` | Scoped App installation/user token or fine-grained PAT; repository Administration read | Enumerate repository runners; do not infer all inherited organizational access from this list alone |
| `GET /orgs/{org}/actions/runners` | Independently authorized organization identity; Self-hosted runners read | Include shared instances and registration IDs |
| `GET /orgs/{org}/actions/runner-groups` | Organization Self-hosted runners read | Include inherited groups and effective routing policy |
| `GET /orgs/{org}/actions/runner-groups/{runner_group_id}/runners` | Organization Self-hosted runners read | Join group membership to stable Runner IDs |
| `GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories` | Organization Self-hosted runners read | Resolve selected repository access plus group visibility and inherited restrictions |

The [Runner REST reference](https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2026-03-10)
is the endpoint permission source. List pagination defaults to 30, maximum 100;
request every page without name filtering and reconcile total counts and stable
IDs. Classic token/admin requirements differ from fine-grained permissions.

The [group REST reference](https://docs.github.com/en/rest/actions/self-hosted-runner-groups?apiVersion=2026-03-10)
is the source for group permissions, inheritance, repository visibility and
workflow restrictions. Group and group-runner enumeration are paginated;
selected-repository enumeration must also be completed according to the actual
response links. A selected list alone is insufficient for all/private visibility.
Inherited enterprise restrictions require their authoritative owner; inaccessible
policy is unknown. A repository token cannot be presumed to see organization or
enterprise controls. No single cross-endpoint atomic snapshot is established.

The model checks normalized pagination consistency, denied reads (401/403/404),
rate limit/server failures, missing pages, duplicate IDs, malformed pages/records
and stale/incomplete visibility. All return unknown without fallback. Repository
access IDs must be positive safe integers before any selector filtering; null,
string, zero, negative, fractional, unsafe, mixed and sparse ID arrays have
explicit negative controls. An earlier model checked only the array container
and incorrectly treated malformed access IDs as a definite mismatch, permitting
fallback. The repair rejects the entire malformed observation before ranking,
including an array containing both the target ID and an invalid element. Empty is
usable only after trusted completeness is established; it produces waiting.
Concurrent mutations can defeat total-count agreement: matching counts are
necessary, never sufficient proof of a stable complete view.

The [routing reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
describes label/group matching, queueing when no idle matching runner is
available, requeue after 60 seconds of nonreceipt, and failure after 24 hours
queued. Hence trust must include currently busy/offline matching instances and
survive reassignment. It supplies no proof here of atomic enumeration-to-receipt
closure. The model's phase ordering is synthetic, not measured provider timing.

Member permission and bindings are independent trusted inputs: a Runner list
cannot establish User ID ownership, current Write/Maintain/Admin membership,
Owner Grant or credential isolation. No live permission endpoint was invoked;
production membership verification and its least-privilege API choice remain
separately scoped. Lost access, Read/Triage and unknown binding deny eligibility.

### Trusted execution source and credentials

A proposed hosted reader must execute reviewed fixed workflow content at a
verified immutable revision in a trusted context. Untrusted Issue text, workflow
refs, pull-request code, reusable workflow replacements and interpolated shell
inputs must never select its code or token destination. Malicious workflow code
can steal a perfectly scoped read credential or falsify enumeration. Binding
workflow path alone is insufficient if its ref can change. Group workflow
restrictions narrow source access but do not prove Runner/member trust or freeze
mutable labels, access or bindings. Source restrictions need their own provider
proof; none is claimed.

Use short-lived least-privilege hosted identity; never expose administration or
organization credentials to checkout code, model scripts or selected Runners.
This research uses no credential path at all. OIDC/source identity, successful
login, API permission, valid Grant and stage success remain distinct evidence.
The current version-4 invocation and protected role interfaces in
`docs/interfaces.md` are consumed as boundary documentation only. This research
exports no production API, modifies no Action/CLI repository and duplicates no
Core authorization/state machine.

## Full-set and race experiments (AC2–AC3)

Thirty-eight inventory cases distinguish recipients from online availability. They
include a positive multi-instance control across pages, online/busy/offline
contamination, missing or old-ID binding, wrong member, missing isolation,
Read/Triage/lost access, wrong OS/label/group/repository, offline fallback,
busy first-rank retention, all offline, empty complete and visibility failures.
The first supplied rank with eligible online instances wins even when all are
busy. A contaminated rank blocks rather than falling through. A trusted offline
first rank can fall back before dispatch; no queued-job member fallback exists.
Assignee order is supplied, never reconstructed or invented here.

Seven attack inputs cover registration after inspection, relabel while queued,
group expansion before receipt, repository-access expansion while queued,
binding revocation before receipt, member downgrade while queued and new
registration after nonreceipt/requeue. Existing unrelated candidates start
outside the selector; expansion brings them inside. All use synthetic stable
repository 101, members 11/22, group 7 and Runner IDs 1/2/3.

Each attack runs five controls (35 traces):

| Protection mode | Expected observation | Interpretation |
| --- | --- | --- |
| Snapshot | Untrusted receipt of harmless marker | Inspection can become stale |
| Post-start | Same receipt, then failed first-step check | Exposure precedes the check |
| Closed range, enforced | Mutation denied; no untrusted receipt | Conditional model control only |
| Closed range, unverified | No dispatch | Missing enforcement fails closed |
| Closed range, bypassed | Untrusted receipt | A privileged bypass defeats the assumption |

Earliest modeled exposure is job receipt before any first step. Marker
`HARMLESS-MODEL-DATA` represents payload delivery, not actual secrets or observed
GitHub credential placement. The closed-range model rejects mutations through a
stipulated guard; it is not evidence GitHub provides such a guard. Attacker code
on an already trusted machine can violate isolation independently; the model
assumes isolation facts are trustworthy and tests missing isolation separately.

## Proposed protection interfaces and enforcement requirements (AC4)

These are interface specifications for future separately scoped work, not
implemented APIs or a new hosted-service commitment.

| Interface | Inputs and trusted authority | Output / failure state | Enforcement owner and lifetime |
| --- | --- | --- | --- |
| Complete recipient observation | Stable Repo ID, member order, all labels/OS/group/access; independently authenticated repository, org and inherited policy reads, Runner ID bindings and current eligibility evidence | Complete versioned set with per-instance proof or unknown/deny; no permission failure becomes empty | Trusted Resolver obtains fresh complete reads; snapshot expires on relevant change and cannot alone permit receipt |
| Closed routing range | Observation plus independently verified constraints on registration, relabeling, group/access, binding, eligibility and workflow changes | Lease/equivalent proof tied to selector, Repo/member/Runner IDs and policy version, or deny | All repository/org/enterprise administrators and binding/eligibility authorities must enforce closure from inspection through queue, nonreceipt requeue and final receipt; extend or deny on expiry |
| Protected-data admission | Exact job/source revision, authorized operation, valid Grant, range proof and receiving-instance trust/isolation | Release protected data only inside proven trusted receipt boundary; unknown proof denies before dispatch | Trusted Core/source and any data custodian; applies before initial payload availability and every privileged stage, including reassignment |
| Receipt/recovery observation | Job and Run/Attempt, selector/config revision, receiving Runner ID, prior intent and immutable source/range evidence | Confirmed receipt/effects, confirmed no effects, or unresolved | Trusted independent observer retains evidence through reconciliation; never infer no effects from timeout |

A closed range might use administratively enforced change constraints or an
equivalent provider capability. Repository/org/enterprise admins able to bypass
those constraints, compromised registration administrators, binding issuers or
membership authorities defeat it. Every relevant authority must participate;
a local lock, random label or a group name cannot constrain all these writers.
Queued jobs require continuous coverage, not a lease ending after dispatch.
The model tests enforcement enabled, unverified and privileged bypass for every
attack. No external assumption in this interface has been provider-proven here.

Delayed data admission is another possible design, but a post-start credential
broker cannot undo job payload exposure or protect Agent credentials already on
an untrusted Runner. A positive design would first prove that all pre-admission
job data is safe, authenticate the recipient independently and enforce isolation
and revocation across every authority. This research neither implements nor
claims that service. First-step checks, cancellation after assignment, repeated
list inspection and random labels are insufficient under the modeled adversary.

| Obligation | Finding and evidence | Remaining boundary |
| --- | --- | --- |
| R-03 | Supported in synthetic selection tests: platform, offline fallback, busy rank, unknown visibility refusal; documented endpoint permissions | Actual hosted least-privilege visibility and token containment unmeasured |
| R-04 | Snapshot/post-start protection infeasible under allowed modeled changes; revocation and downgrade receipt traces exhibit exposure | Enforceable pre-receipt control and safe effects reconciliation inconclusive |
| R-05 | Supported model requirement: all matching instances trusted including offline/busy; all seven attacks defeat unguarded snapshots | Actual full-set closure through provider receipt/reassignment inconclusive |

Positive feasibility requires authoritative support for every enforced constraint
and authorized provider evidence: exact workflow content/revision, Run/Attempt,
source identity, routing/group/access configuration, controlled changes and
actual receipt observations. None exists in this candidate. Provider proof must
use authorized access-controlled storage when private; only a safe conclusion
may be public. Production enforcement, complete enumeration adapters and
receipt verification need separately scoped implementation. No Issues or native
dependencies are created or changed by this finding.

## Recovery, integration and disclosure (AC5–AC6)

Inspection failure or stale evidence blocks dispatch and any inference of
offline fallback. Revocation while queued cannot erase a possibly delivered job;
stop new privileged transitions, establish actual receipt and reconcile effects.
Running work also requires fresh authorization at each protected boundary.
Unknown receipt, canceled jobs, failed transport or lost write responses retain
their original intent and require independent read-back, not speculative retry,
automatic member reassignment or duplicate execution. A later legal event may
start a fresh authorized assessment; events do not grant authority. Preserve
independent Actions Run handoff, isolation, Candidate/Hooks, independent Accept,
exact-head CI, Final Review, merge, deployment and completion gates. No recovery
engine, private polling controller, fixed Runner architecture or second Core is
introduced. `candidate` in the model is never a lifecycle decision.

English/disclosure audit coverage: README.md, LICENSE, all maintained docs under
`docs/`, public examples, experiment messages and source instruction documents
under `src/instructions/`; existing public prose was English. New fixtures,
diagnostics, tests and this record are English and contain invented identities.
Protected repository infrastructure was inspected for identity/hook inventory
only and was not copied into public evidence. No private sources, operational
controller identities, logs, tokens or responses appear in research deliverables.
No adjacent repository was accessed or modified. There are no configured hook
sources or hook dependencies in the complete supplied inventory, package or
bootstrap record; Core still performs applicable hook handling independently.

Acceptance mapping: AC1 permission/source matrix and visibility cases; AC2
38-case inventory; AC3 35 receipt traces; AC4 interface table and explicitly
inconclusive provider finding; AC5 deterministic artifact plus shared commands;
AC6 owning-checkout English/disclosure audit. Test results establish model and
local integration behavior only, never independent Acceptance or actual CI.
