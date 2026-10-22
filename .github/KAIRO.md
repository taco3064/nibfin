# Kairo development

This public repository is enrolled in Kairo using the official public caller at `.github/workflows/kairo.yml`.

- Owner: `taco3064` (GitHub User ID `127829492`).
- Designated private controller: `kairo-nibfin` on the owner's Kairo WSL host.
- Each participating repository has a distinct `KAIRO_RUNNER_KEY` Actions secret and a locally registered binding.
- Public Actions run only the GitHub-hosted notification job. They never run Codex or receive the controller token, root key, or Codex authentication.
- An authenticated notification is a wake-up, not permission to develop or merge.

## Starting real development

1. Define the actual product requirements and meaningful project CI.
2. Write real work as Issues with the problem, expected outcome, exclusions, and acceptance criteria. The owner assigns `scope` and native `Blocked by` dependencies.
3. Prepare a new dynamic authorization for the reviewed Issues, CI workflow/check pins, allowed operations, expiry, and concurrency. Review and sign the Owner Grant, then activate the controller for that exact authorization.
4. Kairo performs independent Shape validation, implementation, independent Accept, exact-head CI, final review, authorized merge, and closure. Never add `shaped` or `delivered` manually as proof of acceptance.

Enrollment does not authorize existing or future Issues. The setup intentionally created no test Issues, signed no delivery Grant, and ran no development E2E. The notification workflow may run every 15 minutes; without a valid signed Grant it cannot start development. Do not replace the official caller without rotating/reapproving its pinned binding.

Controller configuration and enrollment evidence are retained privately under `/etc/kairo/nibfin/`. The prepared policy template is deliberately non-executable until real CI, operations, scope, and validity are supplied. Kairo does not automatically read a Notion URL: product authority must use the configured synchronized GitHub source.

See [Kairo](https://github.com/taco3064/kairo), [public runner](https://github.com/taco3064/kairo/blob/main/docs/public-runner.md), and [dynamic scheduling](https://github.com/taco3064/kairo/blob/main/docs/dynamic-scheduling.md).
