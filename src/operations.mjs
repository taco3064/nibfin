import {deliveryWriteRequest,requireMergeIdentity} from './github.mjs';
import {randomUUID} from 'node:crypto';
import {githubId, repositoryCoordinates, canonicalJSON, bodyDigest, contentIdentity, prepareCustodyManifest, publishCustody} from './index.mjs';

const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const name = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const exact = (v, keys) => v && same(Object.keys(v).sort(), keys.split(' ').sort());
const fail = () => {throw Error('operations:identity');};
async function bounded(work, signal) {
  if (signal.aborted) throw Error('operations:cancelled');
  let abort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      abort = () => reject(Error('operations:cancelled')); signal.addEventListener('abort', abort, {once:true});
    })]);
  } finally {signal.removeEventListener('abort', abort);}
}
// Publication and completed-close require submission custody; presence alone is noncausal.
const publicationEffect = (v,causalClose) => ['comment','reopen','issue-body','label'].includes(v.kind) || causalClose && v.kind === 'close';
const unknown = (refs = {}, reason = 'readback') => ({outcome: 'unknown', continuation: false, refs, reason});

/** Construct the exact supported HTTP request; callers cannot supply endpoints/predicates. */
export function controlledIntent(input) {
  const v = JSON.parse(canonicalJSON(input));
  if (!exact(v, 'version kind correlation source binding target payload') || v.version !== 1
      || !['dispatch', 'pr', 'merge', 'close', 'label', 'issue-body', 'comment', 'reopen'].includes(v.kind) || !name(v.correlation)) fail();
  const b = v.binding;
  if (!exact(b, 'repository repositoryId issueId number cycle scopeHash shapeHash authorization runId attempt candidate base head'
      + (v.kind === 'merge' ? ' baseRef' : ''))
      || typeof b.repository !== 'string') fail();
  const parts = b.repository.split('/');
  if (parts.length !== 2 || repositoryCoordinates(...parts).key !== b.repository) fail();
  for (const key of ['repositoryId', 'number', 'runId', 'attempt']) githubId(b[key]);
  for (const key of ['scopeHash', 'shapeHash', 'authorization']) if (!hash(b[key])) fail();
  if (typeof b.issueId !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(b.issueId)
      || !name(b.cycle) || b.candidate !== null && !hash(b.candidate)
      || b.base !== null && !sha(b.base) || b.head !== null && !sha(b.head)) fail();
  if (!exact(v.source, 'request event repositoryId runId attempt actorId') || !name(v.source.request) || !name(v.source.event)) fail();
  for (const key of ['repositoryId', 'runId', 'attempt', 'actorId']) githubId(v.source[key]);
  if (!exact(v.target, 'id number workflow') || !v.payload || typeof v.payload !== 'object' || Array.isArray(v.payload)) fail();
  githubId(v.target.id);
  const p = v.payload, t = v.target;
  if (['close', 'label', 'issue-body', 'comment', 'reopen'].includes(v.kind) && (t.number !== b.number || t.workflow !== null)) fail();
  if (['pr', 'merge'].includes(v.kind)) {
    if (!sha(b.head) || !sha(b.base) || !hash(b.candidate)) fail();
    if (v.kind === 'merge') githubId(t.number);
  }
  if (v.kind === 'dispatch') {
    if (t.workflow !== t.id || t.number !== null || !exact(p, 'ref inputs' + (p.refIdentity ? ' refIdentity' : '') + (p.handoff ? ' handoff' : ''))
        || (p.refIdentity ? !exact(p.refIdentity, 'sha workflowDigest') || !sha(p.refIdentity.sha) || !hash(p.refIdentity.workflowDigest)
          || typeof p.ref !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/.test(p.ref) || sha(p.ref) || p.ref.startsWith('refs/')
          || p.ref.includes('..') || p.ref.includes('//') || /[/.]$/.test(p.ref) || p.ref.split('/').some(s=>s.endsWith('.lock')) : !sha(p.ref))
        || !p.inputs || typeof p.inputs !== 'object' || Array.isArray(p.inputs)
        || Object.values(p.inputs).some(x => typeof x !== 'string')
        || p.inputs.nibfin_correlation !== v.correlation) fail();
    if (p.handoff && (!p.refIdentity || !exact(p.handoff, 'source origin target workflow')
        || canonicalJSON(p.handoff).length>8192 || !exact(p.inputs,'nibfin_request nibfin_correlation')
        || p.inputs.nibfin_request!==v.correlation || v.source.request!==v.correlation
        || v.correlation!=='fanout-'+contentIdentity({...p.handoff,binding:b})
        || !hash(p.handoff.origin?.identity) || !name(p.handoff.origin?.cycle)
        || p.handoff.source?.repositoryId!==v.source.repositoryId
        || !same(v.source,{...p.handoff.origin?.provenance,request:v.correlation})
        || p.handoff.target?.repositoryId!==b.repositoryId || p.handoff.target?.issueId!==b.issueId
        || p.handoff.target?.repository!==b.repository || p.handoff.target?.number!==b.number
        || p.handoff.workflow?.id!==t.workflow || p.handoff.workflow?.ref!==p.ref
        || p.handoff.workflow?.sha!==p.refIdentity.sha || p.handoff.workflow?.digest!==p.refIdentity.workflowDigest)) fail();
  } else if (v.kind === 'comment') {
    githubId(t.number);
    if (!exact(p, 'body') || typeof p.body !== 'string' || p.body.length > 8192
      || !p.body.endsWith(`\n<!-- nibfin-operation:${v.correlation} -->`)) fail();
  } else if (v.kind === 'reopen') {
    githubId(t.number);
    if (!exact(p, 'state') || p.state !== 'open') fail();
  } else if (v.kind === 'issue-body') {
    githubId(t.number);
    if (!exact(p, 'body') || typeof p.body !== 'string' || !p.body.trim() || bodyDigest(p.body) !== b.shapeHash) fail();
  } else if (v.kind === 'close') {
    githubId(t.number);
    if (!exact(p, 'state state_reason') || p.state !== 'closed' || p.state_reason !== 'completed') fail();
  } else if (v.kind === 'label') {
    githubId(t.number);
    if (!exact(p, 'labels') || !Array.isArray(p.labels) || !p.labels.length || p.labels.some(x => !name(x))
        || new Set(p.labels).size !== p.labels.length) fail();
  } else if (v.kind === 'merge') {
    if (typeof b.baseRef !== 'string' || !/^[a-zA-Z0-9_./-]{1,128}$/.test(b.baseRef)
        || b.baseRef.includes('..') || b.baseRef.includes('//') || b.baseRef.startsWith('/') || b.baseRef.endsWith('/')
        || t.workflow !== null || !exact(p, 'sha merge_method') || p.sha !== b.head
        || !['merge', 'squash', 'rebase'].includes(p.merge_method)) fail();
  } else {
    // Creation only. Updates are deliberately outside this version's exposed PR contract.
    if (t.number !== null || t.workflow !== null || t.id !== b.repositoryId
        || !exact(p, 'title body head base') || typeof p.title !== 'string' || !p.title.trim()
        || p.title.length > 256 || typeof p.body !== 'string'
        || !p.body.endsWith(`\n<!-- nibfin-operation:${v.correlation} -->`)
        || ![p.head, p.base].every(x => typeof x === 'string' && /^[a-zA-Z0-9_/-]{1,128}$/.test(x)
          && !x.includes('..') && !x.includes('//'))) fail();
  }
  return v;
}
const requestFor=deliveryWriteRequest;

