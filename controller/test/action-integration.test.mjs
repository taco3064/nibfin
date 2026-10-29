// Provider and Agent are deterministic fakes. This exercises actual Runtime,
// Core, Store and stage handoff code, and is NOT GitHub/public E2E evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './action-runtime-fixture.mjs';
import { Runtime, runtimeConfigurationHash } from '../src/runtime.mjs';
import { verifyGrant } from '../src/authority.mjs';
import { digest } from '../src/core.mjs';
import { verifyActionRun } from '../src/action-provenance.mjs';
import { reconcileActionIssue, executeActionStage, fanoutActionCompletion } from '../src/action-stage.mjs';
import { runActionLifecycle } from '../src/action-lifecycle.mjs';
import { runOwnerIssueSession } from '../src/owner-issue-session.mjs';
import { ActionOutbox } from '../src/action-outbox.mjs';
import { Store } from '../src/store.mjs';
import { unitId, ready } from '../src/dynamic.mjs';
import { eventSource } from '../src/native-wakeup.mjs';
import { loadIssueScopes, issueScopeStore } from '../src/issue-scope.mjs';
import { KAIRO_REPOSITORY_ID } from '../src/owner-identity.mjs';
import { mkdir } from 'node:fs/promises';

async function harness(t, {local=false,owner=false,live=false}={}) {
  const f = await setup(t), { payload: g, gh, config } = f;
  const template = structuredClone(g.policy.repositories['example/one']);
  const rows = [['I_A', 'example/one', []], ['I_B', 'example/two', []], ['I_C', 'example/three', ['I_B']], ['I_D', 'example/four', ['I_B']]];
  g.manifest.schemaVersion = 2; g.manifest.scheduling = 'native-dependencies'; g.manifest.membership = 'fixed-approved-set';
  g.manifest.issues = rows.map(([id, repository, dependencies], index) => ({ id, repository, repositoryId: String(101 + index), number: 1, scopeBody: `Implement ${id}`, scopeHash: digest(`Implement ${id}`), dependencies }));
  g.policy.repositories = Object.fromEntries(g.manifest.issues.map(i => [i.repository, { ...structuredClone(template), repositoryId: i.repositoryId, deployment: { mode: 'not-applicable', reason: 'Deterministic library fixture; no publishing or deployment authorized' } }]));
  Object.assign(g.policy, { executionMode: 'actions-v1', maxParallel: 2, stateDirectory: config.stateDirectory, manifestHash: digest(g.manifest) });
  g.policy.operations.push('pre-accept-hooks', 'post-accept-hooks', 'verify-deployment');
  const execution = { repository: 'example/control', repositoryId: '999', workflowPath: '.github/workflows/action-stage.yml', workflowBlob: 'f'.repeat(40), actorIds: ['7'], runnerIds: [1], runnerName: config.runnerId, jobName: 'execute', ref: 'main' };
  if(local)Object.assign(execution,{identityMode:'local-gh',ownerId:'7'});
  g.policy.actionExecution = execution; config.actionExecution = execution; config.kairoOwnerGitHubUserId = '7';
  if(owner){config.controlMode='owner-project';g.policy.controlMode='owner-project';for(const r of Object.values(g.policy.repositories)){r.ciMode='github-repository';r.finalProofs=[];}}
  g.policy.runtimeHash = runtimeConfigurationHash(config);
  gh.issues = Object.fromEntries(g.manifest.issues.map(i => [i.id, { node_id: i.id, number: i.number, user:{id:7,type:'User'}, body: i.scopeBody, labels: [{ name: 'scope' }], state: 'open' }]));
  gh.heads = Object.fromEntries(g.manifest.issues.map(i => [i.repository, 'a'.repeat(40)]));
  gh.dependencies = async issue => g.manifest.issues.find(i => i.id === issue.id).dependencies.map(node_id => ({ node_id }));
  const runs = new Map(); let serial = 1000;
  const originalApi = gh.api.bind(gh), originalList = gh.list.bind(gh);
  gh.repository = async repository => ({ id: repository === 'taco3064/kairo' ? KAIRO_REPOSITORY_ID : repository === execution.repository ? 999 : Number(g.manifest.issues.find(i => i.repository === repository).repositoryId), full_name: repository, private: repository === execution.repository, visibility: repository === execution.repository?'private':'public', owner:{id:7,type:'User'}, default_branch: 'main', permissions: { push: true } });
  gh.api = async (path, method, body) => {
    if(path==='/user')return {id:7,type:'User'};
    if(path.includes('/issues/'))return gh.issues[g.manifest.issues.find(i=>path===`/repos/${i.repository}/issues/${i.number}`)?.id] || originalApi(path,method,body);
    if (path.includes('/contents/')) return { type: 'file', sha: execution.workflowBlob };
    const match = path.match(/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/);
    if (match) return structuredClone(runs.get(match[1]).run);
    return originalApi(path, method, body);
  };
  gh.list = async (path, field) => {
    if(local&&path.includes('/jobs'))assert.fail('Local gh path must never query Jobs');
    if(local&&path.includes('labels=scope'))return []; // Deliberately stale discovery index.
    const match = path.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/);
    if (match) return structuredClone(runs.get(match[1]).jobs);
    if (path.endsWith('/dependencies/blocking')) {
      const repository = path.split('/').slice(2, 4).join('/'), upstream = g.manifest.issues.find(i => i.repository === repository);
      return g.manifest.issues.filter(i => i.dependencies.includes(upstream.id)).map(i => gh.issues[i.id]);
    }
    return originalList(path, field);
  };
  const bindings = Object.fromEntries(g.manifest.issues.map(i => [i.repository, { kairoOwnerGitHubUserId:'7',binding: {repository:i.repository,ownerId:'7',runnerId:config.runnerId,bindingId:'b'.repeat(32),repositoryId: i.repositoryId, workflowPath: '.github/workflows/kairo.yml',workflowBlob:execution.workflowBlob } }]));
  g.actorGitHubUserId='7';g.policy.kairoOwnerGitHubUserId='7';
  g.policy.publicRunner={rootId:'c'.repeat(64),bindings:Object.fromEntries(Object.entries(bindings).map(([r,e])=>[r,e.binding]))};
  g.policy.actionEvents = Object.fromEntries(g.manifest.issues.map(i => [i.repository, { actorIds: ['7'],signerVerification:'hmac-workflow-pin',reconcileWorkflowPaths:['.github/workflows/ci.yml'] }]));
  const nativeSources=new Map();
  async function nativeHint(id,action,{key=null,eventName='issues',createdAt=new Date().toISOString(),issuedAt=Date.now()}={}) {
    if(key && nativeSources.has(key))return nativeSources.get(key);
    const issue=g.manifest.issues.find(i=>i.id===id),runId=String(++serial),entry=bindings[issue.repository];
    const payload={repository:issue.repository,repositoryId:issue.repositoryId,issueId:eventName==='issues'?id:null,issueNumber:eventName==='issues'?issue.number:null,
      runId,runAttempt:1,eventName,eventAction:action,issuedAt,bindingId:entry.binding.bindingId,runnerId:config.runnerId};
    const relatedRunId=eventName==='workflow_run'?String(++serial):null;payload.relatedRunId=relatedRunId;
    const run={id:Number(runId),run_attempt:1,created_at:createdAt,event:eventName,path:entry.binding.workflowPath,repository:{id:Number(issue.repositoryId),full_name:issue.repository},head_repository:{id:Number(issue.repositoryId),full_name:issue.repository},head_branch:'main',head_sha:'e'.repeat(40),actor:{id:7},triggering_actor:{id:7}};
    runs.set(runId,{run,jobs:[]});
    if(relatedRunId)runs.set(relatedRunId,{run:{...run,id:Number(relatedRunId),status:'completed',path:'.github/workflows/ci.yml'},jobs:[]});
    const inbox=new Store(config.stateDirectory,`actions-inbox:${g.policy.grantId}`),s=await inbox.read();
    await inbox.transaction(s.revision,x=>({...x,seen:{...x.seen,[runId]:{payload,targetIds:[id]}}}));
    const source=eventSource(payload);if(key)nativeSources.set(key,source);return source;
  }
  const outbox = new ActionOutbox(config.stateDirectory, gh, execution);
  async function begin() {
    const runId = String(++serial), jobId = String(serial * 10);
    const worker = execution.workers ? execution.workers[serial % execution.workers.length] : { id: 1, name: config.runnerId };
    runs.set(runId, { run: { id: Number(runId), run_attempt: 1, repository: { id: 999, full_name: execution.repository }, path: execution.workflowPath,
      event: 'workflow_dispatch', actor: { id: 7 }, triggering_actor: { id: 7 }, head_sha: 'e'.repeat(40), status: 'in_progress' },
      jobs: [{ id: Number(jobId), head_sha: 'e'.repeat(40), name: 'execute', runner_id: worker.id, runner_name: worker.name, status: 'in_progress' }] });
    const runtime = new Runtime(config, process.cwd(), gh, f.runtime.agent, f.runtime.workspaceFactory, {});
    runtime.grant = async () => {
      const grant = verifyGrant(await gh.grant(), f.publicKey.export({ format: 'pem', type: 'spki' }));
      runtime.actionIdentity = await verifyActionRun(gh, execution, { runId, attempt: 1, jobId });
      runtime.executionContext = {...runtime.actionIdentity,kind:'public-runner-dispatch',rootId:g.policy.publicRunner.rootId,kairoOwnerGitHubUserId:'7'}; runtime.publicDispatch=true;runtime.publicBindings = bindings;
      if(live)await loadIssueScopes(runtime,grant);
      return grant;
    };
    return { runtime, finish: () => { const r = runs.get(runId); Object.assign(r.run, { status: 'completed', conclusion: 'success' }); Object.assign(r.jobs[0], { status: 'completed', conclusion: 'success' }); } };
  }
  async function reconcile(id) {
    const run = await begin(), grant = await run.runtime.grant(), issue = grant.manifest.issues.find(i => i.id === id);
    const state = await new Store(config.stateDirectory, unitId(grant, issue)).read();
    const action = { 'publish-shape': 'labeled', close: 'closed', 'reopen-recovery': 'reopened' }[state.actionReceipts?.at(-1)?.operation];
    // Synthetic verified event input only: this is not native GitHub delivery.
    const source = action ? await nativeHint(id,action) : { kind: 'owner-reconcile' };
    try { const next = await reconcileActionIssue(run.runtime, grant, issue, source); if (next.requestId) await outbox.prepareHandoff(next.requestId); return next; }
    finally { run.finish(); }
  }
  async function execute(requestId) {
    const run = await begin(); try { const result = await executeActionStage(run.runtime, requestId); if (['COMPLETE','STAGE_COMPLETE','DUPLICATE','SUPERSEDED'].includes(result.status)) await outbox.finish(requestId,result.status); return result; } finally { run.finish(); }
  }
  async function complete(id) {
    for (let n = 0; n < 25; n++) { const next = await reconcile(id); if (next.status === 'COMPLETE') return next; assert.equal(next.status, 'READY', JSON.stringify(next)); const result = await execute(next.requestId); assert.ok(['STAGE_COMPLETE', 'COMPLETE'].includes(result.status), JSON.stringify(result)); if (result.status === 'COMPLETE') return result; }
    assert.fail('Fixture did not complete within its bounded stage count');
  }
  return { ...f, begin, reconcile, execute, complete, outbox, runs, nativeHint, grant: g };
}

