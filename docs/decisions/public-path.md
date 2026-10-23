# Public-project credential boundary research

Finding: production public-path feasibility is **inconclusive**. Production
reliance is blocked. A persistent public Runner on which untrusted execution can
read login stores is unsafe under that condition; changing `runs-on` does not
supply an isolation boundary. This research closes no R-06 production support
claim. It supplies bounded negative evidence and implementable constraints for
planning N35 and N56, not resolved Issue identities or new dependencies.

## Reproduction and evidence

Use the N01 dependency-free layout, Node 22.23.3 and npm 10.9.9:

```sh
npm ci --offline
node --test test/public-path.test.mjs
node experiments/public-path/run.mjs
npm run build
npm run check
npm test
npm run experiment
npm run verify-package
```

Keep `out/public-path/evidence.json` in the candidate even if ignored. The harness
records baseline bf823fd3db1c63f1a99d65076a27d1d895400b6f, exact file SHA-256
identities, complete synthetic inputs, expected and observed results, environment,
assumptions and route blockers. File hashes are content references, not Core body
hashes. All 49 supplied baseline Git blob identities matched before editing.
There are no configured hooks in the supplied tree, package or bootstrap record.
No root configuration, lockfile, workflow or production interface is changed.

Fifty admission cases, five deduplication observations and 26 bounded probes
are reproduced by the focused tests. Tests independently pin required IDs,
negative/positive expectations and probe families; altered expectations fail,
missing families fail. Unexpected outcomes make the harness exit nonzero.
Temporary directories are random but removed and excluded from observations.
No timestamp or randomness enters case comparison. Environment platform/arch/Node
are intentionally variable across machines; compare them explicitly before
comparing cases. Source identities change when sources change.

Classification matters:

- Synthetic admission cases exercise normalized, stipulated trustworthy facts.
  They do not implement cryptographic verification, provider permission reads,
  durable admission or any production Core decision.
- Measured filesystem probes use fixed trusted subprocess code, empty environment
  and freshly created synthetic files. Unsafe controls can read each sentinel;
  Node's filesystem permission denies the same reads in protected controls. A
  public-file positive control demonstrates that the subprocess actually ran.
- Bounded evaluator probes treat hostile shell-like text as data and observe
  unavailable process/require/fetch globals. No shell or hostile checkout is run.
  This tests a restricted evaluator, not shell escaping or an arbitrary-code sandbox.
- Diagnostic projection retains status/code and drops synthetic private details.
  It does not prove every real provider error is safe to publish.
- Provider observations are empty. No actual GitHub event, isolated native Agent,
  network boundary, mount namespace, process namespace or live credential boundary
  was tested. The container denied `unshare --user --map-root-user --net true`
  with Operation not permitted; docker and bwrap were unavailable. These missing
  prerequisites are blockers to stronger isolation claims, not omitted passes.

The filesystem probes name agent/core login, member/instance, persisted state,
cache, artifact, workspace, process-store and mount-store synthetic files. The
last two are file-channel analogues, not real process/mount isolation. No actual
Agent/Core login path or host environment was read. Node permission controls and
VM contexts are insufficient for arbitrary hostile native code. No actual
credential or private proof is present in the artifact.

## Threat model and frozen-Scope coverage (AC1)

Adversaries include anonymous public contributors, fork/PR authors, malicious
external text providers, substituted workflow/action maintainers, artifact/cache
poisoners, replaying event senders and compromised or revoked member instances.
Trusted authorities are the signed Owner Grant/policy, Core's verified identity
observations, GitHub's authenticated current repository state and independently
captured stage/completion evidence. Public prose cannot become any of these.

