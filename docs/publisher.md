# Raw GitHub Scope publisher (v1)

`publishPortfolio` from `@nibfin/core` composes `createGithubProvider` and
`openPublicationJournal`. It publishes raw Scope only. Its successful receipt
is input evidence for a later independently authorized Shape, never a Shape,
Owner Grant, delivery eligibility assertion or completion certificate.

The retained provider-response fixtures simulate remote effects. They prove local
request construction, gates and reconciliation, not actual GitHub publication.
In the source-first portfolio, E04 (#208) and E08 (#209) own the later
applicable provider/host/release observations, including real publication and
recovery where assigned. No live account or registered Runner is necessary
for this module's local checks.

## Trusted caller boundary

Call `publishPortfolio({provider, manifest, directory, initialize, authorize,
protection, disclose})`. Supply a real `createGithubProvider` with its own trusted
write authorization callback. Hosted integrations inject an authorized transport;
local trusted Core may use the existing stored-login transport. Do not expose
that identity to an Agent, reviewer, hook or untrusted checkout.

These three asynchronous capabilities are mandatory and are implemented outside
untrusted plan/provider data:

- `authorize({manifest, identity, operation})`: authenticate the explicit complete
  concrete plan approval, compare its exact content identity, and check current
  permissions/policy for this operation. Return strictly `true` only while all
  checks hold. An approval reference, structural Plan check, caller boolean in
  JSON, cached authorization or journal record is insufficient. The callback
  must check both repository endpoints for cross-repository operations.
- `protection({manifest, operation, target, issue})`: independently obtain current
  lifecycle evidence for the stable Issue identity. Return all six boolean keys
  `frozen`, `authorized`, `shaped`, `active`, `delivered`, `closed`. Every key must
  be false for ordinary mutation; missing evidence blocks. Repository Issue state
  and shaped/delivered labels are also checked locally. Recovery/reauthorization
  for protected work is a separate lifecycle, not a publisher bypass flag.
- `disclose({manifest, identity, operation})`: authenticate permission to submit
  the complete requested public content/metadata and expose its raw handoff.
  Private source proof and credentials must be rejected unless that specific
  disclosure is approved and policy permits it. Do not infer permission from
  public repository visibility or provider text. Return strictly `true` only
  with sufficient current evidence.

Capabilities must be functions held by trusted Core. A wrapper that simply
returns a plan's `approved: true` field violates this interface. The publisher
clones and recursively freezes the manifest before invoking them. Exceptions,
denials or unavailable capabilities stop. Its fixed diagnostics exclude arbitrary
provider/callback/filesystem error text. Protect the journal and returned raw
handoff according to the disclosure policy; they intentionally contain Scope
content, not credentials or private transport payloads.

## Manifest and request schema

Use the publication manifest `{version:1, approval, plan, operations}`. `plan` contains the
entire concrete approved plan; `operations` is its exact executable inventory and
must be part of the authenticated approval. Every operation is
`{correlation, kind, target:{repository, repositoryId}, payload}`. Coordinates
are canonical lowercase; repository IDs are positive decimal strings. Both
personal-owned and organization-owned public repositories are supported. Private
repositories are rejected. Ownership has no Runner registration implication.
Correlations and item keys use 1–80 ASCII letters, digits, `_` or `-`.

For `kind:'issue'`, payload is:

```js
{
  key: 'N01',
  scope: {body: originalBody, identity: contentIdentity(originalBody)},
  request: {title: 'Approved title', body: originalBody, labels: ['scope'], milestone: null},
  creation: {creatorId: '7', notBefore: '2026-10-25T00:00:00Z', notAfter: '2026-10-25T01:00:00Z'}
}
```

`request` is the exact GitHub body. `title`, `body`, `labels` are required;
`milestone` is optional (null or a positive safe integer milestone number).
No other request fields are accepted. Assignments cannot be selected, reordered
or changed. Initial labels may include only approved raw metadata; shaped and
delivered are always refused. Bodies are preserved byte-for-byte as JS UTF-8
strings; no hidden correlation marker is appended.

`creation` is approved correlation provenance: the intended stable creator ID and
bounded creation-time window. All repository Issues are paginated with `state=all`
and matched by exact raw body/title/metadata, creator and time window. Exactly one
candidate must survive, and an independent single-Issue GET must confirm all
identities/content. This is a conservative discovery mechanism, not an
exactly-once guarantee: an identical concurrent creation can make correlation
ambiguous. Use a reviewable unique approved title/body where needed; do not
mutate bodies after approval to add markers. Zero, duplicate, inaccessible or
incomplete candidates stop for operator reconciliation. A passed window does not
authorize a fresh creation after an uncertain submission.

For `kind:'metadata'`, use the same `key`, `scope`, `request` and an
`issue:{id, nodeId, number}` instead of `creation`. The original Scope body must
already match; this interface does not revise original requirements. `id` is a
stable decimal database ID, `nodeId` is the opaque node ID and `number` is a
positive safe integer. The PATCH omits assignments, verifies preservation of
the existing assignment sequence and verifies exact approved metadata afterward.
An item key is introduced once; combine initial metadata with Issue creation.

For `kind:'dependency'`, payload is `{blocked:'N02', blocking:'N01'}`. Both keys
must already be introduced by earlier Issue/metadata operations. The target must
be the blocked item's repository. Duplicate edges and self-edges are rejected.
Order expresses request derivation only; it assigns no product priority or new
runtime scheduling rule. The approved manifest remains unchanged when GitHub
assigns IDs.

The adapter submits `POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by`
with `{issue_id: <blocker database ID as integer>}`, then independently reads both
blocked-by and reciprocal blocking collections. This follows the
[official GitHub dependency API](https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2026-03-10).
Node IDs are never substituted for database IDs. Database IDs beyond JS's exact
integer range stop before a dependency request; no rounding is permitted.
All collections complete pagination, confined to the original collection path.
Markdown links cannot satisfy the native-edge predicate.

## Durability, recovery and results

The caller supplies an explicitly persisted trusted POSIX journal directory with
single-writer access using existing official concurrency. See
[publication storage and recovery](publication.md) for filesystem/fsync,
retention, permissions and backup prerequisites. `initialize:true` is for the
first invocation only, with a new directory and existing parent; restart uses
`initialize:false` and the identical manifest. Never replace missing/corrupt
history with a new directory to evade reconciliation. There is no retry,
rollback, distributed lock, scheduler, lease or fencing service.

Exact intent, resolved endpoint identities, derived method/endpoint/body and
submission risk are durable before each transport write. Even
rejected/unknown writes are independently observed; acknowledgments alone cannot
complete anything. All recovered submissions, including previously complete
ones, reconcile afresh before new submissions. Missing history, corruption,
append/readback failure or ambiguous effects block subsequent writes. Preserve
those bytes and obtain appropriate operator recovery rather than deleting them.
Every verified Issue readback durably binds repository coordinates/ID, database
ID, node ID and Issue number. Restart observations must preserve all components;
a matching database ID alone cannot replace a changed node ID or number.
Legacy database-only readbacks cannot be silently upgraded into full identity
evidence and stop for authorized reconciliation. Contradictions remain in the
journal and block continuation even if a later read returns the original value.
Metadata submissions additionally retain the pre-PATCH assignment ID sequence
in the durable derivation; readbacks retain the observed sequence. Every restart
compares against that original baseline, including after a lost response or
interrupted observation. Identity-bound, structurally valid assignment observations are journaled as
incomplete before validating other response fields or rejecting body/metadata drift, so simultaneous content failure cannot discard an
assignment contradiction. Any recorded mismatch remains unresolved even if later
assignments return to the baseline. Missing legacy baselines require separate
authorized reconciliation; current assignments cannot reconstruct historical
preservation proof. Fresh authorization/disclosure and repository checks apply during recovery.
Read-only recovery need not reject a now-protected Issue merely to observe it;
any new mutation still requires the full current protection check. Removing the
scope label does not revoke a signed Grant or replace lifecycle recovery.

Success is `{outcome:'verified', handoff:{version:1, kind:'raw-scope', approval,
plan, manifest, journal, mappings, edges, observations, completed}}`.
`plan`, `manifest` and the latest journal record are content identities;
`mappings` carries original exact Scope/body identity, target/stable Issue
identities, approved metadata and observed assignment IDs. `edges` records each
operation and both stable Issue IDs. `observations` names independent collection
and single-Issue paths (and observation time when available). Together with the
journal chain they trace request derivation and reciprocal native readbacks.
Future Shape provenance remains separate. Product `contentIdentity` uses
`nibfin-content-v1\n` plus canonical JSON and is distinct from trusted Core's
Scope/body digest; do not compare or substitute these algorithms.

Failure returns `{outcome:'unresolved', manifest, completed, unresolved,
diagnostic, operation}`. No raw provider error, body or partial handoff escapes.
Completed correlations describe observed operations, never portfolio success.
Unknown results remain unknown and prevent blind resubmission/dependent writes.
There is no claim of an atomic cross-API snapshot or instantaneous revocation;
trusted Core rechecks at subsequent controlled checkpoints.

Local checks: `node --test test/publisher.test.mjs test/publication.test.mjs
test/provider.test.mjs`, `npm run check`, `npm run verify:archive` on locked
Node 22/npm 10. The archive verifier installs into fresh disposable scratch and
runs the actual exported publisher composition with fixtures. Scratch journals
are verifier-owned outputs, not required Candidate artifacts. No repository hook
setup is introduced; Candidate artifact and hook inventories remain empty.
