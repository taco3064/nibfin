# Member capacity and repository-owned Actions

This is the current product target, including installations outside the three
Nibfin development repositories. Runner capacity belongs to a member and is
independent of the number of projects. For example, ten projects may share six
execution slots. A deployment must not require six permanently assigned Runners
for every project, or dispatch their development work to a controller repository.

Each project installs its own stage, delivery and Rescue workflows. Its native
Workflow Run, Jobs, logs, artifacts and conclusions remain in that repository.
Run names show the Issue and stage, such as `#198 | Accept` and
`Rescue | #198 | Accept`; a repository prefix is unnecessary. The Core/Action
distribution may come from another repository; that does not transfer Run
ownership. Actions identity must always agree with the actual project.

Version 2 pool configuration has `id`, `capacity` and explicit protected `targets`.
It has no execution/source repository. Ownership and administration are checked
for each target. Capacity is finite and independent of target count. The protected
host serializes slot allocation; an unknown registration, live process, unknown
write or incomplete cleanup keeps its original slot occupied. A completed Job
cannot be scheduled again by replaying its allocation request.

GitHub repository-level Runner registrations serve only one repository. For
personal-account projects, the maintained host must allocate a free slot and
create a repository-scoped ephemeral registration, execute the authenticated Job,
confirm termination/deregistration and clean its disposable work before reusing
the slot elsewhere. This shares capacity, not a permanent cross-repository
registration. Organization Runner groups may supply native shared registration
where applicable; either path preserves project-owned Runs. See the official
[Runner scopes](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)
and [ephemeral Runner lifecycle](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

The previous version 1 `source`/`targets` implementation centralized Actions Runs.
It is retained for recognition and reconciliation of old protected records, not
as the product onboarding design. Do not activate it or silently rewrite old
records. Preserve pending candidates, conversations, grants and unknown writes.

Current source provides version 2 configuration, repository-local workflow plans,
context checks and a capacity allocator. These do not constitute the live
registration/dispatch adapter. The protected `createRunnerPoolHost` owner now
retains preparation, JIT registration, admission, launch and cleanup intents. It
registers in the authenticated Job's project, reconciles a lost launch reply
against the existing process, and retains the original Job result before cleanup.
An unknown registration result keeps the slot; it never authorizes a second POST.
Its blocked-event notification is not an AI diagnosis or a repair verdict.
Current Issue eligibility authorizes launch, not cleanup. A closed or revised
Issue stops new registration/start; independently authenticated completed Jobs
can still retain their outcome, remove their registration and release the slot.
Native service assembly, actual Job admission,
registration cleanup, recovery notifications and original-work reconciliation
must be integrated and verified before activation. No six-slot/ten-project live
execution or completed takeover is claimed by source fixtures.

Every eligible blocker must receive a retained AI diagnosis with its cause and
repair outcome in the Action log, including deterministic repair paths. A
successful retry dispatch is pending verification. Only independently verified
resolution is green; failed repair, failed diagnosis or unresolved verification
is red. Permission/authority holds and unknown writes cannot be bypassed by AI.