| Boundary / assets and data flow | Exposure point and enforcement owner | Evidence / residual limitation |
| --- | --- | --- |
| Issues, comments, external text to planning/Agent input | Core/adapter passes data without shell generation; no role, executable ref or authority accepted from prose | hostile-text-as-data, payload-role/code; arbitrary shell integration untested |
| Fork/PR checkout to executable code | Operator pins trusted workflow/action/Core content before acquiring credentials; untrusted checkout only in disposable credential-free worker | fork-executable, changed-action/workflow; provider source enforcement unproven |
| Workflow/reusable Action changes to trusted stages | Source verifier binds repository ID, workflow path/content, immutable revision, ref, Run/Attempt and policy | wrong-source cases; path alone is insufficient; no live verifier implemented |
| Agent/Core login to worker | Adapter excludes login stores, inherited environment, mounts, process visibility and credential helpers; trusted Core retains local gh login outside Agent/reviewer/hooks | agent/core probes; native/process/network boundaries unproven |
| Member/environment/instance to neighboring state | Adapter isolates instance workspaces/Git identities and environment credential domains; same-environment Agent login sharing must not share privileged Core login | cross-member/instance and state probes; physical-host compromise untested |
| Cache/artifact/output to predecessor evidence | Immutable candidate custodian checks provenance, content and exact work cycle before parsing; never executes downloaded cache/artifact code | poisoned-cache/artifact, forged/missing/expired predecessor; model only |
| Resolve to GitHub receipt | Resolver plus all routing administrators enforce complete recipient-set trust continuously through queue/reassignment | runner-set decision/evidence; synthetic guard is not a GitHub capability; post-start check is too late |
| Native/Dispatch relay to next stage | Core source verifier separates source authentication, Grant/permissions, completion and deduplication | source/completion and sequence cases; no provider relay E2E |
| Dependency Webhook to affected downstream wake | Operator authenticates raw delivery; Core reads live native relations and valid upstream receipts; payload never writes edges | dependency cases/ping; receiver/subscription not selected |
| deployment_status to closure/health | Deployment verifier binds trusted result to Merge SHA, environment, version, Run/Attempt and health observations | deployment negative cases; no actual deployment proof |
| Recovery Comment/log to repair | Core verifies responsibility against immutable history and fresh repair Grant before safe public comment/read-back and actual Reopen | forged-comment/log/responsibility cases; text cannot assign blame or authorize repair |
| Diagnostics to public logs/comments | Runtime emits allowlisted operation/status/opaque request references; private response and credential-bearing paths remain protected | diagnostic-disclosure; real log redaction requires separate provider tests |

This covers each Scope bullet: public/fork/workflow/login mapping above;
isolation/source/revocation/replay and Resolve-to-Execute below; verifiable
constraints without old Public Dispatch; N01 tooling/evidence locations retained;
stage identities/token ingress/deployment/recovery included; N35/N56 handoff
below. GOV-05 preserves independent authority and gates, PUB-01/PUB-02 separate
untrusted execution from credentials, R-06 remains unproven. DELTA-03/04 cover
stage and recovery inputs; BOOT-02 uses shared bootstrap without a second root.
Proposal §§5, 6 R-06, 8.2, 17.1, 17.5 and C-15 retain these same boundaries.

## Candidate ingress contract for N35/N56 (AC3)

This is a research interface constraint, not a production receiver or a commitment
to a hosted service. Deployment operator remains an explicit, unresolved choice:
a project-approved GitHub App webhook deployment or another separately approved
verified event adapter could be evaluated. Do not use a fixed personal Controller,
a private polling receiver, author repository callback or legacy HMAC reevaluate
artifact. Event receipt is a wake hint only.

An ingress observation must carry stable repository/Issue identity, event/action,
Delivery ID, authenticated actor/installation, received validity interval, source
workflow path and immutable content/ref, Run/Attempt, prior result/receipt content
identity and semantic request/work-cycle identity. The trusted verifier obtains
these independently; a JSON field named authenticated is never production proof.
Validate GitHub webhook signature over original bytes using an operator-held
secret, then accepted event/action/source and current policy. Reject forged,
missing, expired or mismatched source and predecessor evidence before execution.
OIDC issuer/audience/signature/expiry and source claims need independent verification;
OIDC and local gh login prove neither stage success nor authorization.

| Responsibility | Least privilege / custody | Required behavior |
| --- | --- | --- |
| Ingress receiver | Webhook secret only in trusted receiver; no Agent login, Owner signing key or repository write token in payload/checkout | Authenticate raw bytes, limit size/schema, retain protected replay state; reject unknown source |
| Hosted Resolver | Separate short-lived scoped read identity; Issues/dependency/permission reads and Administration read for repository Runner list as required by endpoint | Unknown/denied reads block; never treat 403 as empty/offline; org visibility needs separate authority |
| Trusted relay | Only required workflow Dispatch permission for selected destination; no user-selected repository/workflow/ref | Dispatch fixed content with opaque request identity after persisted verified predecessor evidence |
| Core writer | Fresh operation-specific repository permissions intersected with signed Grant and all Core gates; local gh identity stays outside Agent | Labels/comments/closure and merge require distinct policy-approved operations; login alone never permits them |
| Deployment observer | Deployment/status/Actions read permissions for specific environment; no release-write permission needed by this research | Verify exact Merge/environment/version/Run/Attempt and required health proof |
| Public diagnostic publisher | Only authorized Issue comment operation after private evidence captured | Allowlist safe reference fields, never raw provider response or login data |

Exact endpoint/token permission compatibility is not experimentally verified here.
Production must verify endpoint-specific rights and deny missing capabilities;
this table grants no new permission. Signature custody, durable store and routing
controls require separately authorized implementation and estimation.

