import {resolve, isAbsolute, parse, sep, posix} from 'node:path';
import {bodyDigest, canonicalJSON, skillForRole, validateStageResult, compareEvidence, compareStageCollection} from './index.mjs';

// Internal provenance: authenticated routing must not silently use a lifecycle
// implementation that ignores the final post-readiness checkpoint.
const checkpointLifecycles=new WeakSet();
export const supportsStartCheckpoint=value=>checkpointLifecycles.has(value);

const fail = reason => { throw new TypeError(`lifecycle:${reason}`); };
const copy = value => JSON.parse(canonicalJSON(value));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const snapshot = v => freeze(copy(v));
function fields(v, names) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype
      || Object.keys(v).sort().join(' ') !== names.split(' ').sort().join(' ')) fail('fields');
}
function text(v) { if (typeof v !== 'string' || !v.trim() || /[\x00-\x1f]/.test(v)) fail('string'); }
function location(v) {
  text(v);
  // Guest Linux descriptors retain POSIX identity on Windows hosts. No I/O here.
  const linux = v.startsWith('/') && !v.includes('\\');
  if (linux ? posix.normalize(v) !== v || v === '/' || v.startsWith('//')
    : !isAbsolute(v) || resolve(v) !== v || parse(v).root === v) fail('absolute-resource');
}
const overlaps = (a, b) => {
  const delimiter = a.startsWith('/') && b.startsWith('/') ? '/' : sep;
  return a === b || a.startsWith(b + delimiter) || b.startsWith(a + delimiter);
};

/** A trusted caller owns this registry; descriptors never discover credentials. */
export function createAgentEnvironments() {
  const environments = new Map(), resources = [], ids = new Set();
  return Object.freeze({
    describe(input) {
      const v = copy(input);
      fields(v, 'id agent loginSpace instances'); text(v.id); text(v.agent); location(v.loginSpace);
      if (environments.has(v.id)) {
        if (canonicalJSON(environments.get(v.id)) !== canonicalJSON(v)) fail('fixed-environment');
        return environments.get(v.id);
      }
      if (!Array.isArray(v.instances) || !v.instances.length) fail('instances');
      const local = [v.loginSpace], localIds = [v.id];
      for (const i of v.instances) {
        fields(i, 'id workspace registration service'); text(i.id); localIds.push(i.id);
        for (const key of ['workspace', 'registration', 'service']) { location(i[key]); local.push(i[key]); }
      }
      if (new Set(localIds).size !== localIds.length || localIds.some(id => ids.has(id))) fail('identity-alias');
      for (let n = 0; n < local.length; n++) {
        if (resources.some(p => overlaps(p, local[n])) || local.slice(0, n).some(p => overlaps(p, local[n]))) fail('resource-alias');
      }
      const descriptor = snapshot(v);
      environments.set(v.id, descriptor); resources.push(...local); localIds.forEach(id => ids.add(id));
      return descriptor;
    }
  });
}

