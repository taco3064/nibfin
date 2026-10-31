# Core and Host consolidation

## Baseline and execution boundary

Inspected on 2026-10-31 (Asia/Taipei): Core `83a0e9c`, CLI `c4402fa`,
Action `87d521f`. The installed control service remains stopped. Candidate source
must pass review, merge and release before installation; source edits never
replace the running engine. Existing work and credentials remain untouched.

## Responsibility map before implementation

| Existing modules | Authoritative owner | Retained platform adapter |
| --- | --- | --- |
| Core `core`, `runtime`, `delivery-planner`; CLI `native-delivery`, `native-dispatch-monitor` | Core stage decisions, evidence qualification and transitions | CLI observes remote events, persists claims and dispatches exact authorized jobs |
| CLI `native-base-revision`, `native-delivery-base` | Core integration and receipt invalidation policy | Host reads current main, preserves original session/workspace and performs guarded I/O |
| Core `rescue-*`; CLI `native-rescue` | Core detection, diagnosis state, bounded retries, continuation and resolution | Host stores records, binds released jobs, runs isolated AI and submits guarded notifications |
| Core `provider::localGhTransport`; CLI `native-github-stored-login` | Core stored-account GitHub transport | CLI supplies installed Core and local executable configuration |
| CLI `native-github-transport` | Core authenticated conditional observations and mutation invalidation | Host supplies response notification for persistent cooldown |
| Core provider retry delay; CLI `native-github-rate-limit` | Core response classification and cooldown deadlines | Host serializes, persists and reads cooldown records |
| Core `runner-*`; CLI `native-pool-*` | Core eligibility, capacity and job admission contracts | Host owns actual Runner processes, registrations, leases and platform storage |
| Core workflow templates and Skills; CLI source installation | Core maintained template bytes | CLI installs and verifies generated copies |
| Action `invoke`, Core workflow entry, native stage IPC | Core runtime and stage owners | Action validates inputs/outputs; native bridge binds job and local IPC |
| Legacy `controller/` | Public Core executable owners | Preserve necessary provenance and regression coverage before retiring legacy executable tree |

The table describes target ownership, not completion. Every migration must retain
the existing authorization and independent verification boundaries.

## Reference evidence

Kairo reference: `50581cd4db47ee78f1c1e4862fa10f0c95fcc4a5`.
`src/github.mjs::request` uses authenticated ETag observations, rejects failed
reads, avoids retrying uncertain writes and retains rate-limit deadlines.
`freshReadObservation` invalidates enclosing generations. Nibfin retains its
public credential boundary, bounded memory and request-local mutation auth;
private Kairo credentials, deployment paths and authority are not dependencies.

The native CLI currently duplicates these GitHub behaviors to compensate for an
older installed Core. Moving them into the public producer must precede removing
the compatibility implementation from the CLI and upgrading consumer pins.

## Implemented producer boundaries

Core 0.1.1 adds the `deliveryRevision` and `protectedDiagnosis` contracts.
`delivery-planner.mjs` owns the stage sequence and model-role classification.
`core-contract.mjs` checks requests, selected decisions and owner evidence;
`core.mjs` composes and executes owners; `core-deliver.mjs` owns the original
Writer's capture and collection. Splitting these files preserves the existing
public constructors and their authorization checkpoints.

Public provider collections explicitly request fresh pagination headers, including
an initial URL without page parameters. A 304 without Link metadata cannot turn
an incomplete first page into a complete inventory. The donor's `GitHub.list`
always supplies page parameters; this public contract supports both URL forms.

`deliveryBaseRevisionPolicy` owns normal main-integration applicability, retained
Shape receipts and the complete sequence of repeated Candidate gates. The Host
still observes main, retains the original Writer/session/workspace, reconciles
uncertain publication and applies the resulting state transaction. A normal base
advance leaves the rescue budget unchanged.

`protectedStageDiagnosisPlan` owns missing-record correction, notification
uncertainty, quota waiting and the bounded pre-AI retry decision. Its result
contract keeps a completed diagnosis UNRESOLVED until actual repair and normal
independent verification succeed. Original-role repair counters remain separate.

## Legacy engine retirement

The legacy tree has no unpublished changes, is excluded from the installed Core,
and has no control-service reference to this checkout. Its executable entry,
private development transport and duplicate runtime have been removed together.
The former CI job now verifies provenance instead of executing another engine.

`provenance/controller-baseline.json` records the public repository commit
`83a0e9cd8e1026925ddd8c5bf9d5f987e8905708`, exact controller tree and adaptation
input hashes. Historical source and tests remain recoverable from that public Git
commit. The package generator consumes this frozen record; rebuilding the public
Core no longer requires a working legacy controller directory. Future work must
implement current GitHub Issue requirements through the public Core owners,
using historical source only as a reference.

The CLI/Action fixed pins, protected CI/merge, published release and clean-install
observations are separate pending consumer/operational gates.

## Required completion evidence

- Common Core contracts exercised from native and Action entry points.
- Installed archive identity, package inventory and consumer pins agree.
- Retired controller references have explicit provenance replacements.
- Relevant regression tests and required CI pass before protected merge.
- Original #55 work and merged #76 evidence are preserved before uninstall.
- Clean installation and actual Issue/rescue progression are separately measured.
