import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync,
  chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, prepareWorkspace, captureCandidate, reconstructCandidate, verifyCandidate,
  candidateEvidence, compareCandidateEvidence } from '../src/index.mjs';
import { fixture } from './fixtures/protected.mjs';
import { fixtureAuthorization, signedFixture, hostFor, authorityOf, clock } from './fixtures/authority.mjs';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function setup(t, repair = false) {
  const dir = mkdtempSync(join(tmpdir(), 'nibfin-candidate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'); mkdirSync(source); git(source, 'init');
  git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(source, 'src')); mkdirSync(join(source, 'docs'));
  for (const [p, text] of [['src/text', 'before\n'], ['src/delete', 'deleted\n'], ['src/rename', 'renamed\n'], ['src/mode', 'mode\n'],
    ['docs/.gitignore', 'artifact\nhook\n']]) writeFileSync(join(source, p), text);
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Fixture Base');
  let base = git(source, 'rev-parse', 'HEAD'), root = join(dir, 'run-a'), workspaceId = 'a';
  const f = fixture('deliver'), request = f.request;
  if (!repair) Object.assign(request.binding, { repairCycle: null, incidentId: null });
  let auth = fixtureAuthorization(request.binding);
  if (repair) {
    const p = structuredClone(auth.grant.payload); p.members[0].operations.push('repair');
    const grant = signedFixture(p); auth = { ...auth, grant, authority: authorityOf(grant), host: hostFor(grant, auth.parents) };
  }
  request.binding.authority = auth.authority;
  const obligations = { artifacts: [{ path: 'docs/artifact', purpose: 'Required binary fixture' }],
    hooks: [{ path: 'docs/hook', event: 'pre-commit' }] };
  const observation = () => ({ assignment: structuredClone(request.binding), base, root, sourceRoot: source,
    workspaceId, obligations: structuredClone(obligations), effectiveHooks: structuredClone(obligations.hooks) });
  const host = { authorization: auth.host, requirements: f.adapters.requirements, observe: async () => observation() };
  function extras() { writeFileSync(join(root, 'docs/artifact'), Buffer.from([0, 255, 128, 10])); writeFileSync(join(root, 'docs/hook'), '#!/bin/sh\nexit 0\n'); }
  return { dir, source, request, host, auth, obligations, extras, observation,
    get root() { return root; }, set root(p) { root = p; workspaceId = p; }, get base() { return base; },
    advance() { writeFileSync(join(source, 'src/advance'), 'new Base'); git(source, 'add', '.'); git(source, 'commit', '-m', 'Advance fixture Base'); base = git(source, 'rev-parse', 'HEAD'); } };
}
function edits(f) {
  f.extras(); writeFileSync(join(f.root, 'src/text'), 'after\n');
  writeFileSync(join(f.root, 'src/binary'), Buffer.from([0, 255, 254, 128, 13, 10]));
  writeFileSync(join(f.root, 'src/new'), 'new\n'); rmSync(join(f.root, 'src/delete'));
  renameSync(join(f.root, 'src/rename'), join(f.root, 'src/renamed')); chmodSync(join(f.root, 'src/mode'), 0o755);
}
test('AC1–AC4: signed dedicated capture, exact Git evidence and cross-Run byte reconstruction without commits', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); edits(f);
  // Staged text is superseded by complete working output at the documented boundary.
  git(f.root, 'add', 'src/text'); writeFileSync(join(f.root, 'src/text'), 'final unstaged\n');
  const before = git(f.root, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)');
  const c = await captureCandidate(f.request, f.host, w), again = await captureCandidate(f.request, f.host, w);
  assert.equal(c.candidateDigest, again.candidateDigest); assert(Object.isFrozen(c.record.files));
  assert.deepEqual(c.record.changedPaths, ['src/binary', 'src/delete', 'src/mode', 'src/new', 'src/rename', 'src/renamed', 'src/text']);
  assert.equal(c.record.tree, git(f.root, 'write-tree'));
  const actualDiff = execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', f.base, c.record.tree, '--'], { cwd: f.root });
  assert.equal(c.record.binaryDiff, actualDiff.toString('base64'));
  assert.match(actualDiff.toString(), /GIT binary patch/); assert.match(actualDiff.toString(), /old mode 100644\nnew mode 100755/);
  const after = git(f.root, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)');
  assert.deepEqual(after.split('\n').filter(x => x.startsWith('commit ')), before.split('\n').filter(x => x.startsWith('commit ')));
  assert.equal(git(f.root, 'for-each-ref', '--format=%(refname)'), '');
  assert.equal((await verifyCandidate(f.request, f.host, w, c, c.candidateDigest)).candidateDigest, c.candidateDigest);
  const serialized = JSON.stringify(c); rmSync(f.root, { recursive: true }); rmSync(f.source, { recursive: true });
  f.root = join(f.dir, 'run-b'); f.request.binding.source.runId = 'run-b'; f.request.binding.sessionId = 'session-b';
  const restored = await reconstructCandidate(f.request, f.host, JSON.parse(serialized), c.candidateDigest);
  assert.equal(restored.candidateDigest, c.candidateDigest); assert.notDeepEqual(restored.provenance, c.provenance);
  assert.deepEqual(readFileSync(join(f.root, 'src/binary')), Buffer.from([0, 255, 254, 128, 13, 10]));
  assert.deepEqual(readFileSync(join(f.root, 'docs/artifact')), Buffer.from([0, 255, 128, 10]));
  assert.equal(readFileSync(join(f.root, 'docs/hook'), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(git(f.root, 'for-each-ref', '--format=%(refname)'), '');
  assert.deepEqual(git(f.root, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)').split('\n').filter(x => x.startsWith('commit ')), before.split('\n').filter(x => x.startsWith('commit ')));
});
test('AC1: current signed authority, observed assignment, workspace, Base and path boundaries', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); f.extras();
  for (const mutate of [b => { b.repository.name = 'other/project'; }, b => { b.issue.id = 'other'; },
    b => { b.shapeDigest = 'b'.repeat(64); }, b => { b.deliveryCycle = 'other'; }]) {
    const r = structuredClone(f.request); mutate(r.binding); await assert.rejects(captureCandidate(r, f.host, w));
  }
  await assert.rejects(captureCandidate(f.request, { ...f.host, observe: undefined }, w));
  await assert.rejects(captureCandidate(f.request, f.host, { ...w, workspaceId: 'substitute' }));
  for (const badAuth of [{ now: () => clock + 86400000 }, { revocation: async expected => ({ ...expected, revoked: true }) }]) {
    await assert.rejects(captureCandidate(f.request, { ...f.host, authorization: { ...f.host.authorization, ...badAuth } }, w), /authorization/);
  }
  mkdirSync(join(f.root, 'src-sibling')); writeFileSync(join(f.root, 'src-sibling/bad'), 'no');
  await assert.rejects(captureCandidate(f.request, f.host, w), /authorization/);
  rmSync(join(f.root, 'src-sibling'), { recursive: true });
  f.advance(); await assert.rejects(captureCandidate(f.request, f.host, w), /Base/);
});
test('AC2/AC5: independently expected identity, altered fields, explicit empty evidence and Base races', async t => {
  const f = setup(t); f.obligations.artifacts = []; f.obligations.hooks = [];
  const w = await prepareWorkspace(f.request, f.host), c = await captureCandidate(f.request, f.host, w);
  assert.equal(c.record.binaryDiff, ''); assert.deepEqual(c.record.changedPaths, []);
  const receipt = candidateEvidence(c);
  assert.deepEqual(compareCandidateEvidence(receipt, c), { valid: true, requiresFreshEvidence: false });
  for (const key of ['base', 'tree', 'binaryDiff', 'changedPaths', 'binding', 'files', 'baseObjects']) {
    const altered = structuredClone(c); delete altered.record[key];
    await assert.rejects(verifyCandidate(f.request, f.host, w, altered, c.candidateDigest));
  }
  for (const mutate of [r => { r.base = 'b'.repeat(40); }, r => { r.tree = 'b'.repeat(40); },
    r => { r.binaryDiff = Buffer.from('wrong').toString('base64'); }, r => { r.changedPaths = ['src/new']; },
    r => { r.binding.shapeDigest = 'b'.repeat(64); }, r => { r.binding.policyDigest = 'b'.repeat(64); }]) {
    const changed = structuredClone(c); mutate(changed.record);
    await assert.rejects(verifyCandidate(f.request, f.host, w, changed, c.candidateDigest));
    changed.candidateDigest = digest(changed.record);
    assert.equal(compareCandidateEvidence(receipt, changed).valid, false);
  }
  f.advance(); await assert.rejects(verifyCandidate(f.request, f.host, w, c, c.candidateDigest), /Base/);
  f.root = join(f.dir, 'new-base');
  const nw = await prepareWorkspace(f.request, f.host), nc = await captureCandidate(f.request, f.host, nw);
  assert.equal(compareCandidateEvidence(receipt, nc).valid, false);
  f.root = join(f.dir, 'stale-reconstruction');
  await assert.rejects(reconstructCandidate(f.request, f.host, c, c.candidateDigest), /stale/);
});
test('AC3: mandatory ignored artifacts and effective hooks, inventories and source-only invalidation', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host);
  await assert.rejects(captureCandidate(f.request, f.host, w), /ENOENT/); f.extras();
  const c = await captureCandidate(f.request, f.host, w);
  for (const p of ['docs/artifact', 'docs/hook']) {
    const original = readFileSync(join(f.root, p)); writeFileSync(join(f.root, p), 'changed');
    const changed = await captureCandidate(f.request, f.host, w);
    assert.equal(changed.record.tree, c.record.tree); assert.notEqual(changed.candidateDigest, c.candidateDigest);
    assert.equal(compareCandidateEvidence(candidateEvidence(c), changed).valid, false);
    writeFileSync(join(f.root, p), original);
  }
  const originalObserve = f.host.observe;
  f.host.observe = async () => ({ ...f.observation(), effectiveHooks: [] });
  await assert.rejects(captureCandidate(f.request, f.host, w), /hook inventory/); f.host.observe = originalObserve;
  for (const p of ['/absolute', '../escape', 'docs/../escape', 'docs\\escape', '.git/config', 'docs//ambiguous']) {
    const old = f.obligations.artifacts[0].path; f.obligations.artifacts[0].path = p;
    await assert.rejects(captureCandidate(f.request, f.host, w), /unsafe path/); f.obligations.artifacts[0].path = old;
  }
  f.obligations.artifacts.push({ path: 'docs/hook', purpose: 'conflict' });
  await assert.rejects(captureCandidate(f.request, f.host, w), /conflicting/); f.obligations.artifacts.pop();
  rmSync(join(f.root, 'docs/hook')); await assert.rejects(captureCandidate(f.request, f.host, w), /ENOENT/);
});
test('AC3: symlink files, ancestors, index entries, unsupported modes, deletion and rename authorization', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); f.extras();
  const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret'), 'private');
  symlinkSync(join(outside, 'secret'), join(f.root, 'src/link'));
  await assert.rejects(captureCandidate(f.request, f.host, w)); rmSync(join(f.root, 'src/link'));
  renameSync(join(f.root, 'docs'), join(f.root, 'saved')); symlinkSync(outside, join(f.root, 'docs'));
  await assert.rejects(captureCandidate(f.request, f.host, w)); rmSync(join(f.root, 'docs')); renameSync(join(f.root, 'saved'), join(f.root, 'docs'));
  symlinkSync(join(outside, 'secret'), join(f.root, 'src/link')); git(f.root, 'add', 'src/link'); rmSync(join(f.root, 'src/link'));
  await assert.rejects(captureCandidate(f.request, f.host, w), /unsupported index/); git(f.root, 'update-index', '--force-remove', 'src/link');
  git(f.root, 'update-index', '--add', '--cacheinfo', `160000,${f.base},src/submodule`);
  await assert.rejects(captureCandidate(f.request, f.host, w), /unsupported index/); git(f.root, 'update-index', '--force-remove', 'src/submodule');
  execFileSync('mkfifo', [join(f.root, 'src/fifo')]); await assert.rejects(captureCandidate(f.request, f.host, w), /file kind/); rmSync(join(f.root, 'src/fifo'));
  // A tracked outside-boundary path must be authorized even when only deleted.
  writeFileSync(join(f.source, 'outside'), 'old'); git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'Outside fixture');
  const observed = f.observation(), newBase = git(f.source, 'rev-parse', 'HEAD');
  f.root = join(f.dir, 'outside-base'); f.host.observe = async () => ({ ...f.observation(), base: newBase });
  const w2 = await prepareWorkspace(f.request, f.host); f.extras(); rmSync(join(f.root, 'outside'));
  await assert.rejects(captureCandidate(f.request, f.host, w2), /authorization/);
  writeFileSync(join(f.root, 'outside'), 'old'); renameSync(join(f.root, 'outside'), join(f.root, 'src/from-outside'));
  await assert.rejects(captureCandidate(f.request, f.host, w2), /authorization/);
  assert.equal(observed.base, f.base);
});
test('AC4: malformed, truncated, missing-object and independently mismatched reconstruction fails', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); edits(f);
  const c = await captureCandidate(f.request, f.host, w);
  for (const [i, mutate] of [r => { r.files[0].bytes = '!'; }, r => { r.encoding = 'utf8'; },
    r => { r.files[0].bytes = r.files[0].bytes.slice(0, -1); }, r => { r.baseObjects = []; },
    r => { r.files[0].mode = '120000'; }, r => { r.files.push(r.files[0]); },
    r => { r.binaryDiff = ''; r.diffDigest = digest(''); }, r => { r.changedPaths = []; },
    r => { r.artifacts = []; }].entries()) {
    const bad = structuredClone(c); mutate(bad.record); bad.candidateDigest = digest(bad.record);
    f.root = join(f.dir, `bad-${i}`);
    await assert.rejects(reconstructCandidate(f.request, f.host, bad, bad.candidateDigest), `mutation ${i}`);
  }
  f.root = join(f.dir, 'wrong-expectation');
  await assert.rejects(reconstructCandidate(f.request, f.host, c, 'b'.repeat(64)), /identity/);
});
test('AC6: historical merged output stays historical; fresh authorized repair binds new Base and cycle', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); edits(f);
  const historical = await captureCandidate(f.request, f.host, w), serialized = JSON.stringify(historical);
  // Fixture merge is source setup, never a library-created Candidate commit.
  git(f.root, 'config', 'user.name', 'Fixture'); git(f.root, 'config', 'user.email', 'fixture@example.invalid');
  git(f.root, 'commit', '-m', 'Historical fixture merge');
  const merged = git(f.root, 'rev-parse', 'HEAD');
  const b = f.request.binding; Object.assign(b, { deliveryCycle: 'delivery-2', repairCycle: 'repair-2', incidentId: 'incident-2' });
  const auth = fixtureAuthorization(b), p = structuredClone(auth.grant.payload); p.members[0].operations.push('repair');
  p.repair.commit = merged;
  const g = signedFixture(p); b.authority = authorityOf(g); f.host.authorization = hostFor(g, auth.parents);
  const oldRoot = f.root; f.root = join(f.dir, 'repair');
  f.host.observe = async () => ({ ...f.observation(), base: merged, sourceRoot: oldRoot });
  const repair = await prepareWorkspace(f.request, f.host); f.extras();
  const c = await captureCandidate(f.request, f.host, repair);
  assert.equal(c.record.base, merged); assert.equal(c.record.binding.incidentId, 'incident-2');
  assert.notEqual(c.candidateDigest, historical.candidateDigest);
  for (const gate of ['hooks', 'accept', 'review']) assert.equal(compareCandidateEvidence({ ...candidateEvidence(historical), gate }, c).valid, false);
  assert.equal(JSON.stringify(historical), serialized);
  f.root = join(f.dir, 'old-cycle');
  await assert.rejects(reconstructCandidate(f.request, f.host, historical, historical.candidateDigest), /stale/);
  const noRepair = structuredClone(p); noRepair.members[0].operations = noRepair.members[0].operations.filter(x => x !== 'repair');
  const blocked = signedFixture(noRepair); b.authority = authorityOf(blocked); f.host.authorization = hostFor(blocked, auth.parents);
  await assert.rejects(prepareWorkspace(f.request, f.host), /authorization/);
});
test('AC3: path replacement between validation and use cannot read a symlink target', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); f.extras();
  const outside = join(f.dir, 'private'); writeFileSync(outside, 'must not be captured');
  let observations = 0;
  f.host.observe = async () => {
    if (++observations === 2) {
      rmSync(join(f.root, 'src/text')); symlinkSync(outside, join(f.root, 'src/text'));
    }
    return f.observation();
  };
  await assert.rejects(captureCandidate(f.request, f.host, w), /symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'must not be captured');
});
test('AC1: replaced workspace directory is rejected and preparation Base race fails', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); f.extras();
  const root = f.root; renameSync(root, join(f.dir, 'original')); mkdirSync(root);
  await assert.rejects(captureCandidate(f.request, f.host, w), /workspace identity/);
  f.root = join(f.dir, 'race'); let observations = 0;
  f.host.observe = async () => { if (++observations === 2) f.advance(); return f.observation(); };
  await assert.rejects(prepareWorkspace(f.request, f.host), /Base/);
});
test('AC5: newly signed effective policy or repair binding cannot reuse pending output', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); f.extras();
  const c = await captureCandidate(f.request, f.host, w), receipt = candidateEvidence(c);
  const p = structuredClone(f.auth.grant.payload); p.policy.merge.protectionDigest = 'b'.repeat(64);
  const g = signedFixture(p); f.request.binding.authority = authorityOf(g); f.host.authorization = hostFor(g);
  await assert.rejects(captureCandidate(f.request, f.host, w), /workspace identity/);
  f.root = join(f.dir, 'new-policy'); const nw = await prepareWorkspace(f.request, f.host); f.extras();
  const current = await captureCandidate(f.request, f.host, nw);
  assert.equal(current.record.tree, c.record.tree); assert.equal(compareCandidateEvidence(receipt, current).valid, false);
  f.request.binding.repairCycle = 'unapproved'; f.request.binding.incidentId = 'unapproved';
  await assert.rejects(captureCandidate(f.request, f.host, nw), /authorization/);
});
test('AC4: explicitly staged ignored files remain Tree content across Runs', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); f.extras();
  writeFileSync(join(f.root, 'docs/artifact'), Buffer.from([0, 255])); git(f.root, 'add', '-f', 'docs/artifact');
  const c = await captureCandidate(f.request, f.host, w);
  assert(c.record.files.some(x => x.path === 'docs/artifact'));
  f.root = join(f.dir, 'staged-ignored-run-b');
  const reconstructed = await reconstructCandidate(f.request, f.host, c, c.candidateDigest);
  assert.equal(reconstructed.candidateDigest, c.candidateDigest);
});
test('AC1/AC3: Git metadata redirection and configuration substitution fail closed', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); f.extras();
  git(f.root, 'config', 'core.worktree', f.source);
  await assert.rejects(captureCandidate(f.request, f.host, w), /workspace identity/);
  git(f.root, 'config', '--unset', 'core.worktree');
  const metadata = join(f.root, '.git'); renameSync(metadata, join(f.dir, 'metadata')); symlinkSync(join(f.dir, 'metadata'), metadata);
  await assert.rejects(captureCandidate(f.request, f.host, w), /Git metadata/);
});