test('local gh stages complete with an empty scope discovery index and without Job status reads',async t=>{
  const f=await harness(t,{local:true});
  const done=await f.complete('I_A');assert.equal(done.status,'COMPLETE');
  const state=await new Store(f.config.stateDirectory,unitId(f.grant,f.grant.manifest.issues[0])).read();
  assert.ok(state.actionReceipts.length>=13);
  assert.ok(state.actionReceipts.every(r=>r.action.authentication==='local-gh'));
});

test('actual Runtime advances one formal stage per provider-backed Run; B receipt releases both native dependents', async t => {
  const f = await harness(t);
  await assert.rejects(f.reconcile('I_C'), { code: 'DEPENDENCY_WAIT' });
  await assert.rejects(f.reconcile('I_D'), { code: 'DEPENDENCY_WAIT' });
  const a = await f.reconcile('I_A'), b = await f.reconcile('I_B');
  assert.equal(a.operation, 'shape'); assert.equal(b.operation, 'shape');
  await f.execute(a.requestId); await f.execute(b.requestId);
  // B can finish while A still has only its author draft: no global All-Shaped
  // barrier. Each call executes the actual Runtime with maxSteps exactly one.
  const completedB = await f.complete('I_B'); assert.equal(completedB.status, 'COMPLETE');
  const stateA = await new Store(f.config.stateDirectory, unitId(f.grant, f.grant.manifest.issues[0])).read();
  assert.equal(stateA.issues.I_A.shape.validator, undefined);
  const c = await f.reconcile('I_C'), d = await f.reconcile('I_D'); assert.equal(c.operation, 'shape'); assert.equal(d.operation, 'shape');
  await f.execute(c.requestId); await f.execute(d.requestId);
  await f.complete('I_C'); // D's Shape is not yet validated/published.
  const stateD = await new Store(f.config.stateDirectory, unitId(f.grant, f.grant.manifest.issues[3])).read();
  assert.equal(stateD.issues.I_D.shape.validator, undefined);
  await f.complete('I_D'); await f.complete('I_A');
  for (const issue of f.grant.manifest.issues) {
    const state = await new Store(f.config.stateDirectory, unitId(f.grant, issue)).read();
    assert.equal(state.completion.status, 'COMPLETE');
    const receipts = state.actionReceipts;
    assert.equal(new Set(receipts.map(r => r.action.runId)).size, receipts.length);
    for (const op of ['shape', 'validate-shape', 'publish-shape', 'deliver', 'pre-accept-hooks', 'accept', 'post-accept-hooks', 'commit-pr', 'shaper-review', 'merge', 'verify-deployment', 'close', 'mark-delivered']) assert.ok(receipts.some(r => r.operation === op), op);
    assert.deepEqual(f.gh.issues[issue.id].labels.map(l => l.name).sort(), ['delivered', 'scope', 'shaped']);
  }
  const run = await f.begin(), grant = await run.runtime.grant();
  const handoffs = await fanoutActionCompletion(run.runtime, grant, grant.manifest.issues[1], completedB.completion);
  assert.deepEqual(handoffs.map(h => h.issueId).sort(), ['I_C', 'I_D']);
  assert.deepEqual(await fanoutActionCompletion(run.runtime, grant, grant.manifest.issues[1], completedB.completion), []);
  run.finish();
});

