import {jwtVerify, createLocalJWKSet, decodeProtectedHeader} from 'jose';
import {canonicalJSON, githubId, compareEvidence} from './index.mjs';

export const actionsIssuer = 'https://token.actions.githubusercontent.com';
export const actionsDiscovery = actionsIssuer + '/.well-known/openid-configuration';
export const actionsJwks = actionsIssuer + '/.well-known/jwks';
const reject = category => { throw Error(category); };
const equal = (a, b) => { if (canonicalJSON(a) !== canonicalJSON(b)) reject('identity'); };
const text = v => { if (typeof v !== 'string' || !v.length || v.length > 1024) reject('context'); };
const revision = v => { if (typeof v !== 'string' || !/^[a-f0-9]{40}$/.test(v)) reject('context'); };
const required = ['repository_id', 'repository_owner_id', 'actor_id', 'run_id', 'run_attempt',
  'workflow_ref', 'workflow_sha', 'ref', 'event_name', 'repository_visibility'];
function context(v) {
  for (const k of required) text(v[k]);
  for (const k of required.slice(0, 5)) githubId(v[k]);
  revision(v.workflow_sha);
  if (!/^[^/]+\/[^/]+\/\.github\/workflows\/[^@]+@.+$/.test(v.workflow_ref)) reject('context');
  equal(v.repository_visibility, 'public');
  text(v.audience);
  if (!/^[a-f0-9]{64}$/.test(v.workflowDigest)) reject('context');
  if (!Number.isFinite(v.now) || !Number.isInteger(v.maxAge) || v.maxAge < 1 || v.maxAge > 3600
      || !Number.isInteger(v.tolerance) || v.tolerance < 0 || v.tolerance > 60) reject('context');
  if (!['required', 'not-applicable'].includes(v.reusable)
      || !['required', 'not-applicable'].includes(v.job)) reject('context');
  if (v.reusable === 'required') { text(v.job_workflow_ref); revision(v.job_workflow_sha); }
  if (v.job === 'required') {
    githubId(v.check_run_id); githubId(v.jobId); text(v.runner_environment);
    if (!['required', 'not-applicable'].includes(v.runner)) reject('context');
    if (v.runner === 'required') githubId(v.runnerId);
  }
}
async function fetchJson(url, {signal}) {
  const r = await fetch(url, {signal, redirect: 'error', credentials: 'omit'});
  if (r.status !== 200 || r.url !== url) reject('discovery');
  const reader = r.body.getReader(); let bytes = 0, chunks = [];
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 262144) reject('discovery'); chunks.push(value);
    }
    return {status: r.status, url: r.url, body: Buffer.concat(chunks).toString()};
  } finally { await reader.cancel(); }
}
function verifier(load, synthetic) {
  const authenticated = new WeakSet();
  async function authenticate(token, expected, observation) {
    try {
      const e = structuredClone(expected); context(e);
      if (typeof token !== 'string' || token.length > 32768) reject('token');
      const h = decodeProtectedHeader(token);
      if (h.alg !== 'RS256' || typeof h.kid !== 'string' || !h.kid.length
          || ['jku', 'jwk', 'x5u', 'x5c'].some(k => k in h)) reject('token');
      const verify = async key => jwtVerify(token, key, {issuer: actionsIssuer, audience: e.audience,
        algorithms: ['RS256'], requiredClaims: [...required, 'sub', 'jti', 'iat', 'exp', 'nbf'],
        currentDate: new Date(e.now * 1000), clockTolerance: e.tolerance, maxTokenAge: e.maxAge});
      let verified;
      try { verified = await verify(await load(false)); }
      catch (err) {
        if (err.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw err;
        verified = await verify(await load(true));
      }
      const p = verified.payload;
      for (const k of required) equal(p[k], e[k]);
      if (e.repository !== undefined) equal(p.repository, e.repository);
      text(p.sub); text(p.jti);
      if (p.exp <= p.iat || p.nbf > p.exp || p.iat > e.now + e.tolerance) reject('time');
      for (const k of ['job_workflow_ref', 'job_workflow_sha']) {
        if (e.reusable === 'required') equal(p[k], e[k]);
        else if (p[k] !== undefined) reject('identity');
      }
      if (observation !== undefined && e.job !== 'required') reject('association');
      if (e.job === 'required') {
        equal(p.check_run_id, e.check_run_id); equal(p.runner_environment, e.runner_environment);
        if (!observation) reject('association');
        for (const k of ['repository_id', 'run_id', 'run_attempt', 'check_run_id', 'jobId']) equal(observation[k], e[k]);
        if (e.runner === 'required') equal(observation.runnerId, e.runnerId);
      }
      const result = Object.freeze({ok: true, category: 'authenticated', synthetic,
        identity: Object.freeze({...Object.fromEntries(required.map(k => [k, p[k]])), audience:e.audience, workflowDigest:e.workflowDigest}),
        issuedAt:p.iat, expiresAt:p.exp});
      authenticated.add(result); return result;
    } catch { return {ok:false, category:'source-rejected'}; }
  }
  function predecessor({source, receipt, current, now, maxAge, recordedAt, consumerExecution}) {
    try {
      if (!authenticated.has(source)) reject('source');
      if (!Number.isFinite(now) || !Number.isFinite(recordedAt) || !Number.isInteger(maxAge)
          || maxAge < 1 || maxAge > 3600 || recordedAt > now || now - recordedAt > maxAge
          || now >= source.expiresAt || recordedAt >= source.expiresAt || recordedAt < source.issuedAt) reject('freshness');
      text(consumerExecution);
      const v = compareEvidence(receipt, current);
      if (v.execution.id === consumerExecution) reject('independence');
      const s = v.execution.source, i = source.identity;
      equal(s.repositoryId, i.repository_id); equal(s.runId, i.run_id); equal(s.attempt, i.run_attempt);
      // Existing v1 source.workflow is the independently pinned workflow content digest.
      equal(s.workflow, i.workflowDigest);
      return {ok:true, category:'predecessor', evidence:v};
    } catch { return {ok:false, category:'predecessor-rejected'}; }
  }
  return Object.freeze({authenticate, predecessor});
}
/** Transport is a trusted credential-free HTTP capability, never token input. */
export function createActionsVerifier({transport = fetchJson, timeoutMs = 5000, maxRequests = 3} = {}) {
  if (typeof transport !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isInteger(maxRequests) || maxRequests < 2 || maxRequests > 3) reject('configuration');
  let key, requests = 0, refreshed = false;
  async function json(url) {
    if (++requests > maxRequests) reject('budget');
    const signal = AbortSignal.timeout(timeoutMs);
    let timer;
    try {
      const r = await Promise.race([transport(url, {signal, redirect:'error', credentials:'omit'}),
        new Promise((_, no) => { timer = setTimeout(() => no(Error('timeout')), timeoutMs); })]);
      if (r.status !== 200 || r.url !== url || typeof r.body !== 'string' || Buffer.byteLength(r.body) > 262144) reject('discovery');
      return JSON.parse(r.body);
    } finally { clearTimeout(timer); }
  }
  return verifier(async refresh => {
    if (refresh && refreshed) reject('refresh');
    if (!key) {
      const d = await json(actionsDiscovery);
      equal(d.issuer, actionsIssuer); equal(d.jwks_uri, actionsJwks);
      equal(d.id_token_signing_alg_values_supported, ['RS256']);
    }
    if (!key || refresh) {
      if (refresh) refreshed = true;
      const jwks = await json(actionsJwks);
      if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 32
          || jwks.keys.some(k => k.kty !== 'RSA' || k.d || k.jku || k.x5u)) reject('keys');
      key = createLocalJWKSet(jwks);
    }
    return key;
  }, false);
}
/** Explicit local cryptographic test facility. Never acquires production tokens or roots. */
export function createSyntheticActionsVerifierForTest(jwks) {
  const key = createLocalJWKSet(structuredClone(jwks));
  return verifier(async () => key, true);
}
/** Trusted fixed workflow analysis must establish these facts independently of outputs. */
export function verifyNativeNeeds({expected, dependency, jobsObservation}) {
  try {
    if (expected.fixedWorkflow !== true || expected.unweakened !== true) reject('workflow');
    for (const k of ['repositoryId', 'workflow', 'runId', 'attempt', 'predecessorJob', 'consumerJob']) {
      text(expected[k]); equal(dependency[k], expected[k]);
    }
    if (expected.predecessorJob === expected.consumerJob || dependency.result !== 'success') reject('result');
    if (jobsObservation) {
      for (const k of ['repositoryId', 'workflow', 'runId', 'attempt', 'predecessorJob']) equal(jobsObservation[k], expected[k]);
      if (!((jobsObservation.status === 'queued' && jobsObservation.conclusion === null)
          || (jobsObservation.status === 'completed' && jobsObservation.conclusion === 'success'))) reject('contradiction');
    }
    return {ok:true, category:'local-success-prerequisite'};
  } catch { return {ok:false, category:'waiting-or-blocked'}; }
}