function custodyBinding(v, phase, source) {
  const b = v.binding;
  return {repository: b.repository, repositoryId: b.repositoryId, issueId: b.issueId, cycle: b.cycle,
    scopeHash: b.scopeHash, shapeHash: b.shapeHash, authorization: b.authorization,
    runId: source.runId, attempt: source.attempt, stage: 'candidate', result: `${phase}-${contentIdentity(v)}`, candidate: null};
}
/** Independent GETs only. Acknowledgment is never sufficient. */
async function observe(provider, v, signal, allowAbsent = false, reconcilePR = false) {
  const root = `/repos/${v.binding.repository}`, options = {operation: v.kind, correlation: v.correlation, target: v.target.id, signal};
  const read = async endpoint => {
    const r = await provider.request({...options, endpoint, method: 'GET'});
    if (r.outcome !== 'read' || signal?.aborted) throw Error('readback');
    return r;
  };
  const repo = await read(root);
  if (repo.data?.id !== v.binding.repositoryId || repo.data.full_name?.toLowerCase() !== v.binding.repository
      || repo.data.private !== false) throw Error('repository');
  if (v.kind === 'comment') {
    const issue=(await read(`${root}/issues/${v.target.number}`)).data;
    if(issue.id!==v.target.id || issue.node_id!==v.binding.issueId || String(issue.number)!==v.binding.number
      ||issue.repository_url!==`https://api.github.com${root}` || issue.pull_request) throw Error('issue');
    const path = `${root}/issues/${v.target.number}/comments`;
    const c = await provider.collection({...options, endpoint:path+'?per_page=100', allowPage:p=>p.split('?')[0]===path});
    if(c.outcome!=='complete') throw Error('pagination');
    const related=c.data.filter(d=>d.body?.includes(`<!-- nibfin-operation:${v.correlation} -->`));
    if(related.length!==1) throw Error('comment');
    const d=(await read(`${root}/issues/comments/${related[0].id}`)).data;
    if(d.id!==related[0].id || d.body!==v.payload.body || d.user?.id!==v.source.actorId
      || d.issue_url!==`https://api.github.com${root}/issues/${v.target.number}`
      || d.updated_at!==d.created_at || canonicalJSON(d)!==canonicalJSON(related[0])) throw Error('comment');
    return {effect:'comment-present',id:d.id,endpoint:`${root}/issues/comments/${d.id}`,identity:contentIdentity(d)};
  }
  let r;
  if (v.kind === 'dispatch' || v.kind === 'pr') {
    const path = v.kind === 'pr' ? `${root}/pulls` : `${root}/actions/workflows/${v.target.workflow}/runs`;
    const query = v.kind === 'pr' ? '?state=all&per_page=100' : '?event=workflow_dispatch&per_page=100';
    let total;
    const result = await provider.collection({...options, endpoint: path + query,
      ...(v.kind === 'dispatch' ? {envelope: 'workflow_runs', validate: d => {
        if (!Number.isSafeInteger(d?.total_count) || d.total_count < 0 || total !== undefined && total !== d.total_count) return false;
        total = d.total_count; return true;
      }} : {}), allowPage: p => p.split('?')[0] === path});
    if (result.outcome !== 'complete' || v.kind === 'dispatch' && result.data.length !== total) throw Error('pagination');
    const matchesEffect = d => v.kind === 'pr'
      ? d.body === v.payload.body && d.title === v.payload.title && d.head?.ref === v.payload.head
        && d.base?.ref === v.payload.base && d.head?.sha === v.binding.head && d.base?.sha === v.binding.base
        && d.base?.repo?.id === v.binding.repositoryId && d.head?.repo?.id === v.binding.repositoryId
      : d.workflow_id === v.target.id && d.event === 'workflow_dispatch' && d.head_sha === (v.payload.refIdentity?.sha ?? v.payload.ref)
        && d.display_title === `nibfin-operation:${v.correlation}` && d.repository?.id === v.binding.repositoryId;
    const matches = result.data.filter(matchesEffect);
    if (v.kind === 'pr' && (allowAbsent || reconcilePR)) {
      const related = result.data.filter(d => d.body?.includes(`<!-- nibfin-operation:${v.correlation} -->`)
        || d.head?.ref === v.payload.head);
      if (!related.length && allowAbsent) return null;
      if (related.length !== 1 || matches.length !== 1 || related[0] !== matches[0]) throw Error('conflicting-pr');
    }
    if (matches.length !== 1) throw Error('ambiguous');
    r = await read(v.kind === 'pr' ? `${root}/pulls/${matches[0].number}` : `${root}/actions/runs/${matches[0].id}`);
    if (r.data?.id !== matches[0].id || !matchesEffect(r.data)
        || v.kind === 'pr' && r.data.number !== matches[0].number) throw Error('changed');
    return {effect: v.kind === 'pr' ? 'pr-created' : 'dispatch-run-observed', id: r.data.id,
      endpoint: v.kind === 'pr' ? `${root}/pulls/${matches[0].number}` : `${root}/actions/runs/${matches[0].id}`,
      observedAt: r.observedAt, identity: contentIdentity(r.data)};
  }
  if (v.kind === 'merge') {
    r = await read(`${root}/pulls/${v.target.number}`);requireMergeIdentity(r.data);
    const d = r.data;
    if (d.id !== v.target.id || String(d.number) !== v.target.number || d.base?.repo?.id !== v.binding.repositoryId
        || d.base?.ref !== v.binding.baseRef || !sha(d.base?.sha)
        || d.head?.repo?.id !== v.binding.repositoryId || d.head?.sha !== v.binding.head
        || d.merged !== true || d.state !== 'closed' || !sha(d.merge_commit_sha)) throw Error('merge');
    const commit = await read(`${root}/commits/${d.merge_commit_sha}`);
    if (commit.data?.sha !== d.merge_commit_sha) throw Error('commit');
    const destination = await read(`${root}/branches/${encodeURIComponent(v.binding.baseRef)}`);
    const tip = destination.data?.commit?.sha;
    if(destination.data?.name !== v.binding.baseRef || !sha(tip)) throw Error('destination');
    const membership = await read(`${root}/compare/${d.merge_commit_sha}...${tip}`);
    const m=membership.data;
    if(m?.base_commit?.sha!==d.merge_commit_sha || m.merge_base_commit?.sha!==d.merge_commit_sha
      || !['ahead','identical'].includes(m.status) || !Number.isSafeInteger(m.behind_by) || m.behind_by!==0
      || !Number.isSafeInteger(m.ahead_by) || m.ahead_by<0
      || (m.status==='identical')!==(tip===d.merge_commit_sha)
      || (tip===d.merge_commit_sha?m.ahead_by!==0:m.ahead_by<1)) throw Error('destination-history');
    return {effect: 'merged', id: d.id, mergeCommit: d.merge_commit_sha, baseRef: d.base.ref, base: v.binding.base, destinationTip:tip,
      history:contentIdentity({commit:commit.data,destination:destination.data,membership:m}),
      endpoint: `${root}/pulls/${v.target.number}`, observedAt: r.observedAt, identity: contentIdentity(d)};
  }
  r = await read(`${root}/issues/${v.target.number}`);
  const d = r.data;
  if (d.id !== v.target.id || d.node_id !== v.binding.issueId || String(d.number) !== v.binding.number
      || d.repository_url !== `https://api.github.com${root}` || d.pull_request) throw Error('issue');
  if (v.kind === 'reopen' && (d.state !== 'open' || d.closed_at !== null)) throw Error('reopen');
  if (v.kind === 'close' && (d.state !== 'closed' || d.state_reason !== 'completed' || !d.closed_at)) throw Error('close');
  if (v.kind === 'issue-body' && d.body !== v.payload.body) throw Error('body');
  let labelsIdentity;
  if (v.kind === 'label') {
    // The Issue response can truncate labels: independently retrieve the full collection.
    const path = `${root}/issues/${v.target.number}/labels`;
    const labels = await provider.collection({...options, endpoint: path + '?per_page=100', allowPage: p => p.split('?')[0] === path});
    if (labels.outcome !== 'complete' || !v.payload.labels.every(x => labels.data.some(l => l.name === x))) throw Error('labels');
    labelsIdentity = contentIdentity(labels.data);
  }
  return {effect: v.kind === 'reopen' ? 'open-present' : v.kind === 'close' ? 'closed-completed' : v.kind === 'issue-body' ? 'body-present' : 'labels-present', id: d.id,
    ...(labelsIdentity ? {labelsIdentity, labelsEndpoint: `${root}/issues/${v.target.number}/labels`} : {}),
    endpoint: `${root}/issues/${v.target.number}`, observedAt: r.observedAt, identity: contentIdentity(d)};
}
/**
 * All capabilities are trusted Core-owned. locate resolves the original request's
 * traceable custody references, or positively attests a new request. Never infer
 * newness from a missing artifact. Writes must use createAuthorizationBoundary.
 */