test('first Completion creates its absent receipt; retry revalidates without repeating label publication or fanout', async t => {
  const f = await harness(t), issue = f.grant.manifest.issues[1];
  let publication;
  for (let n = 0; n < 20; n++) {
    const next = await f.reconcile(issue.id); assert.equal(next.status, 'READY');
    if (next.operation === 'mark-delivered') { publication = next; break; }
    await f.execute(next.requestId);
  }
  assert.ok(publication);
  const store = new Store(f.config.stateDirectory, unitId(f.grant, issue));
  const before = await store.read();
  assert.equal(f.gh.issues[issue.id].state, 'closed'); assert.equal(before.completion, undefined);
  assert.ok(!f.gh.issues[issue.id].labels.some(l => l.name === 'delivered'));
  const first = await f.execute(publication.requestId); assert.equal(first.status, 'COMPLETE');
  const after = await store.read(), retry = await f.reconcile(issue.id);
  assert.equal(retry.status, 'COMPLETE'); assert.equal(retry.completion.completionHash, first.completion.completionHash);
  assert.deepEqual((await store.read()).actionReceipts, after.actionReceipts);
  // Simulate loss of only the final local certificate transaction. The
  // publication and its atomic Actions receipt remain intact and are reread.
  await store.transaction(after.revision, s => { delete s.completion; return s; });
  const recovered = await f.reconcile(issue.id); assert.equal(recovered.status, 'COMPLETE');
  assert.equal(recovered.completion.receiptHash, first.completion.receiptHash);
  const current = await store.read();
  await store.transaction(current.revision, s => { s.completion.completionHash = 'f'.repeat(64); return s; });
  await assert.rejects(f.reconcile(issue.id), { code: 'COMPLETION_UNVERIFIED' });
});

test('two enrolled worker processes can overlap real Runtime Deliver stages for independent native children', async t => {
  const f = await harness(t), execution = f.grant.policy.actionExecution;
  execution.runnerIds = [1, 2]; execution.workers = [{ id: 1, name: 'worker-a' }, { id: 2, name: 'worker-b' }];
  f.grant.policy.runtimeHash = runtimeConfigurationHash(f.config);
  await f.complete('I_B');
  async function deliverRequest(id) {
    for (let n = 0; n < 8; n++) { const next = await f.reconcile(id); if (next.operation === 'deliver') return next.requestId; assert.equal(next.status, 'READY'); await f.execute(next.requestId); }
    assert.fail('Child did not reach Deliver');
  }
  const c = await deliverRequest('I_C'), d = await deliverRequest('I_D');
  const original = f.runtime.agent.execute; let active = 0, peak = 0, release;
  const barrier = new Promise(resolve => release = resolve);
  const timeout = setTimeout(() => release(), 5000); t.after(() => clearTimeout(timeout));
  f.runtime.agent.execute = async (stage, context, ...args) => {
    if (stage !== 'deliver') return original(stage, context, ...args);
    active++; peak = Math.max(peak, active); if (active === 2) release();
    await barrier;
    try { return await original(stage, context, ...args); } finally { active--; }
  };
  const results = await Promise.all([f.execute(c), f.execute(d)]);
  assert.equal(peak, 2); assert.ok(results.every(r => r.status === 'STAGE_COMPLETE'));
  const receipts = [];
  for (const id of ['I_C', 'I_D']) { const issue = f.grant.manifest.issues.find(i => i.id === id); const state = await new Store(f.config.stateDirectory, unitId(f.grant, issue)).read(); receipts.push(state.actionReceipts.find(r => r.operation === 'deliver')); }
  assert.notEqual(receipts[0].action.runnerId, receipts[1].action.runnerId);
  assert.notEqual(receipts[0].action.runId, receipts[1].action.runId);
});

test('stage dependency wait reports upstream reason and preserves request for a fresh wakeup', async t => {
  const f=await harness(t), next=await f.reconcile('I_A');
  const old=f.gh.dependencies;f.gh.dependencies=async issue=>issue.id==='I_A'?[{node_id:'I_B'}]:old(issue);
  const run=await f.begin();
  const {runActionLifecycle}=await import('../src/action-lifecycle.mjs');
  const result=await runActionLifecycle(run.runtime,{inputs:{request_id:next.requestId}});
  assert.equal(result.status,'WAITING');assert.equal(result.code,'DEPENDENCY_WAIT');assert.equal(result.dependency.prerequisiteId,'I_B');assert.equal(result.dependency.operation,'shape');
  assert.equal((await f.outbox.read(next.requestId)).status,'dependency-wait');run.finish();
  f.gh.dependencies=old;
  const resumed=await f.reconcile('I_A');assert.notEqual(resumed.requestId,next.requestId);assert.equal((await f.execute(resumed.requestId)).status,'STAGE_COMPLETE');
});

