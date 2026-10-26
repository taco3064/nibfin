# Immutable Core releases

The owning release workflow is `.github/workflows/core-release.yml`. It runs on
protected `main` pushes affecting release inputs, or an authorized manual retry
on `main`. The selected version is the exact `package.json` version, currently
0.1.0; the tag is `v` followed by that version. A changed release requires a new
package version and corresponding lockfile version. Proposal versions are separate.
No registry publication, CLI release or Marketplace Action release is implied.

Before Merge, build with `npm run prepare:release` and inspect the three mandatory
Candidate assets: `out/nibfin-core.tgz`, `out/release-manifest.json`, and
`out/compatibility.json`. `npm run verify:release` checks these existing assets
without rebuilding them and runs a disposable installed consumer. Heavy checks
and dependency preparation in a Core execution must use its verification runner.
The archive contains Core, the three protected Skills, Scope instructions, Claude
and Gemini adapter implementations, and the workflow bundle. Its existing strict
tar verifier rejects unexpected, unsafe, missing and changed files.

The manifest's candidate source records the observed base and SHA-256 inventory of
release build inputs, including packaging, tests and CD configuration. This is a
content mapping of those inputs, not a prediction of the future rebase SHA or a
whole-Candidate completion certificate. Core independently captures the complete
Candidate. CD rebuilds the assets with `kind: merged` and the actual immutable
source commit. It retains Run/Attempt, source, release and asset digest mappings
in `publication-result.json` and the Run's `core-publication-*` artifact.

## Configuration and publication

An administrator must enable GitHub immutable Releases before publication. CD
reads `GET /repos/taco3064/nibfin/immutable-releases`; missing access or a disabled
setting stops publication. Configure the repository secret `NIBFIN_RELEASE_TOKEN`
with a restricted GitHub App installation token or fine-grained token authorized
only for this repository: Contents write (release/assets), Administration read
(immutability setting), and Pull requests read (merged-source provenance). Branch
protection must require the existing reviews/checks, with no direct-push bypass.
The job's default token has only Contents read; the publishing credential is
passed only to the publication step after local checks. This configuration does
not enable settings or provision credentials on the Owner's behalf.

CD verifies the public repository identity, protected main branch and the source's
associated merged PR, executes the genuine pinned artifact SDK tests, source
regression and existing archive/installed consumer checks, then creates a draft,
uploads exact assets and publishes it. Readback must confirm `immutable: true`,
the source tag, all three asset digests and a published result. The mechanism is
[GitHub immutable Releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases);
ordinary tags alone are insufficient. Setting lookup follows the
[official repository API](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository).

Publication uses official Actions concurrency with cancellation disabled. GitHub's
pending-run replacement semantics still apply; a cancelled or skipped Run is not
successful CD. Inspect the applicable Run after the protected Merge. Completion
requires that Run's successful checks and actual, confirmed publication result,
with source/release references. Independent Acceptance and exact-head CI remain
required; local mocks or a workflow file do not prove publication succeeded.

## Retry and upgrade

Inspect the retained write intent/result and GitHub release/tag/asset state before
an authorized retry. Unknown writes stop immediately; do not automatically rerun
or delete a draft/tag to mask uncertainty. Resolve an unknown API outcome by
readback after it settles, retaining the prior Run. An authorized retry on the
same source discovers drafts through the authenticated, paginated release list
and reads releases by ID (the release-by-tag endpoint is for published releases).
It reconciles the existing draft and identical assets, uploads only
missing assets and verifies an already published identical immutable release.
Conflicting tags, draft ownership or bytes stop without overwrite or deletion.
If `main` advanced, the version/content identity must be deliberately reconciled;
a conflicting published version requires a new version, not replacement assets.

Installed consumers import `verifyRelease`, `releaseComponents`, and
`workflowInstallation` from `@nibfin/core`. Supply the trusted manifest source
binding and exact version, the submitted archive and compatibility bytes, and a
reader for the installed package files. Component digests and byte identities
must agree. Workflow installation still requires immutable bundle and host commit
pins and comparison with existing user files before authorized writes. A manifest
hash must come from trusted Candidate/publication evidence; a self-signed hash is
not an independent trust anchor. Missing capability measurements cannot authorize
execution. Required capability requests include the exact configuration and are
rejected unless a Supported entry covers it with the appropriate evidence type.

Upgrades require compatibility checking against the intended concrete environment.
Changes to Grant-bound Core, runtime or Skills require fresh applicable Owner
authorization and independent lifecycle evidence. Installation never silently
replaces an active Grant, takes over unfinished work or resolves an unknown write.
Action and CLI mappings remain explicitly unknown/unreleased here.

## Evidence limits

Initial metadata separates source/contract tests, local installation, actual CLI,
provider execution and full product E2E. It describes public personal and
organization repositories without equating repository ownership with Runner
registration level or optional automatic registration. macOS Intel/Apple Silicon
CLI and Host and unmeasured Codex/Claude/Gemini execution are Unverified. The
adapters are implemented, not research-only. Private and unsafe isolation
configurations are Unsupported. Publishing alone certifies no platform or P1
support. No external published-asset download or fresh consumer installation is
required or claimed by this Issue; that work is separately assigned by the Owner.
