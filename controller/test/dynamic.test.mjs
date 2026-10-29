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
import { KAIRO_REPOSITORY, KAIRO_REPOSITORY_ID } from '../src/owner-identity.mjs';
import { dispatchGrantIdentity } from '../src/dispatch.mjs';
import { createRoot, readBindings, signDispatch } from '../src/runner-binding.mjs';

class FakeGitHub {
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
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'kairo-runtime-'));
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
    return { executionId: `execution-${++count}`, result: { outcome: stage === 'shape' || stage === 'deliver' ? 'ready' : stage === 'accept' ? 'accepted' : 'approved', body: stage === 'shape' ? `Contract ${context.issue.id}\n` + '```kairo-candidate\n{"artifacts":[],"hooks":[]}\n```\n' : '', summary: 'Fixture evidence only', rootCause: '', evidenceReferences: ['fixture://observed'], blockingFindings: [] }, resultHash: 'result-hash', skill: { mode: 'default', hash: 'skill-hash', path: 'fixture' }, evidencePath: 'fixture://execution' };
  } };
  const factory = (path, issue) => withRepairSnapshot({ work: path, prepare: async () => {}, provenance: async base => ({repository:issue.repository,base,tree:SHA('b'),entries:[]}), diff: async () => 'complete fixture diff', captureAttempt: async base => ({repository:issue.repository,base,tree:SHA('b'),diffHash:digest(issue.id),paths:['src/feature.mjs']}), capture: async base => ({ repository: issue.repository, base, tree: SHA('b'), diffHash: digest(issue.id), paths: ['src/feature.mjs'],obligations:{artifacts:[],hooks:[]},artifacts:[],hookSources:[] }), commit: async () => (manifest.issues.findIndex(i => i.id === issue.id) + 1).toString(16).repeat(40), push: async (commit,branch) => { gh.pendingHeads ||= {}; gh.pendingHeads[branch]=commit; } });
  return { runtime: new Runtime(config, process.cwd(), gh, agent, factory, {}), gh, calls, config, payload, publicKey, privateKey };
}


async function publicSetup(t) {
  const f = await setup(t), config = f.config;
  const directory = config.publicKeyPath.replace(/owner\.pem$/, '');
  config.kairoOwnerGitHubUserId = '77';
  f.payload.policy.kairoOwnerGitHubUserId = '77';
  f.payload.actorGitHubUserId = '77';
  config.publicRunner = { rootKeyPath: join(directory, 'runner-root'), registryPath: join(directory, 'bindings.json') };
  const { rootId } = await createRoot(config.publicRunner.rootKeyPath);
  const bindings = Object.fromEntries(Object.keys(f.payload.policy.repositories).map((repository, n) => [repository, { repository, runnerId: config.runnerId, repositoryId: String(n + 100), ownerId: '77', bindingId: String(n + 1).repeat(32), workflowPath: '.github/workflows/kairo.yml', workflowBlob: SHA('e') }]));
  await writeFile(config.publicRunner.registryPath, JSON.stringify({ runnerId: config.runnerId, bindings: Object.values(bindings).map(binding => ({ binding, active: true })) }));
  f.payload.policy.publicRunner = { rootId, bindings };
  f.payload.policy.runtimeHash = runtimeConfigurationHash(config);
  f.gh.repository = async repository => repository === KAIRO_REPOSITORY ? { id: KAIRO_REPOSITORY_ID, owner: { id: 77, type: 'User' } } : ({ private: false, visibility: 'public', id: Number(bindings[repository].repositoryId), owner: { id: 77, type: 'User' }, default_branch: 'main', permissions: { push: true } });
  for (const issue of Object.values(f.gh.issues)) issue.user = { id: 77, type: 'User' };
  f.gh.verifyRunner = async () => { throw new Error('Public repo must not register the credential-bearing runner'); };
  const api = f.gh.api.bind(f.gh), list = f.gh.list.bind(f.gh);
  f.gh.api = async (path, ...rest) => {
    if (path === '/users/owner') return { id: 77, type: 'User' };
    if (path.includes('/contents/')) return { sha: SHA('e') };
    if (path.includes('/actions/runs/')) return { event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_attempt: 1, repository: { id: path.includes('/example/one/') ? 100 : 101 }, head_repository: { id: path.includes('/example/one/') ? 100 : 101 }, head_branch: 'main', head_sha: SHA('f'), path: '.github/workflows/kairo.yml', actor: { id: 77 }, triggering_actor: { id: 77 } };
    return api(path, ...rest);
  };
  f.gh.list = async path => path.endsWith('/jobs') ? [{ name: 'preflight', status: 'completed', conclusion: 'success', labels: ['ubuntu-latest'] }] : list(path);
  const entries = await readBindings(config, f.payload.policy), now = Date.now();
  f.runtime.publicDispatch = { grantHash: dispatchGrantIdentity(f.payload), envelopes: Object.fromEntries(Object.entries(entries).map(([repository, entry]) => [repository, signDispatch({ schemaVersion: 1, operation: 'reevaluate', repository, repositoryId: entry.binding.repositoryId, runnerId: config.runnerId, bindingId: entry.binding.bindingId, runId: '456', runAttempt: 1, nonce: 'a'.repeat(32), issuedAt: now, expiresAt: now + 86400000 }, entry.secret)])) };
  return f;
}