test('queued merge superseded by a changed base schedules a distinct repair', async t => {
  const f = await harness(t), issue = f.grant.manifest.issues[0];
  let merge;
  for (let n = 0; n < 20; n++) {
    const next = await f.reconcile(issue.id);
    if (next.operation === 'merge') { merge = next; break; }
    await f.execute(next.requestId);
  }
  assert.ok(merge);
  f.gh.heads[issue.repository] = 'b'.repeat(40);
  const run = await f.begin();
  const lifecycle = await runActionLifecycle(run.runtime, { inputs: { request_id: merge.requestId } });
  run.finish();
  assert.equal(lifecycle.handoffs.length, 1);
  const result = lifecycle.results[0];
  assert.equal(result.status, 'SUPERSEDED');
  assert.equal(result.detail.expected.operation, 'merge');
  assert.equal(result.detail.actual.operation, 'repair');
  assert.equal(result.detail.actual.artifacts.cause, 'base');
  const state = await new Store(f.config.stateDirectory, unitId(f.grant, issue)).read();
  assert.equal(state.pending.operation, 'repair');
  assert.ok(state.events.some(e => e.kind === 'stage-decision-changed'));
  assert.equal(state.actionRequests?.[merge.requestId], undefined);
  const next = await f.reconcile(issue.id);
  assert.equal(next.operation, 'repair');
  assert.notEqual(next.requestId, merge.requestId);
  assert.equal((await f.execute(next.requestId)).status, 'STAGE_COMPLETE');
});



for(const lost of ['close','label']) test('owner no-deployment finalization resumes lost '+lost+' response without duplicate writes or dependency reads',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];
 let finish;
 for(let n=0;n<20;n++){const next=await f.reconcile(issue.id);assert.equal(next.status,'READY',JSON.stringify(next));assert.notEqual(next.operation,'verify-deployment');if(next.operation==='close'){finish=next;break;}await f.execute(next.requestId);}
 assert.ok(finish);
 f.gh.dependencies=async()=>assert.fail('No dependency reads after verified merge');
 f.gh.protections=async()=>assert.fail('Closure must not recheck branch rules');
 f.gh.checks=async()=>assert.fail('Closure must not recheck CI');
 const originalApi=f.gh.api.bind(f.gh);
 f.gh.api=async(path,...args)=>{assert.ok(!/\/git\/|\/compare\//.test(path),'Closure must not reload immutable Git evidence');return originalApi(path,...args);};
 const originalLabel=f.gh.label.bind(f.gh),originalUpdate=f.gh.updateIssue.bind(f.gh);
 let labels=0,closes=0;
 f.gh.updateIssue=async(i,p)=>{if(p.state==='closed')closes++;const r=await originalUpdate(i,p);if(lost==='close'&&p.state==='closed')throw Error('close response lost');return r;};
 f.gh.label=async(i,l)=>{labels++;await originalLabel(i,l);if(l==='delivered'&&lost==='label')throw Error('label response lost');};
 await assert.rejects(f.execute(finish.requestId),/response lost/);
 const before=await new Store(f.config.stateDirectory,unitId(f.grant,issue)).read();
 assert.equal(before.pending.operation,'close');assert.equal(Boolean(before.issues[issue.id].closeReceipt),lost==='label');
 const result=await f.execute(finish.requestId);assert.equal(result.status,'COMPLETE',JSON.stringify(result));assert.equal(closes,1);assert.equal(labels,1);
 const state=await new Store(f.config.stateDirectory,unitId(f.grant,issue)).read();
 assert.equal(state.pending,null);assert.equal(state.completion.status,'COMPLETE');
 assert.equal(state.actionReceipts.at(-1).operation,'close');
 assert.deepEqual(f.gh.issues[issue.id].labels.map(l=>l.name).sort(),['delivered','scope','shaped']);
 assert.equal((await f.reconcile(issue.id)).status,'COMPLETE');
});

test('owner finalization rejects a changed merged PR before closing or labeling the Issue',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];
 let finish;
 for(let n=0;n<20;n++){const next=await f.reconcile(issue.id);assert.equal(next.status,'READY',JSON.stringify(next));if(next.operation==='close'){finish=next;break;}await f.execute(next.requestId);}
 assert.ok(finish);
 const original=f.gh.pull.bind(f.gh);
 f.gh.pull=async(...args)=>({...await original(...args),merge_commit_sha:'e'.repeat(40)});
 f.gh.updateIssue=async()=>assert.fail('Changed merge must not close Issue');
 f.gh.label=async()=>assert.fail('Changed merge must not label Issue');
 await assert.rejects(f.execute(finish.requestId),/Merged PR differs/);
});

test('owner finalization cannot certify a body change observed in the label readback',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];
 let finish;
 for(let n=0;n<20;n++){const next=await f.reconcile(issue.id);assert.equal(next.status,'READY',JSON.stringify(next));if(next.operation==='close'){finish=next;break;}await f.execute(next.requestId);}
 assert.ok(finish);
 const original=f.gh.label.bind(f.gh);
 f.gh.label=async(...args)=>{await original(...args);f.gh.issues[issue.id].body='unexpected concurrent edit';};
 const result=await f.execute(finish.requestId);assert.notEqual(result.status,'COMPLETE');
 const state=await new Store(f.config.stateDirectory,unitId(f.grant,issue)).read();assert.equal(state.completion,undefined);
});

async function ownerWake(f,id,source) {
 if(source?.kind==='public-issue-event' && source.runAttempt===undefined)source=await f.nativeHint(id,source.action,{key:source.runId,eventName:source.event});
 const run=await f.begin(),grant=await run.runtime.grant(),issue=grant.manifest.issues.find(i=>i.id===id);
 try{return await runOwnerIssueSession(run.runtime,grant,issue,source || {kind:'owner-reconcile',runId:run.runtime.actionIdentity.runId});}finally{run.finish();}
}

