# Nibfin Core

This repository owns the single Nibfin Core implementation. The current baseline
provides a standalone ESM package, canonical GitHub identity helpers, and local
archive installation checks. It is not a published release or a complete delivery
runtime, and makes no Agent or supported-platform certification claim.

Nibfin's planned delivery runtime uses per-Issue native GitHub dependencies,
Owner authorization, independent Shape validation and Acceptance, verified CI,
final review, protected merge and completion evidence. Public repositories owned
by individuals or organizations and multiple collaborators are the product scope;
private product support is excluded. Coordinates and Runner labels grant no
execution permission. Public visibility does not authorize untrusted fork/PR code
to run on credential-bearing self-hosted Runners.

Use Node.js 22.x and npm 10.x (development baseline: Node 22.23.3, npm 10.9.9).
No third-party dependencies or build compiler are needed:

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run check
npm run verify:archive
```

The last command builds and inspects `out/nibfin-core.tgz`, compares all packaged
files with source and tests an independent offline installation. See
[the package contract](docs/package.md) for imports, rejection rules and the
Core/website/Action/CLI ownership handoff. These local checks establish package
behavior; independent Acceptance and repository CI remain separate gates.