import { unitId, prerequisiteIds, projectUnit, prepareDynamic, issueLeaseId } from '../src/dynamic.mjs';
async function dynamicSetup(t, edges = {}, publicMode = false) {
  const f = publicMode ? await publicSetup(t) : await setup(t);
  Object.assign(f.payload.manifest, {schemaVersion:2,scheduling:'native-dependencies',membership:'fixed-approved-set'});
  f.payload.policy.maxParallel = 3;
  f.payload.policy.stateDirectory = f.config.stateDirectory;
  const repository = f.gh.repository.bind(f.gh);
  f.gh.repository = async name => name === KAIRO_REPOSITORY ? repository(name) : ({...await repository(name),id:name === 'example/one' ? 100 : 101});
  for(const i of f.payload.manifest.issues) {
    i.repositoryId = i.repository === 'example/one' ? '100' : '101';
    f.payload.policy.repositories[i.repository].repositoryId = i.repositoryId;
    i.dependencies = edges[i.id] || [];
  }
  f.edges = structuredClone(edges);
  f.gh.dependencies = async i => (f.edges[i.id] || []).map(node_id => ({node_id}));
  f.payload.policy.manifestHash = digest(f.payload.manifest);
  if (publicMode) f.runtime.publicDispatch.grantHash = dispatchGrantIdentity(f.payload);
  return f;
}

test('dynamic independent Issues run concurrently with independent complete lifecycles', async t => {
  const f = await dynamicSetup(t);
  let active=0,peak=0;
  const execute=f.runtime.agent.execute;
  f.runtime.agent.execute=async (...args)=>{ active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,10)); const result=await execute(...args); active--; return result; };
  const result=await f.runtime.resume();
  assert.equal(result.status,'COMPLETE',JSON.stringify(result));
  assert.ok(peak>1);
  const callsBefore = f.calls.length;
  const repeated = await f.runtime.resume();
  assert.equal(repeated.status, 'COMPLETE');
  assert.equal(repeated.completionHash, result.completionHash);
  assert.equal(f.calls.length, callsBefore);
  assert.equal(f.gh.merges,3);
  for(const issue of f.payload.manifest.issues) {
    const s=await new Store(f.config.stateDirectory,unitId(f.payload,issue)).read();
    assert.equal(s.completion.status,'COMPLETE');
    assert.ok(s.issues[issue.id].accept);
    assert.ok(s.issues[issue.id].review);
  }
});

