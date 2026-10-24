import {contentIdentity, canonicalJSON, createEvidence} from './index.mjs';

const text = x => typeof x === 'string' && x.length > 0 && !/[\x00-\x1f]/.test(x);
const positive = x => Number.isSafeInteger(x) && x > 0;
const same = (a, b) => { try { return canonicalJSON(a) === canonicalJSON(b); } catch { return false; } };
const reject = reason => ({status:'blocked', reason});
const qualifications = new WeakMap();
const keys = ['repositoryId','commit','version','environment','deploymentId','statusId','baseline'];
function policyValid(p) {
  if (!p || !['required','not-applicable'].includes(p.mode) || !text(p.reason)) return false;
  if (p.mode === 'not-applicable') return Object.keys(p).sort().join() === 'mode,reason';
  return Object.keys(p).sort().join() === [...keys,'mode','reason','source','maxAgeMs','checks'].sort().join()
    && keys.every(k => text(p[k])) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(p.commit)
    && /^[1-9][0-9]*$/.test(p.repositoryId) && positive(p.maxAgeMs) && p.maxAgeMs <= 86400000
    && p.source && Object.keys(p.source).sort().join() === 'attempt,repositoryId,runId,workflow'
    && ['repositoryId','runId','attempt'].every(k => text(p.source[k]) && /^[1-9][0-9]*$/.test(p.source[k])) && text(p.source.workflow)
    && [p.deploymentId,p.statusId].every(x => /^[1-9][0-9]*$/.test(x))
    && Array.isArray(p.checks) && p.checks.length > 0;
}
function fresh(t, now, age) { return Number.isSafeInteger(t) && t <= now && now - t <= age; }
function destination(value) {
  const u = new URL(value);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.hash) throw Error();
  return u.href;
}
/** Trusted configuration supplies every destination and predicate; observations supply none. */
export async function checkDeploymentHealth(config) {
  try {
    if (!config || !positive(config.timeoutMs) || config.timeoutMs > 30000
        || !positive(config.maxBytes) || config.maxBytes > 1048576
        || !positive(config.maxRequests) || config.maxRequests > 20
        || !Array.isArray(config.allowlist) || !Array.isArray(config.checks)
        || !config.checks.length || config.checks.length > config.maxRequests) return reject('health-configuration');
    const allowed = new Set(config.allowlist.map(destination));
    const checks = config.checks.map(c => {
      const url = destination(c.url);
      if (!allowed.has(url) || !Number.isInteger(c.status) || c.status < 200 || c.status > 299
          || (c.body !== undefined && (typeof c.body !== 'string' || Buffer.byteLength(c.body) > config.maxBytes))) throw Error();
      return {...c, url};
    });
    const signal = AbortSignal.timeout(config.timeoutMs);
    for (const c of checks) {
      const response = await fetch(c.url, {method:'GET', redirect:'manual', signal, credentials:'omit'});
      if (response.status !== c.status) { await response.body?.cancel(); return reject('health-status'); }
      let size = 0;
      const chunks = [];
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        if (size > config.maxBytes) { await response.body.cancel().catch(() => {}); return reject('health-size'); }
        chunks.push(chunk);
      }
      if (c.body !== undefined && Buffer.concat(chunks).toString('utf8') !== c.body) return reject('health-function');
    }
    return {status:'healthy'};
  } catch { return reject('health-unavailable'); }
}

