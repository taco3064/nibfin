import {canonicalJSON, contentIdentity, githubId, controlledIntent, nativeConcurrency} from './index.mjs';

const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && same(Object.keys(v).sort(), keys.split(' ').sort());
const opaque = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = () => { throw Error('relay:contract'); };
const blocked = reason => ({outcome:'blocked', reason, continuation:false});

/** A bounded projection of official Issue events. Raw webhooks are not supported. */
export function issueWakeup(event) {
  if (!exact(event, 'action repositoryId issueId number label stateReason')) fail();
  githubId(event.repositoryId); githubId(event.number);
  if (typeof event.issueId !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(event.issueId)
      || typeof event.action !== 'string' || event.label !== null && typeof event.label !== 'string'
      || event.stateReason !== null && typeof event.stateReason !== 'string') fail();
  if (event.action === 'opened') return event.label === 'scope' ? 'resolve' : null;
  if (event.action === 'labeled') {
    const labels = {scope:'resolve', shaped:'deliver', delivered:'observe'};
    return Object.hasOwn(labels, event.label) ? labels[event.label] : null;
  }
  if (event.action === 'closed') return event.stateReason === 'completed' ? 'completion' : null;
  if (event.action === 'reopened') return 'recovery';
  if (['edited','unlabeled','assigned','unassigned','milestoned','demilestoned'].includes(event.action)) return 'reevaluate';
  return null;
}

function validateRequest(request) {
  if (!exact(request, 'id hint intent sourcePolicy predecessor fallback mutation') || !opaque(request.id)
      || !['resolve','deliver','completion','recovery','reevaluate','substage'].includes(request.hint)) fail();
  const v = controlledIntent(request.intent), p = request.sourcePolicy;
  if (v.kind !== 'dispatch' || !exact(v.payload.inputs, 'nibfin_request nibfin_correlation')
      || v.payload.inputs.nibfin_request !== request.id || v.source.request !== request.id) fail();
  if (!exact(p, 'repositoryId workflowRef workflowSha workflowDigest ref actorIds suppressionEvent') || !Array.isArray(p.actorIds)
      || !p.actorIds.length || !hash(p.workflowDigest) || !/^[a-f0-9]{40}$/.test(p.workflowSha)
      || typeof p.workflowRef !== 'string' || !p.workflowRef.includes('/.github/workflows/')
      || typeof p.ref !== 'string' || !p.ref || !['issues','workflow_dispatch'].includes(p.suppressionEvent)) fail();
  githubId(p.repositoryId); p.actorIds.forEach(githubId);
  if (p.repositoryId !== v.source.repositoryId) fail();
  if (!exact(request.fallback, 'approved reason') || typeof request.fallback.approved !== 'boolean'
      || typeof request.fallback.reason !== 'string'
      || request.fallback.approved && !request.fallback.reason.trim()) fail();
  if (!['required','not-applicable'].includes(request.mutation)) fail();
  if (['deliver','completion','recovery'].includes(request.hint) && request.mutation !== 'required') fail();
  if (request.predecessor !== null && (!exact(request.predecessor, 'identity request result')
      || !hash(request.predecessor.identity) || !opaque(request.predecessor.request) || !opaque(request.predecessor.result))) fail();
  if (['deliver','substage'].includes(request.hint) && request.predecessor === null) fail();
  return v;
}
function sourceMatches(source, policy, name) {
  const i = source?.identity;
  if (!i || source.ok !== true || i.repository_visibility !== 'public' || i.event_name !== name
      || i.repository_id !== policy.repositoryId || i.workflow_ref !== policy.workflowRef
      || i.workflow_sha !== policy.workflowSha || i.workflowDigest !== policy.workflowDigest
      || i.ref !== policy.ref || !policy.actorIds.includes(i.actor_id)) fail();
  githubId(i.run_id); githubId(i.run_attempt);
}

/**
 * Capabilities are installed by trusted Core, never deserialized from an event.
 * authenticateEvent must independently authenticate the event projection and its
 * Actions context. loadRequest/loadPredecessor/currentGate read current retained
 * authority, not caller-supplied claims. operations is createControlledOperations.
 * All calls, including lookup and reconciliation, belong inside native concurrency.
 */
