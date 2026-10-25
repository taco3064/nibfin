# Scope publication journal (v1)

`@nibfin/core` exports `publicationManifest` and `openPublicationJournal`. This
module retains publication evidence; it neither authenticates nor calls a
provider. #119 can consume this interface; live publication/recovery proof is
owned by #124. The retained tests simulate effects and are not GitHub evidence.

A manifest is `{version:1, approval, plan, operations}`. `approval` is the exact
approval reference; `plan` is the entire approved concrete publication plan,
including repositories/stable IDs when known, original Scope bytes/content
identities, Metadata and planned native dependency endpoints. Each operation is
`{correlation, kind, target:{repository, repositoryId}, payload}`. Kinds are
`issue`, `metadata`, `dependency`; repository coordinates are canonical lowercase
public personal or organization repositories, with identical journal rules.
`repositoryId` may be null before discovery. `payload` contains the entire exact
intended provider payload, including original Scope bytes, Metadata or dependency
endpoints. Use the upstream `checkPortfolio` and official Scope instructions for structural
Plan/Audit checking before approval. Provider-schema validity and completeness of the approved plan are
publisher obligations. Do not put credentials or unnecessary private data in it.

`publicationManifest(manifest)` returns a defensive canonical copy and identity.
Manifest, operation and record identities use the existing `contentIdentity`
format: SHA-256 of `nibfin-content-v1\n` plus canonical JSON. These product
identities are distinct from Core's Scope/body digests. The manifest is never
rewritten to insert newly assigned Issue IDs.

## Storage and consumer ordering

Use a dedicated directory on explicitly operator-persisted trusted storage.
The parent must exist. This version supports POSIX hosts only; other platforms fail preflight.
Supported filesystems must provide exclusive creation,
atomic same-directory rename, file fsync and directory fsync with durable ordering
on the deployed OS/filesystem. Unsupported flush operations fail preflight.
The operator must validate the actual storage stack's persistence semantics,
retain the directory across invocations, restrict access to trusted publishers,
and maintain backups. Preflight cannot prove future retention or protection
against a malicious host administrator. Do not select a temporary directory by
default or use ephemeral Runner storage as a persistence guarantee.

```js
import {openPublicationJournal} from '@nibfin/core';
const journal = openPublicationJournal({directory:configuredAbsolutePath,
  manifest:approvedManifest, initialize:true}); // once, new directory only
journal.intent(operation); // fsynced exact intent
journal.submission(operation); // fsynced: submission may have happened
// Only now may the caller, with fresh authorization, perform its external write.
// Retain ONLY the normalized safe outcome, never the response/error body:
journal.result(operation, 'submitted'); // or 'rejected' / 'unknown'
// Independently read the provider, match exact intent, then retain:
journal.readback(operation, {complete:true,
  matches:[{intent:operation, resolved:{issueId:'123'}}]});
```

All calls are synchronous and throw safe `publication:` diagnostic codes.
The constructor writes/fsyncs/reads/removes a probe and verifies history from disk.
No callback is invoked by this module. The caller must stop on any thrown error.
Neither the journal nor an approval string grants permission: fresh authentication,
full-plan approval, protected-work/re-authorization restrictions, current policy,
and applicable independent delivery gates remain the publisher's responsibility.
Do not select/reorder Assignees, change dependencies or modify protected work
based on journal readiness. Use official external concurrency consistently for
all writers to this directory; this is a single-writer module, not a lease,
fencing service, Admission layer, scheduler or global exactly-once guarantee.

## Record and recovery protocol

Each immutable numbered record is exclusively created, fully written and fsynced;
the directory is fsynced before committing a versioned HEAD pointer via a fsynced
pending file, atomic rename and directory fsync. Records carry sequence, previous
record identity and manifest binding. Reopening validates the entire chain,
HEAD, event transitions, identities and exact record inventory. Missing files,
partial bytes, uncommitted extra records, probe/pending remnants, symlinks,
traversal, hardlinked records, unsupported versions and stale writers stop
continuation. Earlier bytes are retained. No automatic repair or deletion occurs.
A failed commit is ambiguous even if some bytes reached storage.

Use `initialize:false` (default) on all subsequent invocations with the same
manifest; missing directories/history then fail, never recreate. Retain the
manifest identity and directory locator in the caller's durable publication
handoff. Never initialize a replacement directory to evade missing history.
Initialization of an existing directory fails, including an empty one.

`recover(correlation)` returns `absent`, `intent`, `unknown` or `complete`, the
exact operation, normalized outcomes and separate observations, with
`reconciliationRequired:true` for attempts recovered by a fresh instance or
unresolved effects. A fresh complete independent readback clears that flag. `history()` returns defensive copies. An intent
alone means this protocol has not permitted submission. A submission record
means a write may have happened, even without an acknowledgment. Results never
complete an operation. Unresolved operations and unreconciled receipts from an earlier invocation
block new submissions in the same manifest; distinct intents can still be retained. Detectable stale/conflicting
writers fail rather than merge history.

Reconcile the original operation independently after restart, even when an old
readback says complete. Read all required pages/targets with the authenticated
provider and compare stable IDs, exact Scope/Metadata or native dependency
endpoints. Supply a complete observation only after that verification. Each match
contains the independently reconstructed exact `intent` and nonempty `resolved`
stable identity strings: `{issueId}` for Issue/Metadata, and
`{blockedIssueId,blockingIssueId}` for dependencies. These are
caller attestations of an observation, not provider authentication by this module.
Incomplete/failed reads use `{complete:false,matches:[]}`; unavailable evidence
must never be converted into a complete empty listing. Mismatching or duplicate
matches and contradictory resolved identities remain unknown, with history intact.
A later complete unique matching observation can resolve a lost response or
previously incomplete read without submitting again.

There is deliberately no retry/replay API: a recorded submission cannot be
submitted again, including after a rejected result, an empty listing or a stored
success. Any unresolved or conflicting history requires operator reconciliation;
no blind Issue/dependency creation, rollback or automatic deletion is permitted.
Stop, preserve the directory, compare backup/HEAD/record identities and provider
observations, and obtain appropriate recovery authorization outside this module.
Do not manually edit records to manufacture a fresh operation. Restoring storage
requires retaining correspondence to the original intended operation and checking
possible effects; an old success receipt is never current write permission.

Local verification uses `node --test test/publication.test.mjs`, `npm run check`
and `npm run verify:archive` with Node 22/npm 10 and locked dependencies. Crash
fault tests use fresh child processes, SIGKILL and Linux `/proc/self/fd` to
interrupt actual record writes. Their scratch is verifier-owned and disposable;
this does not imply production journal directories can be ephemeral.
