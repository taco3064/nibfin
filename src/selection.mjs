import {githubId, repositoryCoordinates, memberRunnerLabel} from './index.mjs';
import {observeRunnerBindings} from './runners.mjs';

const login = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(value);
const sameUser = (a,b) => a?.id === b.id && login(a.login) && a.login.toLowerCase() === b.login.toLowerCase();
const stop = code => {throw code;};
const codes = new Set(['input','stale','cancelled','provider','issue','permission','authorization','runners']);

/** Inert construction. All capabilities and execution assertions belong to trusted Core. */
export function createAssigneeSelector({provider, authorizationFor, now = Date.now, maxCheckpointMs} = {}) {
  if (typeof provider?.request !== 'function' || typeof authorizationFor !== 'function'
      || typeof now !== 'function' || !Number.isSafeInteger(maxCheckpointMs) || maxCheckpointMs <= 0)
    throw Error('Invalid selection configuration');
  return Object.freeze({select: async (input, {signal, memberId} = {}) => {
    let observation;
    const result = (outcome, reason, extra = {}) => ({outcome, reason, ...(observation ? {observation} : {}), ...extra});
    try {
      const c = structuredClone(input), startedAt = now();
      let latest = startedAt;
      const fresh = timestamp => {
        const current = now();
        if (signal?.aborted) stop('cancelled');
        if (!Number.isSafeInteger(current) || !Number.isSafeInteger(timestamp) || timestamp < latest
            || current < timestamp || current - startedAt >= maxCheckpointMs) stop('stale');
        latest = current;
      };
      fresh(startedAt);
      const {target, issueId, number, operation, conditions, execution} = c;
      githubId(target.id); githubId(target.ownerId); githubId(number);
      const {key} = repositoryCoordinates(target.owner, target.repository);
      if (!['User','Organization'].includes(target.ownerType) || !/^[A-Za-z0-9_=-]{1,256}$/.test(issueId)
          || typeof issueId !== 'string' || typeof operation !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(operation)
          || !['linux','windows','macos'].includes(conditions?.platform) || !Array.isArray(conditions.labels)
          || conditions.labels.length > 100
          || conditions.labels.some(l => typeof l !== 'string' || l.length === 0 || l.length > 256
            || l.toLowerCase().startsWith('nibfin-user-'))
          || !Array.isArray(c.records) || !execution || execution.repositoryId !== target.id
          || execution.issueId !== issueId || execution.operation !== operation) stop('input');
      if (conditions.groupId !== undefined) githubId(conditions.groupId);
      if (!Number.isSafeInteger(execution.observedAt) || execution.observedAt > startedAt
          || startedAt - execution.observedAt >= maxCheckpointMs) stop('stale');
      // Existing work never becomes a new route, even if its old member is now offline.
      if (['queued','running','completed'].includes(execution.state)) return result('waiting','existing_work');
      if (execution.state === 'unknown') return result('waiting','reconciliation_required');
      if (execution.state !== 'new') stop('input');
      const prefix = `/repos/${key}`;
      const read = async endpoint => {
        const r = await provider.request({method:'GET',endpoint,target:target.id,operation,correlation:'selection',signal});
        if (r.outcome !== 'read') stop('provider');
        fresh(r.observedAt);
        return r.data;
      };
      const issue = await read(`${prefix}/issues/${number}`);
      githubId(issue?.id);
      if (issue.node_id !== issueId || String(issue.number) !== number || Object.hasOwn(issue,'pull_request')
          || issue.repository_url !== `https://api.github.com${prefix}` || !Array.isArray(issue.assignees)
          || issue.assignees.length > 100 || !Array.isArray(issue.labels)) stop('issue');
      const ids = new Set(), logins = new Set();
      for (const member of issue.assignees) {
        githubId(member?.id);
        if (!login(member.login) || ids.has(member.id) || logins.has(member.login.toLowerCase())) stop('issue');
        ids.add(member.id); logins.add(member.login.toLowerCase());
      }
      observation = {repositoryId:target.id, issueId, number, operation, source:'github-api',
        startedAt, observedAt:latest, candidateOrder:issue.assignees.map(a=>a.id)};
      if (!issue.labels.every(l => typeof l?.name === 'string')) stop('issue');
      if (!issue.labels.some(l=>l.name === 'scope')) return result('waiting','missing_scope');
      if (!issue.assignees.length) return result('waiting','no_assignees');
      if(memberId!==undefined && !issue.assignees.some(m=>m.id===memberId)) stop('authorization');
      const reasons = [];
      for (const member of issue.assignees) {
        if(memberId!==undefined && member.id!==memberId)continue;
        const permission = await read(`${prefix}/collaborators/${member.login}/permission`);
        if (!sameUser(permission?.user,member)
            || !['read','triage','none','write','maintain','admin'].includes(permission.permission)) stop('permission');
        if (['read','triage','none'].includes(permission.permission)) {
          reasons.push({memberId:member.id,reason:'ineligible'}); continue;
        }
        const boundary = await authorizationFor(Object.freeze({...member}), Object.freeze({target,issueId,number,operation}));
        const eligible = await boundary.eligibility({operation,correlation:'selection'}, {signal});
        const a = eligible?.observation;
        if (eligible?.ok !== true || a?.repositoryId !== target.id || a.issueId !== issueId
            || a.memberId !== member.id || a.operation !== operation) stop('authorization');
        fresh(a.observedAt);
        // Preserve every registration's identity checks, including nonmatching platforms.
        const records = c.records.filter(r=>r.memberId === member.id);
        const r = await observeRunnerBindings({request:async options => {
          const response = await provider.request({...options,method:'GET',signal});
          if (response.outcome === 'read') fresh(response.observedAt);
          return response;
        }}, {target, registration:c.registration, records,
          ...(c.executionPool===undefined?{}:{executionPool:c.executionPool}),
          conditions:{...conditions,labels:[]},correlation:'selection',signal});
        if (r.outcome !== 'matched' || r.inventory !== 'complete') stop('runners');
        if (conditions.groupId !== undefined
            && !r.groups?.some(group=>group.id===conditions.groupId && group.access==='allowed')) stop('runners');
        const memberLabel = memberRunnerLabel(member.id);
        if (r.runners.some(remote => remote.labels.includes(memberLabel)
            && !records.some(rec=>rec.runnerId===remote.id))) stop('runners');
        const matchingOnline = r.instances.some(instance => (conditions.groupId === undefined || instance.groupId === conditions.groupId)
          && instance.observation.platform === conditions.platform
          && instance.observation.status === 'online'
          && ['self-hosted',conditions.platform,...conditions.labels].every(l=>instance.observation.labels.includes(l.toLowerCase())));
        fresh(now());
        if (matchingOnline) {
          observation.observedAt = latest;
          const label = memberRunnerLabel(member.id);
          return result('selected','online_member',{memberId:member.id, routing:{runnerLabel:label,
            platform:conditions.platform, labels:[...new Set(['self-hosted',conditions.platform,
              ...conditions.labels.map(l=>l.toLowerCase()),label])],
            ...(conditions.groupId === undefined ? {} : {groupId:conditions.groupId})}});
        }
        reasons.push({memberId:member.id,reason:'no_matching_online_runner'});
      }
      fresh(now()); observation.observedAt = latest;
      return result('waiting','all_unavailable',{reasons});
    } catch (error) {
      return result('blocked', codes.has(error) ? error : 'input');
    }
  }});
}
