import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as C, openSync, closeSync, fstatSync, readFileSync, writeFileSync,
  mkdirSync, lstatSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { authorizeRequest, authorizeOperation } from './authority.mjs';
import { validateProtectedRequest } from './protected.mjs';
import { verifyRequirements } from './requirements.mjs';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const check = (ok, message) => { if (!ok) throw Error(`Candidate: ${message}.`); };
const same = (a, b) => digest(a) === digest(b);
const oid = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const fields = (x, keys) => check(x && Object.getPrototypeOf(x) === Object.prototype &&
  Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k)), 'unsupported record fields');
function path(p) {
  check(typeof p === 'string' && /^[\x21-\x7e]+$/.test(p) && !/[\\:%?#]/.test(p) &&
    !p.startsWith('/') && p.split('/').every(s => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git'), 'unsafe path');
  return p;
}
function bytes(s) {
  check(typeof s === 'string' && s.length <= 128 * 1024 * 1024, 'missing or oversized byte evidence');
  const b = Buffer.from(s, 'base64'); check(b.toString('base64') === s, 'invalid base64 encoding'); return b;
}
// No inherited credential, Git configuration, external diff, hook or filter environment.
function git(root, args, input) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: root, input, maxBuffer: 128 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
}
const gs = (root, args) => git(root, args).toString('utf8').trim();
// Linux descriptor-relative traversal pins every ancestor. O_NOFOLLOW on each open
// prevents a replacement symlink from redirecting reads, including between checks.
function pinned(root, p, use, metadata = false) {
  check(process.platform === 'linux' && C.O_NOFOLLOW && C.O_DIRECTORY, 'descriptor-safe filesystem prerequisite unavailable');
  if (metadata) check(['.git/config', '.git/HEAD'].includes(p), 'unsupported metadata path');
  else path(p);
  const handles = [];
  try {
    let fd = openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); handles.push(fd);
    const parts = p.split('/');
    for (const part of parts.slice(0, -1)) {
      fd = openSync(`/proc/self/fd/${fd}/${part}`, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); handles.push(fd);
    }
    return use(`/proc/self/fd/${fd}/${parts.at(-1)}`);
  } finally { handles.reverse().forEach(closeSync); }
}
function read(root, p, metadata = false) {
  return pinned(root, p, file => {
    const fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const before = fstatSync(fd); check(before.isFile(), 'unsupported file kind');
      const data = readFileSync(fd), after = fstatSync(fd);
      check(before.size === after.size && before.mode === after.mode &&
        before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'file changed during capture');
      const encoded = data.toString('base64');
      return { path: p, mode: before.mode & 0o111 ? '100755' : '100644', bytes: encoded, contentDigest: digest(encoded) };
    } finally { closeSync(fd); }
  }, metadata);
}
function inventory(x) {
  fields(x, ['artifacts', 'hooks']); check(Array.isArray(x.artifacts) && Array.isArray(x.hooks), 'missing obligations');
  const used = [];
  for (const [kind, list] of Object.entries(x)) for (const item of list) {
    fields(item, kind === 'artifacts' ? ['path', 'purpose'] : ['path', 'event']); path(item.path);
    check(typeof item.purpose === 'string' && item.purpose.length > 0 ||
      kind === 'hooks' && ['pre-commit', 'prepare-commit-msg', 'commit-msg'].includes(item.event), 'invalid obligation');
    check(!used.some(p => p === item.path || p.startsWith(`${item.path}/`) || item.path.startsWith(`${p}/`)), 'conflicting obligation destinations');
    used.push(item.path);
  }
  return structuredClone({ artifacts: [...x.artifacts].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    hooks: [...x.hooks].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}
function semantic(b, context) {
  return Object.fromEntries(['repository', 'issue', 'authority', 'requirements', 'scopeDigest', 'shapeDigest',
    'deliveryCycle', 'repairCycle', 'incidentId'].map(k => [k, structuredClone(b[k])])
    .concat([['policyDigest', digest(context.policy)], ['executionDigest', digest(context.execution)]]));
}
async function boundary(request, host, workspace, paths = []) {
  validateProtectedRequest(request); const b = request.binding;
  check(b.role === 'deliver' && b.skill === 'deliver', 'workspace requires Deliver assignment');
  const authorization = await authorizeRequest(request, host.authorization, true);
  await verifyRequirements({ ...b }, host.requirements);
  const o = structuredClone(await host.observe(structuredClone(request)));
  fields(o, ['assignment', 'base', 'root', 'sourceRoot', 'workspaceId', 'obligations', 'effectiveHooks']);
  check(same(o.assignment, b) && oid(o.base) && typeof o.workspaceId === 'string' && o.workspaceId.length > 0 &&
    resolve(o.root) === o.root && resolve(o.sourceRoot) === o.sourceRoot && o.root !== o.sourceRoot, 'untrusted workspace observation');
  const obligations = inventory(o.obligations);
  check(same(obligations.hooks, inventory({ artifacts: [], hooks: o.effectiveHooks }).hooks), 'effective hook inventory mismatch');
  const grant = await host.authorization.resolve(b.authority);
  await authorizeOperation(grant, { ...authorization.context, paths }, host.authorization, b.authority);
  if (b.repairCycle !== null) {
    check(authorization.context.repair !== null, 'repair authorization missing');
    await authorizeOperation(grant, { ...authorization.context, paths, operation: 'repair' }, host.authorization, b.authority);
  }
  const binding = semantic(b, authorization.context);
  if (workspace) check(same(workspace, { schemaVersion: 1, root: o.root, workspaceId: o.workspaceId,
    base: o.base, binding, obligations, filesystem: filesystem(o.root) }), 'workspace identity or fresh Base mismatch');
  return { observation: o, binding, obligations, workspace: { schemaVersion: 1, root: o.root,
    workspaceId: o.workspaceId, base: o.base, binding, obligations } };
}
function entries(root, tree) {
  return git(root, ['ls-tree', '-rz', '--full-tree', tree]).toString('utf8').split('\0').filter(Boolean).map(line => {
    const [meta, p] = line.split('\t'); const [mode, type, id] = meta.split(' '); path(p);
    check(['100644', '100755'].includes(mode) && type === 'blob' && oid(id), 'unsupported Git entry');
    return { path: p, mode, oid: id };
  });
}
function objectId(type, data) { return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex'); }
function baseObjects(root, base) {
  const ids = gs(root, ['rev-list', '--objects', '--no-object-names', base]).split('\n').sort();
  return ids.map(id => { const type = gs(root, ['cat-file', '-t', id]);
    return { oid: id, type, bytes: git(root, ['cat-file', type, id]).toString('base64') }; });
}
function importObjects(root, objects) {
  check(Array.isArray(objects) && objects.length > 0, 'missing Base objects');
  let previous = '';
  for (const o of objects) {
    fields(o, ['oid', 'type', 'bytes']); const data = bytes(o.bytes);
    check(oid(o.oid) && o.oid > previous && ['commit', 'tree', 'blob'].includes(o.type) &&
      objectId(o.type, data) === o.oid, 'invalid Base object'); previous = o.oid;
    check(git(root, ['hash-object', '-t', o.type, '-w', '--stdin'], data).toString().trim() === o.oid, 'Base import mismatch');
  }
}
function filesystem(root) {
  try { return filesystemIdentity(root); } catch { throw Error('Candidate: workspace identity or Git metadata unavailable.'); }
}
function filesystemIdentity(root) {
  const st = lstatSync(root); check(st.isDirectory() && !st.isSymbolicLink(), 'unsafe workspace root');
  const metadata = lstatSync(join(root, '.git'));
  check(metadata.isDirectory() && !metadata.isSymbolicLink(), 'unsafe Git metadata');
  return { device: st.dev, inode: st.ino, gitDevice: metadata.dev, gitInode: metadata.ino,
    configDigest: read(root, '.git/config', true).contentDigest, headDigest: read(root, '.git/HEAD', true).contentDigest };
}
function init(root) {
  // The trusted host reserves an absent, exclusive, non-symlink destination.
  check(resolve(root) === root, 'absolute workspace root required');
  let current = '/';
  for (const part of root.split('/').filter(Boolean).slice(0, -1)) {
    current = join(current, part); check(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), 'unsafe workspace ancestor');
  }
  mkdirSync(root, { mode: 0o700 }); git(root, ['init', '--object-format=sha1']);
}
function write(root, f) {
  path(f.path); check(['100644', '100755'].includes(f.mode), 'unsupported snapshot mode');
  const parts = f.path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    pinned(root, p, name => { try { mkdirSync(name, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      check(lstatSync(name).isDirectory() && !lstatSync(name).isSymbolicLink(), 'unsafe destination ancestor'); });
  }
  pinned(root, f.path, file => {
    const fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, f.mode === '100755' ? 0o755 : 0o644);
    try { writeFileSync(fd, bytes(f.bytes)); } finally { closeSync(fd); }
  });
}
function treeFor(root, files) {
  git(root, ['read-tree', '--empty']);
  const lines = files.map(f => {
    const id = git(root, ['hash-object', '-w', '--stdin'], bytes(f.bytes)).toString().trim();
    return `${f.mode} ${id}\t${path(f.path)}\0`;
  }).join('');
  git(root, ['update-index', '-z', '--index-info'], Buffer.from(lines));
  return gs(root, ['write-tree']);
}
function output(root, base, tree) {
  const diff = git(root, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', base, tree, '--']);
  const paths = git(root, ['diff', '--name-only', '-z', '--no-renames', base, tree, '--']).toString('utf8').split('\0').filter(Boolean).sort();
  paths.forEach(path); return { tree, binaryDiff: diff.toString('base64'), diffDigest: digest(diff.toString('base64')), changedPaths: paths };
}
export async function prepareWorkspace(request, host) {
  request = structuredClone(request);
  const s = await boundary(request, host), o = s.observation;
  check(gs(o.sourceRoot, ['rev-parse', '--show-object-format']) === 'sha1' &&
    gs(o.sourceRoot, ['rev-parse', '--verify', `${o.base}^{commit}`]) === o.base, 'Base unavailable');
  const objects = baseObjects(o.sourceRoot, o.base); init(o.root); importObjects(o.root, objects);
  for (const e of entries(o.root, o.base)) write(o.root, { ...e, bytes: git(o.root, ['cat-file', 'blob', e.oid]).toString('base64') });
  git(o.root, ['read-tree', o.base]);
  s.workspace.filesystem = filesystem(o.root);
  await boundary(request, host, s.workspace); return structuredClone(s.workspace);
}
function inspectKinds(root) {
  const handles = [];
  function walk(fd) {
    for (const name of readdirSync(`/proc/self/fd/${fd}`)) {
      const file = `/proc/self/fd/${fd}/${name}`, st = lstatSync(file);
      check(st.isFile() || st.isDirectory(), 'unsupported file kind or symlink');
      if (st.isDirectory()) {
        const child = openSync(file, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
        handles.push(child); try { walk(child); } finally { closeSync(handles.pop()); }
      }
    }
  }
  const fd = openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); handles.push(fd);
  try { walk(fd); } finally { closeSync(handles.pop()); }
}
function filesAt(root) {
  inspectKinds(root);
  const index = git(root, ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean);
  const tracked = [];
  for (const line of index) {
    const [meta, p] = line.split('\t'), [mode, , stage] = meta.split(' '); path(p);
    check(stage === '0' && ['100644', '100755'].includes(mode), 'conflicted or unsupported index'); tracked.push(p);
  }
  const paths = [...new Set([...tracked, ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)])].sort();
  return paths.flatMap(p => {
    try { return [read(root, p)]; } catch (e) {
      if (e.code === 'ENOENT' && tracked.includes(p)) return []; throw e;
    }
  });
}
function freeze(x) { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
export async function captureCandidate(request, host, workspace) {
  request = structuredClone(request); workspace = structuredClone(workspace);
  const s = await boundary(request, host, workspace), root = s.observation.root;
  const files = filesAt(root), base = workspace.base;
  const obligations = s.obligations;
  const artifacts = obligations.artifacts.map(i => ({ ...i, ...read(root, i.path) }));
  const hooks = obligations.hooks.map(i => ({ ...i, ...read(root, i.path) }));
  // Build index from captured bytes, never from a later filesystem read.
  const tree = treeFor(root, files), changes = output(root, base, tree);
  const allPaths = [...changes.changedPaths, ...artifacts.map(x => x.path), ...hooks.map(x => x.path)];
  await boundary(request, host, workspace, allPaths);
  check(same(filesAt(root), files) && same(artifacts, obligations.artifacts.map(i => ({ ...i, ...read(root, i.path) }))) &&
    same(hooks, obligations.hooks.map(i => ({ ...i, ...read(root, i.path) }))), 'workspace changed during capture');
  const record = { schemaVersion: 1, encoding: 'base64', binding: s.binding, base, ...changes,
    obligations, files, artifacts, hooks, baseObjects: baseObjects(root, base) };
  return freeze({ record, candidateDigest: digest(record), provenance: { workspaceId: workspace.workspaceId, source: structuredClone(request.binding.source) } });
}
function validateCandidate(candidate, expected) {
  fields(candidate, ['record', 'candidateDigest', 'provenance']); const r = candidate.record;
  fields(r, ['schemaVersion', 'encoding', 'binding', 'base', 'tree', 'binaryDiff', 'diffDigest', 'changedPaths',
    'obligations', 'files', 'artifacts', 'hooks', 'baseObjects']);
  check(hash(expected) && candidate.candidateDigest === expected && digest(r) === expected &&
    r.schemaVersion === 1 && r.encoding === 'base64' && oid(r.base) && oid(r.tree), 'Candidate identity mismatch');
  bytes(r.binaryDiff); check(r.diffDigest === digest(r.binaryDiff) && Array.isArray(r.changedPaths) &&
    same(r.changedPaths, [...new Set(r.changedPaths)].sort()), 'missing or inconsistent diff/path evidence');
  r.changedPaths.forEach(path); inventory(r.obligations);
  check(Array.isArray(r.files) && Array.isArray(r.artifacts) && Array.isArray(r.hooks), 'missing snapshot inventory');
  let previous = '';
  for (const f of r.files) {
    fields(f, ['path', 'mode', 'bytes', 'contentDigest']); path(f.path); bytes(f.bytes);
    check(f.contentDigest === digest(f.bytes), 'snapshot content digest mismatch');
    check(f.path > previous && ['100644', '100755'].includes(f.mode), 'ambiguous snapshot destinations'); previous = f.path;
  }
  for (const kind of ['artifacts', 'hooks']) {
    check(r[kind].length === r.obligations[kind].length, 'missing mandatory snapshot');
    r[kind].forEach((f, i) => {
      fields(f, kind === 'artifacts' ? ['path', 'purpose', 'mode', 'bytes', 'contentDigest'] : ['path', 'event', 'mode', 'bytes', 'contentDigest']);
      const { mode, bytes: data, contentDigest, ...obligation } = f; bytes(data);
      check(contentDigest === digest(data), 'obligation content digest mismatch');
      check(['100644', '100755'].includes(mode) && same(obligation, r.obligations[kind][i]), 'obligation mismatch');
      const tracked = r.files.find(x => x.path === f.path);
      check(!tracked || tracked.mode === mode && tracked.bytes === data, 'conflicting snapshot destination');
    });
  }
}
export function candidateEvidence(candidate) {
  validateCandidate(candidate, candidate.candidateDigest); const r = candidate.record;
  return { schemaVersion: 1, candidateDigest: candidate.candidateDigest, base: r.base, binding: structuredClone(r.binding) };
}
export function compareCandidateEvidence(receipt, candidate) {
  try { const valid = same(receipt, candidateEvidence(candidate)); return { valid, requiresFreshEvidence: !valid }; }
  catch { return { valid: false, requiresFreshEvidence: true }; }
}
export async function reconstructCandidate(request, host, candidate, expectedDigest) {
  request = structuredClone(request); candidate = structuredClone(candidate);
  validateCandidate(candidate, expectedDigest);
  const s = await boundary(request, host), r = candidate.record;
  check(same(r.binding, s.binding) && r.base === s.observation.base && same(r.obligations, s.obligations), 'stale Candidate binding');
  await boundary(request, host, null, [...r.changedPaths, ...r.artifacts.map(f => f.path), ...r.hooks.map(f => f.path)]);
  init(s.observation.root); importObjects(s.observation.root, r.baseObjects);
  check(gs(s.observation.root, ['rev-parse', '--verify', `${r.base}^{commit}`]) === r.base, 'missing Base commit');
  entries(s.observation.root, r.base);
  for (const f of [...r.files, ...r.artifacts, ...r.hooks]) {
    if (!r.files.includes(f) && r.files.some(x => x.path === f.path)) continue;
    write(s.observation.root, f);
  }
  const tree = treeFor(s.observation.root, r.files);
  check(same(output(s.observation.root, r.base, tree), {
    tree: r.tree, binaryDiff: r.binaryDiff, diffDigest: r.diffDigest, changedPaths: r.changedPaths }), 'reconstructed Git output mismatch');
  // Keep the reconstructed Tree index: it preserves explicitly staged ignored files.
  // The documented working-output boundary supersedes staged content, not membership.
  s.workspace.filesystem = filesystem(s.observation.root);
  const captured = await captureCandidate(request, host, s.workspace);
  check(captured.candidateDigest === expectedDigest, 'reconstructed Candidate mismatch'); return captured;
}
export async function verifyCandidate(request, host, workspace, candidate, expectedDigest) {
  request = structuredClone(request); workspace = structuredClone(workspace); candidate = structuredClone(candidate);
  validateCandidate(candidate, expectedDigest);
  const current = await captureCandidate(request, host, workspace);
  check(current.candidateDigest === expectedDigest, 'current output differs from expected Candidate');
  return candidateEvidence(current);
}