test('dynamic fork releases both children only after actual upstream closure',async t=>{
  const f=await dynamicSetup(t,{I_B:['I_A'],I_C:['I_A']});
  const execute=f.runtime.agent.execute;
  f.runtime.agent.execute=async (role,c,...rest)=>{
    if(c.issue.id!=='I_A') assert.equal(f.gh.issues.I_A.state,'closed');
    return execute(role,c,...rest);
  };
  const r=await f.runtime.resume();
  assert.equal(r.status,'COMPLETE',JSON.stringify(r));
  assert.deepEqual(f.edges,{I_B:['I_A'],I_C:['I_A']});
});

test('live dependency added during Agent prevents publication; removing it resumes',async t=>{
  const f=await dynamicSetup(t);
  const execute=f.runtime.agent.execute;
  let added=false;
  f.runtime.agent.execute=async(role,c,...rest)=>{
    const r=await execute(role,c,...rest);
    if(c.issue.id==='I_A'&&!added) {f.edges.I_A=['outside'];added=true;}
    return r;
  };
  let r=await f.runtime.resume();
  assert.equal(r.status,'PAUSED');
  assert.equal(f.gh.issues.I_A.body,'Implement I_A');
  assert.ok(r.units.filter(u=>u.issueId!=='I_A').every(u=>u.status==='COMPLETE'));
  f.edges.I_A=[];
  r=await f.runtime.resume();
  assert.equal(r.status,'COMPLETE',JSON.stringify(r));
});

test('new scope is discovered but not authorized and unrelated labels do not pause work',async t=>{
  const f=await dynamicSetup(t);
  const list=f.gh.list.bind(f.gh);
  f.gh.list=async p=>[...await list(p),{node_id:'NEW',number:99,labels:[{name:'scope'}]}];
  f.gh.issues.I_A.labels.push({name:'unrelated'});
  const r=await f.runtime.resume();
  assert.equal(r.status,'COMPLETE',JSON.stringify(r));
  assert.ok(r.discovered.some(i=>i.id==='NEW'&&!i.authorized));
  assert.ok(f.calls.every(([,id])=>id!=='NEW'));
});

test('scope removal quiesces active Issue without stopping unrelated deliveries',async t=>{
  const f=await dynamicSetup(t);
  const execute=f.runtime.agent.execute;
  f.runtime.agent.execute=async(role,c,...rest)=>{const r=await execute(role,c,...rest); if(c.issue.id==='I_A') f.gh.issues.I_A.labels=[];return r;};
  const r=await f.runtime.resume();
  assert.equal(r.status,'PAUSED');
  assert.equal(f.gh.issues.I_A.body,'Implement I_A');
  assert.ok(r.units.filter(u=>u.issueId!=='I_A').every(u=>u.status==='COMPLETE'));
});

test('fake delivered labels and closed Issue do not unlock dependencies',async t=>{
  const f=await dynamicSetup(t,{I_B:['I_A']});
  f.gh.issues.I_A.state='closed';f.gh.issues.I_A.labels.push({name:'delivered'});
  f.gh.issues.I_A.body='tampered';
  const r=await f.runtime.resume();
  assert.notEqual(r.status,'COMPLETE');
  assert.ok(!f.calls.some(([,id])=>id==='I_B'));
});

test('graph cycles and unauthorized external prerequisites are local blocks',()=>{
  const nodes=new Map([['A',{dependencies:['B']}],['B',{dependencies:['A']}],['C',{dependencies:[]}]]);
  assert.throws(()=>prerequisiteIds(nodes,'A'),/cycle/);
  assert.deepEqual(prerequisiteIds(nodes,'C'),[]);
  nodes.set('A',{dependencies:['outside']});
  assert.throws(()=>prerequisiteIds(nodes,'A'),/external/);
});

