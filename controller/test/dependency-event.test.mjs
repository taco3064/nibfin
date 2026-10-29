import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyWebhookSecret, relayDependencyEvent } from '../src/dependency-event.mjs';
import { createActionRelayServer } from '../src/action-relay.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kairo-dependency-')); t.after(() => rm(root, { recursive: true }));
  const entry = { secret: 'aa'.repeat(32), binding: { repository: 'owner/repo', repositoryId: '1', ownerId: '7' } };
  const payload = { action: 'blocked_by_removed', repository: { full_name: 'owner/repo', id: 1, owner: { id: 7 } }, sender: { id: 7 }, blocked_issue: { number: 4, node_id: 'I_D' } };
  let writes = 0, lost = false;
  const context = { entry, stateDirectory: root, execution: { repository: 'taco3064/kairo', workflowPath: '.github/workflows/action-stage.yml', ref: 'main' }, github: { api: async (path,method,body) => {
    if (method === 'POST') { writes++; assert.deepEqual(body.inputs, { issue_id: 'I_D',issue_ref:'repo#4' }); if (lost) throw Error('response lost'); return {}; }
    if (path === '/user') return { id: 7, type: 'User' };
    return { node_id: 'I_D', user: { id: 7 }, labels:[{name:'scope'}] };
  } } };
  const signed = (p = payload) => { const bytes = Buffer.from(JSON.stringify(p)); return { bytes, headers: { 'x-github-event': 'issue_dependencies', 'x-github-delivery': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', dependencyWebhookSecret(entry)).update(bytes).digest('hex') } }; };
  return { context, payload, signed, writes: () => writes, lose: () => { lost = true; } };
}
test('dependency webhook endpoint verifies signature and dispatches only changed Issue once', async t => {
  const f = await fixture(t), server = createActionRelayServer(async repo => repo === 'owner/repo' ? f.context : null);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/dependency-event', s = f.signed();
  for (let n=0;n<2;n++) { const response = await fetch(url, { method:'POST', headers:s.headers, body:s.bytes }); assert.equal(response.status,202); assert.equal((await response.json()).status,n?'DUPLICATE':'DISPATCH_ACCEPTED'); }
  assert.equal(f.writes(),1);
});
test('tampered signatures, foreign senders, wrong issues and unknown activities create no dispatch', async t => {
  const f = await fixture(t), s=f.signed();
  await assert.rejects(relayDependencyEvent(f.context,Buffer.from('{}'),s.headers),{code:'DEPENDENCY_EVENT_INVALID'});
  for (const patch of [{ sender:{id:8} }, { action:'edited' }, { blocked_issue:{number:4,node_id:'I_OTHER'} }, { repository:{id:2,full_name:'owner/repo',owner:{id:7}} }]) {
    const x=f.signed({...f.payload,...patch});await assert.rejects(relayDependencyEvent(f.context,x.bytes,x.headers),{code:'DEPENDENCY_EVENT_INVALID'});
  }
  assert.equal(f.writes(),0);
});
test('lost webhook dispatch response remains waiting and is never sent again', async t => {
  const f=await fixture(t),s=f.signed();f.lose();await assert.rejects(relayDependencyEvent(f.context,s.bytes,s.headers),/response lost/);
  assert.equal((await relayDependencyEvent(f.context,s.bytes,s.headers)).status,'WAITING');assert.equal(f.writes(),1);
});

test('owner Issue without scope is ignored before dispatch, including dependency additions',async t=>{
 const f=await fixture(t),api=f.context.github.api;
 f.context.github.api=async(path,...args)=>path.endsWith('/issues/4')?{node_id:'I_D',user:{id:7},labels:[]}:api(path,...args);
 for(const action of ['blocked_by_added','blocked_by_removed']){
  const s=f.signed({...f.payload,action});
  assert.equal((await relayDependencyEvent(f.context,s.bytes,s.headers)).status,'IGNORED_NOT_SCOPE');
 }
 assert.equal(f.writes(),0);
});

test('signed ping and opposite-side notifications do not schedule duplicate work',async t=>{
 const f=await fixture(t);let s=f.signed();s.headers['x-github-event']='ping';assert.equal((await relayDependencyEvent(f.context,s.bytes,s.headers)).status,'VERIFIED_PING');
 for(const action of ['blocking_added','blocking_removed']){s=f.signed({...f.payload,action});assert.equal((await relayDependencyEvent(f.context,s.bytes,s.headers)).status,'IGNORED_BLOCKING_SIDE');}
 assert.equal(f.writes(),0);
});
