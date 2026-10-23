import { approval } from '../test/fixtures/obligations.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initial, requirementAdapters, snapshot } from '../test/fixtures/request.mjs';
import { scopeFixture } from '../test/fixtures/scope.mjs';
import { fixture, roleResult } from '../test/fixtures/protected.mjs';
import { fixtureAuthorization, contextFor } from '../test/fixtures/authority.mjs';
const directory = await mkdtemp(join(tmpdir(), 'nibfin-consumer-'));
const run = (args, cwd) => execFileSync('npm', args, {
  cwd, encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true' }
});
try {
  const packed = JSON.parse(run(['pack', '--json', '--pack-destination', directory], process.cwd()))[0];
  const paths = packed.files.map(f => f.path).sort();
  const allowed = path => ['package.json', 'README.md', 'LICENSE'].includes(path) ||
    /^(src|examples|docs)\//.test(path);
  assert(paths.every(allowed), `Unexpected package files: ${paths}`);
  const required = ['package.json', 'README.md', 'LICENSE', 'src/identity.mjs', 'src/index.mjs', 'src/requirements.mjs', 'src/authority.mjs', 'src/workspace.mjs', 'src/obligations.mjs',
    'examples/action.mjs', 'examples/cli.mjs'];
  for (const path of required) assert(paths.includes(path), `Missing ${path}`);
  // Compute expected identity from reviewed source bytes independently of package code.
  const entries = [];
  for (const path of ['LICENSE', 'package.json', 'src/identity.mjs', 'src/index.mjs', 'src/requirements.mjs', 'src/authority.mjs', 'src/protected.mjs', 'src/agent.mjs', 'src/workspace.mjs', 'src/obligations.mjs', 'src/instructions/shape.md', 'src/instructions/deliver.md', 'src/instructions/accept.md', 'src/scope.mjs', 'src/instructions/scope.md']) {
    assert((await lstat(path)).isFile());
    entries.push([path, (await readFile(path)).toString('base64')]);
  }
  const metadata = JSON.parse(await readFile('package.json', 'utf8'));
  const expected = { name: metadata.name, version: metadata.version,
    contentDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)], directory);
  const scopeExample = scopeFixture();
  const protectedFixture = fixture('accept');
  const ordinaryPayload = fixtureAuthorization(initial()).grant.payload;
  const protectedAuthorization = fixtureAuthorization(protectedFixture.request.binding);
  await writeFile(join(directory, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { digest, prepareGrant, signGrant, verifyGrant, authorizeOperation, grantDraftDigest } from '@nibfin/core';
import { identity } from '@nibfin/core/identity';
import { prepareWorkspace, captureCandidate, reconstructCandidate, verifyCandidate,
  candidateEvidence, compareCandidateEvidence, parseCandidateInventory, validateCandidateObligations, createAgentAdapter, validateEnvironments, invokeProtected, resolveInstructions } from '@nibfin/core';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { runOneStage } from './node_modules/@nibfin/core/examples/action.mjs';
import { checkInstalledCore } from './node_modules/@nibfin/core/examples/cli.mjs';
const expected = ${JSON.stringify(expected)};
const scope = await import('@nibfin/core');
assert.match(await scope.scopeInstructions(), /Official Scope Skill/);
assert.equal(typeof scope.auditScope, 'function');
assert.equal((await scope.verifyScopePlan({})).planValid, false);
const scopePlan = ${JSON.stringify(scopeExample.plan)};
const observedScope = ${JSON.stringify(scopeExample.observations)};
const scopeHost = { verifyAuthority: async ({snapshot, requirements}) =>
  digest(snapshot) === ${JSON.stringify((await import('../src/index.mjs')).digest(scopeExample.plan.authority))} &&
  digest(requirements) === ${JSON.stringify((await import('../src/index.mjs')).digest(scopeExample.plan.requirements))} };
assert.equal((await scope.verifyScopePlan(scopePlan, scopeHost)).planValid, true);
let scopeWrites = 0;
assert.equal((await scope.auditScope(scopePlan, scopeHost, {
  readInventory: async repository => ({ complete: true, evidence: ['installed:inventory'], issues: observedScope.filter(o => o.repository === repository) }),
  updateIssue: () => scopeWrites++
})).status, 'consistent');
assert.equal(scopeWrites, 0);
assert.deepEqual(await identity(), expected);
assert.deepEqual(await checkInstalledCore(expected), expected);
for (const change of [{ version: 'wrong' }, { contentDigest: '0'.repeat(64) }]) {
  await assert.rejects(checkInstalledCore({ ...expected, ...change }), /identity mismatch/);
}
const keys = generateKeyPairSync('ed25519'), records = new Map();
const host = { ownerKey: async () => keys.publicKey, signingKey: async () => keys.privateKey,
  now: () => Date.parse('2026-10-23T12:00:00.000Z'),
  readApproval: async expected => ({ ...expected, approved: true, approvalId: 'installed-approval' }),
  revocation: async expected => ({ ...expected, revoked: false }), resolve: async a => records.get(a.digest),
  observe: async r => contextFor(records.get((r.binding ?? r).authority.digest),
    ({ 'shape-validator': 'validate-shape', 'shape-diagnosis': 'diagnose-shape' })[r.binding?.role ?? r.stage] ?? r.binding?.role ?? r.stage) };
const contextFor = ${contextFor.toString()};
async function signed(payload) {
  const g = await signGrant({ payload, draftDigest: grantDraftDigest(payload), unauthorized: [], summary: 'Installed fixture' }, host);
  records.set(digest(g), g); return g;
}
const snapshot = ${snapshot.toString()};
const requirementAdapters = ${requirementAdapters.toString()};
const proposed = ${JSON.stringify(ordinaryPayload)};
proposed.members[0].scopeDigest = digest('Installed original Scope');
const prepared = await prepareGrant(proposed, { requirements: requirementAdapters(),
  readPolicy: async () => ({ policy: proposed.policy, execution: proposed.execution, maxParallel: 2 }),
  readWorkSet: async () => ({ complete: true, members: proposed.members.map(m => ({
    repository: m.repository, issue: m.issue, originalBody: 'Installed original Scope',
    dependencies: m.dependencies, requirements: m.requirements })) }) });
const ordinary = await signGrant(prepared, host);
records.set(digest(ordinary), ordinary);
const request = ${JSON.stringify(initial())};
request.authority = { grantId: ordinary.payload.grantId, digest: digest(ordinary) };
request.scopeDigest = prepared.payload.members[0].scopeDigest;
await verifyGrant(ordinary, host, request.authority);
await authorizeOperation(ordinary, contextFor(ordinary), host, request.authority);
assert.equal((await runOneStage(request)).status, 'blocked');
let executions = 0;
const result = await runOneStage(request, {
  authorization: host, requirements: requirementAdapters(),
  verify: async () => ({ permission: 'verified' }),
  execute: async () => { executions++; return { status: 'succeeded' }; }
});
assert.equal(result.status, 'succeeded');
assert.equal(result.requestId, request.requestId);
assert.equal(executions, 1);
const protectedRequest = ${JSON.stringify(protectedFixture.request)};
const protectedProof = ${JSON.stringify(protectedFixture.proof)};
const original = await signed(${JSON.stringify(protectedAuthorization.parents[0].payload)});
const repairPayload = ${JSON.stringify(protectedAuthorization.grant.payload)};
repairPayload.repair.originalAuthority = { grantId: original.payload.grantId, digest: digest(original) };
const repair = await signed(repairPayload);
const repairAuthority = { grantId: repair.payload.grantId, digest: digest(repair) };
protectedProof.instructionContext.authority = repairAuthority;
for (const b of [protectedRequest.binding, ...protectedProof.prior.map(p => p.result.binding)]) {
  b.authority = repairAuthority;
  const i = resolveInstructions(b.role, protectedProof.configuration, protectedProof.instructionContext);
  b.instructionDigest = i.contentDigest; b.instructionSelectionDigest = i.selectionDigest;
}
for (const p of protectedProof.prior) { p.reference.binding = structuredClone(p.result.binding); p.reference.digest = digest(p.result); }
protectedRequest.previous = protectedProof.prior.map(p => p.reference);
protectedRequest.binding.previousDigest = digest(protectedRequest.previous);
protectedProof.assignment = structuredClone(protectedRequest.binding);
const protectedResult = { ...${JSON.stringify(roleResult(protectedFixture.request.binding))}, binding: protectedRequest.binding };
const inventoryEvidence = ${JSON.stringify(approval({ artifacts: [], hooks: [] }, 'a'.repeat(64)))};
const inventoryExpected = { shapeDigest: digest(inventoryEvidence.body), scopeDigest: 'a'.repeat(64) };
assert.deepEqual(parseCandidateInventory(inventoryEvidence.body), { artifacts: [], hooks: [] });
assert.deepEqual(validateCandidateObligations(inventoryEvidence, inventoryExpected, inventoryEvidence.configuration).obligations,
  { artifacts: [], hooks: [] });
assert.throws(() => validateCandidateObligations(inventoryEvidence, { ...inventoryExpected, shapeDigest: 'b'.repeat(64) }, inventoryEvidence.configuration));
assert.throws(() => parseCandidateInventory(inventoryEvidence.body + inventoryEvidence.body));
assert.equal(typeof createAgentAdapter, 'function');
for (const api of [prepareWorkspace, captureCandidate, reconstructCandidate, verifyCandidate, candidateEvidence, compareCandidateEvidence]) assert.equal(typeof api, 'function');
await assert.rejects(prepareWorkspace(protectedRequest, {}));
assert.equal(compareCandidateEvidence({}, {}).valid, false);
assert.throws(() => validateEnvironments([], []));
for (const [role, skill] of Object.entries({ shape: 'shape', 'shape-validator': 'shape',
  'shape-diagnosis': 'shape', 'shaper-review': 'shape', deliver: 'deliver', accept: 'accept' })) {
  const i = resolveInstructions(role, protectedProof.configuration, protectedProof.instructionContext);
  assert.equal(i.skill, skill);
  assert.equal(i.content, await readFile('node_modules/@nibfin/core/src/instructions/' + skill + '.md', 'utf8'));
  assert.equal(i.contentDigest, digest(i.content));
  assert.match(i.selectionDigest, /^[a-f0-9]{64}$/);
}
const selected = resolveInstructions('accept', protectedProof.configuration, protectedProof.instructionContext);
assert.equal(selected.contentDigest, protectedRequest.binding.instructionDigest);
assert.equal((await invokeProtected(protectedRequest)).status, 'blocked');
assert.equal((await invokeProtected(protectedRequest, {
  authorization: host, requirements: requirementAdapters(), verify: async () => protectedProof, execute: async () => protectedResult
})).status, 'succeeded');
protectedRequest.binding.sessionId = 'substituted';
assert.equal((await invokeProtected(protectedRequest, {
  authorization: host, requirements: requirementAdapters(), verify: async () => protectedProof, execute: async () => protectedResult
})).status, 'blocked');
const identityPaths = ${JSON.stringify(entries.map(e => e[0]))};
async function independentIdentity() {
  const pairs = [];
  for (const path of identityPaths) pairs.push([path, (await readFile('node_modules/@nibfin/core/' + path)).toString('base64')]);
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}
assert.equal(await independentIdentity(), expected.contentDigest);
for (const path of identityPaths.filter(p => ['src/protected.mjs', 'src/agent.mjs', 'src/workspace.mjs', 'src/obligations.mjs', 'src/requirements.mjs', 'src/authority.mjs', 'src/scope.mjs'].includes(p) || p.startsWith('src/instructions/'))) {
  const file = 'node_modules/@nibfin/core/' + path;
  const original = await readFile(file);
  try {
    await writeFile(file, Buffer.concat([original, Buffer.from('\\nTampered bytes\\n')]));
    assert.notEqual(await independentIdentity(), expected.contentDigest);
    await assert.rejects(checkInstalledCore(expected), /identity mismatch/);
  } finally { await writeFile(file, original); }
}
assert.equal(await independentIdentity(), expected.contentDigest);
console.log('External installed v4/v5 signed consumers, instruction selection, rejection and tamper checks passed.');
`);
  console.log(execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, encoding: 'utf8' }).trim());
  console.log(JSON.stringify({ packageFiles: paths, expectedIdentity: expected }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