test('dynamic signed grant rejects missing concurrency consent and forged member projection',async t=>{
  const f=await dynamicSetup(t);
  const grant=await f.runtime.grant();
  assert.throws(()=>projectUnit(grant,{...grant.manifest.issues[0],id:'forged'}),/outside/);
  delete f.payload.policy.maxParallel;
  await assert.rejects(f.runtime.resume(),/maxParallel/);
});

test('revocation during Agent execution denies all subsequent mutations',async t=>{
  const f=await dynamicSetup(t);
  const execute=f.runtime.agent.execute;
  f.runtime.agent.execute=async(...args)=>{const r=await execute(...args);f.payload.revoked=true;return r;};
  await assert.rejects(f.runtime.resume(),/revoked/);
  assert.equal(f.gh.merges,0);
  assert.ok(Object.values(f.gh.issues).every(i=>i.body.startsWith('Implement')));
});


test('dynamic public dispatch retains Owner and binding gates through complete delivery',async t=>{
  const f=await dynamicSetup(t,{I_B:['I_A'],I_C:['I_A']},true);
  const r=await f.runtime.resume();
  assert.equal(r.status,'COMPLETE',JSON.stringify(r));
  assert.equal(f.gh.merges,3);
  assert.equal(f.runtime.executionContext.kind,'public-runner-dispatch');
});

test('lost merge response is reconciled without repeating or losing authorization',async t=>{
  const f=await dynamicSetup(t);
  f.gh.interruptMerge=true;
  let r=await f.runtime.resume({maxSteps:10});
  for(let i=0;i<3&&r.status!=='COMPLETE';i++) r=await f.runtime.resume();
  assert.equal(r.status,'COMPLETE',JSON.stringify(r));
  assert.equal(f.gh.merges,3);
});

test('a persisted dynamic write intent preserves the original merge error and state revision',async t=>{
  const f=await dynamicSetup(t);
  f.payload.manifest.issues=f.payload.manifest.issues.slice(0,1);
  f.payload.policy.manifestHash=digest(f.payload.manifest);
  f.gh.interruptMerge=true;
  const result=await f.runtime.resume();
  assert.equal(result.units[0].reason,'Simulated lost merge response');
  const state=await new Store(f.config.stateDirectory,unitId(f.payload,f.payload.manifest.issues[0])).read();
  assert.equal(state.lastError.message,'Simulated lost merge response');
  assert.equal(state.pending.operation,'merge');
  assert.equal(state.pending.writeAttempted,true);
  assert.equal((await f.runtime.resume()).status,'COMPLETE');
  assert.equal(f.gh.merges,1);
});

test('dynamic atomic merge readback delay retains its durable intent and resumes once',async t=>{
  const f=await dynamicSetup(t);
  f.payload.manifest.issues=f.payload.manifest.issues.slice(0,1);
  f.payload.policy.manifestHash=digest(f.payload.manifest);
  const pins=[{path:'.github/workflows/ci.yml',blobSha:SHA('e'),checks:['test']}];
  Object.assign(f.payload.policy.repositories['example/one'],{ciMode:'owner-policy',mergeStrategy:'atomic-merge',mergeMethod:'merge',requiredWorkflows:pins});
  f.gh.protections=async repo=>({head:f.gh.heads[repo],requiredChecks:[],inspection:{source:'branch-api',protected:false}});
  f.gh.checks=async(repo,head)=>[{id:`check-${head}`,name:'test',head,status:'completed',conclusion:'success',trusted:true,provenanceVerified:true,workflowPath:pins[0].path,workflowBlobSha:pins[0].blobSha,runId:'run',runAttempt:1,checkSuiteId:'suite'}];
  let delayReadback=false;
  const pull=f.gh.pull.bind(f.gh),factory=f.runtime.workspaceFactory;
  f.gh.pull=async(...args)=>{const pr=await pull(...args);if(delayReadback){delayReadback=false;pr.merged=false;}return pr;};
  f.runtime.workspaceFactory=(path,issue)=>({...factory(path,issue),mergeCommit:async()=>SHA('d'),advanceBase:async()=>{const pr=Object.values(f.gh.prs)[0];await f.gh.merge(issue.repository,pr.number,pr.head.sha);delayReadback=true;}});
  const result=await f.runtime.resume();
  assert.equal(result.units[0].code,'MERGE_READBACK_PENDING');
  const state=await new Store(f.config.stateDirectory,unitId(f.payload,f.payload.manifest.issues[0])).read();
  assert.equal(state.lastError.message,'Waiting for GitHub merge readback');
  assert.equal(state.pending.atomicCommit,SHA('d'));
  assert.equal((await f.runtime.resume()).status,'COMPLETE');
  assert.equal(f.gh.merges,1);
});

