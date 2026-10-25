import {canonicalJSON, contentIdentity, githubId, publicationManifest, openPublicationJournal} from './index.mjs';

const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
class PublisherError extends Error {}
const stop = code => { throw new PublisherError(code); };
const require = (ok, code) => { if (!ok) stop(code); };
const keys = (value, allowed, required = allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k));
const stable = i => i && typeof i.id === 'string' && /^[1-9][0-9]*$/.test(i.id)
  && typeof i.nodeId === 'string' && /^[A-Za-z0-9_=-]{1,256}$/.test(i.nodeId)
  && Number.isSafeInteger(i.number) && i.number > 0;
const identity = i => ({id:i.id, nodeId:i.node_id, number:i.number});
const issuePath = (op, i) => `/repos/${op.target.repository}/issues/${i.number}`;
const lifecycleFields = ['frozen','authorized','shaped','active','delivered','closed'];

/** Capabilities are supplied by trusted Core, never constructed from plan/provider data. */
export async function publishPortfolio({provider, manifest:input, directory, initialize = false,
  authorize, protection, disclose, journalIO} = {}) {
  let journal, binding, operations = [], mappings = {}, edges = [], completed = [];
  let current = null;
  const observations = [];
  try {
    binding = publicationManifest(input);
    // Freeze the entire binding before invoking asynchronous caller capabilities.
    const manifest = JSON.parse(canonicalJSON(binding.manifest));
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    freeze(manifest);
    operations = manifest.operations;
    require(provider && typeof provider.request === 'function' && typeof provider.collection === 'function', 'provider');
    require([authorize, protection, disclose].every(f => typeof f === 'function'), 'capabilities');
    const items = new Map();
    for (const op of operations) {
      require(/^[A-Za-z0-9_-]{1,80}$/.test(op.correlation), 'schema');
      githubId(op.target.repositoryId);
      const p = op.payload;
      if (op.kind === 'dependency') {
        require(keys(p, ['blocked','blocking']) && p.blocked !== p.blocking, 'schema');
        const a = items.get(p.blocked), b = items.get(p.blocking);
        require(a && b && equal(op.target, a.target), 'endpoints');
        require(!operations.slice(0, operations.indexOf(op)).some(o => o.kind === 'dependency' && equal(o.payload, p)), 'duplicate-edge');
        continue;
      }
      require(keys(p, ['key','scope','request','issue','creation'], ['key','scope','request'])
        && typeof p.key === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(p.key) && !items.has(p.key), 'schema');
      require(keys(p.scope, ['body','identity']) && typeof p.scope.body === 'string'
        && p.scope.identity === contentIdentity(p.scope.body), 'original-provenance');
      require(keys(p.request, ['title','body','labels','milestone'], ['title','body','labels'])
        && typeof p.request.title === 'string' && p.request.title.length > 0
        && p.request.body === p.scope.body && Array.isArray(p.request.labels)
        && p.request.labels.every(l => typeof l === 'string' && l.length > 0 && !['shaped','delivered'].includes(l.toLowerCase()))
        && new Set(p.request.labels).size === p.request.labels.length
        && (!Object.hasOwn(p.request, 'milestone') || p.request.milestone === null
          || Number.isSafeInteger(p.request.milestone) && p.request.milestone > 0), 'metadata');
      if (op.kind === 'metadata') require(stable(p.issue) && !p.creation, 'identity');
      else require(!p.issue && keys(p.creation, ['creatorId','notBefore','notAfter'])
        && /^[1-9][0-9]*$/.test(p.creation.creatorId)
        && Number.isFinite(Date.parse(p.creation.notBefore)) && Number.isFinite(Date.parse(p.creation.notAfter))
        && Date.parse(p.creation.notBefore) <= Date.parse(p.creation.notAfter), 'creation-provenance');
      items.set(p.key, op);
    }
    const checkpoint = async (op, issues = []) => {
      require(await authorize({manifest, identity:binding.identity, operation:op}) === true, 'approval-or-permission');
      const targets = [op.target, ...issues.map(i => i.operation.target)];
      for (const target of targets) {
        const r = await provider.request({endpoint:`/repos/${target.repository}`, operation:'scope-read',
          correlation:op.correlation, target:target.repositoryId});
        require(r.outcome === 'read' && r.data.id === target.repositoryId
          && r.data.full_name?.toLowerCase() === target.repository && r.data.private === false
          && r.data.visibility === 'public' && ['User','Organization'].includes(r.data.owner?.type), 'repository');
      }
      for (const entry of issues) {
        const fresh = await getIssue(entry.operation, entry.issue);
        if (op.kind === 'dependency') require(matches(entry.operation, fresh), 'content-readback');
        const state = await protection({manifest, operation:op, target:entry.operation.target, issue:identity(fresh)});
        require(keys(state, lifecycleFields) && lifecycleFields.every(k => state[k] === false)
          && fresh.state === 'open' && !fresh.labels.some(l => ['shaped','delivered'].includes(l.name.toLowerCase())), 'protected-recovery-required');
      }
      require(await disclose({manifest, identity:binding.identity, operation:op}) === true, 'disclosure');
    };
    const request = (op, endpoint) => ({endpoint, operation:'scope-read', correlation:op.correlation, target:op.target.repositoryId});
    const validAssignments = data => Array.isArray(data?.assignees)
      && data.assignees.every(a => typeof a?.id === 'string' && /^[1-9][0-9]*$/.test(a.id));
    const resolvedIssue = (op, data) => ({issueId:data.id, repository:op.target.repository,
      repositoryId:op.target.repositoryId, nodeId:data.node_id, number:data.number,
      ...(op.kind === 'metadata' ? {assignees:data.assignees.map(a => a.id)} : {})});
    function boundIssue(op, data, expected) {
      return stable(identity(data ?? {})) && !Object.hasOwn(data, 'pull_request')
        && data.repository_url === `https://api.github.com/repos/${op.target.repository}`
        && data.url === `https://api.github.com${issuePath(op, data)}`
        && (!expected || equal(identity(data), expected));
    }
    function validIssue(op, data, expected) {
      return boundIssue(op, data, expected) && ['open','closed'].includes(data.state) && validAssignments(data)
        && Array.isArray(data.labels) && data.labels.every(l => typeof l.name === 'string')
        && (data.milestone === null || Number.isSafeInteger(data.milestone?.number));
    }
    async function getIssue(op, expected, capture = false) {
      const path = issuePath(op, expected);
      const r = await provider.request(request(op, path));
      // Capture metadata assignments as soon as their own identity and schema
      // are verified, before unrelated response/content predicates can reject.
      if (capture && op.kind === 'metadata' && r.outcome === 'read'
          && boundIssue(op, r.data, expected) && validAssignments(r.data)) {
        journal.readback(op, {complete:false, matches:[{intent:op, resolved:resolvedIssue(op, r.data)}]});
      }
      require(r.outcome === 'read' && validIssue(op, r.data, expected), 'issue-readback');
      observations.push({path, observedAt:r.observedAt});
      return r.data;
    }
    function matches(op, data) {
      const p = op.payload, r = p.request;
      return data.title === r.title && data.body === p.scope.body
        && equal(data.labels.map(l => l.name).sort(), [...r.labels].sort())
        && (!Object.hasOwn(r, 'milestone') || (data.milestone?.number ?? null) === r.milestone);
    }
    async function collection(op, path) {
      const initial = new URL(path, 'https://api.github.com'), base = initial.pathname;
      const r = await provider.collection({...request(op, path), allowPage:p => {
        const u = new URL(p, 'https://api.github.com');
        return u.pathname === base && [...u.searchParams.keys()].every(k => ['page',...initial.searchParams.keys()].includes(k)
          && u.searchParams.getAll(k).length === 1)
          && [...initial.searchParams].every(([k,v]) => u.searchParams.get(k) === v)
          && (!u.searchParams.has('page') || /^[1-9][0-9]*$/.test(u.searchParams.get('page')));
      }});
      require(r.outcome === 'complete', 'incomplete-readback');
      observations.push({path, complete:true});
      return r.data;
    }
    async function observe(op) {
      const p = op.payload;
      if (op.kind === 'dependency') {
        const a = mappings[p.blocked], b = mappings[p.blocking];
        require(a && b, 'unresolved-endpoints');
        await getIssue(items.get(p.blocked), a.issue);
        await getIssue(items.get(p.blocking), b.issue);
        const forward = await collection(op, `${issuePath(op, a.issue)}/dependencies/blocked_by?per_page=100`);
        const reverseOp = items.get(p.blocking);
        const reverse = await collection(reverseOp, `${issuePath(reverseOp, b.issue)}/dependencies/blocking?per_page=100`);
        const contains = (list, owner, expected) => {
          const found = list.filter(i => i.id === expected.id);
          return found.length === 1 && validIssue(owner, found[0], expected);
        };
        require(contains(forward, reverseOp, b.issue) && contains(reverse, op, a.issue), 'reciprocal-edge');
        return {blockedIssueId:a.issue.id, blockingIssueId:b.issue.id};
      }
      let expected = p.issue;
      if (op.kind === 'issue') {
        const all = await collection(op, `/repos/${op.target.repository}/issues?state=all&per_page=100`);
        require(all.every(i => Object.hasOwn(i, 'pull_request') || validIssue(op, i)), 'incomplete-issues');
        const candidates = all.filter(i => validIssue(op, i) && matches(op, i)
          && i.user?.id === p.creation.creatorId && Number.isFinite(Date.parse(i.created_at))
          && Date.parse(i.created_at) >= Date.parse(p.creation.notBefore) && Date.parse(i.created_at) <= Date.parse(p.creation.notAfter));
        require(candidates.length === 1, 'creation-reconciliation');
        expected = identity(candidates[0]);
      }
      const data = await getIssue(op, expected, true);
      const resolved = resolvedIssue(op, data);
      const complete = matches(op, data);
      // Preserve independently valid identity/assignment evidence before any
      // content rejection. Incomplete content must not erase a contradiction.
      if (!complete && op.kind !== 'metadata') journal.readback(op, {complete:false, matches:[{intent:op, resolved}]});
      require(complete, 'content-readback');
      mappings = {...mappings, [p.key]:{target:op.target, issue:expected, scope:p.scope, metadata:p.request,
        assignees:data.assignees.map(a => a.id)}};
      return resolved;
    }
    journal = openPublicationJournal({directory, manifest, initialize, ...(journalIO ? {io:journalIO} : {})});
    // Reconcile every old submission before allowing any fresh write, even if
    // the old journal called it complete. The journal enforces this ordering.
    for (const op of operations) {
      current = op;
      const prior = journal.recover(op.correlation);
      if (['absent','intent'].includes(prior.phase)) continue;
      await checkpoint(op);
      if (op.kind === 'metadata') require(Array.isArray(prior.derivation?.assignees), 'assignment-baseline-missing');
      const resolved = await observe(op);
      journal.readback(op, {complete:true, matches:[{intent:op, resolved}]});
      require(journal.recover(op.correlation).phase === 'complete', 'contradictory-history');
      completed.push(op.correlation);
      if (op.kind === 'dependency') edges.push({operation:op.correlation, ...resolved});
    }
    for (const op of operations) {
      current = op;
      if (completed.includes(op.correlation)) continue;
      const p = op.payload;
      const endpoints = op.kind === 'dependency' ? [p.blocked,p.blocking].map(k => ({operation:items.get(k), issue:mappings[k]?.issue}))
        : op.kind === 'metadata' ? [{operation:op, issue:p.issue}] : [];
      require(endpoints.every(e => e.issue), 'unresolved-endpoints');
      await checkpoint(op, endpoints);
      let before;
      if (op.kind === 'metadata') {
        before = await getIssue(op, p.issue);
        require(before.body === p.scope.body, 'original-provenance');
      }
      let endpoint, method, body;
      if (op.kind === 'dependency') {
        const blocker = mappings[p.blocking].issue.id;
        require(Number.isSafeInteger(Number(blocker)), 'unsupported-numeric-id');
        endpoint = `${issuePath(op, mappings[p.blocked].issue)}/dependencies/blocked_by`;
        method = 'POST'; body = {issue_id:Number(blocker)};
      } else {
        endpoint = op.kind === 'issue' ? `/repos/${op.target.repository}/issues` : issuePath(op, p.issue);
        method = op.kind === 'issue' ? 'POST' : 'PATCH'; body = p.request;
      }
      if (journal.recover(op.correlation).phase === 'absent') journal.intent(op);
      journal.submission(op, {method, endpoint, body, ...(before ? {assignees:before.assignees.map(a => a.id)} : {}),
        endpoints:endpoints.map(e => ({target:e.operation.target, issue:e.issue}))});
      const result = await provider.request({endpoint, method, body, operation:'scope-publish', correlation:op.correlation,
        target:op.target.repositoryId, context:{manifest:binding.identity, operation:contentIdentity(op)}});
      journal.result(op, result.outcome === 'submitted' ? 'submitted' : result.outcome === 'unknown' ? 'unknown' : 'rejected');
      const resolved = await observe(op);
      journal.readback(op, {complete:true, matches:[{intent:op, resolved}]});
      require(journal.recover(op.correlation).phase === 'complete', 'contradictory-history');
      completed.push(op.correlation);
      if (op.kind === 'dependency') edges.push({operation:op.correlation, ...resolved});
    }
    return {outcome:'verified', handoff:{version:1, kind:'raw-scope', approval:manifest.approval,
      plan:contentIdentity(manifest.plan), manifest:binding.identity, journal:journal.history().at(-1).identity,
      mappings, edges, observations, completed}};
  } catch (error) {
    // No arbitrary exception, response, caller text or public content escapes.
    return {outcome:'unresolved', manifest:binding?.identity ?? null, completed,
      unresolved:operations.filter(o => !completed.includes(o.correlation)).map(o => o.correlation).filter(c => /^[A-Za-z0-9_-]{1,80}$/.test(c)),
      diagnostic:error instanceof PublisherError ? error.message : 'scope-publication-stopped',
      operation:current && /^[A-Za-z0-9_-]{1,80}$/.test(current.correlation) ? current.correlation : null};
  }
}
