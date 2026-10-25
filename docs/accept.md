# Independent pre-Commit Accept

`createAcceptFlow({current, workspace, prepareRole, evidenceCurrent})` composes
Candidate, first-pass Hooks and `createAgentLifecycle` without mutation or
publication capabilities. Call `run()` before creating the candidate commit.
Only `outcome: accepted` includes successful evidence, consumable by
`compareEvidence` and the existing second-pass hook runner. This evidence is
not permission to commit, publish, merge or close; Core owns those gates.

All four capabilities are trusted Core integrations, never checkout or reviewer
configuration. `current()` returns a fresh JSON snapshot with:

- `repository`, public `visibility`, personal/organization `ownership`, exact
  `scopeBody`, `shapeBody`, relevant `decisions`, instruction selection
  configuration (`repository`, `shared`, `approvals`) and full stage `binding`;
- `workspace`: separately protected capture expectations;
- `obligations`: the existing evidenced artifact requirements and complete hook
  configuration/prerequisite observation;
- `deliver`, `deliverCurrent`: successful Deliver envelope and protected current
  evidence expectation;
- `hooks`: first-pass `stage`, `stageCurrent`, `receipt`, `receiptCurrent`, pinned
  runner `profile`, base64 original commit `message` and hook `executionId`.

`workspace()` returns the retained/imported immutable workspace handle matching
that snapshot. Core must refresh it and its protected expectation when submitted
files change, including ignored artifacts; the API cannot detect changes outside
its supplied current observations. Each checkpoint validates Scope/Shape hashes,
obligation correspondence, workspace sources, Deliver, the first-pass receipt,
and its stage envelope. No empty-hook exemption is inferred from missing data.

`prepareRole({role,skill,instructions,task})` must use the fixed `accept` role and
Skill and return `{lifecycle,input}`. Bind **the entire task** to the backend's
trusted task capability, as for Shape orchestration. The task includes the exact
Scope/Shape and decisions, canonical workspace transfer (full binary diff, Git
objects, changed paths and ignored source bytes), protected expectations, Deliver,
and hook evidence. No digest-only or truncated prompt satisfies this contract.
The transport must reject unsupported sizes; the API also rejects tasks over
64 MiB and reuses workspace transfer bounds. Candidate access is read-only via
the existing backend contract. Test scratch space must be separate from Candidate.

`evidenceCurrent(id)` supplies fresh `{expected,consumed}` for that exact Accept
execution. Expected inputs are `{candidate,hooks:contentIdentity(firstStage),
deliver:deliver.execution.id}`. Instructions, policy and provenance are bound by
the envelope; request/result/execution identities must be fresh and distinct from
Deliver. Core must derive expectations independently of actual reviewer output.
The expected result is a schema-valid successful result; matching successful
collection still requires exact comparison, including result bytes.

With `collectFailures: true`, lifecycle collection distinguishes `result.status: valid` (successful
`evidence`) from `rejected` (validated `collection`, **not** successful evidence).
`compareStageCollection` checks failures against all protected envelope inputs
and validates their actual StageResult separately. For Shape concerns, pass
`resultContext(id) => ({scopeBody,shapeBody})` to `createAgentLifecycle` alongside `collectFailures: true`; exact
hashes and quotes are required. Missing provenance rejects that concern. A
classified result does not authorize Shape restoration. The default remains successful-evidence-only for compatibility with existing callers;
failed results remain `invalid` unless this capability is explicitly enabled.

The flow returns `rejected` with the validated `result` and execution identity
for implementation, Shape concern, authority or external classifications. Bad,
foreign, replayed, absent or nonzero-exit results return `blocked`. Diagnostics
use fixed categories and do not include arbitrary backend errors or output.
Core is responsible for handling reviewer summaries as untrusted diagnostic text.

Fresh checkpoints run before invocation and after collection/termination. Any
input drift blocks old Acceptance. After changes, Core must supply fresh upstream
Candidate/Deliver/hook evidence and obtain a new independent execution. Later
reuse still requires Core's fresh `compareEvidence` checks; a returned object is
not a perpetual approval.

Unknown start/collection/termination retains `reconciliationRequired` and prevents
another `run()`. `reconcile()` collects or checks termination of the same retained
invocation; it revalidates all current inputs. `stop()` requests stop through the
same lifecycle before reconciliation. A confirmed result is retained while
termination is unresolved, then rechecked against fresh expectations. Drift during
an unresolved execution remains blocked for Core reconciliation; do not start a
replacement or discard unknown execution state. Core retains lifecycle/backend
handles for explicit stop, termination, cleanup and external reconciliation.

Local tests use disposable real Git workspaces, fixture hooks and credential-free
recording/process adapters. They measure serialized input/result handling and
backend read-access requests, not model execution or native denial of writes.
Issue #121 owns real Agent-backed integrated lifecycle, native read-only isolation
and live hook evidence after release. No login, paid account, registered Runner
or live GitHub repository is a prerequisite to this module's tests.