test('concurrent same-repository base advance repeats independent acceptance',async t=>{
  const f=await dynamicSetup(t);
  const r=await f.runtime.resume();
  assert.equal(r.status,'COMPLETE',JSON.stringify(r));
  const ids=f.payload.manifest.issues.filter(i=>i.repository==='example/one').map(i=>i.id);
  const states=await Promise.all(ids.map(id=>new Store(f.config.stateDirectory,unitId(f.payload,f.payload.manifest.issues.find(i=>i.id===id))).read()));
  assert.ok(states.some(s=>s.events.some(e=>e.operation==='repair'&&e.artifacts.cause==='base')));
  assert.ok(ids.some(id=>f.calls.filter(([role,i])=>role==='accept'&&i===id).length>1));
});

test('duplicate scheduler invocation cannot bypass maxParallel or duplicate work',async t=>{
  const f=await dynamicSetup(t);f.payload.policy.maxParallel=1;
  let release,entered;
  const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const execute=f.runtime.agent.execute;let first=true;
  f.runtime.agent.execute=async(...args)=>{if(first){first=false;entered();await hold;}return execute(...args);};
  const running=f.runtime.resume({maxSteps:1});
  await started;
  try {await assert.rejects(f.runtime.resume({maxSteps:1}),{code:'EEXIST'});} finally {release();}
  await running;
  assert.equal(f.calls.length,3);
});

test('missing shaped label blocks dependent transitions without repeating delivery',async t=>{
  const f=await dynamicSetup(t,{I_B:['I_A']});
  // A bounded invocation may yield to another lease holder. Exercise that
  // schedule explicitly; completion belongs to the continuation contract.
  await new Store(f.config.stateDirectory,issueLeaseId(f.payload.manifest.issues[0])).lease(async()=>{
    const waiting=await f.runtime.resume({maxSteps:1});
    assert.equal(waiting.status,'PAUSED',JSON.stringify(waiting));
    assert.equal(waiting.units.find(u=>u.issueId==='I_A').code,'EEXIST');
  });
  const initial=await continueCohort(f.runtime,{maxPasses:3,intervalMs:1000,delay:async()=>{}});
  assert.equal(initial.status,'COMPLETE',JSON.stringify(initial));
  const before=f.calls.length;
  f.gh.issues.I_A.labels=f.gh.issues.I_A.labels.filter(l=>l.name!=='shaped');
  const r=await f.runtime.resume({maxSteps:1});
  assert.notEqual(r.status,'COMPLETE');
  assert.equal(f.calls.length,before);
});

test('existing ordered aggregate cannot be silently overwritten by dynamic state',async t=>{
  const f=await dynamicSetup(t);
  const store=new Store(f.config.stateDirectory,f.payload.manifest.id);
  await store.transaction(0,s=>({...s,binding:{historical:true},completion:{status:'COMPLETE'}}));
  await assert.rejects(f.runtime.resume(),/Existing aggregate/);
  assert.deepEqual((await store.read()).completion,{status:'COMPLETE'});
  assert.equal(f.calls.length,0);
});

