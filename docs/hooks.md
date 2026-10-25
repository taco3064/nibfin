# Two-pass hooks

`createHookRunner`, `verifyHookReceipt` and `hookProcess` are exported by
`@nibfin/core`. Construction is inert. Trusted Core supplies configuration and
protected expectations; repository prose, hook output and model claims cannot
supply them. This module produces hook evidence, never Acceptance or permission
to commit. Core retains responsibility for independent roles and all transitions.

Create the runner with `{image, socket, timeout?, process?}`. The image must be
an immutable `sha256:` identity of an approved, credential-free Linux/amd64 image
containing `/bin/sh`, Git and every mandatory offline hook prerequisite. Use the
existing Linux/Codex profile's pinned Docker version and rootless backend's `/run/user/<uid>/docker.sock`. Runtime checks
reject other OS/architecture or non-rootless daemons. Container UID 0 maps to the
rootless daemon owner; run Core as that same OS user. No installation, pull,
Agent login, host home, Docker socket mount or controller mount is supplied to
hooks. Only owned disposable scratch is mounted writable. The image is trusted
configuration and must itself contain no credentials. Network is disabled;
filesystem capabilities, privilege escalation and healthchecks are disabled.

Call `await runner.execute(input)` with:

- `profile`: separately protected current backend identity, equal to `runner.profile`
  (profile ID, image and Docker version). Receipts bind this identity as well as policy.
- `workspace`: verified immutable workspace handle from capture/import;
  `expected`: its separately protected current descriptor.
- `phase`: `pre-accept` or `pre-commit`; `message`: original exact Buffer bytes;
  `executionId`: fresh Core-owned execution identity, never a hook-supplied value.
- `observation`: current trusted hook configuration/prerequisite observation in
  `validateHookObservation` format, exactly matching the workspace inventory.
  Unsupported effects, credentials, network requirements or unavailable tools
  must be reported as unresolved prerequisites, not marked available.

The runner reconstructs the Git repository/index from retained objects and writes
required sources, including ignored artifacts. It executes inventory order with
POSIX shell with an explicit `./` script-path prefix, including for filenames
that begin with a dash; message events receive `/job/message`, and prepare-commit-msg also
receives `message` (Git's explicitly supplied message source). It compares all
worktree files/modes, retained sources, index tree, staged changed paths, Git
administrative metadata and exact message bytes after each hook. Git metadata
changes and symlinks reject before Git observation. No hook-authored verifier
JSON is accepted. Hooks may read/write disposable workspace/index/message files,
but any persistent mutation rejects, including zero-exit mutations. Effects
requiring network, credentials, host mounts or unsupported executables block.

On first-pass success, independently verify the returned `receipt` with
`verifyHookReceipt(receipt, currentInput, {identity, consumed})`. The identity
is the separately protected receipt identity recorded from the actual runner
result; consumed contains already used receipt identities, never receipt claims. Persist it and its identity; create the
existing `pre-accept-hooks` evidence envelope with `inputs.receipt` set to this
identity and `inputs.candidate` to the workspace Candidate. Independent Accept
then consumes the identity of that stage envelope in `inputs.hooks`.

Second-pass inputs additionally require `first`, `firstExecutionId`, `firstReceiptCurrent`, `firstStage`,
`firstStageCurrent`, `firstStageIdentity`, `accept` and `acceptCurrent`.
`firstReceiptCurrent` protects the recorded first-pass receipt identity/replay state.
`firstStageCurrent`/`acceptCurrent` are separately protected `{expected, consumed}`
evidence contexts for `compareEvidence`, including replay state. Acceptance must
be accepted, independent, bound to this Candidate and first-pass stage. The runner
verifies these links, re-executes hooks and binds its receipt to both first-pass
and Acceptance identities. Core wraps it as `pre-commit-hooks` with the existing
Candidate/phase/accept/receipt fields. Any change requires fresh applicable proof.
Core must reject reused execution identities and stale current expectations.

Success is `{ok:true, receipt}`; an explicitly verified empty inventory returns
`status: 'not-applicable'` without launching processes. All receipts have a
`contentIdentity` over their payload, excluding `identity`. A self-consistent
receipt cannot replace current protected expectations. Failure returns
`{ok:false, diagnostic, cleanup, residual}` without a receipt; invalid inputs
throw. Nonzero, timeout, lost/malformed outcomes or failed observation stop the
sequence. Owned containers are forcibly removed before observation; scratch is
removed in finally. Unresolved cleanup reports owned resource names and retires
that runner object. Core must reconcile termination/cleanup before any retry;
constructing another runner is not permission to bypass reconciliation.

## Integration handoff to #121

1. Release/package this implementation. Record its immutable version, image,
   backend, Candidate descriptor, current observation and original message bytes.
2. In an authorized rootless Linux environment, run the first pass using the
   default process boundary, persist/verify the receipt, obtain real independent
   Acceptance and its protected evidence, then run/verify the second pass.
3. In disposable integration Candidates, declare hooks that probe credential
   sentinel access and network denial. Capture actual invocation/denial evidence
   and both bound receipts without logging secrets. Separately exercise ignored
   artifact, source, index-only and message-only mutations; require rejection.
4. Record actual container outcomes, cleanup and released Candidate identities.
   Missing daemon, tools or isolation resources block that integration case.

`test/hooks.test.mjs` uses real disposable Git/filesystem operations and production
verification, injecting only external process/container observations. It checks
invocation configuration and module behavior; it does not measure sandbox denial.
No live isolation, provider/model or GitHub integration success is claimed by
these local tests. #121 owns those live measurements using the released module.
