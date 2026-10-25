# Accepted Candidate publication

`createCandidatePublication` composes existing workspace, evidence, hook and
controlled-operation validators with `createPublicationGit`. It creates an exact
commit and publishes a branch/PR only after independent pre-Commit Acceptance
and both verified hook passes. Publication does not grant CI, review, merge or
closure permission. This is module/local fixture proof; #121 owns live integrated
commit/push/PR observations and #123 owns independent-Run recovery measurements.

## Trusted inputs

Construct with `{current, workspace, authorization, dependencies, dependencyInput,
history, git, operations}`. Every capability is Core-owned, outside Candidate,
Agent/reviewer/hook execution. Do not obtain capabilities or current expectations
from incoming descriptors, artifact bodies or Agent assertions.

`current()` returns a fresh JSON snapshot:

- `target`: canonical lowercase `repository`, decimal `repositoryId`/`number`,
  stable `issueId`, `cycle`, `headRef`, `baseRef`, `branchPrefix` (without trailing
  slash), and approved `paths`. Refs use slash-separated alphanumeric/underscore/
  hyphen components; dotted refs are explicitly unsupported in this version.
- `visibility:'public'`, `ownership:'personal'|'organization'`, `binding` in the
  existing evidence format, exact `scopeBody`/`shapeBody`, and `workspace` containing
  independently retained capture expectations. `workspace()` returns the matching
  protected handle; submitted workspace transfers must first pass `importWorkspace`.
- `obligations` in the existing reconciliation format, including complete current
  effective hook configuration and prerequisites. Empty hooks require both genuine
  not-applicable receipts; absence never substitutes for evidence.
- `evidence`: `author`, `validator`, `publication`, `deliver`, `accept`, `secondStage`,
  each `{value,current:{expected,consumed}}`. These are existing successful evidence
  envelopes, with original publication provenance, independent roles and complete
  Candidate bindings. Core authenticates expectations and replay state separately.
- `hooks`: `profile`, canonical base64 original `message`, second `executionId`,
  `receipt`/`receiptCurrent`, `first`/`firstReceiptCurrent`, `firstExecutionId`, and
  `firstStage`/`firstStageCurrent`, using the existing hook runner contracts.
- `author:{name,email,timestamp}`: fixed commit identity, integer Unix seconds;
  `correlation`/`source` in controlled-intent format; `pr:{title,body}`, ending with
  the controlled operation correlation marker. Core authenticates all these inputs.

`authorization.eligibility` and `dependencies.evaluate` must refresh current
signed permissions, route/Runner identity and native dependencies for the target.
Their observations must identify the same repository/Issue. Eligibility results
are never reusable write permission. Checkpoints compare current inputs before
and after awaited capabilities. The two-minute run cancellation signal is supplied
to external capabilities; they must be bounded and acknowledge termination before
rejecting. No background replacement is authorized by timeout or cancellation.

`operations({intent,beforeSubmit,reconcileExistingPR,concurrency})` MUST construct the
existing `createControlledOperations`, retaining its existing custody and guarded
provider-write boundary. Install `beforeSubmit` both on those operations and as
`createAuthorizationBoundary({beforeMutation: async () => { await beforeSubmit(intent); return true; }})`.
The latter runs after asynchronous authorization reads, immediately before the
provider mutation. It prevents upstream drift during those reads from authorizing
an old publication. Keep the original exact intent; never reconstruct it from
provider output. Honor `reconcileExistingPR:true` and the supplied native repository
write concurrency group. Official concurrency encloses the entire run, including
history lookup, Git operations and readback. No custom locks or scheduler exist.

## Retention and failure semantics

`history.locate({identity,target,signal})` is an authenticated existing-custody
adapter. It returns `{outcome:'found',records}` or positively establishes
`{outcome:'new',identity}`. Missing, expired or inaccessible history is unavailable,
never new. The adapter must resolve the original target/cycle intent across Runs
and input changes, rejecting conflicting or unresolved replacement work. The
identity binds the complete original pin, including non-tree artifacts. Core owns
traceable custody references and authenticates them independently of payload hashes.
`retain({identity,record,signal})` durably appends to that same protected history;
the composition independently retrieves and compares the full sequence before
proceeding. Use existing custody upload/retrieval, not a local success cache.

Intent precedes commit construction; commit and push attempt precede push.
Re-entry rechecks current gates and actual remote state. A prior push attempt
with no matching remote ref stays unresolved and cannot blindly retry. Matching
refs reconcile; conflicting refs never get overwritten or deleted. PR discovery
requires complete pagination and exact unique matching, followed by independent
single-PR GET. Related mismatches/duplicates block. Lost create responses resolve
only through readback; missing/ambiguous results never authorize another POST.
Previous success alone grants no continuation. Readback binds PR head SHA to the
independently fetched Git commit/tree; SHA identity establishes their correspondence.
Base advancement or head/tree drift blocks before further effects. Cross-API
atomicity and instantaneous revocation are not claimed.

`run({signal})` returns `published` with the original Candidate, Acceptance/hooks,
commit/tree/Base, refs and branch/PR readbacks, or fixed `blocked` diagnostics and
`reconciliationRequired`. No raw process/provider errors are returned. Unresolved
cleanup retires that flow; reconcile residual execution through Core before using
another. The same flow also prevents changed-input replacement of unresolved work;
the custody adapter enforces this across independent Runs.

## Git backend and reproducible local proof

`createPublicationGit({repository,repositoryId})` uses `/usr/bin/git` and canonical
GitHub HTTPS, with the trusted OS account's `/usr/bin/gh auth git-credential`.
Node 22/npm 10, POSIX disposable storage and SHA-1 Git (locally tested: 2.39.5) are
required. The protected stored login must be available to this trusted process;
no inherited HOME, tokens, Git config, helpers or executable paths are adopted.
Only the fixed `GH_CONFIG_DIR` under the actual account's `.config/gh` is supplied
to the trusted helper, so Git cannot adopt HOME-based config or `.netrc` credentials.
Hosted deployments supply their explicitly authorized Core transport implementing
`open/observe/push/close`; this local backend does not consume hosted tokens.
`localFixture` is a trusted test-only absolute bare-remote path; it is never an
input from repository prose. `onCommand` is a trusted observation callback.

The backend uses a template-free disposable bare repository, retained objects,
a shallow Base boundary (ancestry is not transferred), and raw commit-object
construction/readback. The sole parent, Tree and message bytes are exact; no
checkout/index, filters, hooks or signing program participate. Subprocesses have
30-second timeouts and 48-MiB output bounds. Branch creation uses an empty expected
ref lease, preventing race-time overwrite of even a fast-forward-compatible ref.
Independent ls-remote/fetch/readback remains mandatory after push.

Run `node --test test/candidate-publication.test.mjs`, affected workspace/hooks/
accept/operations/provider/authorization tests, `npm run check` and
`npm run verify:archive`. Fixtures own disposable Git repositories, ignored payloads
and provider/custody responses; no live credentials or GitHub writes occur. The
archive verifier repeats the publication fixtures against the installed package.
For #121, supply released immutable package identity, actual Core custody and
current-input adapters, protected login/transport, effective hooks and independent
Acceptance, then record actual GitHub branch/PR identities. Missing resources block
that live integration; local tests do not prove a host's isolation or live support.
