import { withRepairSnapshot } from './workspace-repair-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, runtimeConfigurationHash } from '../src/runtime.mjs';
import { coreDigest, signGrant, verifyGrant } from '../src/authority.mjs';
import { digest } from '../src/core.mjs';
import { Store } from '../src/store.mjs';
import { fixture, SHA } from './fixtures.mjs';
import { UPSTREAM_REPOSITORY, UPSTREAM_REPOSITORY_ID } from '../src/owner-identity.mjs';
import { dispatchGrantIdentity } from '../src/dispatch.mjs';
import { createRoot, readBindings, signDispatch } from '../src/runner-binding.mjs';

export class FakeGitHub {
  constructor(payload, privateKey) {
    this.payload = payload; this.privateKey = privateKey; this.merges = 0;
    this.issues = Object.fromEntries(payload.manifest.issues.map(i => [i.id, { node_id: i.id, number: i.number, body: i.scopeBody, labels: [{ name: 'scope' }], state: 'open' }]));
    this.prs = {}; this.heads = { 'example/one': SHA('a'), 'example/two': SHA('a') };
  }
  async grant() { return signGrant(this.payload, this.privateKey); }
  async text() { return this.payload.proposal; }
  async repository(repository) { return { private: true, visibility: 'private', permissions: { push: true }, full_name: repository }; }
  async verifyRunner(repository, ids, name) { assert.deepEqual(ids, [1]); assert.equal(name, 'trusted-runner'); return { repository, id: 1, name }; }
  async protections(repository) { return { head: this.heads[repository], requiredChecks: ['test'], inspection: {source:'protection-apis',protected:true,strictBase:true} }; }
  async list(path) {
    const repository = path.split('/').slice(2, 4).join('/');
    return this.payload.manifest.issues.filter(i => i.repository === repository).map(i => this.issues[i.id]);
  }
  async issue(i) { return structuredClone(this.issues[i.id]); }
  async dependencies(i) { return i.dependencies.map(node_id => ({ node_id })); }
  async updateIssue(i, patch) { Object.assign(this.issues[i.id], patch); if (patch.state === 'closed') this.issues[i.id].closed_at = '2026-10-19T00:00:00Z'; }
  async label(i, name) {
    if (!this.issues[i.id].labels.some(l => l.name === name)) this.issues[i.id].labels.push({ name });
    if (this.interruptLabel === name) { this.interruptLabel = null; throw new Error('Simulated lost label response'); }
  }
  async removeLabel(i, name) { this.issues[i.id].labels = this.issues[i.id].labels.filter(l => l.name !== name); }
  async findPull(repository, branch) { return Object.values(this.prs).find(p => p.head.repo.full_name === repository && p.head.ref === branch); }
  async createPull(i, branch, base) {
    const number = Object.keys(this.prs).length + 1;
    return this.prs[number] = { number, node_id: `PR_${number}`, head: { sha: this.pendingHeads?.[branch] || number.toString(16).repeat(40), ref: branch, repo: { full_name: i.repository } }, base: { ref: base, sha: this.heads[i.repository] }, state: 'open', draft: false, mergeable: true, mergeable_state: 'clean' };
  }
  async pull(repository, number) { return structuredClone(this.prs[number]); }
  async api(path, method, body) {
    if (path.includes('/git/commits/')) {
      const sha = path.split('/').at(-1);
      const pr = Object.values(this.prs).findLast(p => p.head.sha === sha);
      return { tree: { sha: SHA('b') }, parents: [{ sha: pr.base.sha }] };
    }
    if (path.includes('/pulls/') && method === 'PATCH') { Object.assign(this.prs[Number(path.split('/').at(-1))], body); return {}; }
    throw new Error(`Unexpected API: ${path}`);
  }
  async checks(repository, head) { return [{ id: `check-${head}`, name: 'test', head, status: 'completed', conclusion: 'success', trusted: true }]; }
  async merge(repository, number, head) {
    assert.equal(head, this.prs[number].head.sha);
    this.merges++;
    Object.assign(this.prs[number], { merged: true, merged_at: '2026-10-19T00:00:00Z', merge_commit_sha: SHA('d'), state: 'closed' });
    this.heads[repository] = SHA('d');
    if (this.interruptMerge) { this.interruptMerge = false; throw new Error('Simulated lost merge response'); }
  }
}
export async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-runtime-'));
  t.after(() => rm(root, { recursive: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = { runnerId: 'trusted-runner', stateDirectory: join(root, 'state'), publicKeyPath: join(root, 'owner.pem'), agent: { image: `example/codex@sha256:${'a'.repeat(64)}` }, grantSource: { repository: 'example/control', ref: 'main', path: 'grant.json' } };
  config.proposalSource = { repository: 'example/control', ref: 'main', path: 'proposal.txt' };
  await writeFile(config.publicKeyPath, publicKey.export({ format: 'pem', type: 'spki' }));
  const { manifest, policy } = fixture();
  const proposal = 'Approved test product semantics';
  manifest.proposalHash = digest(proposal);
  for (const i of manifest.issues) { i.scopeBody = `Implement ${i.id}`; i.scopeHash = digest(i.scopeBody); }
  Object.assign(policy, { manifestHash: digest(manifest), validFrom: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', coreDigest: await coreDigest(process.cwd()), agentImage: config.agent.image, runtimeHash: runtimeConfigurationHash(config) });
  for (const g of Object.values(policy.repositories)) { g.trustedCheckAppIds = [1]; g.runnerIds = [1]; }
  const payload = { recordId: 'signed-test-grant', actor: 'owner', revoked: false, manifest, policy, proposal };
  const gh = new FakeGitHub(payload, privateKey);
  const calls = [];
  let count = 0;
  const agent = { login: async () => {}, execute: async (stage, context) => {
    calls.push([stage, context.issue.id]);
    return { executionId: `execution-${++count}`, result: { outcome: stage === 'shape' || stage === 'deliver' ? 'ready' : stage === 'accept' ? 'accepted' : 'approved', body: stage === 'shape' ? `Contract ${context.issue.id}\n` + '```nibfin-candidate\n{"artifacts":[],"hooks":[]}\n```\n' : '', summary: 'Fixture evidence only', rootCause: '', evidenceReferences: ['fixture://observed'], blockingFindings: [] }, resultHash: 'result-hash', skill: { mode: 'default', hash: 'skill-hash', path: 'fixture' }, evidencePath: 'fixture://execution' };
  } };
  const factory = (path, issue) => withRepairSnapshot({ work: path, prepare: async () => {}, provenance: async base => ({repository:issue.repository,base,tree:SHA('b'),entries:[]}), diff: async () => 'complete fixture diff', captureAttempt: async base => ({repository:issue.repository,base,tree:SHA('b'),diffHash:digest(issue.id),paths:['src/feature.mjs']}), capture: async base => ({ repository: issue.repository, base, tree: SHA('b'), diffHash: digest(issue.id), paths: ['src/feature.mjs'],obligations:{artifacts:[],hooks:[]},artifacts:[],hookSources:[] }), commit: async () => (manifest.issues.findIndex(i => i.id === issue.id) + 1).toString(16).repeat(40), push: async (commit,branch) => { gh.pendingHeads ||= {}; gh.pendingHeads[branch]=commit; } });
  return { runtime: new Runtime(config, process.cwd(), gh, agent, factory, {}), gh, calls, config, payload, publicKey, privateKey };
}

