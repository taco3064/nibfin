import { ghTransport, ghDownload } from './gh-cli.mjs';
import { setTimeout } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function repoPath(repository) {
  if (!repoPattern.test(repository)) throw new Error('Invalid repository identity');
  return `/repos/${repository}`;
}
export class GitHub {
  jobReadResponses = [];
  async freshReadObservation(work) {
    // Invalidate enclosing observations too: returning from a fresh retry must
    // not resurrect their earlier authority or queued-job snapshot.
    this.readGeneration++;
    this.readCache.clear();
    const scope = { reads: new Map(), generation: this.readGeneration, active: true };
    try { return await this.observations.run(scope, work); }
    finally { scope.active = false; scope.reads.clear(); }
  }
  constructor(token, fetcher = fetch, delay = setTimeout, now = Date.now) { this.token = token; this.fetch = fetcher; this.delay = delay; this.now = now; this.readCache = new Map(); this.retryAt = 0; this.observations = new AsyncLocalStorage(); this.readGeneration = 0; this.timings = new AsyncLocalStorage(); this.metrics = { requests: 0, reusedReads: 0, requestMs: 0, phases: {}, readsByCategory: {} }; }
  // A read observation is explicitly bounded by the caller. It never spans an
  // Agent or mutation. Nested dependency observations share only this boundary.
  async readObservation(work) {
    if (this.observations.getStore()?.active) return work();
    const scope = { reads: new Map(), generation: this.readGeneration, active: true };
    try { return await this.observations.run(scope, work); }
    finally { scope.active = false; scope.reads.clear(); }
  }
  async measure(name, work) {
    const started = performance.now();
    const row = this.metrics.phases[name] ||= { calls: 0, elapsedMs: 0 };
    row.calls++;
    try { return await this.timings.run(name, work); }
    finally { row.elapsedMs += Math.round(performance.now() - started); }
  }
  readMetric(path, method) {
    const category = /check-runs/.test(path) ? 'checks' : /actions\/runs.*jobs/.test(path) ? 'jobs' : /actions\/runs/.test(path) ? 'action-runs' : /contents/.test(path) ? 'contents' : /dependencies/.test(path) ? 'dependencies' : /branches|rulesets|rules\//.test(path) ? 'branch-policy' : /issues/.test(path) ? 'issues' : /pulls/.test(path) ? 'pulls' : /git\/|commits|compare/.test(path) ? 'git' : path === '/user' ? 'identity' : 'other';
    const key = [this.timings.getStore() || 'unscoped', method, category].join(':');
    return this.metrics.readsByCategory[key] ||= { requests: 0, reusedReads: 0, requestMs: 0 };
  }
  static async connect() {
    const github = new GitHub(undefined, ghTransport());
    github.download = ghDownload;
    return github;
  }
  async api(path, method = 'GET', body, apiVersion = '2026-03-10') {
    const scope = this.observations.getStore();
    if (method !== 'GET') {
      this.readGeneration++;
      this.readCache.clear();
      if (scope?.active) throw new Error('Writes are forbidden inside a read observation');
    }
    if (method === 'GET' && scope?.active) {
      if (scope.generation !== this.readGeneration) { scope.reads.clear(); scope.generation = this.readGeneration; }
      const key = `${apiVersion}:${path}`;
      if (!scope.reads.has(key)) scope.reads.set(key, this.request(path, method, body, apiVersion));
      else { this.metrics.reusedReads++; this.readMetric(path, method).reusedReads++; }
      return structuredClone(await scope.reads.get(key));
    }
    return this.request(path, method, body, apiVersion);
  }
  async request(path, method = 'GET', body, apiVersion = '2026-03-10') {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path');
    const cacheKey = `${apiVersion}:${path}`;
    if (method !== 'GET') this.readCache.clear();
    // Only retry unavailable reads. A failed write may already have happened;
    // its durable intent must be reconciled by Runtime instead of sent twice.
    for (let attempt = 0; ; attempt++) {
      if (this.retryAt > this.now()) throw Object.assign(new Error('GitHub rate limit reset pending'), { code: 'GITHUB_RATE_LIMIT', requestMethod: method, retryAt: this.retryAt });
      const cached = method === 'GET' ? this.readCache.get(cacheKey) : null;
      let response;
      const started = performance.now(), generation = this.readGeneration;
      this.metrics.requests++;
      const metric = this.readMetric(path, method); metric.requests++;
      try {
        response = await this.fetch(`https://api.github.com${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': apiVersion, 'Content-Type': 'application/json', ...(cached ? { 'If-None-Match': cached.etag } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        const transient = error.name === 'TimeoutError' || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.cause?.code);
        if (method !== 'GET' || !transient || attempt >= 2) throw Object.assign(error, { requestMethod: method });
        await this.delay(1000 * 2 ** attempt);
        continue;
      } finally {
        const elapsed = performance.now() - started;
        this.metrics.requestMs += elapsed; metric.requestMs += elapsed;
      }
      if (method === 'GET' && /\/actions\/runs\/\d+\/attempts\/\d+\/jobs(?:\?|$)/.test(path)) {
        this.jobReadResponses.push({ path, at: new Date().toISOString(), status: response.status,
          elapsedMs: Math.round(performance.now() - started), requestId: response.headers?.get('x-github-request-id') || null,
          rateLimitRemaining: response.headers?.get('x-ratelimit-remaining') || null, retryAfter: response.headers?.get('retry-after') || null });
        if (this.jobReadResponses.length > 100) this.jobReadResponses.shift();
      }
      // A 304 is a fresh authenticated server observation, never an offline
      // cache fallback. Permission failures and unavailable reads still fail.
      if (response.status === 304 && cached) return structuredClone(cached.value);
      if ([403, 429].includes(response.status)) {
        const reset = response.headers?.get('x-ratelimit-reset');
        const retry = response.headers?.get('retry-after');
        const deadlines = [];
        if (response.headers?.get('x-ratelimit-remaining') === '0' && /^\d+$/.test(reset || '') && Number.isSafeInteger(Number(reset))) deadlines.push(Number(reset) * 1000 + 1000);
        if (/^\d+$/.test(retry || '') && Number.isSafeInteger(Number(retry))) deadlines.push(this.now() + Number(retry) * 1000 + 1000);
        if (response.status === 429 && !deadlines.length) deadlines.push(this.now() + 60000);
        if (deadlines.length && deadlines.every(t => Number.isSafeInteger(t) && t <= this.now() + 86400000)) {
          this.retryAt = Math.max(this.now() + 1000, ...deadlines);
          throw Object.assign(new Error(`GitHub ${method} ${path.split('?')[0]}: HTTP ${response.status}; rate limit reset pending`), { code: 'GITHUB_RATE_LIMIT', status: response.status, requestMethod: method, retryAt: this.retryAt });
        }
      }
      if (method === 'GET' && [502, 503, 504].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        await this.delay(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw Object.assign(new Error(`GitHub ${method} ${path.split('?')[0]}: HTTP ${response.status}`), { ...(response.status === 401 ? { code: 'GITHUB_AUTH_FAILED' } : {}), status: response.status, requestMethod: method });
      const value = response.status === 204 ? null : await response.json();
      const etag = response.headers?.get('etag');
      if (method === 'GET' && response.status === 200 && etag && generation === this.readGeneration) {
        if (this.readCache.size >= 512) this.readCache.delete(this.readCache.keys().next().value);
        this.readCache.set(cacheKey, { etag, value: structuredClone(value) });
      }
      return value;
    }
  }
  async list(path, field) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const items = field ? data[field] : data;
      if (!Array.isArray(items)) throw new Error('Invalid paginated GitHub response');
      result.push(...items);
      if (items.length < 100) return result;
    }
    throw new Error('GitHub pagination limit exceeded');
  }
  async grant(source) {
    return JSON.parse(await this.text(source));
  }
  async text(source) {
    if (!source?.repository || !source?.path || !source?.ref) throw new Error('Explicit live authority source required');
    const path = source.path.split('/').map(encodeURIComponent).join('/');
    const file = await this.api(`${repoPath(source.repository)}/contents/${path}?ref=${encodeURIComponent(source.ref)}`);
    if (file.type !== 'file') throw new Error('Grant source is not a file');
    // Contents omits the inline payload above 1 MB. Read the immutable blob in
    // this same repository, never a caller-supplied download URL or newer ref.
    if (file.encoding === 'none') {
      const limit = 4 * 1024 * 1024;
      if (file.content !== '' || !/^[a-f0-9]{40}$/.test(file.sha || '') ||
          !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limit)
        throw new Error('Invalid or oversized authority blob descriptor');
      const blob = await this.api(`${repoPath(source.repository)}/git/blobs/${file.sha}`);
      if (blob.sha !== file.sha || blob.size !== file.size || blob.encoding !== 'base64' ||
          typeof blob.content !== 'string' || blob.content.length > 2 * limit)
        throw new Error('Authority blob identity changed');
      const encoded = blob.content.replace(/[\r\n]/g, '');
      if (encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded))
        throw new Error('Invalid authority blob encoding');
      const bytes = Buffer.from(encoded, 'base64');
      const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (bytes.toString('base64') !== encoded || bytes.length !== file.size || bytes.length > limit || sha !== file.sha)
        throw new Error('Authority blob bytes changed');
      return bytes.toString('utf8');
    }
    if (file.encoding !== 'base64') throw new Error('Grant source is not a file');
    return Buffer.from(file.content, 'base64').toString('utf8');
  }
  async repository(name) { return this.api(repoPath(name)); }
  async removeLabel(issue, name) {
    try { await this.api(`${repoPath(issue.repository)}/issues/${issue.number}/labels/${encodeURIComponent(name)}`, 'DELETE'); }
    catch (error) { if (error.status !== 404) throw error; }
  }
  async verifyRunner(repository, ids, name) {
    if (!Array.isArray(ids) || !ids.length || !ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error(`Missing approved runner registrations: ${repository}`);
    const runners = await this.list(`${repoPath(repository)}/actions/runners`, 'runners');
    const matched = runners.filter(r => ids.includes(r.id) && r.name === name && r.status === 'online' && r.labels?.some(l => l.name === 'nibfin-private') && r.labels?.some(l => l.name.toLowerCase() === 'linux'));
    if (matched.length !== 1) throw new Error(`Approved private runner is absent, offline or ambiguous: ${repository}`);
    return { repository, id: matched[0].id, name: matched[0].name };
  }
  async issue(issue) { return this.api(`${repoPath(issue.repository)}/issues/${issue.number}`); }
  async issueById(id) {
    const result=await this.api('/graphql','POST',{query:'query($id:ID!){node(id:$id){... on Issue{id number repository{nameWithOwner}}}}',variables:{id}});
    if(result.errors?.length)throw Error('Issue display identity could not be read');return result.data?.node;
  }
  async dependencies(issue) { return this.list(`${repoPath(issue.repository)}/issues/${issue.number}/dependencies/blocked_by`); }
  async label(issue, label) { await this.api(`${repoPath(issue.repository)}/issues/${issue.number}/labels`, 'POST', { labels: [label] }); }
  async updateIssue(issue, patch) { return this.api(`${repoPath(issue.repository)}/issues/${issue.number}`, 'PATCH', patch); }
  async pull(repository, number) {
    // The 2026 REST schema removed merge_commit_sha. Pin the supported 2022
    // representation for this readback; never infer the merge from a branch head.
    const pr = await this.api(`${repoPath(repository)}/pulls/${number}`, 'GET', undefined, '2022-11-28');
    if (pr.merged && !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha || '')) throw new Error('Merged PR lacks an actual merge commit identity');
    return pr;
  }
  async findPull(repository, branch) {
    const pulls = await this.list(`${repoPath(repository)}/pulls?state=all&head=${encodeURIComponent(`${repository.split('/')[0]}:${branch}`)}`);
    if (pulls.length > 1) throw new Error('Ambiguous pull request branch');
    return pulls[0];
  }
  async createPull(issue, branch, base) {
    return this.api(`${repoPath(issue.repository)}/pulls`, 'POST', { title: `upstream: deliver #${issue.number}`, head: branch, base, body: `Implements #${issue.number}.\n\nManaged by the approved upstream cohort. Closure follows verified delivery gates.` });
  }
  async merge(repository, number, head, method) {
    const result = await this.api(`${repoPath(repository)}/pulls/${number}/merge`, 'PUT', { sha: head, merge_method: method });
    if (!result.merged) throw new Error('GitHub did not confirm merge');
    return result;
  }
  async checks(repository, head, trustedApps = [], workflows) {
    const runs = await this.list(`${repoPath(repository)}/commits/${head}/check-runs?filter=latest`, 'check_runs');
    const results = runs.map(r => ({ id: String(r.id), name: r.name, head: r.head_sha, status: r.status, conclusion: r.conclusion, trusted: trustedApps.includes(r.app?.id) }));
    if (!workflows) return results;
    const root = repoPath(repository);
    const actions = await this.list(`${root}/actions/runs?head_sha=${encodeURIComponent(head)}&event=push`, 'workflow_runs');
    const blobs = new Map(), jobs = new Map();
    for (const [index, check] of runs.entries()) {
      const result = results[index];
      result.provenanceVerified = false;
      result.provenanceMatched = false;
      const pins = workflows.filter(w => w.checks.includes(check.name));
      if (pins.length !== 1 || !result.trusted || check.head_sha !== head) continue;
      const pin = pins[0];
      const candidates = actions.filter(r => r.check_suite_id === check.check_suite?.id && r.head_sha === head && r.head_repository?.full_name === repository && r.event === 'push' && r.path === pin.path);
      if (candidates.length !== 1) continue;
      const run = candidates[0];
      if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) continue;
      if (!blobs.has(pin.path)) blobs.set(pin.path, await this.api(`${root}/contents/${pin.path}?ref=${encodeURIComponent(head)}`));
      const file = blobs.get(pin.path);
      if (file.type !== 'file' || file.sha !== pin.blobSha) continue;
      if (!jobs.has(run.id)) jobs.set(run.id, await this.list(`${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs'));
      const matchingJobs = jobs.get(run.id).filter(j => j.check_run_url === `https://api.github.com${root}/check-runs/${check.id}` && j.head_sha === head);
      if (matchingJobs.length !== 1) continue;
      const success = run.status === 'completed' && run.conclusion === 'success' && matchingJobs[0].status === 'completed' && matchingJobs[0].conclusion === 'success';
      Object.assign(result, { provenanceMatched: true, provenanceVerified: success, workflowPath: pin.path, workflowBlobSha: file.sha, runId: String(run.id), runAttempt: run.run_attempt, checkSuiteId: String(run.check_suite_id) });
    }
    // A same-named PR check is not the policy-selected push check. Resolve by
    // provenance, never by choosing whichever result is green. Multiple genuine
    // matching push sources remain ambiguous and fail the Core's uniqueness gate.
    return results.filter(r => !results.some(other => other.name === r.name && other.provenanceMatched) || r.provenanceMatched);
  }
  async protections(repository, branch, ciMode = 'github-required') {
    if (ciMode === 'github-repository') {
      const info = await this.api(`${repoPath(repository)}/branches/${encodeURIComponent(branch)}`);
      return { head: info.commit.sha, requiredChecks: [], inspection: { source: 'github-repository', protected: info.protected } };
    }
    if (!['github-required', 'owner-policy'].includes(ciMode)) throw new Error('Unknown CI policy mode');
    const root = repoPath(repository), encoded = encodeURIComponent(branch);
    const details = await this.api(`${root}/branches/${encoded}`);
    if (typeof details.protected !== 'boolean') throw new Error('Branch protection state is unknown');
    // The branch API covers classic protection and rulesets. An explicitly
    // unprotected branch has no server obligations to discover via paid APIs.
    // This is not a fallback after a 403 or an assertion that CI passed.
    if (ciMode === 'owner-policy' && details.protected === false) return { head: details.commit.sha, requiredChecks: [], inspection: { source: 'branch-api', protected: false } };
    let classic = [], strictBase = false;
    if (details.protected) {
      try {
        const protection = await this.api(`${root}/branches/${encoded}/protection`);
        classic = protection.required_status_checks?.contexts || [];
        strictBase = protection.required_status_checks?.strict === true && protection.enforce_admins?.enabled === true && classic.length > 0;
      } catch (error) { if (error.status !== 404) throw error; }
    }
    // Rulesets and classic branch protection both contribute obligations.
    const rules = await this.list(`${root}/rules/branches/${encoded}`);
    const required = rules.flatMap(r => r.type === 'required_status_checks' ? r.parameters.required_status_checks.map(c => c.context) : []);
    return { head: details.commit.sha, requiredChecks: [...new Set([...classic, ...required])], inspection: { source: 'protection-apis', protected: details.protected, strictBase } };
  }
  async initialize(repository) {
    const repo = await this.repository(repository);
    if (!repo.permissions?.push) throw new Error('Repository write permission required');
    const labels = await this.list(`${repoPath(repository)}/labels`);
    for (const name of ['scope', 'shaped', 'delivered']) if (!labels.some(l => l.name === name)) await this.api(`${repoPath(repository)}/labels`, 'POST', { name, color: '5319e7' });
    return { repository, visibility: repo.visibility, defaultBranch: repo.default_branch, entrypoint: repo.private ? 'private-reusable' : 'public-runner-dispatch', labels: ['scope', 'shaped', 'delivered'] };
  }
}
