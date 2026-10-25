import * as fs from 'node:fs';
import {resolve, parse, join, isAbsolute, sep} from 'node:path';
import {canonicalJSON, contentIdentity, repositoryCoordinates} from './index.mjs';

class JournalError extends Error {}
const fail = code => { throw new JournalError(`publication:${code}; stop publication and reconcile trusted storage/observations`); };
const clone = value => JSON.parse(canonicalJSON(value));
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const id = value => { if (typeof value !== 'string' || !value.length || /[\x00-\x1f]/.test(value)) fail('identity'); };
function fields(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || !equal(Object.keys(value).sort(), names.split(' ').sort())) fail('fields');
}
function operation(value) {
  fields(value, 'correlation kind target payload'); id(value.correlation);
  if (!['issue', 'metadata', 'dependency'].includes(value.kind)) fail('operation-kind');
  fields(value.target, 'repository repositoryId');
  const parts = value.target.repository.split('/');
  if (parts.length !== 2 || repositoryCoordinates(...parts).key !== value.target.repository) fail('repository');
  if (value.target.repositoryId !== null) id(value.target.repositoryId);
  if (!value.payload || Object.getPrototypeOf(value.payload) !== Object.prototype) fail('payload');
  // Payload is the entire exact request, including Scope bytes, Metadata and
  // planned dependency endpoints. The publisher owns its provider schema.
  canonicalJSON(value.payload);
}
export function publicationManifest(input) {
  const value = clone(input);
  fields(value, 'version approval plan operations');
  if (value.version !== 1) fail('version'); id(value.approval);
  if (!value.plan || Object.getPrototypeOf(value.plan) !== Object.prototype) fail('plan');
  if (!Array.isArray(value.operations) || !value.operations.length) fail('operations');
  value.operations.forEach(operation);
  if (new Set(value.operations.map(o => o.correlation)).size !== value.operations.length) fail('correlation-conflict');
  return {manifest:value, identity:contentIdentity({kind:'scope-publication-v1', manifest:value})};
}

