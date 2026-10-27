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
reviewable evidence. Required top-level arrays are explicit, including empty
arrays. Supply sourceInputs or legacy handoffs (or both); projects is optional.

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
| sourceInputs | producer/consumer item ids, source, revision, nonempty relative paths array, interface |
| handoffs (legacy alternative) | producer/consumer item ids, contract, verification (test method, not a proof deliverable) |
| projects (optional v1 extension) | unique id, baseline empty/initialized; empty needs bootstrap item id; initialized needs source/revision |
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
claim. Each cross-repository dependency needs a producer/blocker to
consumer/blocked-item source/interface reference in sourceInputs or legacy handoffs.
The stable missing-handoff diagnostic code is retained for compatibility; it does
not request a separate technical deliverable. Independent items need no edges or
list priority.
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
entry item, its coverage and sourceInputs/edges, remove the entry project
declaration, and add
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
producer and consume the merged source and installed package interface directly;
do not infer a new native dependency from an import alone.

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
offline credential-free Core gate. The actual publisher and journal are maintained
in src/publisher.mjs and src/publication.mjs; downstream E04 (#208) and E08 (#209)
own later applicable provider/host/release claims for this source-first slice.
These local fixtures and archive checks prove neither live GitHub operations nor
whole-product/multi-member/deployment completion.


## Source-first compatibility and bootstrap observations

Version 1 keeps existing handoffs inputs accepted unchanged. Their contract and
verification strings identify an interface and a proposed integration test method;
they never require the producer to supply a parallel report. New callers can omit
handoffs and use sourceInputs instead. Both arrays may coexist, but each supplied
entry is validated; invalid legacy entries do not disappear behind valid source
references. No data is rewritten or inferred. The checker validates reference
shape, not whether paths exist at the supplied revision or source access is legal.
Inspect the actual merged source before consuming it. Trusted predecessor
completion still gates native edges even when only source is consumed.

The example declares two initialized projects with observed baseline references
and no bootstrap. These are illustrative references, not authenticated completion.
When projects is supplied, every item must have a project referencing one declared
id. In an empty project exactly one member has type bootstrap, and the project's
bootstrap field names it. Every other member must reach that bootstrap through
planned dependencies (from blocked item to blocker). Native drift is checked
separately; paths cannot turn proposed edges into real provider relationships.
Initialized projects require source/revision and reject bootstrap members or a
bootstrap field. Duplicate project identities, missing members and orphan work
are errors. Omitting projects preserves older v1 inputs; it supplies no bootstrap
proof. Unknown fields are not additional supported planning promises.

The retained empty-project test makes core the minimal shared bootstrap and adds
two independent features depending on it, plus a consumer depending on a feature.
It accepts branching and rejects a second bootstrap and an unreachable feature.
Semantic review must confirm core really owns only pinned setup, lockfile, common
entry points and module boundaries, rather than feature, release or E2E work.
The checker cannot infer project boundaries from directory names, authenticate an
initialized baseline or detect a disguised second initializer in prose.

Full raw Bodies, selected routes, decision-specific approvals, named later real
verifiers and stage-specific readiness belong in the reviewed Scope Plan, not a
new technical SSOT or mandatory per-module evidence artifact. The structural JSON
is a diagnostic aid; it does not validate raw-body semantics, feasibility, real
runtime transitions or whether an implementation waits for its own future release.
Review those constraints explicitly against instructions/scope.md before declaring
PLAN_READY. Actual release/CD success and external installation/E2E observations
remain separate from source completion and package fixture results.

## Publish integration and mode verdicts

publishPortfolio uses publicationManifest, openPublicationJournal and the supplied
provider with trusted authorize/protection/disclose callbacks. See docs/publisher.md
for its accepted manifest, exact approval boundary and sanitized verified/unresolved
results. A callback must check the entire manifest identity, current permission and
revocation; approval of a subset cannot authorize the remainder. Protection must
be known false for every protected lifecycle flag. Public disclosure is a separate
trusted decision; accepting a manifest does not approve private proof disclosure.
Raw body bytes as represented by the JavaScript string, including Unicode,
newlines and trailing whitespace, survive serialization/readback exactly. No
hidden correlation marker is appended. The publication handoff is provider-read
raw provenance, not a mirror implementation specification.

Plan/Audit are strictly read-only. The instruction asset's fixed PLAN_READY,
PLAN_BLOCKED, AUTHORITY_UPDATE_REQUIRED, PUBLISHED, PARTIAL_PUBLICATION,
PUBLICATION_BLOCKED, REPLAN_REQUIRED, AUDIT_PASS and AUDIT_FAILED are mode report
verdicts, not added Core role-result enum values or checkPortfolio return values.
Ownership uncertainty is a finding. Report four evidence levels separately:
text compared, design examined, local checks executed and real results observed.
Unknown gate support is UNVERIFIED, never affirmative unsupported evidence or a
successful result. A failed actual publication remains failed. Scope label removal
cannot revoke a signed Grant; protected changes need authorized lifecycle recovery.
