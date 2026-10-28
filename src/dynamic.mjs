import {prerequisiteTraversal} from './collaboration.mjs';
import {githubId, repositoryCoordinates} from './index.mjs';
import {verifyCompletion} from './evidence.mjs';

const nodeId = v => typeof v === 'string' && /^[A-Za-z0-9_=-]{1,256}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const key = n => `${n.repositoryId}:${n.issueId}`;
const issuePath = n => `/repos/${n.repository}/issues/${n.number}`;
const clone = structuredClone;
function identity(n) {
  githubId(n.repositoryId); githubId(n.databaseId); githubId(n.number);
  const [owner, repo, extra] = n.repository.split('/');
  if (extra || repositoryCoordinates(owner, repo).key !== n.repository || !nodeId(n.issueId)) throw Error('identity');
  return {repository:n.repository, repositoryId:n.repositoryId, issueId:n.issueId,
    databaseId:n.databaseId, number:n.number};
}
const safeKinds = new Set(['authentication','denied','not_found_or_inaccessible','rate_limited',
  'transport','timeout','cancelled','malformed','pagination','expired','invalid_evidence',
  'server','invalid_request','unsupported','digest','source','mismatch','missing_or_ambiguous']);
const reason = r => safeKinds.has(r?.diagnostic?.kind) ? r.diagnostic.kind : 'incomplete';

