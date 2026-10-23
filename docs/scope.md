# Scope planning and read-only Audit interface

Nibfin owns and ships the official pre-delivery Scope Skill at
`src/instructions/scope.md`. `scopeInstructions()` returns its maintained text.
Reuse the Investigation section of `src/instructions/shape.md` as read-only
planning guidance. Scope is not a fourth protected Skill; no Runtime schema or
protected role is added. This interface supplies local deterministic verification,
not live GitHub publishing, a journal implementation or an execution grant.

The public exports from `@nibfin/core` are `scopeInstructions`,
`publicationPlanDigest`, `verifyScopePlan`, `verifyScopeHandoff` and `auditScope`.
This additive interface uses schemaVersion 1; existing schema-4 and schema-5
consumers keep their existing contracts. `src/scope.mjs` owns these fields and
results; callers produce plans and trusted host adapters supply authenticated
observations. The archive smoke check exercises the installed exports and Skill
and checks tampering against the reviewed installation identity.

## Plan data contract

All inputs are plain serializable records. Identity strings are nonempty and
repositories use `owner/name`. Arrays remain explicit even when empty. The
executable whole/partial examples are in `test/fixtures/scope.mjs` and
`test/scope.test.mjs`; these are synthetic source tests, not approved real plans.

| Field | Meaning |
| --- | --- |
| schemaVersion, id | 1 and stable plan identity |
| authority | Complete `{reference, content}` snapshot using the existing requirement-source contract in interfaces.md |
| requirements | Complete current ledger: each entry has id, repository (unique normative owner), outcome, sourceClause and evidence references |
| boundary | `{mode:'whole'}` or `{mode:'partial', included:[requirementId], excluded:[{id,reason}]}`; partial partitions the complete ledger and needs exact approval |
| items | Stable original drafts with id, repository, requirements (IDs), body, metadata, acceptance, evidence and effort |
| prerequisites | Evidenced external outcomes: requirement, outcome, repository and evidence; kept visible even for partial plans |
| dependencies | Proposed `{item,blockedBy,kind:'prerequisite',rationale,interface,evidence}` edges; never actual dependency writes |
| sharedVerification | Deliberate repeated coverage: requirement, exact items inventory, rationale and evidence |
| unresolved | Unresolved facts; nonempty means completeness remains unsupported |
| investigations | Planning findings with source, revision, evidence, findings, uncertainty, interfaces, implication, item and use (boundary, ownership or dependency) |

An item's metadata is the exact proposed Issue metadata object; optional
`assignees` is an array requiring a separate specific user decision, including an explicit empty list clearing
Assignees. Scope drafts cannot request shaped/delivered stage labels. `effort`
contains positive integer lines, confidence (low/medium/high), basis and counts.
Counts are nonnegative integers for disjoint added, ported, rewritten, tests,
scripts, configuration and workflows categories, summing to lines. Count each
meaningful line once, including necessary tests. Exclude lockfiles, generated
outputs and formatting-only edits; never use net growth. Above 1,000 lines needs
`exception:{reason,reassessment:[evidenceReference]}`. Evidence references identify
inspectable records, not proof of their authenticity by themselves.

Optional `item.observed:{repository,issueId}` binds an already known stable Issue.
Keep `body` as original Scope, even after actual Shape publication changes the
mutable Issue body. The current authority ledger must include materially
applicable cross-cutting safety, documentation, release and integration outcomes;
a plan cannot authenticate its own claim to completeness.

`verifyScopePlan(plan,trusted)` returns planValid, planDigest, findings, coverage
and planningEvidence. Findings identify codes and affected subjects. Missing
coverage, unauthorized boundary expansion, ownership drift, unsupported effort,
dangling/cyclic/redundant edges and unresolved authority prevent plan-valid status.
Shared verification is distinct from accidental duplicate coverage. The host
must assess semantic independence and the truth of dependency rationales: text
presence cannot prove that a prerequisite is necessary. Ordering alone never
constitutes a prerequisite or product priority.

## Trusted host seams and publication preflight

