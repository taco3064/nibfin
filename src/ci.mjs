import {createHash} from 'node:crypto';

const id = x => typeof x === 'string' && /^[1-9][0-9]*$/.test(x);
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const need = (ok, reason = 'malformed') => { if (!ok) throw {reason}; };
const fingerprint = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const execution = x => object(x) && ['queued','in_progress','completed','waiting','requested','pending'].includes(x.status)
  && (x.conclusion === null || text(x.conclusion));
const state = x => x.conclusion === 'stale' ? 'stale' : x.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(x.conclusion) ? 'satisfied' :
  ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(x.conclusion) ? 'failed' : 'unknown';
const result = (requirement, status, reason, evidence = []) => ({requirement, status, reason, evidence:evidence.map(value => {
  if (value.runId) return value;
  return Object.fromEntries(['id','name','context','head_sha','status','conclusion','state','created_at'].filter(k => Object.hasOwn(value,k)).map(k => [k,value[k]]).concat(value.app ? [['appId',value.app.id]] : []));
})});

/** Read-only checkpoint observation. This never grants operational authorization. */
export async function observeGithubCI({provider, expected, actions = [], maxPages = 50} = {}) {
  const provenance = [], evaluations = [];
  let policy = null;
  try {
    need(provider && typeof provider.request === 'function' && object(expected), 'invalid_input');
    const e = structuredClone(expected), pins = structuredClone(actions);
    need(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(e.repository)
      && !e.repository.includes('..') && id(e.repositoryId) && id(e.prId) && Number.isSafeInteger(e.pr) && e.pr > 0
      && sha(e.head) && sha(e.baseSha) && id(e.baseRepositoryId) && /^[a-zA-Z0-9_./-]{1,200}$/.test(e.baseBranch)
      && !e.baseBranch.includes('..') && Array.isArray(pins) && pins.length <= 20
      && Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 100, 'invalid_input');
    for (const p of pins) need(object(p) && text(p.context) && id(p.appId) && p.sourceRepository === e.repository
      && p.sourceRepositoryId === e.repositoryId && sha(p.revision) && sha(p.blob)
      && /^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(p.path)
      && text(p.event) && id(p.runId) && Number.isSafeInteger(p.attempt) && p.attempt > 0 && text(p.job), 'invalid_input');
    const root = `/repos/${e.repository}`, base = encodeURIComponent(e.baseBranch);
    async function read(path, allow404 = false) {
      const r = await provider.request({method:'GET', endpoint:root + path, operation:'observe-ci', correlation:'ci', target:e.repositoryId});
      provenance.push({endpoint:root + path, observedAt:r.observedAt ?? null, diagnostic:r.diagnostic});
      if (allow404 && r.diagnostic?.status === 404) return null;
      need(r.outcome === 'read', r.diagnostic?.kind ?? 'unknown');
      return r;
    }
    async function pages(path, envelope) {
      const items = [], seen = new Set(), identities = new Set();
      let next = path, total;
      for (let n = 0; n < maxPages; n++) {
        need(!seen.has(next), 'pagination'); seen.add(next);
        const r = await read(next), values = envelope ? r.data?.[envelope] : r.data;
        need(Array.isArray(values));
        for (const value of values) {
          need(object(value));
          const key = value.id ?? fingerprint(value);
          need(!identities.has(key), 'pagination'); identities.add(key); items.push(value);
        }
        if (envelope) {
          need(Number.isSafeInteger(r.data.total_count) && r.data.total_count >= 0);
          total ??= r.data.total_count; need(total === r.data.total_count, 'pagination');
        }
        if (!r.link) { need(total === undefined || items.length === total, 'pagination'); return items; }
        const links = r.link.split(',').map(s => { const m = s.trim().match(/^<([^>]+)>;\s*rel="([a-z]+)"$/); need(m, 'pagination'); return m; });
        const following = links.filter(m => m[2] === 'next');
        if (!following.length) { need(total === undefined || items.length === total, 'pagination'); return items; }
        need(following.length === 1, 'pagination');
        const u = new URL(following[0][1]), original = new URL(root + path, 'https://api.github.com');
        need(u.origin === original.origin && !u.username && !u.password && !u.hash && u.pathname === original.pathname, 'pagination');
        const fixed = url => [...url.searchParams].filter(([k]) => k !== 'page').sort();
        need(JSON.stringify(fixed(u)) === JSON.stringify(fixed(original)) && /^[1-9][0-9]*$/.test(u.searchParams.get('page')), 'pagination');
        next = u.pathname.slice(root.length) + u.search;
      }
      throw {reason:'pagination'};
    }
    async function identity() {
      const repo = (await read('')).data, pr = (await read(`/pulls/${e.pr}`)).data;
      const branch = (await read(`/branches/${base}`)).data;
      need(repo.id === e.repositoryId && repo.full_name?.toLowerCase() === e.repository.toLowerCase()
        && repo.private === false && repo.visibility === 'public' && ['User','Organization'].includes(repo.owner?.type), 'identity');
      need(pr.id === e.prId && pr.number === e.pr && pr.head?.sha === e.head && pr.base?.ref === e.baseBranch
        && pr.base?.repo?.id === e.baseRepositoryId && pr.base.repo.id === e.repositoryId
        && pr.base.sha === e.baseSha && branch.name === e.baseBranch && branch.commit?.sha === e.baseSha, 'stale');
      need(typeof branch.protected === 'boolean');
      return branch;
    }
    async function currentPolicy(branch) {
      const classic = await read(`/branches/${base}/protection`, true);
      // Corroborate absence with the branch read; protected + 404 remains unknown.
      need(classic !== null || branch.protected === false, 'policy_unreadable');
      const rules = await pages(`/rules/branches/${base}?per_page=100`);
      const requirements = [], limitations = [];
      let strict = false;
      function add(context, appId, source) {
        need(text(context) && (appId === null || id(appId)));
        requirements.push({context, appId, source});
      }
      if (classic) {
        need(object(classic.data) && Object.hasOwn(classic.data, 'required_status_checks'));
        const c = classic.data.required_status_checks;
        if (c !== null) {
          need(object(c) && typeof c.strict === 'boolean' && Array.isArray(c.contexts) && Array.isArray(c.checks));
          strict ||= c.strict;
          for (const check of c.checks) {
            need(object(check) && Object.hasOwn(check,'app_id'));
            add(check.context, check.app_id === '-1' ? null : check.app_id, {kind:'classic'});
          }
          for (const context of c.contexts) if (!c.checks.some(x => x.context === context)) add(context, null, {kind:'classic'});
        }
        for (const [key,value] of Object.entries(classic.data)) if (!['url','required_status_checks'].includes(key) && value !== null && value !== false)
          limitations.push({kind:'classic', type:key});
      }
      for (const rule of rules) {
        need(object(rule) && text(rule.type) && id(rule.ruleset_id) && text(rule.ruleset_source)
          && ['Repository','Organization','Enterprise'].includes(rule.ruleset_source_type));
        const source = {kind:'ruleset', id:rule.ruleset_id, source:rule.ruleset_source, sourceType:rule.ruleset_source_type};
        if (rule.type === 'required_status_checks') {
          const p = rule.parameters;
          need(object(p) && typeof p.strict_required_status_checks_policy === 'boolean' && Array.isArray(p.required_status_checks));
          need(p.do_not_enforce_on_create === undefined || typeof p.do_not_enforce_on_create === 'boolean');
          need(Object.keys(p).every(k => ['strict_required_status_checks_policy','required_status_checks','do_not_enforce_on_create'].includes(k)), 'unsupported');
          strict ||= p.strict_required_status_checks_policy;
          for (const c of p.required_status_checks) add(c.context, c.integration_id ?? null, source);
        } else {
          limitations.push({...source, type:rule.type});
          // Known non-CI gates remain limitations. Unknown/other CI semantics cannot qualify.
          need(['deletion','non_fast_forward','required_linear_history','required_signatures','pull_request','creation','update',
            'required_deployments','merge_queue','required_code_scanning','code_scanning'].includes(rule.type), 'unsupported');
        }
      }
      return {requirements, strict, limitations, identity:fingerprint({classic:classic?.data ?? null,rules})};
    }
    const branch = await identity();
    policy = await currentPolicy(branch);
    const checks = await pages(`/commits/${e.head}/check-runs?filter=latest&per_page=100`, 'check_runs');
    const statuses = await pages(`/commits/${e.head}/statuses?per_page=100`);
    need(checks.every(c => object(c) && id(c.id) && text(c.name) && sha(c.head_sha) && id(c.app?.id)
      && execution(c)));
    need(statuses.every(s => object(s) && id(s.id) && text(s.context) && ['success','pending','failure','error'].includes(s.state)
      && Number.isFinite(Date.parse(s.created_at))));
    for (const requirement of policy.requirements) {
      const cs = checks.filter(c => c.name === requirement.context && (requirement.appId === null || c.app.id === requirement.appId));
      const ss = requirement.appId === null ? statuses.filter(s => s.context === requirement.context) : [];
      const apps = new Set(cs.map(c => c.app.id));
      if (apps.size > 1 || cs.length > 1) { evaluations.push(result(requirement,'unknown','ambiguous_source',cs)); continue; }
      const latest = ss.sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at));
      if (latest.length > 1 && Date.parse(latest[0].created_at) === Date.parse(latest[1].created_at)) {
        evaluations.push(result(requirement,'unknown','ambiguous_status',latest)); continue;
      }
      const evidence = [...cs, ...latest.slice(0,1)];
      const states = [...cs.map(c => c.head_sha === e.head ? state(c) : 'stale'), ...latest.slice(0,1).map(s => s.state === 'success' ? 'satisfied' : s.state === 'pending' ? 'pending' : 'failed')];
      const status = ['stale','unknown','failed','pending'].find(s => states.includes(s)) ?? (states.length ? 'satisfied' : 'pending');
      evaluations.push(result(requirement,status,states.length ? 'native_policy' : 'missing',evidence));
    }
    for (const pin of pins) {
      const requirement = {kind:'actions', ...pin};
      const runs = await pages(`/actions/workflows/${pin.path.split('/').at(-1)}/runs?head_sha=${e.head}&per_page=100`, 'workflow_runs');
      const matches = runs.filter(r => r.id === pin.runId);
      need(matches.length === 1, 'run_association');
      const run = (await read(`/actions/runs/${pin.runId}`)).data;
      need(execution(run));
      need(run.id === pin.runId && run.repository?.id === pin.sourceRepositoryId && run.head_repository?.id === pin.sourceRepositoryId
        && run.head_sha === e.head && run.path === pin.path && run.event === pin.event
        && run.run_attempt === pin.attempt && matches[0].run_attempt === pin.attempt, 'run_association');
      // Workflow run response pins the source path; bytes are resolved at caller's immutable revision.
      need(pin.revision === run.head_sha, 'source_revision');
      const source = (await read(`/contents/${pin.path}?ref=${pin.revision}`)).data;
      need(source.type === 'file' && source.path === pin.path && source.encoding === 'base64'
        && typeof source.content === 'string' && /^[A-Za-z0-9+/=\r\n]*$/.test(source.content), 'source');
      const bytes = Buffer.from(source.content.replace(/\s/g,''), 'base64');
      need(source.sha === pin.blob && blob(bytes) === pin.blob, 'source');
      const jobs = await pages(`/actions/runs/${pin.runId}/attempts/${pin.attempt}/jobs?per_page=100`, 'jobs');
      const selected = jobs.filter(j => j.name === pin.job);
      need(selected.length === 1, 'job_association');
      const job = selected[0];
      need(execution(job));
      // The attempt-specific endpoint binds jobs to the verified current run attempt.
      // GitHub's documented job response omits run_attempt; reject contradictory extensions if supplied.
      need(id(job.id) && job.run_id === pin.runId && job.head_sha === e.head
        && (!Object.hasOwn(job, 'run_attempt') || job.run_attempt === pin.attempt), 'job_association');
      const association = job.check_run_url?.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/check-runs\/([1-9][0-9]*)$/);
      need(association && association[1].toLowerCase() === e.repository.toLowerCase(), 'check_association');
      const associated = checks.filter(c => c.id === association[2] && c.name === pin.context && c.app.id === pin.appId && c.head_sha === e.head);
      need(associated.length === 1, 'check_association');
      const successful = [run,job,associated[0]].every(v => v.status === 'completed' && v.conclusion === 'success');
      evaluations.push(result(requirement, successful ? 'satisfied' : ['stale','unknown','failed','pending'].find(s => [run,job,associated[0]].some(v => state(v) === s)) ?? 'failed', 'actual_execution',
      [{runId:run.id,attempt:run.run_attempt,jobId:job.id,checkId:associated[0].id,conclusion:associated[0].conclusion,blob:source.sha}]));
      // Re-read the run to invalidate a rerun begun during collection.
      const fresh = (await read(`/actions/runs/${pin.runId}`)).data;
      need(fingerprint(fresh) === fingerprint(run), 'stale');
    }
    const refreshed = await identity(), refreshedPolicy = await currentPolicy(refreshed);
    need(fingerprint(policy) === fingerprint(refreshedPolicy), 'stale');
    const status = ['stale','unsupported','unknown','failed','pending'].find(s => evaluations.some(v => v.status === s)) ?? 'satisfied';
    return {qualifies:status === 'satisfied', status, expected:e, policy, evaluations, provenance, checkpointOnly:true};
  } catch (error) {
    const reason = error?.reason ?? 'malformed';
    const status = reason === 'stale' ? 'stale' : ['unsupported','invalid_input'].includes(reason) ? 'unsupported' : 'unknown';
    return {qualifies:false, status, reason, policy, evaluations, provenance, checkpointOnly:true};
  }
}
