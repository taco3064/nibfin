# Nibfin documentation shell

This independent package uses Node 22.12–22.x and npm 10.x (verified with
Node 22.23.3/npm 10.9.9). Run commands from `website/`; no root installation,
workspace or Core import is required. Exact direct dependencies and the genuine
registry lockfile belong only to this directory.

```sh
npm run evidence
npm run dev
```

`evidence` first runs a locked `npm ci --no-audit --no-fund`, then sequentially runs `typecheck` (Astro and TypeScript), `lint` (ESLint),
`blueprint` (real Blueprint inspect), `content`, `test`, `test:boundaries`,
`build` (Astro, React, Starlight and Pagefind), and `links`. It stops on any failure.
Each script can also run separately. `check` runs the same validation without
packaging evidence. `links` requires an existing successful build.

The environment needs writable executable scratch and sufficient dependency/cache
space. If `/tmp` is limited, set `npm_config_cache` and `TMPDIR` to appropriately
sized verifier-owned writable storage. Do not delete someone else's inputs or
attempt to provision the host. Locked dependency caches may be reused.

## Framework and semantic ownership

Starlight owns routes, navigation, search, TOC, theme switching and documentation
components. Tailwind v4 utilities and centralized Starlight tokens live in
`src/styles/theme.css`; Tailwind preflight is deliberately excluded to preserve
Starlight's base styles. Flowbite React's real `Badge` renders the verification
status on Overview through Astro's React renderer. It is server-rendered only:
there is no interaction to justify hydration, browser state or a second theme
switcher. Tailwind's dark variant follows Starlight's `data-theme` attribute.
The [official Astro integration guide](https://flowbite-react.com/docs/guides/astro)
documents server rendering without a client directive. The static badge uses Flowbite's color classes and contains a textual
status, so status does not depend on color alone.

Blueprint's module-first root is `src/modules`. `status` owns release-status
presentation and may consume `policy`; `policy` owns product-boundary copy and
cannot import presentation. The module roots are Blueprint containers. New
reusable components may use the declared components layer. All governed TS/TSX
files are evaluated by Blueprint inspect and emitted structural ESLint rules.
Review still owns semantic responsibility: these modules contain neither network
operations nor credentials nor delivery logic. No package lifecycle installs hooks.

`src/content.config.ts` is an Astro framework adapter outside the governed module
root. Astro checks it and the MDX import chain. The narrow `Head.astro` framework adapter preserves Starlight head entries and
corrects its file-based 404 canonical/OpenGraph URL to `/nibfin/404.html`.
Blueprint does not claim to govern
Astro/Markdown/MDX. Astro's schema/compiler, the separate English/metadata/area
content check, generated HTML link checks and content review cover those surfaces.
English-only checking rejects CJK copy and verifies the expected area inventory;
human review is still needed for language and truthful claims generally.

## Distinguishing checks

`test:boundaries` copies source and configuration into temporary writable storage
and reuses genuine installed dependencies. It first passes Blueprint, then adds a
forbidden policy → status module import and requires Blueprint to reject it. It
separately requires Astro to reject a TSX assignment error and malformed MDX YAML.
The copy is removed after execution; submitted source is not mutated.

`test` retains positive and negative generated-link fixtures, including missing
files and fragments, and malformed content rejection. `links` parses actual HTML,
resolves relative and `/nibfin/` paths, checks destination existence and fragments,
all seven routes and navigation, English language, descriptions, canonical URLs,
the rendered status and Pagefind output. It does not prove browser interactions.

## Candidate evidence and integration handoff

`out/site.tar.gz` preserves the complete successful `dist/` with relative paths.
`out/build-evidence.json` records exact source-byte SHA-256 identities, direct
installed package versions, Node/npm versions, commands, actual exit codes and
logs, execution reference and archive digest. These are mandatory ignored
Candidate artifacts; `node_modules`, `.cache`, `.astro` and `dist` are not the
artifact inventory. Core binds the artifacts to the final Candidate. The record
has no self-referential Candidate digest. Re-run evidence after changing inputs.

The workflow uses the website lockfile on GitHub-hosted runners, read-only
contents permission and checkout without persisted credentials. It runs local
checks and creates evidence; it neither deploys nor installs Core. Repository
protections and independent delivery gates remain in force.

This is a truthful English shell, not a verified product installation guide.
Public repositories with individual or organization owners and multiple
collaborators are the product scope; private support is excluded. No release,
Agent/platform combination, provider lifecycle or deployment is certified here.
#132 owns integrated desktop/mobile/light/dark and keyboard/focus/browser checks,
real route/asset/search behavior and actual Pages deployment. Output is configured
for `https://taco3064.github.io/nibfin/`; no live deployment is claimed.
