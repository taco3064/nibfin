# Nibfin Core

[English documentation](https://taco3064.github.io/nibfin/)

This repository owns the single Nibfin Core implementation. The current baseline
provides a standalone ESM package, canonical GitHub identity helpers, explicit
Grant preparation/signing/verification APIs, approved authority export/import and
explicit synchronization, Actions OIDC source and predecessor verification, and local archive installation checks. It is not a published release or a complete delivery
runtime, and makes no Agent or supported-platform certification claim.

Nibfin's planned delivery runtime uses per-Issue native GitHub dependencies,
Owner authorization, independent Shape validation and Acceptance, verified CI,
final review, protected merge and completion evidence. Public repositories owned
by individuals or organizations and multiple collaborators are the product scope;
private product support is excluded. Coordinates and Runner labels grant no
execution permission. Public visibility does not authorize untrusted fork/PR code
to run on credential-bearing self-hosted Runners.

Use Node.js 22.x and npm 10.x (development baseline: Node 22.23.3, npm 10.9.9).
The runtime dependency is pinned JOSE; no build compiler is needed. Routine local checks use narrow artifact-client boundary doubles and require no
artifact SDK download:

```sh
npm ci --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund
npm run check
npm run verify:archive
```

The last command builds and inspects `out/nibfin-core.tgz`, compares all packaged
files with source and tests an independent offline installation. See
[the package contract](docs/package.md) for imports, rejection rules and the
Core/website/Action/CLI ownership handoff. These local checks establish package
behavior; independent Acceptance and repository CI remain separate gates.

The [single-stage Core entry](docs/core.md) composes maintained lifecycle owners
with fresh authorization and native dependency checks. Its retained local proof
does not certify live Actions execution.

The [approved-export contract](docs/authority.md) documents full representation,
independent approval, cycle binding and dependent-evidence invalidation. It uses
locally supplied exports and does not connect to live Notion.

The [protected registration contract](docs/registration.md) provides Owner opt-in,
fresh member eligibility and encrypted short-lived responses through Actions
artifacts. #122 owns actual protected-host/channel integration proof. Production
artifact hosts still need the genuine pinned SDK in [custody.md](docs/custody.md).
Its separate `npm run test:artifact-sdk` regression requires an existing approved
runtime via `NIBFIN_ARTIFACT_SDK_ROOT`; Core CI provisions and runs that suite.

The [Windows-hosted WSL adapter](docs/wsl.md) implements the protected Linux/Codex backend bridge with local contract tests. Native Windows and Windows-hosted WSL execution remain Unverified; platform integration evidence belongs to gh-nibfin#28.

The [workflow bundle v1](docs/workflows.md) supplies reusable hosted Resolve/member Execute, independent wakeup and protected registration entries, with content-pinned installation plans and local caller fixtures.

The [immutable release contract](docs/releases.md) defines the release CD workflow,
exact local Candidate assets, installer identity checks and evidence limits.
Publication success is confirmed after protected Merge; local packaging does not
certify CLI/platform support or full P1 delivery.

The [public collaboration adapter](docs/collaboration.md) documents versioned identity and binding checks, the reusable local Runner instance lifecycle, and the approved source origin mapping. Local source tests do not certify live multi-member isolation or external E2E.