/** Synchronous durable filesystem journal. It has no provider or authorization capability. */
export function openPublicationJournal({directory, manifest, initialize = false, io = fs} = {}) {
  let root, binding;
  const safe = fn => {
    try { return fn(); }
    catch (error) {
      // Never return filesystem paths, provider errors, payloads or credentials.
      if (error instanceof JournalError) throw error;
      fail('storage-or-record-invalid');
    }
  };
  return safe(() => {
    binding = publicationManifest(manifest);
    if (sep !== '/') fail('unsupported-filesystem-platform');
    if (typeof directory !== 'string' || !isAbsolute(directory)
        || directory.split(/[\\/]/).some(p => p === '..' || p === '.') || directory.includes('\0')) fail('storage-configuration');
    root = resolve(directory);
    if (root === parse(root).root) fail('storage-configuration');
    function boundary(includeRoot = true) {
      const segments = root.slice(parse(root).root.length).split('/');
      let path = parse(root).root;
      for (const part of includeRoot ? segments : segments.slice(0, -1)) {
        path = join(path, part);
        const stat = io.lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-storage-path');
      }
    }
    const syncDirectory = () => {
      const fd = io.openSync(root, 'r');
      try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    };
    function write(name, data) {
      const fd = io.openSync(join(root, name), 'wx', 0o600);
      try { io.writeFileSync(fd, canonicalJSON(data)); io.fsyncSync(fd); }
      finally { io.closeSync(fd); }
    }
    function read(name) {
      const path = join(root, name), stat = io.lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe-record');
      return JSON.parse(io.readFileSync(path, 'utf8'));
    }
    const filename = n => String(n).padStart(8, '0') + '.json';
    function record(sequence, previous, event) {
      const payload = {version:1, sequence, previous, manifest:binding.identity, event};
      return {...payload, identity:contentIdentity(payload)};
    }
    function commitHead(entry) {
      write('HEAD.pending', {version:1, sequence:entry.sequence, identity:entry.identity});
      io.renameSync(join(root, 'HEAD.pending'), join(root, 'HEAD'));
      syncDirectory();
    }
    boundary(false);
    if (initialize) {
      // An existing directory is never silently adopted, even if empty.
      io.mkdirSync(root, {mode:0o700}); boundary();
      const parent = io.openSync(resolve(root, '..'), 'r');
      try { io.fsyncSync(parent); } finally { io.closeSync(parent); }
      const first = record(0, null, {type:'manifest', value:binding.manifest});
      write(filename(0), first); syncDirectory(); commitHead(first);
    }
    function load() {
      boundary();
      const head = read('HEAD');
      fields(head, 'version sequence identity');
      if (head.version !== 1 || !Number.isSafeInteger(head.sequence) || head.sequence < 0) fail('head-invalid');
      const names = io.readdirSync(root).sort();
      if (names.length !== head.sequence + 2 || names.some(n => n !== 'HEAD' && !/^\d{8}\.json$/.test(n))) fail('partial-or-conflicting-history');
      const records = [];
      for (let n = 0; n <= head.sequence; n++) {
        const entry = read(filename(n));
        fields(entry, 'version sequence previous manifest event identity');
        const expected = record(n, n ? records[n - 1].identity : null, entry.event);
        if (!equal(entry, expected)) fail('record-integrity');
        if (n === 0 && !equal(entry.event, {type:'manifest', value:binding.manifest})) fail('manifest-mismatch');
        records.push(entry);
      }
      if (records.at(-1).identity !== head.identity) fail('head-mismatch');
      return records;
    }
    let records = load();
    // Actual commit/readback probe. Crash remnants block reopening; no cleanup
    // or tail repair is inferred from an incomplete write.
    write('PREFLIGHT', {identity:binding.identity}); syncDirectory();
    if (!equal(read('PREFLIGHT'), {identity:binding.identity})) fail('preflight-readback');
    io.unlinkSync(join(root, 'PREFLIGHT')); syncDirectory();
    records = load();
    function states(history) {
      const result = new Map();
      for (const entry of history.slice(1)) {
        const e = entry.event;
        if (!e || !['intent','submission','result','readback'].includes(e.type)) fail('event-invalid');
        const op = binding.manifest.operations.find(o => o.correlation === e.correlation);
        if (!op || e.operation !== contentIdentity(op)) fail('correlation-conflict');
        const prior = result.get(e.correlation);
        if (e.type === 'intent') {
          fields(e, 'type correlation operation value');
          if (prior || !equal(e.value, op)) fail('intent-invalid');
          result.set(e.correlation, {operation:clone(op), phase:'intent', outcomes:[], observations:[]});
        } else {
          if (!prior) fail('missing-intent');
          if (e.type === 'submission') {
            fields(e, 'type correlation operation');
            if (prior.phase !== 'intent') fail('submission-replay');
            if ([...result.values()].some(s => s.phase === 'unknown')) fail('unresolved-operation');
            prior.phase = 'unknown';
          } else if (e.type === 'result') {
            fields(e, 'type correlation operation outcome');
            if (prior.phase !== 'unknown' || prior.outcomes.length || !['submitted','rejected','unknown'].includes(e.outcome)) fail('result-invalid');
            prior.outcomes.push(e.outcome);
          } else {
            fields(e, 'type correlation operation observation');
            if (prior.phase === 'intent') fail('readback-before-submission');
            const observation = e.observation;
            fields(observation, 'complete matches');
            if (typeof observation.complete !== 'boolean' || !Array.isArray(observation.matches)) fail('observation-invalid');
            for (const m of observation.matches) {
              fields(m, 'intent resolved'); operation(m.intent);
              fields(m.resolved, op.kind === 'dependency' ? 'blockedIssueId blockingIssueId' : 'issueId');
              Object.values(m.resolved).forEach(id);
            }
            prior.observations.push(clone(observation));
            prior.phase = observation.complete && observation.matches.length === 1
              && equal(observation.matches[0].intent, op) ? 'complete' : 'unknown';
            // Previously observed stable identities cannot silently change.
            const matches = prior.observations.filter(o => o.complete && o.matches.length === 1 && equal(o.matches[0].intent, op));
            if (matches.some(o => !equal(o.matches[0].resolved, matches[0].matches[0].resolved))
                || prior.observations.some(o => o.matches.length > 1 || o.matches.some(m => !equal(m.intent, op)))) prior.phase = 'unknown';
          }
        }
      }
      return result;
    }
    const pendingReconciliation = new Set([...states(records)].filter(([, s]) => s.phase !== 'intent').map(([key]) => key));
    function append(event) {
      return safe(() => {
        const current = load();
        if (current.at(-1).identity !== records.at(-1).identity) fail('stale-writer');
        const next = record(records.length, records.at(-1).identity, event);
        states([...records, next]);
        if (event.type === 'submission' && pendingReconciliation.size) fail('fresh-reconciliation-required');
        write(filename(next.sequence), next); syncDirectory(); commitHead(next);
        records = load();
        if (event.type === 'submission') pendingReconciliation.add(event.correlation);
        if (event.type === 'readback' && states(records).get(event.correlation).phase === 'complete') pendingReconciliation.delete(event.correlation);
        return snapshot(event.correlation);
      });
    }
    function snapshot(correlation) {
      return safe(() => {
        id(correlation);
        if (!binding.manifest.operations.some(o => o.correlation === correlation)) fail('unknown-correlation');
        const current = load(), state = states(current).get(correlation);
        return state ? {...clone(state), reconciliationRequired:pendingReconciliation.has(correlation) || state.phase === 'unknown'}
          : {phase:'absent', reconciliationRequired:false};
      });
    }
    function event(type, op) {
      operation(op);
      const expected = binding.manifest.operations.find(o => o.correlation === op.correlation);
      if (!expected || !equal(expected, op)) fail('correlation-conflict');
      return {type, correlation:op.correlation, operation:contentIdentity(op)};
    }
    return Object.freeze({identity:binding.identity,
      intent: op => safe(() => append({...event('intent', op), value:clone(op)})),
      submission: op => safe(() => append(event('submission', op))),
      result: (op, outcome) => safe(() => append({...event('result', op), outcome})),
      readback: (op, observation) => safe(() => append({...event('readback', op), observation:clone(observation)})),
      recover: snapshot,
      history: () => safe(() => clone(load()))
    });
  });
}
