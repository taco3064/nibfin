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
documents server rendering without a client directive. The static badge uses the shared semantic color adapter and contains a textual
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
#129 owns local desktop/mobile/light/dark and keyboard/focus theme checks.
#132 owns live route/asset/search integration and actual Pages deployment. Output is configured
for `https://taco3064.github.io/nibfin/`; no live deployment is claimed.

## Shared Indigo/Violet theme (#129)

`theme.css` owns the `--nf-*` semantic values: surfaces, text, muted copy, links,
selected colors, status, meaningful borders and focus, plus spacing and typography.
Its explicit `--sl-*` adapter covers Starlight's native documentation controls.
Flowbite's supported Badge `theme` prop selects `nf-status`, which consumes the
same root tokens. No common primitive exceptions or new interactive islands are
introduced. At narrow widths, the native Starlight Cancel control stacks above
its search field: the framework's fixed inline allowance otherwise consumes the
text area at 200% text enlargement. This changes layout only and retains native
search and dismissal behavior. Starlight retains navigation, search, menu and theme-selection behavior.

Exact locked Fontsource variable packages serve Latin DM Sans and Space Grotesk
from the generated local assets, without a font CDN request. DM Sans is body text;
Space Grotesk is headings/site title. Font display is swap; blocked or unavailable
fonts fall back to system-ui/sans-serif. This small dependency addition supplies
font bytes through the existing locked build, rather than a runtime service.

Local rendered theme proof belongs to #129, independently of #132's later live
Pages integration. `out/theme-evidence.json` and `out/theme-screenshots.tar.gz`
retain the local proof; build evidence alone does not establish theme acceptance.

### Reproducing local theme checks

After `npm run evidence`, run `npm run evidence:theme`. Playwright 1.56.1 is a
locked development dependency. Supply an installed Chromium executable through
`THEME_BROWSER_PATH`, or install Playwright's matching Chromium in verifier-owned
scratch storage. Missing browser/runtime libraries are a failing prerequisite.
The checker starts a loopback-only server for the built `/nibfin/` site, records
computed samples and retains screenshots. It rejects stale build/source identities
and checks real font loading, reflow, preference persistence, contrast, keyboard
search focus restoration and reduced motion. It never publishes or deploys.

This execution used Chromium 141.0.7390.0 from the exact npm package
`@sparticuz/chromium@141.0.0`, with its bundled `al2023.tar.br` runtime libraries
extracted into verifier scratch (no host package installation). The regular
Playwright browser CDN was unavailable (403). To reproduce that fallback, install
that package outside the source tree, use its exported `executablePath()` and
bundled `inflate()` helper, and set `LD_LIBRARY_PATH` to the extracted `al2023/lib`.
Use writable `TMPDIR` with room for the extracted browser. The actual invocation
was `THEME_BROWSER_PATH=/work/website/.cache/browser/chromium
LD_LIBRARY_PATH=/work/website/.cache/browser/al2023/lib TMPDIR=/work/website/.cache/browser npm run evidence:theme`
(on one shell line). These are tool paths, not product runtime dependencies.

Inspect the retained captures for clipping, overlap and readable hierarchy;
automated metrics do not replace visual review. The 200% text test doubles the
root font size at 320 CSS pixels rather than changing screenshot pixel density.
Hover, selected, open-search and keyboard focus observations belong to the
rendered report. Static Badge has no hover/disabled/action contract; the native
search control is only disabled transiently before initialization. No dummy
controls are added to manufacture states.


### Candidate capture cleanup

After the final build, rendered checks and visual review, run `npm run candidate:clean`
from `website/`. Core rejects symlinks anywhere in an isolated workspace, including
ignored npm executable links and temporary browser/font links. The cleanup first
checks current source identities and required archive digests, removes only the
website's generated `node_modules`, `.astro`, `dist` and `.cache` directories, then
checks the entire owning workspace for remaining symlinks or unsupported file types.
It preserves all four mandatory `out/` artifacts and records the handoff observation
in the theme report. Do not remove `out/`. Reinstall locked dependencies and rebuild
before running verification again after cleanup; caches are never delivery evidence.
