# Bootstrap interface version 1

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
1 requires `schemaVersion: 1`, nonempty `requestId`, `stage`, `repository`
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

`execute` receives a separate clone and is called exactly once after verification.
It returns `{status: 'succeeded'}` only for confirmed completion of that stage.
Core persists actual stage artifacts separately and binds their references to
subsequent requests; this bootstrap neither creates nor publishes them.
Adapters are trusted in-process code. Never load them from a request path or
expose these injection arguments as user permission assertions. There is no
production success adapter; deterministic adapters exist only in tests and the
explicit synthetic experiment. Requests and results must contain no credentials.
Prerequisite installation and authenticated transport confer no execution grant.

Results have `schemaVersion: 1` and one of `rejected`, `blocked`, `succeeded`.
Malformed requests return rejected plus an English error and no execution.
Well-formed results carry `resultId` (requestId + ':result'), requestId, stage,
repository, issue, authority, Scope, supplied Shape/candidate/source, and
components. Each request ID must be unique within the host's work cycle;
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
LICENSE, package.json, src/identity.mjs, src/index.mjs. Those regular files are
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
