# Approved authority exports v1

The root `@nibfin/core` entry exports `exportAuthority`, `importAuthority`,
`authoritySnapshot`, `verifyAuthority` and `synchronizeAuthority`. These are local,
serializable, pure interfaces. They perform no provider reads or mutations,
automatic approval, refresh, signing, persistence or restart. Local tests establish
these bounded contracts, not live provider or complete product delivery support.

`observeIssueAuthority` is a separate read-only provider adapter for an installed
GitHub Issue target. Native canonical `https://github.com/owner/repo/issues/number`
sources are the only accepted requirement sources. Proposal documents are not
requirement authority. The protected caller
supplies the exact repository ID, Issue database/node IDs, number, cycle and
approval identity. Each call freshly reads the public repository and Issue,
checks those independent identities and retains the full current body as one
Scope component with a content-derived revision. No source URL or module is
selected from Issue text. Cancellation, missing/changed identities, empty or
oversized bodies and unavailable reads return a sanitized unavailable result.

The adapter performs no persistence, approval, signing, label changes or stage
execution. Reading a body does not approve it or overwrite original pending
work. The host must still supply its independently authorized Owner policy and
the existing signed-Grant/current-context checks, and re-observe before effects.
Old exports and receipts do not become current simply because the URL is valid.

## Representation and identities

`exportAuthority(input)` takes exactly:

```js
{
  source: 'https://github.com/example-org/core/issues/101',
  revision: '2026-10-24T13:10:19.626Z',
  approvalId: 'owner-approval-1',
  cycle: 'authorization-cycle-1',
  components: [
    {id:'goal', kind:'section', body:'Hello\n世界', references:['diagram']},
    {id:'diagram', kind:'attachment', body:'AAEC/w==', references:[]}
  ]
}
```

Source is a canonical GitHub Issue URL in the displayed form, using lowercase
owner/repository coordinates and a positive decimal Issue number;
URL aliases are deliberately unsupported. Revision, approvalId, cycle, component
IDs and reference IDs are nonempty strings without controls or `*`. Components
are a nonempty ordered array, each with exactly `id`, `kind`, `body`, `references`.
Kinds are `section`, `attachment`, `reference`. IDs are unique. References are
ordered unique component IDs and must resolve within the export. Sections contain
exact text, attachments contain complete canonical base64 bytes, and reference
components contain the complete material referenced text, not just an external
link. Section/reference bodies can include URLs as text; this API never fetches
or infers their materiality. Attachments of any media type use the same byte
encoding. No Unicode, newline, whitespace or component-order normalization occurs.

The Owner review must enumerate and approve ALL material sections, attachments
and referenced content, their order, exact bodies and reference edges. Completeness
means equality with that independently approved full representation. It is not a
claim that this package observed all current Issue requirements. The trusted application
must obtain a complete export and review it independently; a caller-provided
`complete:true`, self-selected inventory or self-recomputed hash proves nothing.
Do not include credentials or private material in public candidates or diagnostics.

The returned export contains exactly the input fields plus `version:1`, `manifest`
and `identity`. Manifest is exactly `{version:1, source, revision, components}`;
each ordered manifest component is `{id, kind, hash, references}`, with
`hash=bodyDigest(component.body)`. The identity is
`contentIdentity({kind:'nibfin-authority-export-v1', payload})`, where payload is
the entire export excluding identity. Existing `contentIdentity` uses SHA-256 of
`nibfin-content-v1\n` plus canonicalJSON; sorted object keys and ordered arrays
are unchanged. `bodyDigest` uses SHA-256 of JSON.stringify(string), never raw text.
For `Hello\n世界` its vector is
`e25356b0e259cd559cbbe5495f10b8eb613890dd47e20afbb9d2a105c3531bf7`.
For `"quoted"\n魚` it is
`25c8e296ea1d5da1c922ab22d824b23fbb8ce43be2d35212914e02e3bf9474dd`.

