import {githubId, repositoryCoordinates, memberRunnerLabel} from './index.mjs';
import {publicDiagnostic} from './provider.mjs';

const platforms = new Set(['linux', 'windows', 'macos']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const lower = value => value.toLowerCase();
const fail = (code, kind = 'mismatch') => { throw {code, kind}; };
const malformed = () => fail('response_schema', 'unavailable');
function runner(value) {
  githubId(value.id);
  if (!text(value.name) || !platforms.has(value.os) || !['online', 'offline'].includes(value.status)
      || typeof value.busy !== 'boolean' || !Array.isArray(value.labels)
      || value.labels.some(label => !text(label.name) || !['custom', 'read-only'].includes(label.type))) malformed();
  const labels = value.labels.map(label => lower(label.name));
  if (new Set(labels).size !== labels.length) malformed();
  return {id:value.id, name:value.name, platform:value.os, status:value.status, busy:value.busy, labels};
}

/** Read-only observations; trusted Core inputs and provider capability are required. */
export function observeRunners(provider, input) { return observe(provider, input, true); }

/** Binding/access reconciliation across platforms; does not establish job eligibility. */
export function observeRunnerBindings(provider, input) { return observe(provider, input, false); }
async function observe(provider, input, matchJob) {
  const diagnostics = [];
  let request, target, registration, records, conditions;
  try {
    target = input.target;
    const coordinates = repositoryCoordinates(target.owner, target.repository);
    githubId(target.id); githubId(target.ownerId);
    if (!['User', 'Organization'].includes(target.ownerType)) fail('target_schema');
    registration = input.registration;
    if (!['repository', 'organization'].includes(registration.level)) fail('registration_scope');
    if (registration.level === 'repository') {
      if (registration.id !== target.id) fail('registration_scope');
    } else {
      const org = repositoryCoordinates(registration.organization, 'unused').owner;
      githubId(registration.id);
      if (org !== coordinates.owner || target.ownerType !== 'Organization' || registration.id !== target.ownerId)
        fail('registration_scope');
    }
    conditions = input.conditions ?? {};
    if (!Array.isArray(conditions.labels) || conditions.labels.some(label => !text(label))
        || !platforms.has(conditions.platform)) fail('conditions');
    if (conditions.groupId !== undefined) githubId(conditions.groupId);
    if (conditions.groupId !== undefined && registration.level !== 'organization') fail('registration_scope');
    if (conditions.workflow !== undefined && (typeof conditions.workflow !== 'string'
        || !new RegExp('^' + coordinates.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          + '/\\.github/workflows/[A-Za-z0-9_.-]+@[^\\s]+$','i').test(conditions.workflow))) fail('workflow_context');
    records = input.records;
    if (!Array.isArray(records)) fail('records');
    const ids = new Set(), instanceIds = new Set();
    for (const record of records) {
      githubId(record.runnerId); githubId(record.memberId);
      if (!text(record.instanceId) || !platforms.has(record.platform)) fail('record_schema');
      if (ids.has(record.runnerId) || instanceIds.has(record.instanceId)) fail('duplicate_record');
      ids.add(record.runnerId); instanceIds.add(record.instanceId);
      if (record.registration?.level !== registration.level || record.registration?.id !== registration.id
          || record.repositoryId !== target.id) fail('record_scope');
      if (registration.level === 'organization') {
        let organization;
        try { organization = repositoryCoordinates(record.registration.organization, 'unused').owner; }
        catch { fail('record_scope'); }
        if (organization !== coordinates.owner) fail('record_scope');
      }
    }
    request = {operation:'runner-observation', correlation:input.correlation, target:target.id, signal:input.signal};
    const repoPath = `/repos/${coordinates.key}`;
    const repo = await provider.request({...request, endpoint:repoPath, expectedId:target.id});
    if (repo.outcome !== 'read') throw {code:'target_unavailable', kind:'unavailable', provider:publicDiagnostic(repo).diagnostic};
    if (repo.data.owner?.id !== target.ownerId || repo.data.owner?.type !== target.ownerType
        || typeof repo.data.full_name !== 'string' || lower(repo.data.full_name) !== coordinates.key) fail('wrong_target');
    if (repo.data.private !== false || repo.data.visibility !== 'public') fail('private_or_unknown_target', 'unsupported');
    const maxPages = input.maxPages ?? 100;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) fail('page_bound');
    // Each collection has a single identity; only page/per_page may vary in continuation.
    async function inventory(path, envelope, normalize) {
      let endpoint = path + '?per_page=100', total;
      const seenPages = new Set(), seenIds = new Set(), data = [];
      for (let page = 0; page < maxPages; page++) {
        if (seenPages.has(endpoint)) fail('pagination_cycle', 'unavailable');
        seenPages.add(endpoint);
        const result = await provider.request({...request, endpoint});
        if (result.outcome !== 'read') throw {code:'inventory_unavailable', kind:'unavailable', provider:publicDiagnostic(result).diagnostic};
        const values = result.data?.[envelope], count = result.data?.total_count;
        if (!Array.isArray(values) || !Number.isSafeInteger(count) || count < 0 || (total !== undefined && count !== total)) malformed();
        total = count;
        for (const value of values) {
          githubId(value.id);
          if (seenIds.has(value.id)) fail('duplicate_remote_id', 'unavailable');
          seenIds.add(value.id); data.push(normalize(value));
        }
        if (data.length > total) malformed();
        let next;
        if (result.link !== undefined) {
          if (typeof result.link !== 'string') malformed();
          for (const part of result.link.split(',')) {
            const match = part.trim().match(/^<([^>]+)>;\s*rel="(next|prev|first|last)"$/);
            if (!match) fail('pagination_link', 'unavailable');
            const url = new URL(match[1]);
            if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash
                || url.pathname !== path || [...url.searchParams.keys()].some(key => !['page','per_page'].includes(key))
                || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)
                || !/^[1-9][0-9]*$/.test(url.searchParams.get('page') ?? '')
                || !/^(100)$/.test(url.searchParams.get('per_page') ?? '100')) fail('pagination_target', 'unavailable');
            if (match[2] === 'next') {
              if (next) fail('pagination_link', 'unavailable');
              next = path + '?per_page=100&page=' + url.searchParams.get('page');
            }
          }
        }
        if (!next) {
          if (data.length !== total) fail('incomplete_count', 'unavailable');
          return data;
        }
        if (!values.length) fail('pagination_empty', 'unavailable');
        endpoint = next;
      }
      fail('pagination_limit', 'unavailable');
    }
    let prefix = repoPath;
    if (registration.level === 'organization') {
      const org = await provider.request({...request, endpoint:`/orgs/${coordinates.owner}`, expectedId:registration.id});
      if (org.outcome !== 'read') throw {code:'organization_unavailable', kind:'unavailable', provider:publicDiagnostic(org).diagnostic};
      if (org.data.type !== 'Organization' || typeof org.data.login !== 'string' || lower(org.data.login) !== coordinates.owner) fail('wrong_organization');
      prefix = `/orgs/${coordinates.owner}`;
    }
    const runners = await inventory(prefix + '/actions/runners', 'runners', runner);
    const groupsByRunner = new Map();
    if (registration.level === 'organization') {
      const groups = await inventory(prefix + '/actions/runner-groups', 'runner_groups', value => {
        if (!text(value.name) || !['all','selected','private'].includes(value.visibility)
            || typeof value.allows_public_repositories !== 'boolean' || typeof value.restricted_to_workflows !== 'boolean'
            || !Array.isArray(value.selected_workflows) || value.selected_workflows.some(w => !text(w))) malformed();
        return value;
      });
      for (const group of groups) {
        const groupPath = prefix + '/actions/runner-groups/' + group.id;
        const members = await inventory(groupPath + '/runners', 'runners', runner);
        let allowed = group.visibility !== 'private' && group.allows_public_repositories;
        if (group.visibility === 'selected') {
          const repositories = await inventory(groupPath + '/repositories', 'repositories', value => {
            if (!text(value.full_name) || typeof value.private !== 'boolean') malformed();
            if (value.id === target.id && (lower(value.full_name) !== coordinates.key || value.private !== false)) malformed();
            return value;
          });
          allowed &&= repositories.some(value => value.id === target.id);
        }
        let access = allowed ? 'allowed' : 'group_access';
        if (allowed && group.restricted_to_workflows) access = conditions.workflow === undefined
          ? 'workflow_unresolved' : group.selected_workflows.includes(conditions.workflow) ? 'allowed' : 'workflow_denied';
        for (const member of members) {
          const observed = runners.find(r => r.id === member.id);
          if (!observed || JSON.stringify(observed) !== JSON.stringify(member) || groupsByRunner.has(member.id))
            fail('group_inventory_conflict', 'unavailable');
          groupsByRunner.set(member.id, {id:group.id, access});
        }
      }
      if (runners.some(r => !groupsByRunner.has(r.id))) fail('group_membership_unavailable', 'unavailable');
    }
    const members = new Set(records.map(record => memberRunnerLabel(record.memberId)));
    const knownIds = new Set(records.map(record => record.runnerId));
    for (const remote of runners) {
      if (!knownIds.has(remote.id) && remote.labels.some(label => members.has(label)))
        diagnostics.push({code:'unrecognized_member_registration', runnerId:remote.id});
    }
    const instances = records.map(record => {
      const remote = runners.find(value => value.id === record.runnerId);
      const codes = [];
      if (!remote) codes.push('missing_or_replaced_id');
      else {
        const memberLabels = remote.labels.filter(label => label.startsWith('nibfin-user-'));
        if (memberLabels.length !== 1 || memberLabels[0] !== memberRunnerLabel(record.memberId)) codes.push('member_label');
        if (remote.platform !== record.platform || (matchJob && remote.platform !== conditions.platform)
            || remote.labels.some(label => platforms.has(label) && label !== remote.platform)) codes.push('platform');
        if (!conditions.labels.every(label => remote.labels.includes(lower(label)))) codes.push('required_labels');
        const group = groupsByRunner.get(remote.id);
        if (group) {
          if (conditions.groupId !== undefined && conditions.groupId !== group.id) codes.push('group_membership');
          if (group.access !== 'allowed') codes.push(group.access);
        }
      }
      return {instanceId:record.instanceId, runnerId:record.runnerId, memberId:record.memberId,
        outcome:codes.length ? 'mismatch' : 'matched', diagnostics:codes.map(code => ({code})),
        ...(remote ? {observation:remote} : {})};
    });
    return {outcome:diagnostics.length || instances.some(value => value.outcome !== 'matched') ? 'mismatch' : 'matched',
      inventory:'complete', runners, instances, diagnostics};
  } catch (error) {
    // Never serialize arbitrary exceptions, provider data or local records.
    const known = error && ['mismatch','unavailable','unsupported'].includes(error.kind);
    return {outcome:known ? error.kind : 'unavailable', inventory:'unavailable',
      diagnostics:[{code:known ? error.code : 'invalid_input_or_response', ...(error?.provider ? {provider:error.provider} : {})}]};
  }
}