Replay storage must durably and atomically bind Delivery ID and semantic
repository/Issue/work-cycle/stage decision across native and approved Dispatch
notifications. Both sides of a dependency notification deduplicate to the same
actual downstream relation/version; current relations determine affected Issues.
The model uses an in-memory semantic key only and cannot prove crash safety.
Unauthenticated inputs cannot poison its dedup set. Ping observes the channel
without dispatch. Missing subscription blocks unless a previously approved,
verified compensation wake exists; compensation re-reads live dependencies,
all upstream receipts, Grant and existing intents. No periodic private polling.
Do not infer a new request from an unknown Dispatch result: preserve the original
intent and reconcile independently before any resend.

Same-workflow `needs` can supply the fixed workflow's non-bypassed successful job
ordering. The model admits that control separately; cross-Run `needs` rejects.
Cross-Run success needs authenticated persisted complete results, not partial
logs, OIDC, local login or a transient Jobs API status. Conflicting queued/log
observations require approved sufficient-evidence policy, bounded re-read or
blocking; this research adds no universal immediate Jobs API success gate.
Candidate/Hooks, independent Accept, exact-head CI, Final Review, conditional
Merge and completion proofs remain mandatory and unaffected.

## Events, deployment and revocation (AC4)

Documentation retrieved 2026-10-23, classified as documented, not provider-observed:
[GitHub workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
describes suppression of most events created by GITHUB_TOKEN, with Dispatch
exceptions. Thus native scope/shaped label changes, closed and reopened Issue
events written with that token cannot be assumed to start the next Run. An
appropriately scoped App identity is a candidate for native relay, pending actual
provider tests. Approved equivalent workflow/repository Dispatch is a distinct
path; it still requires the real label/Close/Reopen write and read-back. Neither
path was tested here. No native support or equivalent Dispatch E2E is claimed.

[GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use)
informs injection, untrusted checkout and secret handling constraints. Our route
conclusions are engineering inferences plus local bounded evidence, not a GitHub
certification. Provider behavior claims need separately authorized real runs.

Deployment status cannot itself assign responsibility or unlock downstream work.
Check source authenticity, exact merged commit, version/environment, Run/Attempt,
fresh health and functional proof. Spoofed status, wrong identities and stale
health block in the model. A Recovery Comment/log reference alone is public text:
verify immutable Actions evidence and responsible Issue history first. Failure
before Close keeps the Issue Open; after Close requires safe Comment/read-back,
actual Reopen and a fresh authorized repair cycle. Unknown effects remain blocked.
A repair exception covers only the confirmed responsible failure's health gate,
never other dependencies or authorization/validation gates.

Revoke before dispatch: deny admission. Revoke while queued: do not assume GitHub
removes the job; withhold protected data and reconcile actual receipt/effects.
Revoke during execution: deny every subsequent privileged stage, safely stop and
verify old writer termination and effects before any handoff. Three revocation
cases demonstrate the normalized policy predicate, not live token revocation.
Refer to `docs/decisions/runner-set.md` and `out/runner-set/evidence.json` for
busy/offline whole-set inclusion and mutations through queued receipt/reassignment.
No secure path is established by checking a single online instance or validating
only after the job has received protected data.

## Handoff, rejected routes and public audit (AC5–AC6)

Rejected: persistent credential-bearing public execution; runs-on-only changes;
untrusted checkout in a privileged workflow; payload-selected role/code;
unauthenticated predecessor/cache use; post-start-only trust; private polling or
fixed personal Controller; unapproved hosted-service commitment. These are not
made safe by stronger labels, successful login or green UI.

Potential credential-free ephemeral workers and trusted-ingress/isolated-member
execution remain inconclusive. Missing capabilities are actual provider source
and token-trigger observations, approved ingress deployment/custody, durable
replay/intents, complete current permission visibility, whole-set pre-receipt
protection, native-code/environment/process/mount/network isolation and verified
deployment/recovery proof. Every proposed route in the artifact blocks production
reliance; none is advertised as supported.

N35 must consume the boundary map and require measured credential isolation,
whole-set receipt protection and explicit deployment/operator policy before
public support. N56 must verify source/event/token identities, independent Run
receipts, webhook authenticity/dual-side dedup, compensation and unknown-effect
reconciliation. Both need real native and approved Dispatch evidence classified
separately. Production receiver/verifiers, distributed storage, isolation adapter,
relay and recovery implementation require separately scoped maintained code and
estimates; this research provides no hidden production implementation.

Audit: reviewed the maintained README, docs, examples, source instructions,
workflow descriptions, package metadata and synthetic fixture/output text in
this owning checkout for English consistency. No non-English maintained prose
was found requiring correction. Synthetic sentinels are invented, not private
proof. Remote repository description, hosted website/releases and other two
repositories were inaccessible in this supplied checkout and were not audited.
No production release, deployment, public-path support, Acceptance or CI success
is claimed. Core must capture this candidate and obtain independent Acceptance.
