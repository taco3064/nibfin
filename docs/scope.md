# Local Scope portfolio contract (version 1)

`scopeInstructions()` returns the actual packaged English pre-delivery asset as
text. `checkPortfolio(portfolio)` returns `{ok, graph, resources, diagnostics}`.
Import both from `@nibfin/core`; no checkout paths or donor source are needed.
They do not select a protected Runtime Skill. The checker uses no filesystem,
provider, environment, clock or credential input; retrieval only reads its static
packaged instruction file. Neither function publishes work.

`ok` means no structural errors were found, not authenticated authority, semantic
completeness, publication approval, execution readiness or product completion.
Warnings retain uncertainty even when `ok` is true. `graph` is either
`known-subgraph` or `complete-observation`, describing caller-declared observation
coverage, never independent authentication. `resources` is `observed`, `unknown`
or `limited`; unavailable resources do not by themselves make a plan defective.
Diagnostics have stable `code`, `path`, `reason`, `severity` and `remediation`.
Ordering follows input order; identical JSON inputs produce identical results.
Inputs are not mutated. Supply ordinary JSON data, not accessors or class objects.

## Template

The maintained `examples/scope.json` is a full concrete instance. Copy it and
replace example authority, requirements, work and observations with actual
reviewable evidence. All top-level arrays are explicit, including empty arrays.

| Field | Required representation |
| --- | --- |
| version | 1 |
| authority | source, revision strings referencing the current requirements |
| boundary | kind: whole or subset; subset also needs approval reference |
| requirements | unique id, statement, source, revision for every authority requirement |
| items | unique id, repository OWNER/REPO, ownership rationale, outcome, verification, estimate |
| estimate | positive integer lines, confidence low/medium/high, basis; exception reason above 1000 |
| coverage | requirement id, nonempty items array, rationale; one entry per covered requirement |
| exclusions | requirement id, reason; permitted only for an approved subset |
| handoffs | producer/consumer item ids, contract, verification |
| dependencies | from blocked item id, to blocker item id (proposed expectations) |
| nativeDependencies | same edge representation, from supplied native observations |
| graphCoverage | complete or partial (known observation coverage) |
| resources | name, kind tool/artifact/hook/resource, status, evidence when observed |
| claims | kind availability/target-completion/live-provider/global-graph, evidence; availability needs resource; completion needs origin target-live |
| audit (optional) | authority source/revision, issues array of observations described below |

Resource status is observed, unknown, unavailable, unsupported or unverified.
An empty resource inventory raises an uncertainty warning. Evidence references
are opaque strings; the checker cannot authenticate them, detect arbitrary lies,
classify all secrets or determine whether prose really meets a requirement.
Semantic review must inspect cross-cutting requirements, independent outcomes,
conflicting prose, official-interface semantics, permissions, evidence truth and
public disclosure approval. Do not supply secrets or unapproved private proof.
Unknown fields are not interpreted as authorization. No result grants permission.

An unresolved dependency endpoint is an error in a declared complete graph and
a warning in a partial graph. Known cycles, duplicates and redundant edges are
reported even in partial graphs; absence of a known cycle proves no global
claim. Each cross-repository dependency needs an explicit producer/blocker to
consumer/blocked-item handoff. Independent items need no edges or list priority.
Native drift is reported for review, never repaired by this function.

## Whole-project and approved subset walkthrough

The example traces API/security/docs to Core and release verification to the
entry consumer. Core produces the normative interface consumed by entry; its
800-line estimate includes safety tests and documentation, and the 200-line
consumer estimate includes installation proof. Both outcomes are independently
verifiable. The example resources are deliberately unverified/unknown: a clean
plan is not a claim that a target runtime or hook configuration exists.

For an explicitly approved API/security/docs subset, retain all four requirements,
set `boundary` to `{kind:'subset', approval:'owner:subset-review-1'}`, remove the
entry item, its coverage and handoff/edges, and add
`{requirement:'release', reason:'Approved deferred release integration owned by the later entry work.'}`
to exclusions. The retained test executes this transformation. It is a usable
subset plan, with visible outstanding release work, never whole-product completion.

## Read-only Audit template and example

Supply `audit.authority` and `audit.issues`. Each Issue observation has `item`,
`repository`, `outcome`, nonempty `states` (raw/frozen/authorized/shaped/active/delivered/closed), original `scope` with source/revision/
identity, and optional separate `shape` with source/revision/identity. Use native
edges above as current observations. Supply every current Issue, including extra
or duplicate work. Identity strings are comparison evidence, not authentication.

Example: planned Core has an observed Issue in `example/entry`, states
`['authorized','shaped']`, and missing original Scope identity. Audit reports
ownership drift and provenance loss. Proposed remediation must use applicable
reauthorization and safe recovery; ordinary publication approval cannot change
protected work. A changed authority revision requires reviewing all coverage.
Tests execute these examples and verify input preservation. This checker only
returns diagnostics; a person separately reviews and approves a correction plan.

## Plan Investigation example

Request: Plan; in taco3064/nibfin, can installed consumers retrieve Scope
instructions without selecting a protected Skill? Inspect only src/index.mjs,
src/portfolio.mjs, tooling/archive.mjs and test/portfolio.test.mjs. Return export,
asset and installed-consumer correspondence; no provider access or writes.
Response: src/index.mjs exports scopeInstructions; src/portfolio.mjs reads
instructions/scope.md relative to its module. tooling/archive.mjs includes that
asset and copies the portfolio test into its fresh consumer, whose test imports
@nibfin/core. Limits: these are local package observations, not live publication
or external consumer repository evidence. Implication: keep Core as normative
producer and document the installed-consumer handoff; do not infer a new native
dependency from an import alone.

## Audit Investigation example

Request: Audit; for the documented fixture, explain Core's observed ownership
drift to example/entry using supplied snapshots and the accessible package
interface. Inspect only docs/scope.md, examples/scope.json and the Audit fixture
in test/portfolio.test.mjs. No Issue or dependency edits.
Response: examples/scope.json assigns core to example/core; the retained Audit
test changes audit.issues[0].repository to example/entry and removes its original
scope.identity while retaining authorized/shaped states. These are synthetic
observations with explicit fixture references. Limits: no actual Issue or private
history was inspected and snapshots are not authenticated. Implication: report
ownership/provenance correction through protected reauthorization/recovery.
Neither response is formal Shape, independent validation, publication authority,
Owner Grant, execution eligibility or completion evidence. Use Shape's existing
bounded Investigation capability, without creating another protected role.

## Verification and ownership

Run `node --test test/portfolio.test.mjs`, `npm run check` and
`npm run verify:archive` with supported Node 22/npm 10 and locked dependencies.
Use isolated disposable writable storage for builds and consumers. Child JS uses
the installed interpreter; no temporary executable/shebang probe is needed.
Missing supported tools/cache/scratch are execution-resource failures: record the
exact failure rather than counting unrun checks as passed. Hooks remain a separate
offline credential-free Core gate. #118/#119 own Publish/journal; #124 owns live
publication/recovery. These local fixtures and archive checks prove neither live
GitHub operations nor whole-product/multi-member/deployment completion.
