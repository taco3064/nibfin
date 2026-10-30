import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionOutbox } from '../src/action-outbox.mjs';
import {issueReference,actionRunTitle} from '../src/action-display.mjs';

test('private dispatch and old durable intents show repository and Issue while preserving exact request identity',async t=>{
 const root=await mkdtemp(join(tmpdir(),'nibfin-display-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const execution={repository:'owner/core',repositoryId:'1',workflowPath:'.github/workflows/stage.yml',ref:'main',actorIds:['7']},issues=[{id:'I_A',repository:'owner/gh-nibfin',number:55}];
 const calls=[],published=[],github={api:async(_p,_m,body)=>{calls.push(body);},list:async()=>published};
 const old=new ActionOutbox(root,github,execution),request={issueId:'I_A',repository:'owner/gh-nibfin',sourceReceipt:'verified'};
 const id=await old.enqueue(request),box=new ActionOutbox(root,github,execution,issues);
 assert.equal((await box.dispatch(id)).status,'WAITING');assert.deepEqual(calls[0].inputs,{request_id:id,issue_ref:'gh-nibfin#55'});
 published.push({id:123,display_title:actionRunTitle('gh-nibfin#55',id),path:execution.workflowPath,repository:{id:1},actor:{id:7}});
 assert.equal((await box.dispatch(id)).runId,'123');assert.equal(calls.length,1);assert.deepEqual((await box.read(id)).request,request);
 assert.equal(box.handoff(id,await box.read(id)).issueRef,'gh-nibfin#55');
 published[0].display_title=actionRunTitle('other#99',id);assert.equal((await box.dispatch(id)).status,'WAITING');
 assert.equal(issueReference({repository:'owner/nibfin-action',number:17}),'nibfin-action#17');assert.equal(issueReference({repository:'owner/nibfin',number:0}),undefined);
});

test('lost dispatch response persists intent and reconciles without sending twice across restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-outbox-')); t.after(() => rm(root, { recursive: true }));
  const execution = { repository: 'owner/core', repositoryId: '1', workflowPath: '.github/workflows/stage.yml', ref: 'main', actorIds: ['7'] };
  let writes = 0, published = [];
  const gh = { api: async () => { writes++; throw new Error('response lost'); }, list: async () => published };
  const outbox = new ActionOutbox(root, gh, execution);
  const request = { issueId: 'I_A', sourceReceipt: 'verified-hash', stage: 'shape' };
  const id = await outbox.enqueue(request); assert.equal(await outbox.enqueue(request), id);
  await assert.rejects(outbox.dispatch(id), /response lost/);
  assert.equal((await outbox.dispatch(id)).code, 'DISPATCH_READBACK_PENDING');
  published = [{ id: 123, display_title: `upstream ${id}`, path: execution.workflowPath, repository: { id: 1 }, actor: { id: 7 } }];
  const restarted = new ActionOutbox(root, gh, execution);
  assert.equal((await restarted.dispatch(id)).runId, '123'); assert.equal(writes, 1);
  assert.deepEqual((await restarted.read(id)).request, request);
  published.push({ ...published[0], id: 124 });
  await assert.rejects(restarted.dispatch(id), { code: 'AMBIGUOUS_DISPATCH' }); assert.equal(writes, 1);
});

test('different event Runs share one stage handoff, including restart; changed work remains new', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-dedup-')); t.after(() => rm(root, { recursive: true }));
  const execution = { repositoryId: '1', repository: 'owner/core', workflowPath: 'stage.yml', ref: 'main' };
  const request = { schemaVersion: 1, authority: { revision: 1 }, repository: 'owner/repo', issueId: 'A', operation: 'shaper-review', basis: 'basis', artifacts: { head: 'head' }, source: { runId: '1' }, predecessor: { runId: '10' } };
  const box = new ActionOutbox(root, {}, execution), first = await box.enqueue(request);
  assert.ok(await box.prepareHandoff(first));
  const restarted = new ActionOutbox(root, {}, execution);
  for (let n = 2; n <= 4; n++) {
    const id = await restarted.enqueue({ ...request, source: { runId: String(n) }, predecessor: { runId: String(n*10) } });
    assert.equal(id, first); assert.equal(await restarted.prepareHandoff(id), null);
  }
  assert.deepEqual((await restarted.read(first)).request, request);
  for (const patch of [{ issueId: 'B' }, { basis: 'new' }, { artifacts: { head: 'new' } }, { authority: { revision: 2 } }])
    assert.notEqual(await restarted.enqueue({ ...request, ...patch }), first);
});

test('explicit dependency wait can be woken by a fresh event without retrying ambiguous dispatches', async t => {
  const root=await mkdtemp(join(tmpdir(),'nibfin-wait-'));t.after(()=>rm(root,{recursive:true}));
  const box=new ActionOutbox(root,{}, {repositoryId:'1',repository:'owner/core',workflowPath:'stage.yml',ref:'main'});
  const r={schemaVersion:1,authority:{revision:1},repository:'owner/repo',issueId:'C',operation:'shape',basis:'b',artifacts:{},source:{runId:'1'}};
  const id=await box.enqueue(r);await box.prepareHandoff(id);
  assert.equal(await box.prepareHandoff(await box.enqueue({...r,source:{runId:'2'}})),null);
  await box.deferDependency(id,{prerequisiteId:'B',code:'CI_PENDING'});
  const resumed=await box.enqueue({...r,source:{runId:'3'}});assert.notEqual(resumed,id);assert.ok(await box.prepareHandoff(resumed));
});

test('same-repository mutations queue durably while independent work runs; completion releases exactly one',async t=>{
 const root=await mkdtemp(join(tmpdir(),'nibfin-write-queue-'));t.after(()=>rm(root,{recursive:true}));
 const ex={repositoryId:'1',repository:'owner/core',workflowPath:'stage.yml',ref:'main'};
 const box=new ActionOutbox(root,{},ex),other=new ActionOutbox(root,{},ex);
 const base={schemaVersion:1,authority:{revision:1},repository:'owner/repo',operation:'publish-shape',basis:'b',artifacts:{}};
 const a=await box.enqueue({...base,issueId:'A'}),b=await box.enqueue({...base,issueId:'B'});
 const h=await Promise.all([box.prepareHandoff(a),other.prepareHandoff(b)]);
 assert.ok(h[0]);assert.equal(h[1],null);
 const read=await box.enqueue({...base,issueId:'C',operation:'accept'});assert.ok(await other.prepareHandoff(read));
 const foreign=await box.enqueue({...base,repository:'owner/other',issueId:'D'});assert.ok(await other.prepareHandoff(foreign));
 const restarted=new ActionOutbox(root,{},ex);
 assert.deepEqual(await restarted.drainWrites(),[]); // ambiguous/in-flight writer is never bypassed
 await restarted.finish(a,'STAGE_COMPLETE');
 const drained=await Promise.all([box.drainWrites(),other.drainWrites()]);
 assert.deepEqual(drained.flat().map(x=>x.requestId),[b]);
 await restarted.finish(a,'DUPLICATE');assert.deepEqual(await restarted.drainWrites(),[]);
});
