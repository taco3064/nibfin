# Kairo integration

This public repository uses the official Kairo hosted caller.

- Primary wake-up: Owner updates of Owner-created Issues.
- Explicit recovery: workflow_dispatch.
- No schedule or cron trigger is configured.
- Hosted Actions produce signed notifications; the enrolled private Controller verifies them before execution.
- Labels are cumulative: scope selects membership, shaped records validated published requirements, delivered records verified delivery after merge and post-merge checks.
- Native Blocked by relationships determine prerequisite order. Labels and notifications do not grant permission to execute.
- Work requires a separate signed Owner grant, meaningful project CI, and applicable branch protection.
- Repository merge policy: rebase only, delete branches after merge, PR creation limited to collaborators (currently Owner only).