`importAuthority(jsonStringOrObject)` validates exact schemas, version, references,
manifest and identity, returning a detached export. Unknown fields/versions fail.
Neither construction nor import establishes approval. `authoritySnapshot(export)`
returns the existing Grant-compatible `{source, revision, body, hash}` where body
is canonicalJSON of the ENTIRE export and hash is bodyDigest(body). Thus content,
manifest, approvalId and cycle all affect the signed authority and evidence identity.
Existing Grant signatures and digest semantics are unchanged.

## Independent approval verification

An approved signed Owner Grant is the approval evidence; there is no second
signing protocol. After independent Owner review, trusted code may bind
`authoritySnapshot(export)` as the full `authority` of the explicitly approved
Grant payload. Use existing prepareGrant/signGrant only under their separate
Owner authorization rules. The export contains no trusted key or approval flag.

`verifyAuthority(export, {grant, grantContext, expected})` requires expected to be
exactly `{source, revision, approvalId, cycle}`, independently supplied as CURRENT
trusted expectations. The full snapshot must equal grantContext.expectedAuthority,
which MUST originate from independently reviewed approved content, not the input
being checked or the untrusted Grant. All existing verifyGrant context fields
remain mandatory: external trustedKeys, time, fresh revocation, expectedPolicy,
expectedWork and a concrete permitted request. This performs the existing Grant
signature, trust, validity, permission and membership checks as well as exact
snapshot comparison. Public personal and organization repositories use the same
predicates; private repositories remain rejected by the Grant contract.

Success is `{ok:true, category:'approved', binding}`. Binding is exactly
`{identity, approvalId, cycle, snapshot}`. Failure is `{ok:false, category}` without
export text, keys, signatures, provider responses or underlying exception details.
Returned success is a comparison observation, not a persistent capability or
permission to skip live eligibility and independent lifecycle gates.

## Explicit synchronization and invalidation

`synchronizeAuthority({active, expectedPrevious, replacement, verification,
authorization})` compares a trusted active binding to its exact expected previous
binding, then verifies replacement using the context above. Authorization is a
separate, independently approved trusted transition instruction, exactly
`{previousIdentity, replacementIdentity, cycle}`. It must match the active identity,
replacement identity and replacement cycle. Never derive this instruction from
an untrusted export, request or agent result. The application owns its provenance,
current authorization, storage transaction and checkpoint revalidation.

Replacement must retain the active canonical source; even a separately signed
foreign document is rejected. Changing a binding requires a different explicitly approved cycle. The transition
returns `{status:'replaced', active:newBinding, previous:oldBinding,
invalidated:['grants','evidence','completion']}`. Reapplying the identical binding
with matching active/expectedPrevious and transition instruction returns
`status:'unchanged'` with `invalidated:[]`; it creates no new cycle. A stale previous
binding or old transition instruction fails. All inputs remain unchanged on both
success and failure. Persist only a successful result, atomically against the
expected previous identity; no built-in persistence or orchestration is implied.

At the next boundary, callers use the new snapshot as expectedAuthority and its
contentIdentity as the evidence binding.authority; newly signed Grants also change
binding.grant. Old Grants then fail verifyGrant's authority comparison and old
stage/completion receipts fail compareEvidence/verifyCompletion against fresh
expectations. Retain historical records under their original identities, never
relabel them as current. Original Scope and published Shape stay distinct. An
imported unapproved export cannot pass verification using a previous valid Grant.

Construction/import/snapshot/synchronization throw TypeError with only
`authority:<category>`. Verification returns safe categories. Categories are
`schema`, `version`, `source`, `completeness`, `integrity`, `expectation`, `approval`,
`authorization`, `previous`, `cycle`. Malformed JSON/non-serializable values map to
schema. Grant failure details are collapsed to approval. Missing current trusted
inputs always reject. These APIs do not replace fixed Skills, independent roles,
Candidate/Hooks, exact-head CI, protected Merge or any Core permission gate.