test('a fresh dispatched stage continues an Owner session after grouped historical stages',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];
 await ownerWake(f,issue.id);
 const hint=await f.nativeHint(issue.id,'labeled'),run=await f.begin(),grant=await run.runtime.grant();
 run.runtime.ownerRunBudget={shouldYield:operation=>operation==='accept',deadline:Date.now()+60000};
 try{const result=await runOwnerIssueSession(run.runtime,grant,issue,hint);assert.equal(result.code,'OWNER_RUN_BUDGET_EXHAUSTED');}finally{run.finish();}
 const store=new Store(f.config.stateDirectory,unitId(f.grant,issue)),before=await store.read();
 assert(before.actionReceipts.length>new Set(before.actionReceipts.map(r=>r.action.runId)).size);
 const next=await f.reconcile(issue.id);assert.equal(next.operation,'accept');
 const result=await f.execute(next.requestId);assert.equal(result.status,'STAGE_COMPLETE');
 const after=await store.read(),receipt=after.actionReceipts.at(-1);assert.equal(receipt.operation,'accept');
 assert(!before.actionReceipts.some(r=>r.action.runId===receipt.action.runId));assert(after.issues[issue.id].accept);
});

test('authenticated out-of-grant reconciliation is ignored without Agent work',async t=>{
 const f=await harness(t,{local:true,owner:true}),run=await f.begin();
 const result=await runActionLifecycle(run.runtime,{inputs:{issue_id:'I_UNRELATED',issue_ref:'nibfin#229'}});
 assert.deepEqual(result,{status:'IGNORED',code:'ISSUE_NOT_IN_GRANT',handoffs:[]});
 assert.equal(f.calls.length,0);run.finish();
 const foreign=await f.begin(),grant=foreign.runtime.grant;
 foreign.runtime.grant=async()=>{const g=await grant();foreign.runtime.actionIdentity.actorId='8';return g;};
 await assert.rejects(runActionLifecycle(foreign.runtime,{inputs:{issue_id:'I_UNRELATED'}}),{code:'OWNER_RECONCILIATION_REQUIRED'});
 foreign.finish();
});

test('Scope change restores prior implementation but repeats every new-cycle gate',async t=>{
 const f=await harness(t,{local:true,owner:true,live:true}),issue=f.grant.manifest.issues[0],execute=f.runtime.agent.execute;
 let firstDeliver=true,restored=false,oldUnit;
 f.runtime.agent.execute=async(stage,context,...args)=>{
  const run=await execute(stage,context,...args);
  if(stage==='deliver'&&firstDeliver){firstDeliver=false;await mkdir(args[0],{recursive:true});run.result.outcome='blocked';run.result.failureClass='external_failure';run.result.blockingFindings=['Old Scope requested unavailable live evidence'];}
  else if(stage==='deliver'){
   assert.equal(context.repairSource.sourceUnitId,oldUnit);assert.equal(context.repairSource.unaccepted,true);
   assert.equal(context.repairSource.restoration.status,'restored');assert.ok(context.diff);
   assert.match(context.repairInstruction,/No old verdict/);restored=true;
  }
  return run;
 };
 await ownerWake(f,issue.id);await ownerWake(f,issue.id,await f.nativeHint(issue.id,'labeled'));
 const old=await issueScopeStore(f.runtime,f.grant,issue).read();
 const oldRun=await f.begin(),g=await oldRun.runtime.grant();oldRun.finish();oldUnit=unitId(g,issue);
 const before=await new Store(f.config.stateDirectory,oldUnit).read();assert.ok(before.issues[issue.id].blocked);
 f.gh.issues[issue.id].body='Corrected Scope with post-merge CD ownership';
 await ownerWake(f,issue.id);
 const current=await issueScopeStore(f.runtime,f.grant,issue).read();
 assert.equal(current.current.priorImplementation.sourceUnitId,oldUnit);
 assert.equal(current.current.priorImplementation.sourceScopeHash,old.current.issue.scopeHash);
 const done=await ownerWake(f,issue.id,await f.nativeHint(issue.id,'labeled'));
 assert.equal(done.status,'COMPLETE',JSON.stringify(done));assert.equal(restored,true);
 assert.deepEqual(await new Store(f.config.stateDirectory,oldUnit).read(),before);
 for(const stage of ['shape','shape-validator'])assert.equal(f.calls.filter(c=>c[0]===stage).length,2);
 for(const stage of ['accept','shaper-review'])assert.equal(f.calls.filter(c=>c[0]===stage).length,1);
});

test('live Issue requirements preserve body, supersede old Shape, and complete a fresh cycle',async t=>{
 const f=await harness(t,{local:true,owner:true,live:true}),issue=f.grant.manifest.issues[0];
 const original=issue.scopeBody;
 assert.equal((await ownerWake(f,issue.id)).code,'NATIVE_ISSUE_EVENT_REQUIRED');
 assert.equal(f.gh.issues[issue.id].body,original);
 const cursor=issueScopeStore(f.runtime,f.grant,issue),first=await cursor.read();
 const run=await f.begin(),g=await run.runtime.grant();run.finish();
 const oldId=unitId(g,g.manifest.issues[0]),oldStore=new Store(f.config.stateDirectory,oldId),before=await oldStore.read();
 assert.ok(before.issues[issue.id].shape.publication.scopeHash);
 f.gh.issues[issue.id].body='Owner revised requirements';
 // Leave the old shaped label in place: accepting edits does not require manual label cleanup.
 assert.equal((await ownerWake(f,issue.id)).code,'NATIVE_ISSUE_EVENT_REQUIRED');
 const second=await cursor.read();assert.equal(second.current.sequence,2);
 assert.notEqual(second.current.revisionHash,first.current.revisionHash);
 assert.equal(second.current.issue.scopeBody,'Owner revised requirements');
 assert.deepEqual(await oldStore.read(),before);
 assert.equal(f.gh.issues[issue.id].body,'Owner revised requirements');
 const done=await ownerWake(f,issue.id,await f.nativeHint(issue.id,'labeled'));
 assert.equal(done.status,'COMPLETE',JSON.stringify(done));
 assert.equal(f.gh.issues[issue.id].body,'Owner revised requirements');
 assert.equal(f.calls.filter(c=>c[0]==='shape').length,2);
});

test('live edits during Agent execution fence old publication and automatically replan latest requirements',async t=>{
 const f=await harness(t,{local:true,owner:true,live:true}),issue=f.grant.manifest.issues[0];
 const agent=f.runtime.agent,execute=agent.execute.bind(agent);let edited=false;
 agent.execute=async(...args)=>{const result=await execute(...args);if(!edited){edited=true;f.gh.issues[issue.id].body='Changed while Shape was running';}return result;};
 assert.equal((await ownerWake(f,issue.id)).code,'NATIVE_ISSUE_EVENT_REQUIRED');
 const record=await issueScopeStore(f.runtime,f.grant,issue).read();
 assert.equal(record.current.sequence,2);
 assert.equal(record.current.issue.scopeBody,'Changed while Shape was running');
 assert.equal(f.calls.filter(c=>c[0]==='shape').length,2);
 assert.equal(f.gh.issues[issue.id].body,'Changed while Shape was running');
});

