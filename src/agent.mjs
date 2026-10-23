import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { invokeProtected, validateProtectedRequest } from './protected.mjs';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const check = (ok, message = 'Invalid Agent adapter observation.') => { if (!ok) throw Error(message); };
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const same = (a, b) => digest(a) === digest(b);
function record(x, keys) {
  check(x && typeof x === 'object' && !Array.isArray(x) &&
    Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k)));
}
function version(x, keys) { record(x, ['schemaVersion', ...keys]); check(x.schemaVersion === 1); }
function path(x) {
  check(typeof x === 'string' && x.length > 0 && !x.includes('\\') && !x.includes('\0') &&
    !posix.isAbsolute(x) && x.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe evidence destination.');
}
export function validateEnvironments(environments, instances, previous = []) {
  check(Array.isArray(environments) && environments.length > 0 && Array.isArray(instances) && Array.isArray(previous));
  for (const e of environments) {
    version(e, ['id', 'agent', 'credentialDomain']); check(['id', 'agent', 'credentialDomain'].every(k => id(e[k])));
    const old = previous.find(p => p.id === e.id);
    if (old) { version(old, ['id', 'agent', 'credentialDomain']); check(same(e, old), 'Environment identity is immutable.'); }
  }
  for (const key of ['id', 'credentialDomain']) check(new Set(environments.map(e => e[key])).size === environments.length);
  const domains = new Set(environments.map(e => e.credentialDomain));
  for (const i of instances) {
    version(i, ['id', 'environmentId', 'agentCredentialDomain', 'githubIdentity', 'githubCredentialDomain', 'workspace', 'service', 'runnerId']);
    const e = environments.find(e => e.id === i.environmentId);
    check(e && i.agentCredentialDomain === e.credentialDomain, 'Cross-environment credentials.');
    check(['id', 'workspace', 'service', 'githubCredentialDomain'].every(k => id(i[k])) && !domains.has(i.githubCredentialDomain));
    check((i.runnerId === null && i.githubIdentity === null) || (id(i.runnerId) && id(i.githubIdentity)), 'Registration identity mismatch.');
  }
  for (const key of ['id', 'workspace', 'service', 'githubCredentialDomain', 'githubIdentity', 'runnerId']) {
    const values = instances.map(i => i[key]).filter(v => v !== null);
    check(new Set(values).size === values.length, 'Reused registration resource.');
  }
  return { environments, instances };
}
// Observations come from trusted host code, never sandbox output. No raw errors survive this seam.
export function validateLogin(o, expected) {
  version(o, ['phase', 'operation', 'runId', 'attempt', 'account', 'userId', 'agent', 'gh', 'tokenEnvironment', 'httpStatus']);
  record(expected, ['phase', 'operation', 'runId', 'attempt', 'account', 'userId', 'caller']);
  check(['create', 'register', 'standby', 'issue'].includes(o.phase) && ['local', 'github-hosted'].includes(expected.caller));
  for (const k of ['phase', 'operation', 'runId', 'attempt', 'account', 'userId']) check(o[k] === expected[k]);
  check(['operation', 'runId', 'account', 'userId'].every(k => id(o[k])) && Number.isSafeInteger(o.attempt) && o.attempt > 0);
  check(['available', 'unavailable', 'unknown'].includes(o.agent) && ['available', 'unavailable', 'unknown'].includes(o.gh));
  check(o.agent === 'available' && (expected.caller === 'github-hosted' || o.gh === 'available') &&
    o.tokenEnvironment === 'absent' && (o.httpStatus === null || o.httpStatus === 200), 'Required login is unavailable or unverified.');
  return o;
}
function assignment(a) {
  version(a, ['executionId', 'workspaceId', 'environmentId', 'instanceId', 'class', 'binding', 'references']);
  check(['executionId', 'workspaceId', 'environmentId', 'instanceId'].every(k => id(a[k])));
  check(['agent', 'hook'].includes(a.class)); validateProtectedRequest({ schemaVersion: 3, binding: a.binding, previous: [] });
  check(Array.isArray(a.references) && a.references.length > 0);
  const paths = new Set();
  for (const r of a.references) {
    version(r, ['id', 'kind', 'digest', 'path', 'repositoryId', 'candidateDigest', 'runId', 'attempt']);
    check(id(r.id) && hash(r.digest) && ['repository', 'candidate', 'artifact', 'hook'].includes(r.kind)); path(r.path);
    check([...paths].every(p => p !== r.path && !p.startsWith(r.path + '/') && !r.path.startsWith(p + '/'))); paths.add(r.path);
    check(r.repositoryId === a.binding.repository.id && r.candidateDigest === a.binding.candidateDigest &&
      r.runId === a.binding.source.runId && r.attempt === a.binding.source.attempt, 'Evidence assignment mismatch.');
  }
  return a;
}
function correlation(a) {
  return { executionId: a.executionId, workspaceId: a.workspaceId, assignmentDigest: digest(a),
    operation: a.class === 'hook' ? 'hook' : a.binding.role, runId: a.binding.source.runId, attempt: a.binding.source.attempt };
}
function observation(o, a, keys) {
  version(o, [...Object.keys(correlation(a)), ...keys]);
  const expected = correlation(a); for (const k of Object.keys(expected)) check(o[k] === expected[k], 'Stale execution observation.');
}
export function validateCleanup(o, a) {
  assignment(a); observation(o, a, ['termination', 'disposal', 'references']);
  check(['confirmed', 'running', 'failed', 'unknown'].includes(o.termination) &&
    ['safe', 'failed', 'incomplete', 'unknown'].includes(o.disposal) && Array.isArray(o.references) &&
    o.references.length > 0 && o.references.every(id));
  return { safe: o.termination === 'confirmed' && o.disposal === 'safe', observation: o };
}
// The host is injected by Core. A function closing over authenticated observations is the
// authority boundary; an authenticity string in a serialized request is never sufficient.
export function createAgentAdapter(host) {
  for (const name of ['observe', 'materialize', 'seal', 'execute', 'stop', 'cleanup', 'reconcile', 'predecessors']) check(typeof host?.[name] === 'function');
  const prepared = new WeakMap();
  const reserved = new Set();
  async function prepare(input, expectedLogin, diagnostic) {
    const a = structuredClone(input); assignment(a);
    const proof = structuredClone(await host.observe(structuredClone(a)));
    record(proof, ['assignment', 'environments', 'instances', 'previousEnvironments', 'login', 'capabilities', 'exposures', 'permission']);
    diagnostic.httpStatus = Number.isInteger(proof.login?.httpStatus) && proof.login.httpStatus >= 100 &&
      proof.login.httpStatus <= 599 ? proof.login.httpStatus : null;
    check(same(proof.assignment, a), 'Host assignment mismatch.');
    validateEnvironments(proof.environments, proof.instances, proof.previousEnvironments);
    const instance = proof.instances.find(i => i.id === a.instanceId && i.environmentId === a.environmentId);
    check(instance && instance.runnerId !== null, 'Issue execution requires a registered instance.');
    check(proof.permission === 'verified', 'Fresh Core permission is required.');
    if (a.class === 'hook') check(proof.login === null && expectedLogin === null);
    else {
      validateLogin(proof.login, expectedLogin); check(expectedLogin.phase === 'issue' &&
        proof.login.runId === a.binding.source.runId && proof.login.attempt === a.binding.source.attempt);
    }
    const mode = a.class === 'hook' || a.binding.role !== 'deliver' ? 'read-only' : 'workspace-write';
    record(proof.capabilities, ['filesystem', 'symlinks', 'credentials', 'network', 'termination']);
    check(proof.capabilities.filesystem === mode && proof.capabilities.symlinks === 'deny' &&
      proof.capabilities.credentials === 'isolated' &&
      (a.class === 'hook' ? proof.capabilities.network === 'denied' : ['denied', 'restricted'].includes(proof.capabilities.network)) &&
      proof.capabilities.termination === 'observable', 'Required isolation enforcement is unsupported.');
    check(Array.isArray(proof.exposures) && proof.exposures.every(x => x === 'agent-login') &&
      new Set(proof.exposures).size === proof.exposures.length &&
      (a.class !== 'hook' || proof.exposures.length === 0), 'Forbidden sandbox credentials.');
    const predecessors = await host.predecessors(structuredClone(a));
    check(Array.isArray(predecessors));
    for (const p of predecessors) {
      record(p, ['assignment', 'observation']);
      const current = await host.reconcile(structuredClone(p));
      check(validateCleanup(current, p.assignment).safe, 'Predecessor cleanup is uncertain.');
      check(p.assignment.workspaceId !== a.workspaceId && p.assignment.executionId !== a.executionId, 'Execution workspace cannot be reused.');
    }
    check(!reserved.has(a.workspaceId) && !reserved.has(a.executionId), 'Execution workspace cannot be reused.');
    reserved.add(a.workspaceId); reserved.add(a.executionId);
    // All required inputs, including ignored artifacts, are explicit trusted expectations.
    for (const reference of a.references) {
      const content = await host.materialize(structuredClone(a), structuredClone(reference));
      check(typeof content === 'string' && digest(content) === reference.digest, 'Missing or changed immutable evidence.');
    }
    const sealed = await host.seal(structuredClone(a));
    observation(sealed, a, ['mode', 'references']);
    check(sealed.mode === mode && same(sealed.references, a.references), 'Workspace seal mismatch.');
    const handle = Object.freeze({ ...correlation(a), schemaVersion: 1 });
    prepared.set(handle, { a, used: false }); return handle;
  }
  async function execute(handle, protectedAdapters) {
    const state = prepared.get(handle); check(state && !state.used, 'Unknown or consumed execution handle.');
    state.used = true;
    const { a } = state;
    try {
      if (a.class === 'hook') {
        const result = await host.execute(structuredClone(a), null);
        observation(result, a, ['references', 'status']);
        check(result.status === 'succeeded' && Array.isArray(result.references) && result.references.length > 0 && result.references.every(id));
        return result;
      }
      // Preserve ALL schema-3 gates. Callers supply verification, never a sandbox executor.
      check(protectedAdapters && typeof protectedAdapters.verify === 'function');
      let references = [];
      const output = await invokeProtected(protectedAdapters.request, { ...protectedAdapters,
        verify: async r => { check(same(r.binding, a.binding)); return protectedAdapters.verify(r); },
        execute: async (r, instructions) => {
          check(same(r.binding, a.binding));
          const output = structuredClone(await host.execute(structuredClone(a), instructions));
          observation(output, a, ['result', 'references']);
          check(Array.isArray(output.references) && output.references.length > 0 && output.references.every(id));
          references = output.references;
          return output.result;
        } });
      return { ...correlation(a), schemaVersion: 1, status: output.status, references, protected: output };
    } catch { return { schemaVersion: 1, status: 'blocked', ...correlation(a), error: 'Execution is unverified; reconcile cleanup before replacement.' }; }
  }
  async function cleanup(handle) {
    const state = prepared.get(handle); check(state, 'Unknown execution handle.');
    state.used = true;
    try { await host.stop(structuredClone(state.a)); }
    catch { /* A failed stop can only be resolved by an independent host observation. */ }
    try { return validateCleanup(await host.cleanup(structuredClone(state.a)), state.a); }
    catch { return { safe: false, observation: null }; }
  }
  return Object.freeze({ prepare: async (input, login) => {
    // Diagnostic locators are hints; HTTP status is a bounded host observation.
    const diagnostic = { schemaVersion: 1, operation: 'prepare', status: 'blocked',
      runId: id(input?.binding?.source?.runId) ? input.binding.source.runId : null,
      attempt: Number.isSafeInteger(input?.binding?.source?.attempt) ? input.binding.source.attempt : null, httpStatus: null };
    try { return await prepare(input, structuredClone(login), diagnostic); }
    catch {
      const error = Error('Agent preparation blocked; isolation, login, evidence or cleanup is unverified.');
      error.diagnostic = diagnostic;
      throw error;
    }
  }, execute, cleanup });
}
