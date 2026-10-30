# Local Candidate capture

`@nibfin/core` exports `captureWorkspace`, `verifyWorkspace`, `exportWorkspace`,
`importWorkspace`, `materializeWorkspace` and `workspaceLimits`. These synchronous APIs require Node 22
and Git with SHA-1 repositories. No provider, login or network is used. Hooks,
filters, credential helpers and external diff drivers are never executed. Lazy
object fetching and all Git transport protocols are disabled; each subprocess has
a 30-second timeout.

```js
import {captureWorkspace, verifyWorkspace, exportWorkspace, importWorkspace,
  bodyDigest} from '@nibfin/core';
const snapshot = captureWorkspace({
  root: '/absolute/repository', base: explicitCommitSHA,
  scopeBody, shapeBody, permittedPaths: ['src', 'docs', 'package.json'],
  binding: {repository: 'owner/public-repository', cycle: 'cycle-id',
    policy: protectedPolicyHash, scopeHash: bodyDigest(scopeBody),
    shapeHash: bodyDigest(shapeBody)}
});
// Core retains this expectation separately in protected custody at capture time.
const expected = snapshot.expected;
const transfer = exportWorkspace(snapshot);
const restored = importWorkspace(transfer, {expected});
verifyWorkspace(restored, expected);
// Trusted host selects an empty/nonexistent destination below its private directory.
materializeWorkspace(restored, {expected, root: '/private/role/checkout'});
```

On Linux, `materializeWorkspace` restores the verified base commit, Candidate tree,
file modes and declared ignored sources into an independent role checkout. It uses
local object writes and raw file bytes, without fetching, filters or repository
scripts. The immediate parent must belong to the current account and be private.
Existing nonempty directories and links are rejected; original work is never
overwritten. A private staging tree is published only after all content is checked,
and removed on failure. This filesystem receipt does not grant Acceptance or mark
pending work as accepted. The protected host still supplies the independently
retained expectation and chooses when the role may consume the checkout.

`base` must be the full immutable commit ID, never an ambiguous revision expression.
The caller authenticates repository identity and supplies its permitted paths and
Scope/Shape/cycle/policy bindings. A path permission covers that path and its
children. Every base-tree file, proposed file and declared source must be within
these explicit permissions. Required ignored files must appear in Shape's unique
`kairo-candidate` block; empty arrays need the parser's separate applicability
explanations. This consumes the producer's inventory, without discovering host Git
configuration. Producer validation and independent Candidate/Hooks gates still apply.

The proposed tree uses final worktree bytes for all indexed files and nonignored
untracked files. Partial staging does not override final worktree bytes. Missing
tracked files become deletions; ignored files are additional sources only unless
already tracked. Index flags, sparse-checkout intentions and Git clean filters do
not transform these raw bytes. Executable mode follows worktree execute bits.
The real index, worktree and source object database are not modified. A temporary
bare Git repository with no templates computes `diff-tree --binary --full-index
--no-renames -p` between the retained base tree and proposed tree, with external
drivers and text conversion disabled. Deleted files and both sides' modes/object
IDs appear in `metadata.changes`; rename is represented as deletion plus addition.

For retained work using a separate Git directory, the trusted host may explicitly
supply `gitDirectory` alongside `root`. Both locations stay in place: capture
uses fixed `--git-dir`/`--work-tree` arguments and the same credential-free,
transport-disabled Git commands. The metadata directory and its ancestors must
be real directories without links. This path is never derived from a transfer
or model output. The resulting transfer contains the same files, objects and
protected expectation as a normal checkout; no Git configuration or credentials
are imported into the independently materialized role workspace.

Supported paths use ASCII letters, digits, underscore, dot and hyphen components.
Names such as `untracked..file` are unambiguous. Spaces, control characters,
non-UTF-8 names, `.git` components, traversal and absolute paths fail explicitly.
Only regular files, normal/executable blobs and trees are accepted. Symlinks
(including ancestors), submodules, special files, unreadable declarations and
unmerged index stages fail. SHA-256 repositories are explicitly unsupported.

Snapshots retain the base commit, complete base/proposed trees and blobs, exact
binary diff and declared artifact/hook bytes, modes, purposes and event order.
They do not retain commit ancestry or claim to be a full repository backup.
Metadata and buffer getters return copies. Source deletion and mutations of caller
inputs or returned objects cannot change retained custody. Repeated observations
compare file bytes/modes, index entries, HEAD, untracked inventory and declared
sources; inconsistent observations throw without returning a partial snapshot.
This detects observed races, not an OS-atomic snapshot or protection against a
compromised administrator. Optional `afterRead` is a trusted caller callback for
deterministic race testing; it is never loaded from repository content.

`expected` contains the aggregate identity, binding and compatible evidence
`candidate` (base/tree/diff/paths/artifacts/hooks/emptyHooksReason). Authentication
requires this separately protected expectation. Do not derive it from an incoming
transfer: an attacker can recompute every unkeyed checksum. Missing or mismatched
expectations throw. Retain expectations through the existing protected evidence
or custody interfaces; this local module neither grants permissions nor publishes.

Transfer version 1 is canonical UTF-8 JSON with canonical base64 payloads, no
compression and no destination extraction. Import fully validates the manifest,
object hashes/tree correspondence, exact source declaration order, recomputed
binary diff and protected expectation before exposing a handle. It never writes
transfer-selected filesystem paths. Scratch object files are named by independently
recomputed Git IDs and always cleaned up. Duplicate JSON keys, duplicate objects,
missing/extra payloads, unsupported fields/types, corruption and truncation fail.

Default finite limits (overridable by the trusted caller on operations
that consume/produce bytes) are 10,000 retained payload entries including diff,
8 MiB per payload, 32 MiB aggregate raw bytes and 48 MiB serialized bytes.
`captureWorkspace` takes `limits` on its input; export/import take `{limits}`;
`verifyWorkspace` only compares already retained identities and takes no limits.
Limits have inclusive boundaries and require positive safe integers. Entries
count deduplicated Git objects, each declared source and the diff. Tree walks and
worktree inventories are additionally bounded by the entry limit. File sizes are
checked before bounded reads, Git subprocess output is capped, and import checks
serialized size before JSON parsing and decoded lengths before allocating buffers.
Export bounds retained payloads and base64 expansion before JSON serialization.
Verification and import use temporary writable Git scratch space; package consumers
must supply supported Git and executable scratch. This API is local capture only;
it does not run hooks, accept, commit, publish, schedule or close Issues.