/** Inputs are freshly obtained by trusted Core, not authenticated by their content hash. */
export async function verifyDeployment({policy, observation, health, now = Date.now} = {}) {
  if (!policyValid(policy)) return reject('policy');
  if (policy.mode === 'not-applicable') return {status:'not-applicable', proof:{mode:policy.mode, identities:[], reason:policy.reason}};
  const time = now();
  if (!Number.isSafeInteger(time) || !observation) return reject('observation');
  if (keys.some(k => observation[k] !== policy[k]) || !same(observation.source, policy.source)) return reject('correlation');
  if (!fresh(observation.observedAt, time, policy.maxAgeMs)) return reject('freshness');
  if (observation.state !== 'success') return reject('deployment-state');
  if (!health || !same(health.checks, policy.checks)) return reject('health-policy');
  const result = await checkDeploymentHealth(health);
  if (result.status !== 'healthy') return result;
  if (!fresh(observation.observedAt, now(), policy.maxAgeMs)) return reject('freshness');
  const identity = contentIdentity({kind:'deployment-v1', policy, observation, health});
  const qualified = {status:'qualified', identity, proof:{mode:'required',identities:[identity],reason:null}};
  qualifications.set(qualified, canonicalJSON({policy, observation, health}));
  return qualified;
}

/** Reverify current inputs; an old token or repair disposition cannot authorize final evidence. */
export async function createDeploymentFinal(current, qualified, inputs) {
  if (!qualifications.has(qualified) || qualifications.get(qualified) !== canonicalJSON({policy:inputs.policy, observation:inputs.observation, health:inputs.health})) throw Error('deployment:qualification');
  const freshProof = await verifyDeployment(inputs);
  if (freshProof.status !== 'qualified' || freshProof.identity !== qualified.identity
      || current.expected.stage !== 'final' || current.expected.inputs.commit !== inputs.policy.commit
      || current.expected.binding.repositoryId !== inputs.policy.repositoryId
      || !same(current.expected.inputs.deployment, freshProof.proof)) throw Error('deployment:final');
  return createEvidence(current);
}

/** Read four exact resources. Paths and all expected identities come from trusted policy. */
export async function readDeploymentObservation(provider, {repository, policy, now = Date.now}) {
  try {
    if (!policyValid(policy) || policy.mode !== 'required' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)
        || ![policy.deploymentId,policy.statusId,policy.source.runId,policy.source.attempt].every(x => /^[1-9][0-9]*$/.test(x))) return reject('read-configuration');
    const prefix = `/repos/${repository}`;
    const paths = [prefix, `${prefix}/deployments/${policy.deploymentId}`,
      `${prefix}/deployments/${policy.deploymentId}/statuses/${policy.statusId}`,
      `${prefix}/actions/runs/${policy.source.runId}/attempts/${policy.source.attempt}`];
    const values = [];
    for (const endpoint of paths) {
      const r = await provider.request({endpoint,method:'GET',operation:'deployment-read',correlation:'deployment',target:policy.repositoryId});
      if (r.outcome !== 'read') return reject('read-unavailable');
      values.push(r.data);
    }
    const [repo,d,s,run] = values;
    if (repo.id !== policy.repositoryId || d.id !== policy.deploymentId || s.id !== policy.statusId
        || d.sha !== policy.commit || d.environment !== policy.environment
        || d.payload?.version !== policy.version || d.payload?.baseline !== policy.baseline
        || s.environment !== policy.environment || run.id !== policy.source.runId
        || String(run.run_attempt) !== policy.source.attempt || run.repository?.id !== policy.source.repositoryId
        || run.head_sha !== policy.commit || run.path !== policy.source.workflow
        || run.status !== 'completed' || run.conclusion !== 'success'
        || s.log_url !== `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`) return reject('read-correlation');
    return {status:'observed', observation:{...Object.fromEntries(keys.map(k => [k,policy[k]])),
      source:{...policy.source}, state:s.state, observedAt:now()}};
  } catch { return reject('read-malformed'); }
}

