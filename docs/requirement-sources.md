# Replaceable requirement sources

Requirements and execution authorization are separate. The protected installation
selects a requirement source and its authenticated connection. Requirement text,
events and Agent output cannot select a module, connection or alternate source.
Direct Owner instructions authorizing installation do not require creating a
requirements ticket. Proposal documents are not an execution prerequisite.

## Supported adapters

| Kind | Module | Status |
| --- | --- | --- |
| `github-issue` | `src/requirement-sources/github-issue.mjs` | Implemented; native public GitHub Issue reads |
| Jira | Separate future adapter | Not implemented |
| Linear | Separate future adapter | Not implemented |

`supportedRequirementSources` lists only implemented adapters and their contract
versions. An unknown kind fails before I/O. There is no fallback to another
provider and no URL-based autodiscovery. Notion is not a requirement adapter.

## Common entry

```js
await observeRequirementAuthority({
  source: {kind: 'github-issue', target: {
    repository: 'example-org/core', repositoryId: '42',
    issueId: 'I_101', databaseId: '61', number: '101'
  }},
  provider, cycle, approvalId, signal
});
```

The caller supplies `source` and `provider` from protected installation settings,
independently of the text being read. Each provider retains its own target schema,
stable identities, connection and permission rules; Jira/Linear identifiers will
not need to impersonate GitHub repository or Issue identifiers. Execution targets
remain separately bound by the existing workflow authorization contract.

All adapters share the result `{outcome:'observed', source, startedAt, observedAt,
authority}`. `authority` keeps the existing provider-independent signed snapshot
representation: canonical source locator, content-derived revision, complete
ordered content, manifest and identity. The common entry owns revision hashing,
timeouts, cancellation, content limits and safe unavailable results. It permits
GET reads only. It never approves, signs, persists, changes labels or dispatches.
Changing sources cannot transfer a prior Grant, receipt or pending execution to a
different authority. Source replacement must reconcile existing work and establish
the newly authorized binding before effects; it must not rewrite historical proof.

`observeIssueAuthority` remains a compatibility wrapper selecting `github-issue`;
it has no duplicate provider implementation. Hosts should use the common entry.

## Adding another provider

Each implementation belongs in its own module under `src/requirement-sources/`
and exports an immutable adapter with this contract:

- `kind`, `version`: unique installed selector and contract version.
- `validateTarget(target)`: reject incomplete or ambiguous protected identities.
- `canonicalSource(target)`, `acceptsSource(url)`: one canonical locator contract.
- `read({target,request})`: freshly verify provider-specific identities and return
  complete `{body}` bytes using the supplied read-only request capability.

Register it explicitly in `requirement-sources/index.mjs`, include its maintained
files in the distribution, and add its separate provider tests plus common-entry
tests. The authority validator uses this same catalog, so observation and signed
snapshot validation cannot disagree about supported sources. No global mutable
plugin registry or dynamically loaded user module is required.

Once the provider is implemented, switching the protected `kind`, provider
connection and target selects it through the same common entry. Core stages do
not need provider-specific branches. An adapter must define complete text/rich-text
and attachment handling before claiming support; silently dropping required
content or inheriting another provider's credentials is not acceptable. Reads
are implemented here; provider-specific writes, webhooks and full lifecycle
integration require their own implementation and verification before use.
