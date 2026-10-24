# Authorization checkpoints

`createAuthorizationBoundary` is an inert public export from `@nibfin/core`.
Construction and import do not discover credentials or access GitHub. This bounded
module supplies eligibility and provider-write checks, not a delivery runtime,
Runner registration, dependency scheduler, or proof of deployed integration.

Trusted Core constructs the boundary with `getCheckpoint(intent)`, `now` (integer
milliseconds), and a required positive integer `maxCheckpointMs`. Other options
are the existing `createGithubProvider` options, except `authorize`, which this
boundary owns. Use its `request` for controlled mutations and `reconcile` for
submitted or unknown results. Never retain a separate unguarded mutation path.
`eligibility(intent, {signal})` performs read-only checks; its result is a report,
never a reusable capability. Each mutation obtains a new checkpoint and fresh reads.

`getCheckpoint` must return these trusted inputs on every invocation:

- `request`: the existing Grant request containing `{repository:{id,name,visibility},
  issueId,number,path,operation}`. IDs and numbers are canonical decimal strings;
  `issueId` is the Issue node ID. Repository name is canonical lowercase.
- `member`: `{id,login}` for the selected Assignee, independent of the API operator.
- `operator`: local `{id,login}` expected from the actual process account's stored
  `gh` login; or hosted `{kind:'user'|'service',id,source:'hosted-authorized',trusted:true}`.
- `grant` and `grantContext`: the existing signed Grant and verifier trust context,
  including trusted public keys, current authority, policy, work and available
  revocation observation. The boundary supplies its own clock and exact request.
- For a write, `write:{method,endpoint,target}`: the exact allowed provider mutation
  mapped by Core to the scoped request. The operation must also match.

The callback, transport, clock, expected operator and hosted source assertion are
trusted capabilities configured outside untrusted checkout/event content. The
callback must independently resolve current Grant/revocation/authority inputs and
inspect `intent.body` (the serialized payload snapshot) and map each
method/endpoint/target and its payload semantics to the correct scoped
operation and path. It must not copy authority from `intent.context`, accept an
Agent Boolean, or turn arbitrary endpoints into an authorized operation. Snapshot
inputs are cloned before provider awaits; later mutation cannot change a running
checkpoint. Invalid or uncloneable inputs reject without mutation. The callback
must return promptly; it is trusted Core code, not an unbounded external reader.

Local mode uses the existing stored-login transport and `/user`; it does not
inherit token overrides or substitute the selected member for the operator.
Hosted mode requires an explicitly injected trusted transport, never invokes local
login, and does not require service credentials to support `/user`. The hosted
identity must be verified by its owner before injection; an assertion originating
in an event or provider body is not sufficient.

Every call reads the repository, Issue, selected user and effective permission
through the real provider. It requires public visibility, exact repository and
Issue identities, current matching Assignee stable ID and login, and Write,
Maintain or Admin effective permission. PRs returned by the Issues API reject.
Personal and organization owners use the same repository endpoints. Effective
permission (including inherited grants) comes from the official permission
response, not organization membership or labels. Unknown roles reject.

Freshness uses a Core-selected checkpoint duration, not a product-wide TTL.
Every successful read must be observed at or after checkpoint start, no later
than the trusted current clock, and before the exclusive duration bound. Final
Grant verification uses current time and must finish within that bound; backwards
or invalid clocks, cancellation, failed/missing reads and expired observations
reject. Each checkpoint retains its latest validated clock value; later reads
and final verification cannot move behind it, even within the duration bound.
No API accepts caller-supplied observations. Checks are sequential,
non-atomic GitHub observations: a change after a check can only be caught at the
next controlled checkpoint. This does not promise instantaneous revocation.

Eligibility returns `{ok, observation}` with source, times and scoped stable IDs,
or `{ok:false, diagnostic}` with bounded categories and provider HTTP status and
correlation when available. Raw responses, private bodies, keys and transport
errors are excluded. Provider mutations retain their existing fixed-schema
results; authorization rejection yields `failed/unauthorized`. A submitted write
is not verified completion. Lost responses remain unknown, never automatically
resubmit, and may be reconciled with readback. Readback grants no new mutation.

Fixture provenance: retained tests use synthetic values for the fields specified
by GitHub's [user API](https://docs.github.com/en/rest/users/users),
[repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository),
[Issue API](https://docs.github.com/en/rest/issues/issues#get-an-issue) and
[effective permission API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user).
The tests exercise these responses through the provider's injected transport and
use real locally signed Ed25519 Grant fixtures. They do not certify live provider,
multi-member or deployment behavior; those integrations belong to #121 and #122.
