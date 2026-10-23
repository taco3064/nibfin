# nibfin
Nibfin is developing GitHub Issues-based AI software delivery with per-Issue
lifecycles scheduled by live native dependencies. Independent work can run in
parallel within Owner-authorized limits. Assignees, labels and events never grant
execution or merge permission.

This checkout implements a development bootstrap and bounded adapter interfaces,
including fresh requirement-source and approved-snapshot verification and an
explicit version-5 protected role, instruction and evidence contract, plus
version-4 single-stage invocation with signed Owner authorization. A version-1
trusted Agent host interface adds environment/registration separation, isolated
workspace reconstruction and cleanup observations. Its bounded local test host
is not a production Agent sandbox. The Notion
integration seam is tested with synthetic data; live synchronization is unverified.
The complete delivery engine, trusted Runner routing, Actions relay, recovery and
public installation releases remain planned. No product E2E or Agent/platform
support is claimed.

## Development

Use Node.js 22.23.3 and npm 10.9.9. No external packages or credentials are needed.

```sh
npm ci --offline
npm run build
npm run check
npm test
npm run experiment
npm run verify-package
```

See [interface and local installation contracts](docs/interfaces.md) and
[shared configuration ownership](docs/decisions/bootstrap.md). The experiment
writes disposable temporary output and removes it. The local package smoke test
checks an installed consumer outside this checkout; it does not publish a release.
The future documentation website is reserved for website/ and is not scaffolded.

## Public-facing language

All public-facing information maintained by this project must be written in English. This applies across `taco3064/nibfin`, `taco3064/nibfin-action`, and `taco3064/gh-nibfin`, including repository descriptions, READMEs, documentation and the website, UI text, CLI help and user-facing output/errors, Action/workflow descriptions, examples, release notes, and maintainer-authored issue/PR titles, descriptions, and comments.

Review new or changed public-facing text for English language consistency before publication or release.

## License

This project is **source-available under a custom restricted license**, not an
OSI-approved open-source project. See [LICENSE](LICENSE) for the binding terms.

- You may download, install, build, and use the **unmodified original** for
  **noncommercial purposes**.
- Modification, derivative works, and redistribution (including unmodified
  copies) require separate prior written permission.
- Commercial use, including internal business use and paid client work,
  requires separate prior written permission.
- Ordinary external configuration and necessary installation/build copies are
  allowed. Your independently created projects and output do not become subject
  to this license merely because you use the software.
- GitHub viewing/forking rights and non-waivable legal exceptions are preserved.
  Share the official repository link instead of redistributing copies.

For additional permissions, contact the maintainer through this repository's
Discussions (if enabled) or an Issue. The English LICENSE text governs.

### License correction

The maintainer identified the earlier MIT notice as a configuration error.
It has been replaced with the custom license above. The project is not
currently offered under MIT or as a dual-licensed project.
