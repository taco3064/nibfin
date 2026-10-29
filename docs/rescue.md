# Rescue source integration

Nibfin retains Kairo's bounded recovery mechanisms in the public Core. Recovery
metadata uses the existing protected host state/custody owner through
`createRescueRecords`; it is not delivery evidence or another scheduler.
`createRescueHost` attaches to the existing relay. It authenticates the exact
webhook bytes before JSON parsing and retains notifications; it never executes
stages. `createWorkflowEntry`'s authenticated `rescue` mode runs the maintained
controller. Only normal Core owners execute original-role repairs.

Install exactly one English **Nibfin Rescue** workflow from
`workflow/templates/nibfin-rescue.yml`. It accepts typed case, source Run/Attempt
and mode inputs. It has no workflow_run trigger, self-completion subscription,
cron, skipped-job fallback or untrusted source checkout. Current-main workflow
blobs must match trusted configuration. A historical queued source requires its
explicitly approved original head AND blob. Display text never selects work.
Native Issue events, suppressed GITHUB_TOKEN events and explicit dispatch remain
separate observations in the existing event relay and controlled operation history.

## Host and installation handoff

`rescueInstallation` supplies the #233 and gh-nibfin #55/#56 source contract:
actual repository Administration/Workflow permissions and Owner setup approval,
one webhook on the existing relay, an external protected secret, one durable
notifier, managed URL updates preserving hook/secret identity and bounded
upgrade-window backfill (at most 24 hours and 100 Runs). The installer executes
and independently reads back the plan; this library does not mutate GitHub.
Neither personal nor Organization ownership changes member execution eligibility.
Do not share Owner credentials, model logins or install per-Runner controllers.
`host/templates/nibfin-rescue-wakeups.service` is rendered by that installer with
its own trusted host values. It introduces no sudo or arbitrary command adapter.
The existing relay passes raw bytes and authenticated GitHub headers to `receive`;
never parse or reserialize before signature validation. Load the secret with
`loadRescueCompletionSecret` outside source, state and model-login mounts, under
the configured service owner, single-linked, mode 0600, with no symlink ancestors.

The storage adapter's `load` independently validates the existing state owner;
`commit` performs durable compare-and-set and readback under the existing native
writer exclusion. Missing records cannot be inferred from failed reads.
`subscribe` observes that same owner. The notifier reconstructs only retained
pending deadlines after restart. An empty inbox/case index has no timer. Repeated
unchanged source/formal Issue evidence does not allocate another Action.
Normal green source Runs without a durable case create no inbox entry or Run.
Green structured BLOCKED, lost notifications and provider-proven failures before
case creation are handled through the same authenticated inbox. Attribution reads
the original retained request/session, never a title, log substring or Issue hint.

## Authority, diagnosis and continuation

Every checkpoint rechecks current cycle, authority, Scope/Shape/Candidate,
Assignee, effective Write/Maintain/Admin permission, Runner and session ownership.
Active work defers; intentional pauses, Owner holds, changed authority,
conflicts, unattributed cancellation and uncertain writes stop. A cancelled Run
needs the provider's exact timeout annotation on the original execute job.
Known deterministic remedies precede AI. Dead-lock cleanup requires a dead PID,
original Run/Attempt/time attribution and unchanged inode/bytes immediately
before removal. Availability probes only read. Verification continuations require
the last exact retained receipt: earlier exhaustion cannot conceal a later failure.
EPIPE retains a failed receipt and reconciles descendants before releasing only
the owned verification lane. Fresh continuation never changes a failed check to pass.

The packaged `skills/rescue/SKILL.md` instructs a separate bounded read-only
session. `createRescueAgentAdapter` reuses the maintained Codex/Claude/Gemini
restricted Linux backend, each member's own login, image/egress pins and process
cleanup. No paid model execution is implied by source tests. Unsupported
profiles/capabilities, including absent safe session persistence, remain explicit. Cross-container original
conversation restoration is currently supported for the pinned Codex JSONL
session format. Claude/Gemini keep their implemented diagnostic adapters but
report SESSION_RESUME_UNSUPPORTED when a cross-container repair would require
unimplemented session restoration; they never substitute a new conversation.
The diagnostic cannot repair host/Core, execute a plan or grant any permission.
Typed plans contain only retry-original-role and 1–8 steps. Invalid/no plans,
changed preserved bytes and unsuccessful diagnosis stop. The original role's
`createRescueContinuation` retains UNACCEPTED source, original session and fresh
attempt requirements; its protected prepare capability must import that exact
workspace/session and resume that same member. Missing session bytes cannot be
replaced with a new conversation. Reviewers remain independent and read-only.
Candidate, Hooks, independent Acceptance, exact-head CI, review and protected
merge/closure remain required. A failed continuation cannot recursively reset
the shared finite Issue-cycle repair budget or cooldown.

## Results and evidence

RESOLVED/success requires `verifyCompletion` against fresh independent current
expectations, matching Issue/cycle/Scope/Shape; automatic attribution additionally
requires the actual repair continuation linkage. UNRESOLVED is failure/red.
STAGE_RECOVERED, DEFERRED, PENDING_VERIFICATION, SUPERSEDED and NOT_NEEDED have
neutral/gray semantics. Dispatch acceptance and stage receipts never resolve an
Issue. `reportRescueOutcome` accepts only a capability bound to the reporting Run;
there is no source/continuation cancellation API. The installed single-job workflow
has no safely Run-scoped gray presentation mechanism. A separate neutral Check
does not change that Run's conclusion, so all neutral outcomes fail visibly as
reporting-unsupported, retaining the actual recovery outcome. The CLI permits a
successful Rescue exit only for verified RESOLVED. Do not configure an unrestricted Actions
cancellation token to simulate a Run-scoped credential.

`rescueReport` projects sanitized existing case receipts: eligible unique cases,
triggered cases, diagnoses, actual repair attempts/dispatches and independently
verified automatic resolutions. Trigger coverage is triggered unique eligible
cases / unique eligible cases; verified repair success is verified automatic
resolutions / cases with an actual repair attempt. Zero denominators are null.
External/human completion is separate from automatic repair. Pending, exhausted
and unsupported cases remain explicit. No telemetry service or donor success rate
is introduced.

Source-only completion continues to require explicit not-applicable deployment
proof. Existing deployment recovery separately preserves attributable incidents,
comment readback before legal reopen, fresh authority and Candidate gates. Merge
facts never disappear. Unknown writes always reconcile against the original
controlled operation before any retry. Source fixtures are not live GitHub,
release, model or multi-account certification; those remain separately owned.