/** Backend methods receive only allowlisted, immutable inputs. No host env is forwarded. */
export function createAgentLifecycle({environment, instanceId, backend, current, startCurrent = null, resultContext = () => ({}), collectFailures = false}) {
  const env = snapshot(environment);
  // Validate even descriptors supplied across a serialization boundary.
  createAgentEnvironments().describe(env);
  const instance = env.instances.find(i => i.id === instanceId);
  if (!instance || typeof current !== 'function' || startCurrent!==null && typeof startCurrent!=='function') fail('instance-or-current');
  for (const op of ['readiness', 'start', 'collect', 'stop', 'termination', 'cleanup']) {
    if (typeof backend[op] !== 'function') fail('backend');
  }
  const executions = new Map(), pins = new Map(); let busy = false, retired = false;
  const base = snapshot({environment: env.id, agent: env.agent, instance: instance.id});
  const view = s => snapshot(s);
  async function exclusive(fn) {
    if (busy) fail('concurrent-operation');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }
  async function call(op, input, normalize) {
    try { return snapshot(normalize(snapshot(await backend[op](snapshot(input))))); }
    catch { return {status: 'unknown'}; } // Never expose arbitrary backend errors/output.
  }
  function get(id) { const s = executions.get(id); if (!s) fail('execution'); return s; }
  function query(s) { return {...base, execution: s.id, request: s.request}; }
  const lifecycle=Object.freeze({
    observe(id) { return view(get(id)); },
    start(input,{signal,beforeStart}={}) { return exclusive(async () => {
      if (retired) fail('cleaned-instance');
      fields(input, 'execution binding instructions visibility ownership');
      const v = copy(input), e = v.execution;
      if (skillForRole(e.role) !== e.skill) fail('skill');
      fields(v.instructions, 'identity content');
      if (typeof v.instructions.content !== 'string' || !v.instructions.content.trim()
          || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v.instructions.content)) fail('instructions');
      if (bodyDigest(v.instructions.content) !== v.instructions.identity
          || v.instructions.identity !== v.binding.instructions) fail('instructions');
      if (v.visibility !== 'public' || !['personal', 'organization'].includes(v.ownership)) fail('product-scope');
      // Existing validator checks all execution and binding fields before any backend call.
      const expected = startCurrent ? startCurrent(e.id) : current(e.id);
      validateStageResult(expected.expected.result, {execution:e, binding:v.binding});
      if (canonicalJSON(e) !== canonicalJSON(expected.expected.execution)
          || canonicalJSON(v.binding) !== canonicalJSON(expected.expected.binding)) fail('current-identity');
      if(startCurrent) {
        // Deliver's final Candidate exists only after the Writer has run. Pin the
        // independent role/authority now; collect still compares the full envelope.
        fields(expected,'expected consumed');fields(expected.expected,'stage execution binding result');
        if(e.role!=='deliver'||expected.expected.stage!=='deliver'
          ||expected.expected.result.outcome!=='ready'||expected.expected.result.failureClass!=='none'
          ||!Array.isArray(expected.consumed)||expected.consumed.includes(e.result))fail('start-contract');
        expected.consumed.forEach(text);
      } else compareEvidence(expected.expected, expected);
      if (executions.has(e.id) || [...executions.values()].some(s => s.termination.status !== 'terminated')) fail('duplicate-or-unresolved');
      const access = e.role === 'deliver' ? 'write' : 'read';
      const requirements = {workspace: access, isolation: 'verified', login: 'available', tool: 'available'};
      const readiness = await call('readiness', {...base, requirements}, r => {
        fields(r, 'login tool isolation read write evidence limitations');
        for (const k of ['login', 'tool']) if (!['available', 'unavailable'].includes(r[k])) fail('readiness');
        for (const k of ['isolation', 'read', 'write']) if (!['verified', 'unsupported', 'unverified'].includes(r[k])) fail('capability');
        if (!Array.isArray(r.evidence) || !r.evidence.length || !Array.isArray(r.limitations)) fail('evidence');
        r.evidence.forEach(text); r.limitations.forEach(text);
        const status = r.login !== 'available' || r.tool !== 'available' ? 'unavailable'
          : [r.isolation, r[access]].includes('unsupported') ? 'unsupported'
          : [r.isolation, r[access]].includes('unverified') ? 'unverified' : 'ready';
        // Evidence is held by the backend/owner; only classifications cross diagnostics.
        return {status};
      });
      if(beforeStart!==undefined) {
        if(typeof beforeStart!=='function')fail('checkpoint');
        try {await beforeStart();}catch {return snapshot({...base,readiness,start:{status:'rejected'}});}
      }
      if (signal?.aborted) return snapshot({...base,readiness,start:{status:'rejected'}});
      if (readiness.status !== 'ready') return snapshot({...base, readiness});
      const s = { ...base, id:e.id, request:e.request, start:{status:'unknown'},
        result:{status:'unresolved'}, stop:{status:'not-requested'}, termination:{status:'unknown'}, cleanup:{status:'unresolved'}};
      pins.set(e.id, snapshot({execution:e, binding:v.binding}));
      executions.set(e.id, s); // Reserve before awaiting a possibly lost start response.
      s.start = await call('start', {...query(s), executionIdentity:e, binding:v.binding,
        instructions:v.instructions, workspace:{path:instance.workspace, access},
        agentLogin:{owner:env.id, space:env.loginSpace}, processEnvironment:{}}, r => {
        fields(r, 'status'); if (!['started', 'rejected'].includes(r.status)) fail('start'); return r;
      });
      if (s.start.status === 'rejected') { s.termination = {status:'terminated'}; s.result = {status:'absent'}; }
      return view(s);
    }); },
    collect(id) { return exclusive(async () => {
      const s = get(id);
      if (s.start.status === 'rejected' || s.cleanup.status === 'completed') fail('collect-transition');
      if (['valid','rejected'].includes(s.result.status)) fail('already-collected');
      const observed = await call('collect', query(s), r => {
        fields(r, 'status exitCode evidence');
        if (!['pending', 'complete'].includes(r.status)) fail('collection');
        if (r.status === 'pending') return {status:'pending'};
        if (r.exitCode !== 0 || r.evidence === null) return {status:'invalid'};
        try {
          const c = current(id);
          const collected = collectFailures ? compareStageCollection(r.evidence, c, resultContext(id))
            : {status:'valid',evidence:compareEvidence(r.evidence,c)};
          const receipt = collected.evidence ?? collected.collection;
          const pin = pins.get(id);
          if (canonicalJSON(receipt.execution) !== canonicalJSON(pin.execution)
              || canonicalJSON(receipt.binding) !== canonicalJSON(pin.binding)) fail('start-binding');
          if (receipt.execution.id !== id || receipt.execution.request !== s.request) fail('correlation');
          return collected;
        } catch { return {status:'invalid'}; }
      });
      s.result = observed;
      return view(s);
    }); },
    stop(id) { return exclusive(async () => {
      const s = get(id);
      if (s.termination.status === 'terminated' || s.stop.status === 'requested') fail('stop-transition');
      s.stop = await call('stop', query(s), r => {
        fields(r, 'status'); if (!['requested', 'failed', 'unknown'].includes(r.status)) fail('stop'); return r;
      });
      return view(s);
    }); },
    termination(id) { return exclusive(async () => {
      const s = get(id);
      if (s.termination.status !== 'terminated') s.termination = await call('termination', query(s), r => {
        fields(r, 'status'); if (!['running', 'terminated', 'unknown'].includes(r.status)) fail('termination'); return r;
      });
      return view(s);
    }); },
    cleanup() { return exclusive(async () => {
      if (retired) fail('already-cleaned');
      const states = [...executions.values()];
      if (states.some(s => s.termination.status !== 'terminated' || ['unresolved','pending','unknown'].includes(s.result.status))) {
        return snapshot({...base, status:'unresolved', residuals:[instance.workspace, instance.registration, instance.service]});
      }
      const result = await call('cleanup', {...base, resources:[instance.workspace, instance.registration, instance.service]}, r => {
        fields(r, 'status residuals');
        if (!['completed','failed','unresolved'].includes(r.status) || !Array.isArray(r.residuals)) fail('cleanup');
        if (r.residuals.some(p => ![instance.workspace,instance.registration,instance.service].includes(p))
            || (r.status === 'completed' && r.residuals.length)) fail('residuals');
        return r;
      });
      states.forEach(s => { s.cleanup = result; });
      if (result.status === 'completed') retired = true;
      return snapshot({...base, ...result});
    }); }
  });
  checkpointLifecycles.add(lifecycle);return lifecycle;
}
