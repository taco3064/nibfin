# Bootstrap ownership and integration record

The owning repository is nibfin. This record is the maintained location for
bootstrap engineering decisions and evidence pointers, not a substitute for
Core's independent immutable candidate evidence.

Use one dependency-free Node ESM root with npm's built-in test runner. Build
validates all ESM syntax, resolves public interfaces and checks runtime, package
and lockfile correspondence; the source ESM is the distribution. Quality checks
also enforce regular sources, whitespace and final newlines. npm engine-strict
and the quality command fail on unsupported versions. This is development
runtime support only, with no cross-platform Agent or Runner support claim.

The Core maintainers own package.json, package-lock.json, .npmrc, runtime pins,
root scripts, shared configuration and product-quality CI. `src/` owns interfaces;
`test/fixtures/` owns synthetic input, `examples/` owns checked consumer contracts,
`experiments/` owns disposable experiments, and `docs/decisions/` owns maintained
integration decisions/evidence pointers. There are no commit hooks.

N29, N32, N34 and N54 extend these interfaces and tooling rather than initializing
another root. Before parallel branches change shared configuration, compare the
current base, identify consumers, agree the integration change and regenerate
the single root lockfile with npm 10.9.9. Rebase/integrate updated shared files
and rerun affected root checks; do not replace root settings silently. This is
configuration ownership, not priority or a scheduling edge.

Reserve `website/` for N45. No scaffold or website dependencies are installed.
A future website may have its own scripts and CI/Pages lifecycle in that boundary,
using the agreed root package/lockfile authority (extend workspace configuration
when introduced). It must not replace root scripts or require Core releases for
website-only changes. Website checks must cover its sources independently.

nibfin-action owns Action packaging/metadata and calls this Core contract.
gh-nibfin owns its seven onboarding commands and consumes installation/verification
interfaces. Neither owns a second delivery state machine. No consumer repository
is modified here. No private-source package, provider, routing security, relay,
coordination service or delivery engine is needed to run this baseline.

Reproducible evidence entry points are test/contract.test.mjs,
test/bootstrap.test.mjs, scripts/package-smoke.mjs and experiments/sample.mjs.
The product-quality workflow runs the same commands. Local results establish
bootstrap behavior; hosted CI and real GitHub/Actions E2E require separate evidence.
The sample experiment uses only a synthetic test adapter and a temporary directory
which is deleted even on failure. No external persistent state or credentials
are required. Build output is validated source, with no ignored distribution to
hand off. Archives and experiment outputs are temporary verification products.

Public text is English; the existing license notice is retained. Protected
repository development infrastructure is preserved and is not a product runtime
dependency. Planned capabilities and P2 integrations must not be described as
released behavior. Future decisions should name the affected interface version,
consumers, compatibility implications and concrete verification commands.
