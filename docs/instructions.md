# Protected instruction selection

N07 supplies exactly three maintained snapshots at skills/{shape,deliver,accept}/SKILL.md.
They are portable instructions, not installed provider adapters or live support
claims. The package reads them relative to its module URL, never the working
directory. It performs no runtime network access or configuration discovery.

Import selectInstructions and bodyDigest from @nibfin/core. Supply skill and role;
skillForRole remains the normative mapping for all four Shape roles, Deliver and
Accept. Investigation is bounded read-only support for Plan/Audit within Shape
instructions, not a fourth Skill or an additional execution role.

repository and shared are plain maps keyed only by protected Skill names. Each
entry is exactly {mode:'default'} or {mode:'extend'|'override',content:string}.
A present repository entry replaces that Skill's shared entry. Otherwise shared
wins, then built-in. Explicit default resets to exact built-in text, suppressing
lower content. Extend concatenates built-in + two LF characters + chosen custom
text. Override returns only chosen custom text. No trimming, Unicode normalization,
newline conversion or trailing-newline insertion occurs. Text must be nonblank;
tab, CR and LF are allowed; other ASCII control characters are rejected.

Every selected non-built-in entry, including a default reset, requires a trusted
approval expectation at approvals[source][skill].configurationIdentity. Its value
is bodyDigest(JSON.stringify({mode})) for default or
bodyDigest(JSON.stringify({mode,content})) for customization, in that property
order. This binds mode as well as exact content. Input object property order does
not change the identity. bodyDigest uses the existing Core string convention;
do not substitute a raw byte hash. Missing, malformed or mismatched selected
entries fail explicitly. Unselected per-Skill entries are not interpreted; map
structure and supported keys are still checked. SKILL.md files in a target
repository are never automatically enabled.

Example for a trusted caller that has already independently approved this exact
configuration (computing this value alone does not approve it):

```js
const config = {mode:'extend',content:'Use the approved local test command.'};
const approvedIdentity = bodyDigest(JSON.stringify(config));
const selected = selectInstructions({skill:'deliver',role:'deliver',
  repository:{deliver:config},
  approvals:{repository:{deliver:{configurationIdentity:approvedIdentity}}}});
```

The returned frozen, detached flat snapshot contains skill, role, source, mode,
configurationIdentity, inputIdentity (custom text digest, otherwise null),
builtinIdentity, effective identity and exact content. Pass
{identity:selected.identity,content:selected.content} to lifecycle instructions;
the independently trusted binding.instructions must match the effective identity.
Changing configuration requires fresh approval and current lifecycle evidence.
No result objects or permissions are derived from the prose.

Trusted execution framing stays outside replaceable content: fixed role mapping,
versioned result validation, Deliver-only write access, authorization, native
dependencies, independent Validator/Accept, Candidate/Hooks, exact-head CI, Final
Review, protected Merge and truthful closure. Even approved hostile override text
cannot change those checks. Callers must protect approval expectations separately
from repository-controlled input; the selector compares them but does not
authenticate them. It does not schedule, publish or execute anything.

The retained fake-backend checks establish local interface behavior only. They do
not prove live isolation, provider execution, Runner behavior or end-to-end
delivery. Public repository ownership, Runner registration level and optional
automatic registration remain separate. No private product support is claimed.

Pre-delivery Scope Plan/Publish/Audit instructions are available via `scopeInstructions()`;
it is not accepted by `selectInstructions`. See docs/scope.md for the local
portfolio contract, exact-manifest publisher boundary, maintained source-input
example and bounded read-only Investigation. Scope mode verdicts are report
conventions, not additional protected role/result-schema values.