/** Selection and incident classification are independently supplied trusted Core facts. */
export async function deploymentHealthDisposition({target, selectors, baselines, observations, health, repair, now = Date.now}) {
  if (!target || !text(target.issueId) || !Array.isArray(selectors) || !Array.isArray(baselines)
      || !Array.isArray(observations) || baselines.some(b => !b || !text(b.id) || !b.selector)
      || observations.some(o => !o || typeof o !== 'object')
      || new Set(baselines.map(b => b.id)).size !== baselines.length) return reject('selection');
  const blocked = [], bypassed = [], selected = [];
  let time = now();
  if (!Number.isSafeInteger(time)) return reject('clock');
  const bypassCandidates = [];
  const qualifiedObservations = [];
  function repairEligible(selector, b, time) {
    const r = repair;
    return selector.kind === 'environment' && policyValid(b.policy) && b.policy.mode === 'required' && r && r.classification === 'implementation_defect' && r.responsibleIssue === target.issueId
      && text(r.incident) && r.incident === b.incident && r.unknownWrites === false
      && fresh(r.classifiedAt,time,r.maxAgeMs) && positive(r.maxAgeMs) && r.maxAgeMs <= 86400000
      && r.authorization?.issueId === target.issueId && r.authorization.incident === r.incident
      && r.authorization.operation === 'deliver-repair' && text(r.authorization.grant)
      && r.authorization.revoked === false && Number.isSafeInteger(r.authorization.validFrom)
      && r.authorization.validFrom <= time && Number.isSafeInteger(r.authorization.expiresAt)
      && time < r.authorization.expiresAt;
  }
  for (const selector of selectors) {
    if (!selector || !['environment','dependency'].includes(selector.kind)
        || !['repositoryId','environment','releaseLine','output'].every(k => text(selector[k]))) return reject('selection');
    const matches = baselines.filter(b => same(b.selector,selector));
    if (!matches.length || matches.some(b => !Number.isSafeInteger(b.effectiveAt) || b.effectiveAt > time)) {
      blocked.push({obligation:contentIdentity(selector), reason:'baseline'}); continue;
    }
    matches.sort((a,b) => b.effectiveAt-a.effectiveAt);
    if (matches.length > 1 && matches[0].effectiveAt === matches[1].effectiveAt) return reject('baseline-ambiguous');
    const b = matches[0];
    if (!text(b.id) || (b.policy?.mode === 'required'
        && (b.policy.repositoryId !== selector.repositoryId || b.policy.environment !== selector.environment))) return reject('baseline');
    selected.push(b.id);
    const obs = observations.filter(o => o.baseline === b.policy?.baseline);
    const result = await verifyDeployment({policy:b.policy, observation:obs.length === 1 ? obs[0] : null,health:health?.[b.id],now});
    if (result.status === 'qualified') {
      qualifiedObservations.push({obligation:b.id, observedAt:obs[0].observedAt, maxAgeMs:b.policy.maxAgeMs});
      continue;
    }
    if (result.status === 'not-applicable') continue;
    const decisionTime = now();
    if (!Number.isSafeInteger(decisionTime) || decisionTime < time) return reject('clock');
    time = decisionTime;
    const eligible = repairEligible(selector, b, time);
    if (eligible) { bypassed.push(b.id); bypassCandidates.push({selector, baseline:b}); }
    else blocked.push({obligation:b.id, reason:result.reason});
  }
  // All temporal claims must hold at one aggregate decision time after every await.
  const finalTime = now();
  if (!Number.isSafeInteger(finalTime) || finalTime < time) return reject('clock');
  for (const {obligation, observedAt, maxAgeMs} of qualifiedObservations) {
    if (!fresh(observedAt, finalTime, maxAgeMs)) blocked.push({obligation, reason:'freshness'});
  }
  for (const {selector, baseline} of bypassCandidates) {
    if (!repairEligible(selector, baseline, finalTime)) {
      bypassed.splice(bypassed.indexOf(baseline.id), 1);
      blocked.push({obligation:baseline.id, reason:'repair-freshness'});
    }
  }
  return {status:blocked.length ? 'blocked' : bypassed.length ? 'repair-health-exception' : 'eligible',
    selected, blocked, bypassed, permission:false, otherGates:'required', completion:'unqualified'};
}