test('returning to earlier Issue text starts a new generation rather than reusing old evidence',async t=>{
 const f=await harness(t,{local:true,owner:true,live:true}),issue=f.grant.manifest.issues[0];
 await ownerWake(f,issue.id);const first=await issueScopeStore(f.runtime,f.grant,issue).read();
 f.gh.issues[issue.id].body='B';await ownerWake(f,issue.id);
 f.gh.issues[issue.id].body=issue.scopeBody;await ownerWake(f,issue.id);
 const third=await issueScopeStore(f.runtime,f.grant,issue).read();
 assert.equal(third.current.sequence,3);assert.equal(third.current.issue.scopeHash,first.current.issue.scopeHash);
 assert.notEqual(third.current.revisionHash,first.current.revisionHash);
 assert.equal(f.calls.filter(c=>c[0]==='shape').length,3);
});

test('removing shaped resets an unchanged live Issue to a new Shape cycle',async t=>{
 const f=await harness(t,{local:true,owner:true,live:true}),issue=f.grant.manifest.issues[0];
 await ownerWake(f,issue.id);
 f.gh.issues[issue.id].labels=[{name:'scope'}];
 await ownerWake(f,issue.id);
 assert.equal((await issueScopeStore(f.runtime,f.grant,issue).read()).current.sequence,2);
 assert.equal(f.calls.filter(c=>c[0]==='shape').length,2);
});

test('live scope cannot replace the enrolled issue identity or retire an uncertain write',async t=>{
 const f=await harness(t,{local:true,owner:true,live:true}),issue=f.grant.manifest.issues[0];
 await ownerWake(f,issue.id);
 const run=await f.begin(),g=await run.runtime.grant();run.finish();
 const store=new Store(f.config.stateDirectory,unitId(g,g.manifest.issues[0])),s=await store.read();
 await store.transaction(s.revision,x=>({...x,pending:{operation:'merge',writeAttempted:true}}));
 f.gh.issues[issue.id].body='New requirements';
 await assert.rejects(ownerWake(f,issue.id),e=>e.code==='SCOPE_WRITE_RECONCILIATION_REQUIRED');
 f.gh.issues[issue.id].user.id=123;
 await assert.rejects(ownerWake(f,issue.id),e=>e.code==='ISSUE_SCOPE_IDENTITY_CHANGED');
 assert.equal((await issueScopeStore(f.runtime,f.grant,issue).read()).current.sequence,1);
});

test('a delivered label cannot release dependents after the producer Issue requirements change',async t=>{
 const f=await harness(t,{local:true,owner:true,live:true}),issue=f.grant.manifest.issues.find(i=>i.id==='I_B');
 await ownerWake(f,issue.id);
 assert.equal((await ownerWake(f,issue.id,await f.nativeHint(issue.id,'labeled'))).status,'COMPLETE');
 const run=await f.begin(),g=await run.runtime.grant();run.finish();
 const dependent=g.manifest.issues.find(i=>i.dependencies.includes(issue.id));assert.ok(dependent);
 await ready(run.runtime,g,dependent);
 f.gh.issues[issue.id].body='Changed after completion';
 await assert.rejects(ready(run.runtime,g,dependent),e=>e.code==='DEPENDENCY_WAIT');
});

test('historical labeled hint cannot start Deliver after a new Shape; a later verified hint can resume',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];
 const old=await f.nativeHint(issue.id,'labeled',{createdAt:'2026-10-23T12:31:23Z',issuedAt:Date.parse('2026-10-23T12:31:23Z')});
 assert.equal((await ownerWake(f,issue.id)).code,'NATIVE_ISSUE_EVENT_REQUIRED');
 const calls=f.calls.length,merges=f.gh.merges;
 assert.equal((await ownerWake(f,issue.id,old)).code,'NATIVE_ISSUE_EVENT_REQUIRED');
 assert.equal(f.calls.length,calls);assert.equal(f.gh.merges,merges);
 const store=new Store(f.config.stateDirectory,unitId(f.grant,issue)),held=await store.read();
 assert.deepEqual(held.actionReceipts.map(r=>r.operation),['shape','validate-shape','publish-shape']);
 assert.ok(held.actionReceipts.at(-1).transition.startedAt);
 const fresh=await f.nativeHint(issue.id,'labeled');
 assert.equal((await ownerWake(f,issue.id,fresh)).status,'COMPLETE');
 assert.equal(f.calls.filter(c=>c[0]==='deliver').length,1);assert.equal(f.gh.merges,1);
});

test('queued native stage is rechecked at execution; changed original Run time prevents every side effect',async t=>{
 const f=await harness(t,{local:true}),issue=f.grant.manifest.issues[0];
 for(let n=0;n<3;n++){const next=await f.reconcile(issue.id);assert.equal(next.status,'READY');await f.execute(next.requestId);}
 const ready=await f.reconcile(issue.id);assert.equal(ready.operation,'deliver');
 const item=await f.outbox.read(ready.requestId),sourceRunId=item.request.source.runId;
 f.runs.get(sourceRunId).run.created_at='2026-10-23T12:31:23Z';
 const calls=f.calls.length,merges=f.gh.merges,result=await f.execute(ready.requestId);
 assert.equal(result.code,'NATIVE_ISSUE_EVENT_REQUIRED');assert.equal(f.calls.length,calls);assert.equal(f.gh.merges,merges);
 const state=await new Store(f.config.stateDirectory,unitId(f.grant,issue)).read();
 assert.equal(state.actionReceipts.at(-1).operation,'publish-shape');assert.equal(state.pending,null);
});

