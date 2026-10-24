# Agent environments and lifecycle

`@nibfin/core` exports `createAgentEnvironments()` and
`createAgentLifecycle({environment, instanceId, backend, current})`. Imports are
inert. This is a backend contract, not an execution authorization or sandbox.

A trusted caller owns one environment registry and one lifecycle object per instance. `describe({id, agent, loginSpace,
instances})` returns a deeply frozen descriptor. Each instance has `id`,
`workspace`, `registration`, and `service`. Resource names are canonical absolute
paths excluding filesystem roots, pairwise disjoint (including parent/child paths). IDs cannot alias.
An existing environment cannot change, including its Agent. Instances reference
the environment's shared Agent login space; another environment must have its own.
Descriptors perform no login discovery, registration, execution, or deletion.
The owner must resolve filesystem aliases/symlinks before supplying paths and
provide actual isolation. Lexical path checks alone are not isolation proof.

The lifecycle receives one descriptor and instance. `current(executionId)` returns
fresh trusted `{expected, consumed}` evidence context using the existing version-1
evidence API. The caller owns freshness, authorization, consumed-result persistence,
and independently verified backend configuration. Backend output never supplies
current expectations. Keep this callback and environment registry outside Agent
control. Mark results consumed atomically at the Core acceptance boundary; this
module prevents duplicate collection of valid results locally but does not provide
a distributed replay database. Successful parsing alone never accepts evidence.

`start({execution, binding, instructions, visibility, ownership})` accepts existing
execution/binding identities and `{identity, content}` instructions. The instruction
identity uses `bodyDigest`, including JSON string encoding. Only public visibility
and personal/organization ownership are accepted. Ownership has no registration or
Agent behavior effect. Only Deliver receives writable workspace access; the other
five roles receive read access. This API never grants GitHub operations.

Backend methods receive immutable allowlisted inputs, not caller bags or host
process environments. Implement all six async methods:

| Method | Return contract |
| --- | --- |
| readiness | `{login, tool, isolation, read, write, evidence, limitations}` |
| start | `{status: 'started' or 'rejected'}` |
| collect | `{status: 'pending' or 'complete', exitCode, evidence}` |
| stop | `{status: 'requested' or 'failed' or 'unknown'}` |
| termination | `{status: 'running' or 'terminated' or 'unknown'}` |
| cleanup | `{status: 'completed' or 'failed' or 'unresolved', residuals}` |

Readiness login/tool are `available` or `unavailable`; isolation/read/write are
`verified`, `unsupported`, or `unverified`. Evidence is a nonempty string array;
limitations is a string array. These are backend contract observations, not a
certification. Public observations expose only readiness classification to avoid
leaking arbitrary backend diagnostics. Missing runtime resources remain unavailable;
unsupported and unverified required capabilities remain distinct. None starts work.

Start receives exact execution identity, binding, instructions, workspace path and
access, explicitly scoped `{owner, space}` Agent login access, and empty
`processEnvironment`. Backend implementations must actually apply these restrictions,
launch without inherited host variables, and never mount Core login/signing keys,
GitHub write credentials or instance registration credentials into Agent space.
No generic secret or environment passthrough channel exists. Agent login belongs
to the environment backend, not Core or registration credentials. Repository prose
and model output must never be interpreted as permission or replacement inputs.

Queries carry environment, Agent, instance, execution and request correlation.
The backend owns internal handles indexed by these values, including when start's
response is lost. Exceptions and malformed responses normalize to `unknown` without
copying backend errors into public diagnostics. Backend responses are copied before
validation and normalized observations are deeply frozen copies; later mutations
of backend-owned objects cannot change retained state. Do not replace an unknown start.
No backend isolation claims are independently certified by this module.

`observe(id)` returns an immutable snapshot. `collect(id)`, `stop(id)`, and
`termination(id)` update separate result, stop and termination observations.
One operation at a time is legal per lifecycle. Start reserves the ID before
calling the backend. A second start is rejected while termination is unresolved;
IDs cannot be reused. Stop acknowledgment cannot mark termination. A timeout is a
caller policy: request stop, observe termination, and reconcile results. Failed or
unknown stop may be retried; an acknowledged stop cannot be repeated. Confirmed
termination is retained. Rejected starts are known terminated with absent results.

Collection can remain pending or unknown. Nonzero exit, missing or invalid evidence
is invalid, even if the process exited. Complete zero-exit evidence must pass
`compareEvidence` against fresh independent expectations and `validateStageResult`.
The original start binding is pinned even if current expectations change.
All binding, source, role/Skill, independence, version, request/result identities
and replay checks remain those of existing evidence contracts. A valid result is
not synonymous with termination and cannot be collected again. Invalid/pending
observations may be reconciled by collection again. A cleaned instance cannot collect.

`cleanup()` applies only to the selected instance's three owned resources, never
shared login or sibling resources. It cannot run until every owned execution has
confirmed termination and known valid/invalid/absent result. Completed cleanup must
have empty residuals; failed/unresolved cleanup may be retried. Unknown cleanup
never claims success. Historical observations remain available after cleanup.
After completed cleanup no new start is allowed. An environment owner must aggregate
all instance lifecycle observations and confirm all instances cleaned before removing
shared login or claiming environment cleanup; there is deliberately no blind
recursive environment deletion operation. Do not discard lifecycle objects with
unresolved executions. The backend must reconcile unknown operations and verify
actual resource removal and termination, not merely cancellation acknowledgments.

Retained recording and local Node process tests are credential-free contract proof.
They do not invoke models, register Runners, certify isolation or establish any
OS-by-Agent support combination. Live provider/platform and full product evidence
remain separate. Node 22/npm 10 package verification uses disposable executable
scratch and a separate offline package consumer.
