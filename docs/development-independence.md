# Nibfin-owned development transport

The development Controller is maintained in `controller/`. The protected
`Nibfin action stage` and `Nibfin Rescue` workflows use its installed Nibfin
entry point and two enrolled Nibfin workers. Participant repositories send signed
notifications through `nibfin-events.yml`; their checks execute on hosted runners.
No participant checkout runs on the protected Controller workers.

An explicit Owner-signed transport migration binds the unchanged original
portfolio and policy to the installed Controller digest, exact private execution workflow
blobs, repository ID, coordination host, two worker identities and notification
bindings. Protected workers belong only to the private `taco3064/nibfin-control` execution repository; public repositories never receive protected-host self-hosted workers. This execution repository contains fixed workflows only, not product source. Public product users do not need access to it. The
controller still verifies the original Owner login and provider identities;
untrusted Issue text and dispatch hints cannot choose commands or credentials.

Grant and Proposal inputs reside in protected root-owned files outside source,
Agent credentials and mutable execution state. Their original signatures and
content hashes remain mandatory. Historical source descriptors are retained for
audit identity but resolve locally; private Kairo API access is rejected instead
of used as a fallback. Existing state, sessions, Candidates and independent
verification gates are retained. Uncertain writes must be reconciled before
cutover and must never be replayed merely because transport changed.

New entry points remain inactive until `NIBFIN_CONTROLLER_ACTIVE` is explicitly
enabled. Stage installation and rollback source, export and validate authority,
wait for an idle boundary, reconcile outstanding dispatches, then switch the
single lifecycle owner. Retired Rescue cases are archived as historical outcomes;
they are not silently certified as resolved. New recovery notifications use a
migration-bound index and retain the existing per-Issue repair budgets.

Before retiring old ingress, independently observe native Issue and dependency
notifications, CI wakeups, Nibfin-owned stage execution, durable handoffs and
recovery readiness. Preserve source attribution in `controller/origin.json`;
attribution does not require a private checkout or runtime service. This
development cutover does not certify public product release, external onboarding
or platform support.