These functions are trusted code supplied directly by the owning host. Never
construct them from plan data, Issue prose or repository-discovered instructions.
The library clones inputs crossing seams. True means the host actually verified
the exact supplied claim using its independently authenticated authority; a
caller-set approval flag is ignored. The test seam returning true is no evidence
of real user authentication, permissions or persistent storage.

| Host method | Required verified claim |
| --- | --- |
| verifyAuthority({snapshot,requirements}) | Current authenticated complete authority, content identity/revision and the complete faithful ledger, including material cross-cutting constraints |
| verifyBoundaryApproval({planId,authority,boundary}) | Explicit user approval of the exact partial boundary at that authority revision |
| verifyPublicationApproval({planId,planDigest}) | Explicit user approval of the entire exact concrete publication plan |
| verifyAssigneeDecision({planId,planDigest,item}) | User's specific decision for actual Assignees, including order |
| observeWork(item) | Fresh complete observation `{complete:true,states:[...],evidence:[...]}`; states are original, frozen, authorized, shaped, executing, delivered or closed |
| publicationPreflight({planId,planDigest}) | Fresh tools boolean, writeRepositories and journal `{writable,persistent,recoverable,evidence}` observations |

Use `publicationPlanDigest(plan)` to bind the complete plan with the existing
Core digest convention, SHA-256 of JSON.stringify(value). This includes exact
bodies, repositories, metadata and native edges. Preserve serialization ordering
when approving; even an otherwise equivalent reordered plan requires approval
again. Do not invent a raw-text body hash. Mutating any approved plan content
changes the approval input. The host must never approve solely by plan ID.

`verifyScopeHandoff` returns the design result plus publicationReady, limitations
and handoff. It makes no writes. Missing tools, denied write permission and
unverified durable journal only limit publication; independently sound design
remains planValid. Every protected state blocks ordinary Publish, including
metadata-only edits. Lifecycle safety, recovery and reauthorization must happen
through their authorized path, followed by a separately approved publication
plan; flags or an ordinary Scope approval cannot waive them.

Before actual publication, the separately authorized publisher must recheck
fresh permissions and a writable, persistent, recoverable Publication Journal,
persist intents before writes and independently read back stable Issue IDs,
original bodies, metadata and both native dependency directions. Partial writes,
interrupted sessions or lost responses require reconciliation before retries;
never blindly recreate or automatically roll back unknown results. This Issue
implements preflight only and does not certify journal recovery or S-03 E2E.

## Audit observations

`auditScope(plan,trusted,adapter)` validates the current authority baseline, then
calls only `adapter.readInventory(repository)` for each normative target repo.
No mutation method is accessed, even on findings, denied reads or interruption.
The read adapter must supply independently read current evidence:

```js
{
  complete: true,
  evidence: ['read:repository-inventory'],
  issues: [{
    repository: 'example/core', issueId: 'stable-issue-id', planItemId: 'item-0',
    originalScopeDigest: 'preserved-original-scope-digest',
    body: 'Current Shape may legitimately differ',
    blockedBy: [{ repository: 'example/core', issueId: 'stable-upstream-id' }],
    evidence: ['read:issue-and-native-dependencies']
  }]
}
```

Optional completion `{claimed:true,repository}` identifies the target of supplied
completion evidence; a source-project claim cannot become target completion.
This audit does not certify Core completion receipts. `originalScopeDigest` uses
the existing digest on original body text, separately from current Shape.
Exact stable bindings are matched alongside plan-item correspondence so duplicate
or replacement Issues remain visible. The host must authenticate that
correspondence; untrusted Issue assertions alone cannot establish it.

Audit returns baselineValid, status (consistent/findings/unknown), findings,
remediation and planningEvidence. Findings identify requirements, plan item,
observed stable identity and evidence or explicit unknown. Read exceptions,
incomplete inventories and interruption yield unknown, never an empty successful
inventory or missing-ticket inference for that unread repository. Ambiguous
upstream identity produces unknown-dependencies rather than fabricated edge
comparison. Differences remain read-only proposed corrections, requiring a new
concrete plan and applicable approval. No label, event, successful Plan, Publish
approval, Audit or Investigation provides formal delivery eligibility.