test('AC4: protected-store JSON reconstructs in a new Node process with no source workspace', async t => {
  const f = setup(t), w = await prepareWorkspace(f.request, f.host); edits(f);
  const c = await captureCandidate(f.request, f.host, w);
  const publicKey = (await f.auth.host.ownerKey('owner-key')).export({ type: 'spki', format: 'pem' });
  rmSync(f.root, { recursive: true }); rmSync(f.source, { recursive: true });
  f.root = join(f.dir, 'new-process'); f.request.binding.source.runId = 'new-process';
  f.request.binding.sessionId = 'new-process-session';
  const transfer = join(f.dir, 'protected-store.json'), expected = join(f.dir, 'trusted-expectation.json');
  writeFileSync(transfer, JSON.stringify({ candidate: c, request: f.request, grant: f.auth.grant,
    observation: f.observation(), publicKey }));
  writeFileSync(expected, JSON.stringify({ candidateDigest: c.candidateDigest, base: f.base }));
  const script = join(f.dir, 'run-b.mjs');
  writeFileSync(script, `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { reconstructCandidate } from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)};
import { contextFor, clock } from ${JSON.stringify(new URL('./fixtures/authority.mjs', import.meta.url).href)};
import { requirementAdapters } from ${JSON.stringify(new URL('./fixtures/request.mjs', import.meta.url).href)};
const d = JSON.parse(readFileSync(process.argv[2])), e = JSON.parse(readFileSync(process.argv[3]));
assert.equal(d.observation.base, e.base);
const host = { requirements: requirementAdapters(), observe: async () => d.observation,
  authorization: { ownerKey: async () => createPublicKey(d.publicKey), now: () => clock,
    revocation: async x => ({ ...x, revoked: false }), resolve: async () => d.grant,
    observe: async () => contextFor(d.grant, 'deliver') } };
const result = await reconstructCandidate(d.request, host, d.candidate, e.candidateDigest);
assert.deepEqual(result.record, d.candidate.record);
assert.notDeepEqual(result.provenance, d.candidate.provenance);
assert.equal(execFileSync('git', ['for-each-ref'], { cwd: d.observation.root, encoding: 'utf8' }), '');
console.log(result.candidateDigest);
`);
  assert.equal(execFileSync(process.execPath, [script, transfer, expected], { encoding: 'utf8' }).trim(), c.candidateDigest);
});
