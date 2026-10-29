# Runner job admission

Agent container isolation does not restrict arbitrary jobs assigned to a GitHub
self-hosted Runner. The public Core supplies one separate admission primitive,
`runnerJobPolicy` / `verifyRunnerJobAdmission`, and the installed
`host/runner-job-hook.sh` entry. This narrows an instance to exact reviewed workflow
bytes and a verified Run/Attempt/job/Runner identity. It grants no execution,
Issue, model, registration or merge authority; those still belong to Core.

The required CLI integration installs the hook outside Runner and participant workspaces, writes a
private policy, and configures `ACTIONS_RUNNER_HOOK_JOB_STARTED` and
`NIBFIN_RUNNER_JOB_POLICY` in the actual Runner service environment. It must
verify the installed source inventory, official Runner binary/worker hash and
supported process layout before enabling a public instance. Model/event/Issue
input never selects executable code, the policy file or approved source. Missing
or incompatible capability is a readiness error, not permission to omit the gate.
This source primitive is not itself a complete CLI installer or certification.
Do not execute the live hook as a read-only `init --check` probe: that command
inspects the installed policy/capabilities without aborting its enclosing Job.
One policy file may hold `{schemaVersion:1, policies:[...]}` for separately pinned
Controller and Rescue workflows on the same instance. Duplicate source/job entries
or differing installation identities reject. Events default to workflow dispatch;
workflow-run recovery must be explicitly included in the reviewed policy.

GitHub's pre-job hook nonzero exit is insufficient: an actual disposable Runner
2.338.0 probe observed an `always()` step succeeding after `Set up runner` failed.
The denied-job entry therefore terminates its live `Runner.Worker` ancestor before
returning, rather than relying on ordinary step failure. It checks the executable
and `/proc` process start time; it never chooses a PID from event data or a stale
file. The shell wrapper also aborts that Worker if the Node entry fails. A second
real disposable probe terminated the Worker and the sentinel step never started.
Do not present the expected failed probe Run as product delivery failure or use
an untested hook as a blanket host security guarantee.
Its Node child runs under an interruptible wait: INT, TERM and HUP during
admission also abort the Worker rather than deferring rejection until a child
network call returns. Linux process tests exercise each signal while the child
deliberately keeps waiting, using a disposable Worker-named process fixture.

Admission requires an authenticated read of the Run, this exact Attempt's jobs
and the workflow file at the Run's immutable head SHA. Repository/owner IDs,
actors, event, branch, workflow bytes, job name and assigned local Runner must
all match the locally installed policy. Workflow dispatch hints and Runner labels
alone grant nothing. Policy retains the official Worker binary SHA-256; API
errors, unknown state, changed source, audit failure and mismatches deny. Provider
stderr and credentials are never public diagnostics. GH_TOKEN/GITHUB_TOKEN and
other inherited overrides are omitted from management subprocesses; the intended
execution account owns its stored gh login.

The hook uses the supported Linux `/proc` and fixed Node/gh locations. It reads
only bounded regular files with expected ownership and records private admission
results beside the policy. Use the maintained CLI and package readiness contract
to install/update/remove this alongside the Runner lifecycle; do not copy scripts
by hand as end-user onboarding. Existing source/Runner changes require reviewed
policy updates at a safe boundary. Preserve independent model logins, unrelated
registrations and protected pending work.

The host administrator, OS, immutable installed sources, Runner binary and gh
login store remain trusted. A hook is not a VM boundary or protection from a
compromised Runner/OS. Unsupported layouts and real Linux/WSL registration,
service, credentials and lifecycle support remain explicit until actually tested.


## Official Organization registrations

The optional policy field `registrationLevel` is `repository` by default or
explicitly `organization`. The official Runner stores the configured registration
URL in `.runner.gitHubUrl`; an Org-level registration therefore has an Org URL,
not a fabricated repository URL. The Hook parses that exact scope and retains
all actual Run/Attempt/job/Runner, binary and workflow-source checks.

An Org policy requires matching Org URL, target owner ID and authenticated
`Organization` owner type. A per-instance policy set may list distinct exact
repositories in that same Org, each with its own stable ID and workflow pins.
Unlisted repositories, inconsistent names/IDs, another Org, mixed registration
levels or another instance reject. Repository registrations remain bound to one
repository. The Hook selects a listed repository before making bounded API reads;
Org registration never becomes blanket admission or Issue authority.

This implements source-level scope compatibility. It does not certify a live
Organization registration or replace the Core's independent eligibility checks.
Official source: https://github.com/actions/runner/blob/v2.331.0/src/Runner.Listener/Configuration/ConfigurationManager.cs#L140

## Reusable workflow source binding

An optional protected `workflowDependencies` list pins one to eight distinct local
workflow paths and SHA-256 digests. The caller cannot also be a dependency. The
Hook reads each dependency from the same repository at the actual Run commit,
never from a moving branch or event-selected URL. Admission requires the complete
ordered set, exact Git blob identity and original bytes; a missing, replaced or
unreadable callee denies the Worker before any workflow steps. Older policies
without this field retain their existing single-workflow contract.

Shared-pool source installations bind each generated stage caller to its own
fixed delivery callee. These policy entries still describe one physical source
registration; they do not create per-logical-repository Runner registrations.
