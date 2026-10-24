# Deployment verification

Import the deployment APIs from `@nibfin/core`. These are bounded local contracts,
not a deployment service or a permission boundary. Core supplies independently
verified policy, expected merge and provider identity, latest baseline inventory,
incident classification and verified Owner authorization. Never deserialize these
trusted inputs from an Issue, provider payload or an agent result. Hashes bind
content; they do not authenticate observations. #123 owns actual live readback,
incident attribution, Recovery Comment/Reopen integration and deployment E2E.

`verifyDeployment({policy, observation, health, now})` returns `qualified`,
`not-applicable`, or `blocked` with a public-safe reason. `now` defaults to
Date.now and returns integer milliseconds. Missing policy fails closed.
Not-applicable policy has exactly `{mode:'not-applicable', reason:'...'}`.
Required policy has mode, reason, repositoryId, commit (40/64 hex), version,
environment, deploymentId, statusId, baseline, source, maxAgeMs, checks.
Source has repositoryId, workflow, runId, attempt. IDs are strings. Commit is the
actual merged commit. Workflow identifies the trusted workflow path/content
revision selected by the caller's source policy, not an arbitrary workflow name.
The caller must authenticate this source against its pinned workflow content.
Observation carries matching identities/source, state and observedAt. Only
state `success` qualifies. A workflow result or release label alone fails.
Freshness includes both boundaries: observedAt <= now <= observedAt + maxAgeMs;
maxAgeMs is a positive integer capped at one day. It is checked again after HTTP.
Policy, baseline, version, merge, health configuration and observation identities
all contribute to qualification identity. A changed input requires requalification.

`checkDeploymentHealth(health)` returns healthy or blocked. Configuration has
allowlist (exact absolute URLs), checks (`{url,status,body?}`), timeoutMs,
maxBytes and maxRequests. Required policy checks must equal these checks.
Only HTTP(S) GET is supported; URL credentials and fragments are rejected.
Redirects always fail, including same-origin redirects; no redirect destination
is contacted. No cookies or authorization headers are added. Each request must
match the exact allowlist before any request starts. An allowlist is trusted
network configuration: its administrator controls DNS and destination ownership;
this module does not establish a DNS security or network-isolation boundary.
Loopback tests explicitly allow their disposable server URLs.
Status must be a configured 2xx value; optional body is exact UTF-8 equality.
Limits are positive integers: at most 30 seconds total, 1 MiB per response and
20 requests per verification. All checks share one deadline. Oversize, timeouts,
connection errors and predicate failures block. Diagnostics contain no bodies,
URLs, exception messages or credentials. Arbitrary commands are unsupported.

`readDeploymentObservation(provider, {repository, policy, now})` reuses
createGithubProvider.request with four GETs: repository, exact deployment,
exact deployment status, exact Actions run attempt. Repository is `owner/repo`.
The supported mapping requires deployment payload `{version,baseline}`; status
environment and log_url must identify the expected run attempt using
`https://github.com/owner/repo/actions/runs/ID/attempts/N`. Run repository.id,
id, run_attempt, head_sha, path, completed status and success conclusion must
match. Provider parses database IDs without numeric loss. Unsupported payloads,
missing resources, inaccessible reads or malformed responses block. This maps
observations only; call verifyDeployment to check health. Trusted Core must
independently establish that the selected status belongs to the requested
resource and run and that workflow content matches its pin. No writes occur.

`deploymentHealthDisposition({target,selectors,baselines,observations,health,
repair,now})` evaluates every independently supplied relevant selector. Target
has issueId. A selector has kind (`environment` or `dependency`), repositoryId,
environment, releaseLine and output. Baselines have id, selector, effectiveAt,
policy and optional incident. Every selector selects the greatest effectiveAt;
missing, ambiguous or future-inconsistent inventories block. Core must supply
all applicable selectors, including dependency outputs; an empty list means no
applicable health obligations, never proof of permission. Observations match
policy.baseline uniquely; health is keyed by baseline id. Unrelated selectors
are not evaluated and an unrelated success cannot mask a required failure.

Repair facts have classification, responsibleIssue, incident, unknownWrites,
classifiedAt, maxAgeMs, and authorization. Authorization has issueId, incident,
operation `deliver-repair`, grant, revoked, validFrom and expiresAt (exclusive).
Core supplies these only after independent attribution, implementation-defect
classification and fresh verification of the explicit incident-bound grant.
The disposition rereads its validated clock after failed verification and again
before return, rechecking every provisional bypass after later obligations.
Every successfully verified required observation is also retained and checked
against that final decision time; later HTTP checks cannot leave expired health
evidence eligible. Expired evidence identifies and blocks its affected obligation.
Authorization expiry is exclusive; classification freshness is inclusive. Invalid
or backward decision clocks fail closed.
Only a matching incident's environment-health obstruction can be bypassed.
Dependency-output obligations are never bypassed. Another failed baseline
still blocks; unknown writes, external failure, stale classification or invalid
authorization cannot qualify. The return contains selected, blocked and bypassed
obligation IDs; permission is always false, otherGates is required, completion
is unqualified. This API never claims Scope, dependencies, routing, isolation,
Candidate/Hooks, Accept, CI, Review or Merge have passed.

`createDeploymentFinal(current, qualified, inputs)` is the semantic handoff to
existing createEvidence final inputs. Use the original in-process qualified
result, not a serialized copy. It reverifies current inputs and live health,
compares the proof, repository and actual final merged commit, then calls
createEvidence. Inputs are the same as verifyDeployment. A repair-start
exception cannot qualify completion. Fresh healthy proof after the repaired
merge can qualify. Set current.expected.inputs.deployment to qualified.proof.
The resulting final receipt participates in createCompletion/verifyCompletion's
existing full chain. Existing evidence functions remain structural validators;
they do not authenticate or semantically verify arbitrary identity hashes.
Trusted completion callers must use this handoff for required deployments and
recompute it on freshness, policy, baseline or observation changes. Explicit
not-applicable evidence remains compatible with the existing final interface.

Retained tests use disposable local HTTP fixtures and injected provider reads.
They are module evidence, not live deployments, Actions runs or product E2E.