test('reviewed recovery projection retains Candidate and existing PR while repeating independent Acceptance',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];
 for(let n=0;n<12;n++){
   const next=await f.reconcile(issue.id);assert.equal(next.status,'READY');await f.execute(next.requestId);
   if(next.operation==='commit-pr')break;
 }
 const store=new Store(f.config.stateDirectory,unitId(f.grant,issue)),before=await store.read(),v=before.issues[issue.id];
 assert.ok(v.prNumber);const pr=await f.gh.pull(issue.repository,v.prNumber),calls=f.calls.length;
 // Synthetic Operator projection of the proposed, separately authorized repair.
 // This test is not a production recovery entry point or permission to release a fence.
 await store.transaction(before.revision,s=>{
   s.runtimeRecoveryHistory=[{state:structuredClone(s),reason:'test-only approved Candidate adoption after fresh native verification'}];
   for(const field of ['accept','review','hookEvidence','preCommitHooks'])delete s.issues[issue.id][field];
   return s;
 });
 const result=await ownerWake(f,issue.id);assert.equal(result.status,'COMPLETE');
 const after=await store.read(),now=after.issues[issue.id];
 assert.equal(digest(now.candidate),digest(v.candidate));assert.equal(now.prNumber,v.prNumber);
 assert.equal((await f.gh.pull(issue.repository,v.prNumber)).head.sha,pr.head.sha);
 assert.notEqual(now.accept.executionId,v.accept.executionId);
 assert.equal(f.calls.slice(calls).filter(c=>c[0]==='deliver').length,0);
 assert.equal(f.calls.slice(calls).filter(c=>c[0]==='accept').length,1);
 assert.equal(Object.keys(f.gh.prs).length,1);
 assert.deepEqual(after.actionReceipts.slice(0,before.actionReceipts.length),before.actionReceipts);
 assert.equal(digest(after.runtimeRecoveryHistory[0].state),digest(before));
});

test('owner Issue session uses one Run through Shape publication and one through delivery, without empty hook stages or private handoffs',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];
 const run=await f.begin();
 const first=await runActionLifecycle(run.runtime,{inputs:{issue_id:issue.id}});run.finish();
 assert.deepEqual(first.handoffs,[]);assert.equal(first.results[0].code,'NATIVE_ISSUE_EVENT_REQUIRED');
 const store=new Store(f.config.stateDirectory,unitId(f.grant,issue));
 const shaped=await store.read();assert.deepEqual(shaped.actionReceipts.map(r=>r.operation),['shape','validate-shape','publish-shape']);
 assert.equal(new Set(shaped.actionReceipts.map(r=>r.action.runId)).size,1);
 const unauthorized=await ownerWake(f,issue.id);assert.equal(unauthorized.code,'NATIVE_ISSUE_EVENT_REQUIRED');
 const source={kind:'public-issue-event',repository:issue.repository,issueId:issue.id,runId:'native-shape',event:'issues',action:'labeled'};
 const final=await ownerWake(f,issue.id,source);assert.equal(final.status,'COMPLETE',JSON.stringify(final));
 const state=await store.read();assert.deepEqual(state.actionReceipts.map(r=>r.operation),['shape','validate-shape','publish-shape','deliver','accept','commit-pr','shaper-review','merge','close']);
 assert.equal(new Set(state.actionReceipts.map(r=>r.action.runId)).size,2);
 assert.equal(new Set(f.calls.map(c=>c[0])).size,5);
 assert.equal((await ownerWake(f,issue.id,source)).status,'DUPLICATE');
 assert.equal((await ownerWake(f,issue.id)).status,'COMPLETE');
 assert.equal((await store.read()).actionReceipts.length,state.actionReceipts.length);
 assert.equal(f.gh.merges,1);
});

test('owner budget yields after completed work and uses the durable outbox for fresh independent verification',async t=>{
 const f=await harness(t,{local:true,owner:true}),run=await f.begin();let delivered=false;
 run.runtime.ownerRunBudget={deadline:Date.now()+60000,shouldYield:operation=>delivered&&operation==='validate-shape'};
 const execute=f.runtime.agent.execute.bind(f.runtime.agent);f.runtime.agent.execute=async(...args)=>{const result=await execute(...args);delivered=true;return result;};
 const out=await runActionLifecycle(run.runtime,{inputs:{issue_id:'I_A'}});assert.equal(out.results[0].code,'OWNER_RUN_BUDGET_EXHAUSTED');assert.equal(out.handoffs.length,1);
 const request=await f.outbox.read(out.handoffs[0].requestId);assert.equal(request.request.operation,'validate-shape');assert.equal(request.request.predecessor.runId,run.runtime.actionIdentity.runId);
 const issue=f.grant.manifest.issues[0],state=await new Store(f.config.stateDirectory,unitId(f.grant,issue)).read();assert.equal(state.pending,null);assert(state.issues.I_A.shape);assert.equal(state.issues.I_A.shape.validation,undefined);
 const count=f.calls.length,duplicate=await runActionLifecycle(run.runtime,{inputs:{issue_id:'I_A'}});assert.equal(duplicate.handoffs.length,0);assert.equal(f.calls.length,count);
 run.finish();const next=await f.execute(out.handoffs[0].requestId);assert.equal(next.status,'STAGE_COMPLETE');assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1)[0],'shape-validator');
});

test('owner session yields to GitHub merge requirements and resumes on a fresh CI wakeup without repeating agents',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];
 await ownerWake(f,issue.id);
 const merge=f.gh.merge.bind(f.gh);f.gh.merge=async()=>{throw Object.assign(Error('CI pending'),{status:405});};
 const waiting=await ownerWake(f,issue.id,{kind:'public-issue-event',repository:issue.repository,issueId:issue.id,runId:'native-shaped',event:'issues',action:'labeled'});
 assert.equal(waiting.code,'MERGE_REQUIREMENTS_PENDING');assert.equal(f.gh.issues[issue.id].state,'open');
 const calls=f.calls.length;f.gh.merge=merge;
 const done=await ownerWake(f,issue.id,{kind:'public-issue-event',repository:issue.repository,issueId:null,runId:'native-ci',event:'workflow_run',action:'completed'});
 assert.equal(done.status,'COMPLETE');assert.equal(f.calls.length,calls);assert.equal(f.gh.merges,1);
});

test('native shaped wakeup arriving during publication is consumed after the writer releases its lease',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0],label=f.gh.label.bind(f.gh);
 f.gh.label=async(i,name)=>{
  await label(i,name);if(name!=='shaped')return;
  const source=await f.nativeHint(issue.id,'labeled');
  await assert.rejects(ownerWake(f,issue.id,source),{code:'EEXIST'});
 };
 const result=await ownerWake(f,issue.id);assert.equal(result.status,'COMPLETE');assert.equal(f.gh.merges,1);
});

