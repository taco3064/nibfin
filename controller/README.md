# Nibfin development controller

This is the executable development controller for Nibfin, gh-nibfin and
nibfin-action. Its initial maintained source is transplanted from the working
upstream implementation at the revision recorded in `origin.json`, including the
deferred-notification correction. Source hashes retain the exact origin of each
copied file. Further fixes belong here and run through protected PRs and CI.

This bootstrap does not depend on issue #231 completing. Its source can develop
the three repositories using the existing signed portfolio, protected work,
role sessions, restricted Agents, event outbox and verified downstream gates.

## Onboarding remains the public product contract

Users continue through the official gh-nibfin init, runner create/register and
upgrade interfaces. Members use their own model logins and Runner identities.
The localhost dashboard remains in scope. No private upstream access, maintainer
keys, private grant, fixed host layout, new mandatory command, manual signing or
second controller setup is added to user onboarding.

During this development cutover the existing private Actions transport and
protected host configuration remain infrastructure. They execute these Nibfin
source bytes; they are not a public installation dependency or evidence that
external onboarding is complete. `bin/controller.mjs` and the nested workflow samples
are retained compatibility interfaces for that transport. `bin/controller.mjs`
provides the Nibfin entry point. Nested workflows are source fixtures, not
additional active workflows.

## Cutover and subsequent upgrades

An installed revision must be identified by public Nibfin commit and controller
digest, with a separately signed `controllerSource` installation binding.
`verifyControllerBinding` checks that binding against all three repositories
without changing the approved portfolio or historical evidence. The signing
key, model credentials, live configuration and state never enter this tree.

Install at an idle boundary after tests and protected merge; retain the previous
installation for rollback. Existing work is preserved as unaccepted source and
must pass its normal independent gates. A running stable controller may develop
its successor but cannot install unreviewed work into itself. Unknown writes
remain stopped for reconciliation. Do not run two lifecycle owners on one state.

## Verification

From this directory, `npm run check` checks JavaScript syntax and `npm test`
executes retained upstream tests plus self-binding tests. Two upstream suites
depending on private deployment evidence or an experimental host are explicitly
excluded in `origin.json`; their historical results are not imported.

This development controller is not yet the public Core distribution. Public
packaging consumes the maintained implementation through the existing #233,
gh-nibfin #55/#56 and nibfin-action #17 interfaces, with one runtime owner rather
than a parallel product engine. Real onboarding/recovery claims require actual
installed-provider verification.