test('prepare command derives scope hashes and stable IDs without writes or signatures',async t=>{
  const f=await dynamicSetup(t);
  const api=f.gh.api.bind(f.gh);
  f.gh.api=async(path,...args)=>path==='/user'?{login:'owner',id:77}:api(path,...args);
  const result=await prepareDynamic(f.gh,f.config,f.payload.policy,{id:'fresh-dynamic-draft',coreDigest:'digest',runtimeHash:'runtime'});
  assert.equal(result.payload.manifest.schemaVersion,2);
  assert.equal(result.payload.manifest.issues.length,3);
  assert.ok(result.payload.manifest.issues.every(i=>i.scopeHash===digest(i.scopeBody)&&i.repositoryId));
  assert.equal(result.signature,undefined);
  assert.match(result.summary,/Unsigned/);
  assert.equal(f.calls.length,0);assert.equal(f.gh.merges,0);
  f.gh.issues.I_A.labels.push({name:'shaped'});
  await assert.rejects(prepareDynamic(f.gh,f.config,f.payload.policy,{id:'another'}),/migration/);
});

test('a chain waits for each actual upstream delivery and keeps original edges',async t=>{
  const f=await dynamicSetup(t,{I_B:['I_A'],I_C:['I_B']});
  const execute=f.runtime.agent.execute;
  f.runtime.agent.execute=async(role,c,...rest)=>{for(const dep of f.edges[c.issue.id]||[]) assert.equal(f.gh.issues[dep].state,'closed');return execute(role,c,...rest);};
  const r=await f.runtime.resume();
  assert.equal(r.status,'COMPLETE',JSON.stringify(r));
  assert.deepEqual(f.edges,{I_B:['I_A'],I_C:['I_B']});
});

test('dynamic runtime blocks cyclic units while unrelated work completes',async t=>{
  const f=await dynamicSetup(t,{I_A:['I_B'],I_B:['I_A']});
  const r=await f.runtime.resume();
  assert.equal(r.units.find(u=>u.issueId==='I_C').status,'COMPLETE');
  assert.ok(r.units.filter(u=>u.issueId!=='I_C').every(u=>u.code==='DEPENDENCY_CYCLE'));
  assert.ok(f.calls.every(([,id])=>id==='I_C'));
});

test('expired dynamic authority is refused before any Agent starts',async t=>{
  const f=await dynamicSetup(t);f.payload.policy.expiresAt='2020-01-02T00:00:00Z';
  await assert.rejects(f.runtime.resume(),/expired/);assert.equal(f.calls.length,0);
});

test('dynamic completion cannot bypass non-independent Accept evidence',async t=>{
  const f=await dynamicSetup(t);
  const execute=f.runtime.agent.execute;
  const ids={};
  f.runtime.agent.execute=async(role,c,...rest)=>{const r=await execute(role,c,...rest);if(role==='deliver') ids[c.issue.id]=r.executionId;if(role==='accept')r.executionId=ids[c.issue.id];return r;};
  const r=await f.runtime.resume();
  assert.equal(r.status,'PAUSED');assert.equal(f.gh.merges,0);
  assert.ok(r.units.every(u=>u.code==='NOT_INDEPENDENT'));
});


import { continueCohort } from '../src/continuation.mjs';
test('watcher stays alive for per-Issue graph blocks and resumes after live edge removal',async t=>{
  const f=await dynamicSetup(t,{I_A:['external']});
  let wakes=0;
  const r=await continueCohort(f.runtime,{maxPasses:2,intervalMs:1000,delay:async()=>{wakes++;f.edges.I_A=[];}});
  assert.equal(r.status,'COMPLETE',JSON.stringify(r));assert.equal(wakes,1);
});


test('dynamic grant cannot be replayed using a different state and lease directory',async t=>{
  const f=await dynamicSetup(t);
  f.config.stateDirectory=join(f.config.stateDirectory,'different');
  await assert.rejects(f.runtime.resume(),/signed coordination root/);
  assert.equal(f.calls.length,0);
});