for(const lost of ['close','label']) test('owner session resumes an interrupted '+lost+' without replaying agents or completed writes',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];await ownerWake(f,issue.id);
 const close=f.gh.updateIssue.bind(f.gh),label=f.gh.label.bind(f.gh);let closes=0,labels=0;
 f.gh.updateIssue=async(i,p)=>{await close(i,p);if(p.state==='closed'){closes++;if(lost==='close')throw Error('close response lost');}};
 f.gh.label=async(i,l)=>{await label(i,l);if(l==='delivered'){labels++;if(lost==='label')throw Error('label response lost');}};
 await assert.rejects(ownerWake(f,issue.id,{kind:'public-issue-event',repository:issue.repository,issueId:issue.id,runId:'native-shaped',event:'issues',action:'labeled'}),/response lost/);
 const calls=f.calls.length;
 assert.equal((await ownerWake(f,issue.id)).status,'COMPLETE');assert.equal(f.calls.length,calls);assert.equal(closes,1);assert.equal(labels,1);
});

test('owner dependency inspection reads only this Issue and its actual prerequisites',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0],dependencies=f.gh.dependencies.bind(f.gh);
 f.gh.dependencies=async i=>{assert.equal(i.id,issue.id,'Independent A must not scan unrelated Issues');return dependencies(i);};
 assert.equal((await ownerWake(f,issue.id)).code,'NATIVE_ISSUE_EVENT_REQUIRED');
});

test('owner Issue session rejects a corrupted Completion certificate on a fresh reconciliation',async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];await ownerWake(f,issue.id);
 await ownerWake(f,issue.id,{kind:'public-issue-event',repository:issue.repository,issueId:issue.id,runId:'native-shaped',event:'issues',action:'labeled'});
 const store=new Store(f.config.stateDirectory,unitId(f.grant,issue));let state=await store.read();
 await store.transaction(state.revision,s=>{s.completion.receiptHash='f'.repeat(64);return s;});
 await assert.rejects(ownerWake(f,issue.id),{code:'COMPLETION_UNVERIFIED'});
 state=await store.read();await store.transaction(state.revision,s=>{s.completion.receiptHash=digest(s.actionReceipts.at(-1));s.completion.completionHash='f'.repeat(64);return s;});
 await assert.rejects(ownerWake(f,issue.id),{code:'COMPLETION_UNVERIFIED'});
});

test('owner session releases capacity to a waiting authorized Issue without another private dispatch',{timeout:15000},async t=>{
 const f=await harness(t,{local:true,owner:true});f.grant.policy.maxParallel=1;
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),execute=f.runtime.agent.execute;
 f.runtime.agent.execute=async(stage,context,...args)=>{if(stage==='shape'&&context.issue.id==='I_A'){entered();await gate;}return execute(stage,context,...args);};
 const a=await f.begin(),b=await f.begin();
 const first=runActionLifecycle(a.runtime,{inputs:{issue_id:'I_A'}});await started;
 const waiting=await runActionLifecycle(b.runtime,{inputs:{issue_id:'I_B'}});assert.equal(waiting.results[0].code,'ACTIONS_CAPACITY_BUSY');
 release();const done=await first;a.finish();b.finish();assert.deepEqual(done.handoffs,[]);
 const issue=f.grant.manifest.issues.find(i=>i.id==='I_B'),state=await new Store(f.config.stateDirectory,unitId(f.grant,issue)).read();assert.ok(state.issues.I_B.shape.publication);
});

test('two owner Issues wait inside their Runs for a shared repository publication lease',{timeout:15000},async t=>{
 const f=await harness(t,{local:true,owner:true}),[a,b]=f.grant.manifest.issues;
 // Both Issues in one repository, while retaining their distinct native IDs.
 b.repository=a.repository;b.repositoryId=a.repositoryId;
 f.grant.policy.manifestHash=digest(f.grant.manifest);
 const original=f.gh.repository.bind(f.gh);f.gh.repository=async r=>r===a.repository?{...await original(r),id:Number(a.repositoryId)}:original(r);
 let entered,release;const held=new Promise(r=>entered=r),gate=new Promise(r=>release=r),update=f.gh.updateIssue.bind(f.gh);
 f.gh.updateIssue=async(i,p)=>{if(i.id===a.id&&p.body){entered();await gate;}return update(i,p);};
 const first=ownerWake(f,a.id);await held;
 let settled=false;const second=ownerWake(f,b.id).finally(()=>settled=true);
 await new Promise(r=>setTimeout(r,250));assert.equal(settled,false,'B must wait for A rather than drop its intent');release();
 for(const result of await Promise.all([first,second]))assert.equal(result.code,'NATIVE_ISSUE_EVENT_REQUIRED');
 for(const issue of [a,b]){const state=await new Store(f.config.stateDirectory,unitId(f.grant,issue)).read();assert.equal(state.pending,null);assert.ok(state.issues[issue.id].shape.publication);assert.equal(state.lastError,undefined);}
});

for(const outcome of ['blocked','decision_required']) test('owner CI completion '+(outcome==='blocked'?'resumes original review after temporary CI wait':'cannot waive an Owner decision'),async t=>{
 const f=await harness(t,{local:true,owner:true}),issue=f.grant.manifest.issues[0];await ownerWake(f,issue.id);
 let ready=false,reviews=0;const checks=f.gh.checks.bind(f.gh),execute=f.runtime.agent.execute;
 f.gh.checks=async(...args)=>(await checks(...args)).map(c=>({...c,status:ready?'completed':'queued',conclusion:ready?'success':null}));
 f.runtime.agent.execute=async(stage,context,...args)=>{
  if(stage==='shaper-review'){
   reviews++;assert.equal(context.repositoryControls.ciMode,'github-repository');
   if(!ready){const result=await execute(stage,context,...args);result.result={...result.result,outcome,failureClass:outcome==='blocked'?'external_failure':'authority_gap',summary:'CI pending; independent implementation review has no defect findings.'};return result;}
  }
  return execute(stage,context,...args);
 };
 const first=await ownerWake(f,issue.id,{kind:'public-issue-event',repository:issue.repository,issueId:issue.id,runId:'native-shaped',event:'issues',action:'labeled'});assert.equal(first.status,'BLOCKED');assert.equal(reviews,1);
 const deliver=f.calls.filter(c=>c[0]==='deliver').length;ready=true;
 const result=await ownerWake(f,issue.id,{kind:'public-issue-event',repository:issue.repository,issueId:null,runId:'native-ci-complete',event:'workflow_run',action:'completed'});
 assert.equal(result.status,outcome==='blocked'?'COMPLETE':'BLOCKED');assert.equal(reviews,outcome==='blocked'?2:1);assert.equal(f.calls.filter(c=>c[0]==='deliver').length,deliver);
});