/** Trusted capabilities only. Results are observations, never execution permissions. */
export function createDependencyEvaluator({provider, authorize, current, retrieve, custody,
  maxNodes = 100, maxReads = 300, maxEdges = 1000, maxDepth = 100, timeoutMs = 30000} = {}) {
  if (typeof provider?.request !== 'function' || typeof provider?.collection !== 'function'
      || typeof authorize !== 'function' || typeof current !== 'function'
      || [maxNodes,maxReads,maxEdges,maxDepth,timeoutMs].some(n => !Number.isSafeInteger(n) || n < 1)
      || maxNodes > 10000 || maxReads > 30000 || maxEdges > 100000 || maxDepth > 500 || timeoutMs > 86400000)
    throw Error('Invalid dependency configuration');
  // Capture capabilities; mutation of the supplied capability bags cannot replace them.
  const request = provider.request.bind(provider), collection = provider.collection.bind(provider);
  const recover = custody?.retrieve?.bind(custody);
  return Object.freeze({evaluate: async (input, {signal: caller} = {}) => {
    const observations = [], edges = [], completions = [], findings = [];
    const started = performance.now();
    let target, active, timer, abort;
    const stop = (code, issue, waiting = false) => {throw {code, issue, waiting};};
    try {
      // Catalog and target are independently supplied authorization boundaries, not graph edges.
      const snapshot = clone(input);
      target = identity(snapshot.target);
      const catalog = snapshot.issues.map(identity);
      const byKey = new Map(), byPath = new Map(), byDatabase = new Set(), byNode = new Set(), repositories = new Map();
      for (const n of catalog) {
        if (byKey.has(key(n)) || byPath.has(issuePath(n)) || byDatabase.has(n.databaseId) || byNode.has(n.issueId)
            || repositories.has(n.repository) && repositories.get(n.repository) !== n.repositoryId) stop('identity', n);
        repositories.set(n.repository,n.repositoryId); byKey.set(key(n),n); byPath.set(issuePath(n),n); byDatabase.add(n.databaseId); byNode.add(n.issueId);
      }
      if (JSON.stringify(byKey.get(key(target))) !== JSON.stringify(target)) stop('unauthorized',target);
      active = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(caller ? [caller] : [])]);
      // Bound even capabilities that ignore AbortSignal. Clear our timer and listener on exit.
      const deadline = new Promise((_, reject) => {
        abort = () => reject({code:caller?.aborted ? 'cancelled' : 'timeout', issue:target});
        active.addEventListener('abort',abort,{once:true});
        timer = setTimeout(abort,timeoutMs);
      });
      let reads = 0, edgeCount = 0;
      const gate = issue => {
        if (active.aborted || performance.now() - started >= timeoutMs) stop(caller?.aborted ? 'cancelled' : 'timeout',issue);
      };
      const call = async (fn, issue) => {
        gate(issue);
        let value;
        try {value = await Promise.race([Promise.resolve().then(fn),deadline]);}
        catch (e) {gate(issue); if (e?.code === 'timeout') stop('timeout',issue); stop('unavailable',issue);}
        gate(issue); return value;
      };
      const read = async (fn,n) => {if (++reads > maxReads) stop('limit',n); return call(fn,n);};
      const visit=prerequisiteTraversal({key,
        cycle:n=>stop('cycle',n),limit:(n,depth,count)=>{
          gate(n);if(depth>maxDepth||count>=maxNodes)stop('limit',n);
        },enter:async n=>{
        const auth = clone(await call(() => authorize(clone(n),{signal:active}),n));
        if (auth?.ok !== true || auth.observation?.repositoryId !== n.repositoryId
            || auth.observation?.issueId !== n.issueId || auth.observation?.operation !== 'readiness'
            || !Number.isSafeInteger(auth.observation?.observedAt)
            || !Number.isSafeInteger(auth.observation?.startedAt)
            || auth.observation.startedAt > auth.observation.observedAt) stop('unauthorized',n);
        const options = {method:'GET',target:n.repositoryId,operation:'readiness',correlation:'dependencies',signal:active};
        const repo = await read(() => request({...options,endpoint:`/repos/${n.repository}`}),n);
        if (repo?.outcome !== 'read') stop(reason(repo),n);
        if (repo.data?.id !== n.repositoryId || repo.data.full_name?.toLowerCase() !== n.repository
            || repo.data.private !== false || repo.data.visibility !== 'public'
            || !['User','Organization'].includes(repo.data.owner?.type)) stop('repository',n);
        const issue = await read(() => request({...options,endpoint:issuePath(n)}),n);
        if (issue?.outcome !== 'read') stop(reason(issue),n);
        const matches = (d, expected) => d?.id === expected.databaseId && d.node_id === expected.issueId
          && String(d.number) === expected.number && !Object.hasOwn(d,'pull_request')
          && d.repository_url === `https://api.github.com/repos/${expected.repository}`
          && d.url === `https://api.github.com${issuePath(expected)}`;
        if (!matches(issue.data,n)) stop('identity',n);
        const path = `${issuePath(n)}/dependencies/blocked_by`;
        let pages = 0;
        const dependencies = await call(() => collection({...options,endpoint:path+'?per_page=100',allowPage:p => {
          if (++pages + reads > maxReads) return false;
          try {
            const u = new URL(p,'https://api.github.com');
            return u.origin === 'https://api.github.com' && u.pathname === path && !u.hash && !u.username && !u.password
              && [...u.searchParams.keys()].every(k => ['page','per_page'].includes(k))
              && [...u.searchParams.values()].every(v => /^[1-9][0-9]*$/.test(v))
              && [...u.searchParams.keys()].every(k => u.searchParams.getAll(k).length === 1);
          } catch {return false;}
        }}),n);
        reads += pages;
        if (dependencies?.outcome !== 'complete' || !Array.isArray(dependencies.data)) stop(reason(dependencies),n);
        const upstreams = [], seen = new Set();
        for (const d of dependencies.data) {
          if (++edgeCount > maxEdges) stop('limit',n);
          if (typeof d?.url !== 'string' || !d.url.startsWith('https://api.github.com/repos/')) stop('identity',n);
          const parent = byPath.get(d.url.slice('https://api.github.com'.length));
          if (!parent) stop('unauthorized_upstream',n);
          if (!matches(d,parent) || seen.has(key(parent))) stop('identity',n);
          seen.add(key(parent)); upstreams.push(parent);
          edges.push({from:clone(n), upstream:clone(parent)});
        }
        observations.push({issue:clone(n),authorization:{repositoryId:auth.observation.repositoryId,issueId:auth.observation.issueId,
          operation:auth.observation.operation,startedAt:auth.observation.startedAt,observedAt:auth.observation.observedAt},
          observedAt:issue.observedAt,upstreams:upstreams.map(n=>clone(n))});
        return upstreams;
      },leave:async (n,upstream)=>{
        if (upstream) {
          const c = clone(await call(() => current(clone(n),{signal:active}),n));
          if (!c || !hash(c.identity) || !c.expected) stop('completion_missing',n,true);
          let receipt;
          if (c.custody) {
            if (!recover) stop('custody_unavailable',n);
            const result = await call(() => recover({...clone(c.custody),signal:active}),n);
            if (result?.outcome !== 'retrieved') stop('custody_'+reason(result),n);
            try {receipt = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.payloads.get(c.custody.path)));}
            catch {stop('completion_invalid',n);}
          } else {
            if (typeof retrieve !== 'function') stop('completion_unavailable',n);
            receipt = clone(await call(() => retrieve(clone(n),{signal:active}),n));
          }
          try {
            const valid = verifyCompletion(receipt,c.expected);
            const binding = valid.payload.receipts.publication.binding;
            if (binding.repositoryId !== n.repositoryId || binding.issueId !== n.issueId || valid.identity !== c.identity) throw Error();
            completions.push({issue:clone(n),identity:valid.identity});
          } catch {stop('completion_invalid',n);}
        }
      }});
      await visit(target,0,false);
      gate(target);
    } catch (e) {
      const codes = new Set(['identity','unauthorized','unauthorized_upstream','cycle','limit','repository',
        'completion_missing','completion_invalid','completion_unavailable','custody_unavailable','unavailable',
        ...safeKinds,...[...safeKinds].map(k=>'custody_'+k),'custody_incomplete','incomplete']);
      findings.push({reason:codes.has(e?.code) ? e.code : 'invalid_input',issue:e?.issue ? clone(e.issue) : target ?? null});
      return {outcome:e?.waiting ? 'waiting' : 'blocked',target:target ?? null,observations,edges,completions,findings};
    } finally {clearTimeout(timer); if (abort) active?.removeEventListener('abort',abort);}
    return {outcome:'ready',target,observations,edges,completions,findings};
  }});
}
