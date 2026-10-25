import {createGithubProvider, publicDiagnostic} from './provider.mjs';
import {verifyGrant} from './grants.mjs';
import {githubId, repositoryCoordinates} from './index.mjs';

const validId = value => {try {githubId(value); return true;} catch {return false;}};
const login = value => typeof value === 'string' && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(value);
const sameLogin = (a, b) => login(a) && login(b) && a.toLowerCase() === b.toLowerCase();
const user = (actual, expected) => actual?.id === expected.id && sameLogin(actual.login, expected.login);
const denied = category => ({ok: false, diagnostic: {kind: category}});

/** Core-owned configuration only. No observation or eligibility result is a write capability. */
export function createAuthorizationBoundary({getCheckpoint, now = Date.now, maxCheckpointMs, beforeMutation = async () => true, ...providerOptions} = {}) {
  if (typeof getCheckpoint !== 'function' || typeof now !== 'function' || typeof beforeMutation !== 'function'
      || !Number.isSafeInteger(maxCheckpointMs) || maxCheckpointMs <= 0
      || Object.hasOwn(providerOptions, 'authorize')) throw Error('Invalid authorization configuration');
  const identity = providerOptions.identity ?? 'local-stored-login';
  let provider;
  async function check(intent, signal) {
    let started, c, request;
    try {
      started = now();
      if (!Number.isSafeInteger(started)) return denied('timing');
      // Snapshot trusted inputs before any provider await, including mutable Grant context.
      c = structuredClone(await getCheckpoint(Object.freeze({...intent})));
      request = c.request;
      githubId(request.repository.id); githubId(request.number); githubId(c.member.id);
      const [owner, repo, extra] = request.repository.name.split('/');
      if (extra || repositoryCoordinates(owner, repo).key !== request.repository.name
          || request.repository.visibility !== 'public' || !login(c.member.login)
          || typeof request.issueId !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(request.issueId)
          || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.operation)) return denied('identity');
      if (intent.method && (c.write?.method !== intent.method || c.write?.endpoint !== intent.endpoint
          || c.write?.target !== intent.target || request.operation !== intent.operation)) return denied('binding');
      const prefix = `/repos/${request.repository.name}`;
      let latest = started;
      const fresh = timestamp => {
        const current = now();
        // Retain the high-water mark so earlier reads cannot become future-dated
        // after a regression that still remains above checkpoint start.
        if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(current)
            || timestamp < latest || current < timestamp || current - started >= maxCheckpointMs) return false;
        latest = current;
        return true;
      };
      const read = async endpoint => {
        const result = await provider.request({endpoint, target: request.repository.id, operation: request.operation,
          correlation: intent.correlation ?? 'authorization', signal});
        if (result.outcome !== 'read') return {error: {ok: false, ...publicDiagnostic(result)}};
        if (!fresh(result.observedAt)) return {error: denied('stale')};
        return {data: result.data};
      };
      const observe = async (endpoint, validate) => {
        const r = await read(endpoint);
        if (r.error) return r.error;
        return validate(r.data) ? null : denied('observation');
      };
      if (identity === 'local-stored-login') {
        githubId(c.operator.id);
        if (!login(c.operator.login)) return denied('identity');
        const failure = await observe('/user', d => user(d, c.operator));
        if (failure) return failure;
      } else if (c.operator?.trusted !== true || c.operator.source !== 'hosted-authorized'
          || !['user', 'service'].includes(c.operator.kind)
          || typeof c.operator.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.operator.id)) return denied('identity');
      const observations = [
        [prefix, d => d?.id === request.repository.id && d.private === false && d.visibility === 'public'
          && typeof d.full_name === 'string' && d.full_name.toLowerCase() === request.repository.name
          && sameLogin(d.owner?.login, owner) && ['User', 'Organization'].includes(d.owner?.type)],
        [`${prefix}/issues/${request.number}`, d => validId(d?.id) && d.node_id === request.issueId && String(d.number) === request.number
          && !Object.hasOwn(d, 'pull_request') && d.repository_url === `https://api.github.com${prefix}`
          && Array.isArray(d.assignees) && d.assignees.every(a => login(a?.login) && validId(a.id))
          && d.assignees.some(a => user(a, c.member))],
        [`/users/${c.member.login}`, d => user(d, c.member)],
        [`${prefix}/collaborators/${c.member.login}/permission`, d => user(d?.user, c.member)
          && ['write', 'maintain', 'admin'].includes(d.permission)],
      ];
      for (const [endpoint, validate] of observations) {
        const failure = await observe(endpoint, validate);
        if (failure) return failure;
      }
      const finished = now();
      if (!fresh(finished) || signal?.aborted) return denied(signal?.aborted ? 'cancelled' : 'stale');
      // Never accept a request/clock supplied by Grant context in place of this checkpoint.
      const grant = verifyGrant(c.grant, {...c.grantContext, now: finished, request});
      if (!grant.ok) return denied('grant_' + grant.category);
      if (!fresh(now()) || signal?.aborted) return denied(signal?.aborted ? 'cancelled' : 'stale');
      return {ok: true, observation: {source: identity, startedAt: started, observedAt: finished,
        repositoryId: request.repository.id, issueId: request.issueId, memberId: c.member.id,
        operation: request.operation}};
    } catch { return denied('incomplete'); }
  }
  provider = createGithubProvider({...providerOptions, now, authorize: async intent => {
    if (!(await check(intent, intent.signal)).ok) return false;
    try {return await beforeMutation(intent) === true && !intent.signal?.aborted;} catch {return false;}
  }});
  return Object.freeze({eligibility: (intent = {}, {signal} = {}) => check(intent, signal),
    request: provider.request, reconcile: provider.reconcile});
}
