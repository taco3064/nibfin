# Protected role instruction packages

The three protected instruction files in `src/instructions/` ship with the local package and are included
in installation identity. They are complete role instructions, not a second Core
or a deployment backend. Scope Investigation is a read-only planning capability;
it is not an accepted protected role or a formal Shape result.

The current bootstrap interface is schema 4 and protected interface is schema 5.
These advanced after the original instruction work was shaped. This change keeps
the current interfaces, signed authorization and requirement-source verification;
it does not restore obsolete schema 2/3 requests. See `interfaces.md` for the
normative owner, fields, migration requirements and external consumer examples.

Every row requires an authenticated assignment, frozen Scope and authority,
approved instruction content/selection identities, pinned component identities,
request/result/session IDs and source workflow/content/Run/Attempt. Core checks
fresh eligibility for each separate formal Run. New Runs do not prove permission
or independent identity. Results retain their exact Binding and evidence references.

| Role | Skill | Required applicable inputs | Successful outcome |
| --- | --- | --- | --- |
| shape | shape | Original Scope, requirements, repository reality; no required prior role | proposal |
| shape-validator | shape | Proposed Shape and authenticated successful Author; independent session | approved |
| shape-diagnosis | shape | Current Shape, Author evidence, actual concern/attempt; authenticated exact conflicts for confirmation | not-confirmed, or confirmed with shape_defect |
| deliver | deliver | Published Shape, successful Validator, current base/candidate, delivery cycle and applicable repair context | candidate |
| accept | accept | Complete Candidate, successful Deliver, pre-Accept hooks, delivery/repair cycle; independent read-only session | accepted |
| shaper-review | shape | Final Shape/head/base/diff, Author, Validator, Deliver and Accept, applicable hooks/CI and decisions; independent session from all four | approved |

A concern or rejection is classified using implementation_defect, shape_defect,
authority_gap or external_failure; success uses none. Successful transport can
carry a concern and never implies approval. External Agent adapter envelopes do
not replace this protected vocabulary. Current schema-5 prior inventory and
requirements identities must remain correlated across Runs and repair cycles.

Author and Validator must reconcile exactly one fenced kairo-candidate JSON
inventory against Scope and repository hook configuration. Artifacts require
path/purpose and hooks path/event. Empty lists require separate applicability
reasons. Required ignored artifacts remain mandatory. Core captures complete
Candidate identities and runs credential-free, network-free hooks before Accept
and again before commit. Missing prerequisites, changed index/message or accepted
content block. Agents neither stage nor perform these lifecycle operations.

Approved repository selection replaces shared selection; explicit default returns
to built-ins. Extend/override change content only and bind effective content and
selection digests. Discovered repository SKILL.md files cannot self-activate.
All mandatory gates survive customization. No role may publish, dispatch, mutate
Scope/dependencies or erase merged history. Original-Scope defects require read-only
Scope Audit/Plan and separate approval. Pre-merge Shape restoration is exclusively
an authorized Core action after independent diagnosis.

Incident input must correlate responsibility evidence, incident/delivery/repair
cycles, current authorization, Merge/version/environment and authenticated
Run/Attempt/log references. An observation or Core-selected next stage is not an
approved repair cycle. Open post-merge failure needs no Reopen; closed regression
requires Core attribution, safe Recovery Comment/read-back and lawful Reopen.
The incident-specific health exception does not waive other gates. Independently
confirmed implementation defects under correct Shape follow signed repair policy;
until-conformant is not stopped by a historical repair count.

`test/instructions.test.mjs` separates content regression checks from executable
interface scenarios. Artifact/hook availability and incident attribution scenarios
exercise a synthetic trusted-host permission seam; they do not implement capture,
hook orchestration or attribution. `test/protected.test.mjs` checks signed bindings,
customization, independent sessions, prior completion, conflicts and substitutions.
`verify-package` resolves all six roles from an external installed local archive,
reconciles instruction identities and rejects tampering with every instruction
source. These are local checks, not Agent obedience, live Actions, production
sandbox, release, deployment or cross-repository E2E support claims.

The separately maintained `scope.md` instructions provide the official pre-delivery
Skill, covered by installation identity without becoming a protected role. See
[Scope contracts](scope.md) for whole/partial Plan, approval handoff and read-only
Audit interfaces and their local verification limits.
