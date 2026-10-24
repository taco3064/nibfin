# Core package and bootstrap contract

The root `package.json` and `package-lock.json` belong exclusively to Core.
The local package is `@nibfin/core` version `0.1.0`, ESM only, with one public
export: `@nibfin/core`. There are no runtime dependencies, install scripts,
credential reads, network lookups or execution on import. The package is private
to prevent accidental registry publication; no license grant is asserted.

## Public identity API

```js
import { githubId, repositoryCoordinates, memberRunnerLabel } from '@nibfin/core';
githubId('9007199254740993'); // exact string, never converted to Number
repositoryCoordinates('Example-Org', 'Core');
// { owner: 'example-org', repository: 'core', key: 'example-org/core' }
memberRunnerLabel('42'); // 'nibfin-user-42'
```

`githubId(value)` validates repository, user or runner database IDs. The caller
retains the semantic ID kind. Only strings matching `[1-9][0-9]*` are accepted.
Zero, leading zeros, signs, fractions, whitespace, nondecimal text and numbers
throw `TypeError`; IDs beyond JavaScript's safe integer range remain exact.

`repositoryCoordinates(owner, repository)` takes two separate strings, never a
URL or combined path. Owner syntax is 1–39 ASCII letters/digits/hyphens, with
alphanumeric ends and no consecutive hyphens. Repository syntax is 1–100 ASCII
letters/digits/underscores/dots/hyphens, excluding `.` and `..`. Both are
lowercased for deterministic comparison; the returned object has `owner`,
`repository` and `key`. Missing components, slashes, backslashes, control
characters and traversal paths throw `TypeError`. No trimming or URL parsing
occurs. Personal and organization owners follow identical syntax. Syntactic
validation does not prove a repository exists or establish ownership.

`memberRunnerLabel(userId)` validates the same decimal ID contract and returns
`nibfin-user-<ID>`. A routing label is distinct from a stable ID and from repository
coordinates. Labels prove neither registration nor identity nor authorization.
These helpers do not check permissions or implement Runner selection/scheduling.

## Reproduce installation and archive verification

Prerequisites: Node.js 22.x, npm 10.x and a writable OS temporary directory outside
the checkout. Commands run from the root, with website/ absent or present:

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run check
npm run verify:archive
```

No registry installation is needed. `check` discovers only `test/*.test.mjs`.
It tests public imports, malformed inputs, real archive rejection, byte
correspondence and disposable website coexistence. `verify:archive` uses offline
`npm pack`, normalizes the output to `out/nibfin-core.tgz`, reads the actual gzip/tar
payload and enforces the exact file allowlist in `tooling/archive.mjs`:
`package.json`, `README.md`, `docs/package.md`, `src/index.mjs`.
Every entry is mandatory and must match the producer bytes. Unexpected entries,
duplicates, links, unsupported tar types, bad checksums and absent runtime files
fail. Tests, tooling, controls, secrets, donor material, prototype commands,
website output/dependencies and producer node_modules are excluded.
Regenerate the archive after changing any packaged file; it is a mandatory
ignored candidate artifact, not a cache. No build transformation is required.

The same command installs that exact archive into a fresh external temporary
consumer using `npm install --offline --ignore-scripts --no-audit --no-fund`.
It passes a minimal environment without inherited credentials, imports by package
name, verifies the installed resolution, checks success and rejection, and removes
consumer state on success or failure. npm offline mode prevents registry fetching;
the smoke program uses only Node built-ins and this package. Core executes any
required hooks in its separate credential-free, network-disabled environment;
this baseline introduces no hook manager.

A manual local consumer example (run after archive verification):

```sh
archive="$PWD/out/nibfin-core.tgz"
consumer=$(mktemp -d)
(
  trap 'rm -rf "$consumer"' EXIT
  cd "$consumer"
  printf '{"private":true,"type":"module"}\n' > package.json
  npm install --offline --ignore-scripts --no-audit --no-fund "$archive"
  node --input-type=module -e "import {githubId} from '@nibfin/core'; console.log(githubId('42'))"
)
```

## Ownership and downstream handoff

Root tooling does not aggregate a workspace or install/govern website dependencies.
Future website work owns `website/package.json`, its separate lockfile and local
configuration. `.github/workflows/core-ci.yml` checks the root package on relevant
PRs and main pushes using GitHub-hosted runners and read-only contents permission.
The separately owned `website-ci.yml` handles website checks/deployment; this
baseline does not create it. Root ignore rules cover only root generated output
and node_modules. The coexistence fixture includes failing website tests and
uninstallable website dependencies to detect accidental coupling.

Future nibfin-action and gh-nibfin consumers use this reviewed package boundary
and public entry instead of copying Core or importing checkout-relative modules.
This Issue writes neither repository. The archive is a local integration contract;
formal immutable release identities, compatibility metadata, official Action/CLI
installation, upgrades and publication remain later work. A future consumer must
verify its approved immutable version/content and compatibility before execution;
floating latest must not silently replace an authorized runtime. No private donor
repository is an installation or runtime dependency.