export function createControlledOperations({authorization, provider, custody, publication, locate, execution, beforeSubmit = async () => {}, reconcileExistingPR = false, causalClose = false, timeoutMs = 30000} = {}) {
  if (typeof authorization?.request !== 'function' || typeof provider?.request !== 'function'
      || typeof provider?.collection !== 'function' || typeof custody?.retrieve !== 'function'
      || typeof publication !== 'function' || typeof locate !== 'function') throw Error('operations:capability');
  if (typeof causalClose !== 'boolean') fail();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw Error('operations:timeout');
  if (!exact(execution, 'runId attempt')) fail();
  githubId(execution.runId); githubId(execution.attempt);
  execution = structuredClone(execution);
  async function recover(entry, v, phase, signal) {
    if (!exact(entry, 'ref source') || !exact(entry.source, 'runId attempt')) fail();
    githubId(entry.source.runId); githubId(entry.source.attempt);
    const r = await bounded(custody.retrieve({ref: entry.ref, expected: custodyBinding(v, phase, entry.source), signal}), signal);
    if (r.outcome !== 'retrieved') throw Error('custody');
    const value = JSON.parse(r.payloads.get('operation.json').toString());
    if (!same(value.intent, v) || value.phase !== phase || value.version !== 1) throw Error('binding');
    return value;
  }
  async function retain(v, phase, value, signal) {
    const expected = custodyBinding(v, phase, execution);
    const payloads = new Map([['operation.json', Buffer.from(canonicalJSON({version: 1, phase, intent: v, ...value}))]]);
    const manifest = prepareCustodyManifest(expected, payloads);
    const facilities = await bounded(publication({intent: v, phase, expected}), signal);
    const r = await publishCustody({...facilities, expected, manifest, payloads, custody,
      name: `${phase}-${contentIdentity(v)}-${randomUUID()}`, retentionDays: 7, signal});
    if (r.outcome !== 'retained') throw Error('retention');
    const entry = {ref:r.ref, source:structuredClone(execution)};
    await recover(entry, v, phase, signal);
    return entry;
  }
  async function submit(v, refs, signal) {
    const boundary = ['dispatch','merge','close','label','comment','reopen'].includes(v.kind) ? authorization.withMutationGuard(async()=>{
      await beforeSubmit(structuredClone(v)); return !signal.aborted;
    }) : authorization;
    const result = await bounded(boundary.request({...requestFor(v), context: structuredClone(v.binding), signal}), signal);
    // An attempt precedes the guard and is not submission provenance. Retain the
    // boundary's actual result separately, including unknown/lost responses. If
    // retention is interrupted, recovery fails closed rather than inventing proof.
    if (publicationEffect(v,causalClose)) refs.submission = await retain(v, 'submission', {
      attempt: refs.attempt, submission: {outcome: result.outcome, diagnostic: result.diagnostic}
    }, signal);
    return result;
  }
  async function execute(input, {signal: caller, retryAfterNoEffect = false} = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(caller ? [caller] : [])]);
    let v, prior, refs = {}, submission;
    try {
      v = controlledIntent(input);
      prior = await bounded(locate({identity: contentIdentity(v), correlation: v.correlation, binding: structuredClone(v.binding)}), signal);
      if (signal?.aborted) return unknown(refs, 'cancelled');
      if (prior?.outcome === 'found') {
        refs = structuredClone(prior.refs);
        await recover(refs.intent, v, 'intent', signal);
        if (publicationEffect(v,causalClose) && !refs.attempt) return unknown(refs, 'missing-attempt');
        // Even a retained success is re-observed; no local result cache authorizes continuation.
        if (refs.attempt) await recover(refs.attempt, v, 'attempt', signal);
        const result = refs.result ? await recover(refs.result, v, 'result', signal) : null;
        if (publicationEffect(v,causalClose) && result?.outcome === 'confirmed-no-effect'
            && same(result.attempt, refs.attempt) && retryAfterNoEffect !== true)
          return unknown(refs, 'known-no-effect');
        if (publicationEffect(v,causalClose) && retryAfterNoEffect !== true) {
          if (!refs.submission) return unknown(refs, 'missing-submission');
          const submitted = await recover(refs.submission, v, 'submission', signal);
          if (!same(submitted.attempt, refs.attempt)) return unknown(refs, 'submission-attempt');
          if (submitted.submission?.outcome === 'failed' && submitted.submission.diagnostic?.kind === 'unauthorized')
            return unknown(refs, 'known-no-effect');
        }
        if (retryAfterNoEffect === true) {
          if (result?.outcome !== 'confirmed-no-effect' || result.submission?.diagnostic?.kind !== 'unauthorized'
              || !refs.attempt || !same(result.attempt, refs.attempt))
            return unknown(refs, 'unsafe-retry');
          refs.attempt = await retain(v, 'attempt', {previousResult: refs.result ?? null}, signal);
          await bounded(Promise.resolve(beforeSubmit(structuredClone(v))), signal);
          submission = await submit(v, refs, signal);
        }
      } else if (prior?.outcome === 'new' && prior.identity === contentIdentity(v)) {
        refs.intent = await retain(v, 'intent', {}, signal);
        if (signal?.aborted) return unknown(refs, 'cancelled');
        refs.attempt = await retain(v, 'attempt', {previousResult: refs.result ?? null}, signal);
        await bounded(Promise.resolve(beforeSubmit(structuredClone(v))), signal);
        const existing = reconcileExistingPR && v.kind === 'pr' ? await observe(provider, v, signal, true) : null;
        if (existing) {
          refs.result = await retain(v, 'result', {outcome:'confirmed-success', attempt:refs.attempt, observation:existing, submission:null}, signal);
          return {outcome:'confirmed-success', continuation:true, refs, observation:existing};
        }
        if (reconcileExistingPR && v.kind === 'pr') await bounded(Promise.resolve(beforeSubmit(structuredClone(v))), signal);
        submission = await submit(v, refs, signal);
      } else return unknown(refs, 'history');
      let observation;
      try {observation = await observe(provider, v, signal, false, reconcileExistingPR);} catch { /* Unknown effect remains blocked. */ }
      // Only the current boundary's explicit rejection BEFORE transport proves no effect.
      // HTTP failures, provider acknowledgment, cancellation and old state never do.
      const noEffect = submission?.outcome === 'failed' && submission.diagnostic?.kind === 'unauthorized';
      const outcome = noEffect ? 'confirmed-no-effect' : observation ? 'confirmed-success' : 'unknown';
      refs.result = await retain(v, 'result', {outcome, attempt: refs.attempt ?? null, observation: observation ?? null,
        submission: submission ? {outcome: submission.outcome, diagnostic: submission.diagnostic} : null}, signal);
      return {outcome, continuation: outcome === 'confirmed-success', refs,
        ...(observation ? {observation} : {})};
    } catch { return unknown(refs, 'identity-or-custody'); }
  }
  return Object.freeze({execute,causalClose});
}

/** Independent official GET readback, without submission or authorization. */
export function observeControlledOperation(provider, input, signal) {
  return observe(provider, controlledIntent(input), signal);
}