export function createEventRelay({authenticateEvent, loadRequest, loadPredecessor, verifier, currentGate, operations} = {}) {
  if (![authenticateEvent, loadRequest, loadPredecessor, currentGate].every(f => typeof f === 'function')
      || typeof verifier?.predecessor !== 'function' || typeof operations?.execute !== 'function') fail();
  async function wake(input) {
    try {
      if (!exact(input, 'name payload') || !['issues','workflow_dispatch','suppressed'].includes(input.name)) fail();
      const inputCopy = structuredClone(input);
      let hint, selector;
      if (inputCopy.name === 'workflow_dispatch') {
        if (!exact(inputCopy.payload, 'nibfin_request nibfin_correlation')
            || !opaque(inputCopy.payload.nibfin_request) || !opaque(inputCopy.payload.nibfin_correlation)) fail();
        selector = {request:inputCopy.payload.nibfin_request};
      } else {
        hint = issueWakeup(inputCopy.payload);
        if (hint === 'observe' || hint === null) return {outcome:'ignored', continuation:false};
        selector = {hint, repositoryId:inputCopy.payload.repositoryId, issueId:inputCopy.payload.issueId, number:inputCopy.payload.number};
      }
      // The capability validates event authenticity, not payload.authenticated.
      const source = await authenticateEvent(structuredClone(inputCopy));
      const request = structuredClone(await loadRequest(selector));
      const intent = validateRequest(request), b = intent.binding;
      sourceMatches(source, request.sourcePolicy, inputCopy.name === 'suppressed' ? request.sourcePolicy.suppressionEvent : inputCopy.name);
      if (hint && (hint !== request.hint || inputCopy.payload.repositoryId !== b.repositoryId
          || inputCopy.payload.issueId !== b.issueId || inputCopy.payload.number !== b.number)) fail();
      if (!hint && (inputCopy.payload.nibfin_request !== request.id || inputCopy.payload.nibfin_correlation !== intent.correlation)) fail();
      if (inputCopy.name !== 'issues' && !request.fallback.approved)
        return {outcome:'waiting', reason:'dispatch-not-approved', continuation:false};
      const wakeup = contentIdentity({version:1, request});
      if (request.predecessor !== null) {
        const args = await loadPredecessor(structuredClone(request));
        const checked = verifier.predecessor(args);
        if (!checked.ok || contentIdentity(checked.evidence) !== request.predecessor.identity
            || checked.evidence.execution.request !== request.predecessor.request
            || checked.evidence.execution.result !== request.predecessor.result
            || checked.evidence.binding.repositoryId !== b.repositoryId
            || checked.evidence.binding.issueId !== b.issueId || checked.evidence.binding.scopeHash !== b.scopeHash
            || checked.evidence.binding.shapeHash !== b.shapeHash) return blocked('predecessor');
      }
      const gate = await currentGate({request:structuredClone(request), wakeup, source});
      if (!gate || !['authorization','dependencies','upstream','applicability','runner'].every(k => gate[k] === true)
          || request.mutation === 'required' && gate.mutationReadback !== true) return blocked('current-gate');
      // Persist the full relay binding through the existing immutable intent.
      const result = await operations.execute({...intent, source:{...intent.source, request:`relay-${wakeup}`}});
      return {outcome:result.continuation === true ? 'run-observed' : 'waiting', continuation:false,
        wakeup, provenance:{transport:inputCopy.name, repositoryId:source.identity.repository_id,
          runId:source.identity.run_id, attempt:source.identity.run_attempt,
          ...(inputCopy.name !== 'issues' ? {reason:request.fallback.reason} : {})},
        concurrency:{issue:nativeConcurrency({repository:b.repository,repositoryId:b.repositoryId,issue:b.number,scope:'issue'}),
          write:nativeConcurrency({repository:b.repository,repositoryId:b.repositoryId,scope:'repository-write'})},
        operation:result};
    } catch { return blocked('identity-or-evidence'); }
  }
  return Object.freeze({wake});
}
