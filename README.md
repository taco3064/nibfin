# Nibfin Core

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

The [approved-export contract](docs/authority.md) documents full representation,
independent approval, cycle binding and dependent-evidence invalidation. It uses
locally supplied exports and does not connect to live Notion.

The [protected registration contract](docs/registration.md) provides Owner opt-in,
fresh member eligibility and encrypted short-lived responses through Actions
artifacts. #122 owns actual protected-host/channel integration proof. Production
artifact hosts still need the genuine pinned SDK in [custody.md](docs/custody.md).
Its separate `npm run test:artifact-sdk` regression requires an existing approved
runtime via `NIBFIN_ARTIFACT_SDK_ROOT`; Core CI provisions and runs that suite.
