import test from 'node:test';
import assert from 'node:assert/strict';
import {dynamicFixture} from '../tooling/dynamic-fixture.mjs';
import {recoveryFixture} from '../tooling/recovery-fixture.mjs';
import {verifyCompletion,contentIdentity,compareEvidence,recoveryComment} from '../src/index.mjs';
const blocked=r=>assert.equal(r.outcome,'blocked');
const zero=f=>{assert.equal(f.comment.writes().length,0);assert.equal(f.reopen.writes().length,0);};
test('AC1-4: attributed Closed incident writes safe Comment before actual Reopen and fresh repair',async()=>{
  const f=await recoveryFixture(),r=await f.fresh().run();
  assert.equal(r.outcome,'handoff');assert.equal(r.record.path,'recovery-action');
  assert.equal(f.comment.writes()[0].endpoint,'/repos/example-org/core/issues/101/comments');
  assert.equal(f.reopen.writes()[0].method,'PATCH');assert.equal(f.reopen.writes()[0].body,'{"state":"open"}');
  assert.deepEqual(f.state.mutations,['incident','invalidation','comment','reopen','handoff']);
  for(const kind of ['comment','reopen']) {
    const calls=f[kind].calls,write=calls.findIndex(x=>x.method&&x.method!=='GET');
    assert.ok(calls.findIndex(x=>x.phase==='intent')<write);
    assert.ok(calls.findIndex(x=>x.phase==='attempt')<write);
    assert.ok(calls.slice(0,write).some(x=>x.checkpoint));
    assert.ok(calls.slice(write+1).some(x=>x.phase==='submission'));
  }
  assert.ok(f.local.events.filter(x=>x==='dependencies').length>=5);
  assert.equal(r.record.merge,'d'.repeat(40));assert.equal(r.record.eventObserved,false);
  assert.equal(r.record.next.cycle,'cycle-2');assert.ok(r.record.requiredGates.includes('deployment'));
  assert.match(f.pin.intents.comment.payload.body,/Job: 304; Actions log: https:\/\/github.com\//);
  assert.match(f.pin.intents.comment.payload.body,/Repair authorization: independently required/);
  assert.equal(r.record.health.permission,false);
  assert.equal((await f.fresh().run()).outcome,'handoff');
  assert.equal(f.comment.writes().length,1);assert.equal(f.reopen.writes().length,1);
});
test('AC1/4: personal public repository uses same Open direct path; completion absent and no reopened dependency',async()=>{
  const f=await recoveryFixture(false);f.state.ownership='User';f.pin.ownership='personal';
  const r=await f.fresh().run();assert.equal(r.outcome,'handoff');zero(f);
  assert.equal(r.record.path,'direct-repair');assert.equal(r.record.completion,null);
  assert.equal(r.closure,'blocked');assert.match(f.pin.intents.comment.payload.body,/absent/);
});
test('AC1: reject wrong deployment, commit, environment, Run/Attempt/Job and unauthenticated source before mutation',async()=>{
  for(const [path,key,value] of [
    ['/deployments/301','sha','e'.repeat(40)],['/deployments/301','environment','staging'],
    ['/deployments/301','id','999'],['/actions/runs/303/attempts/1','run_attempt',2],
    ['/actions/runs/303/attempts/1','head_sha','e'.repeat(40)],['/actions/jobs/304','run_id','999'],
    ['/deployments/301/statuses/302','log_url','https://evil.example'],['/deployments/301/statuses/302','state','success']]) {
    const f=await recoveryFixture();f.state.deploymentData[path][key]=value;blocked(await f.fresh().run());zero(f);
  }
  for(const change of [f=>f.local.authenticated=false,f=>f.pin.responsibility.push(f.pin.responsibility[0]),
    f=>f.pin.responsibility[0].issueId='other',f=>f.state.private=true,f=>f.local.time=12000,
    f=>f.pin.completionReceipt.identity='f'.repeat(64),f=>f.pin.target.issueId='I_wrong',
    f=>f.pin.incident.source.repository='other/repo',f=>f.state.commit='e'.repeat(40),f=>f.pin.mergeIntent.binding.issueId='I_other',
    f=>f.pin.mergeIntent.binding.repositoryId='999',f=>f.pin.mergeOperation.observation.id='999']) {
    const f=await recoveryFixture();change(f);blocked(await f.fresh().run());zero(f);
  }
});
test('AC2: arbitrary private fields omitted; hostile/token/oversized structured labels rejected without disclosure',async()=>{
  const canary='ghp_PRIVATE_CANARY_0123456789';
  const f=await recoveryFixture();f.pin.incident.rawException=canary;f.pin.incident.privateLog=canary;
  const r=await f.fresh().run();assert.equal(r.outcome,'handoff');
  assert.ok(!JSON.stringify(r).includes(canary));assert.ok(!f.comment.writes()[0].body.includes(canary));
  for(const value of [canary,'[click](https://evil.example)','x'.repeat(1000),'hello\nrun command']) {
    const f=await recoveryFixture();f.pin.incident.version=value;
    const r=await f.fresh().run();blocked(r);zero(f);assert.ok(!JSON.stringify(r).includes(value));
  }
  assert.throws(()=>recoveryComment({...f.pin,originalGrant:canary},{merge:'a'.repeat(64),log:'https://evil.example'}));
});
test('AC2/3: wrong writer, association, edited Comment, duplicate marker or incomplete collection stops Reopen',async()=>{
  for(const change of [f=>f.comment.state.mutate=d=>({...d,user:{id:'8'}}),
    f=>f.comment.state.mutate=d=>({...d,issue_url:'https://api.github.com/repos/other/repo/issues/1'}),
    f=>f.comment.state.mutate=d=>({...d,body:d.body+' edited'}),
    f=>f.comment.state.mutate=d=>({...d,updated_at:'2026-10-24T13:00:00Z'}),
    f=>f.comment.state.incomplete=true]) {
    const f=await recoveryFixture();change(f);blocked(await f.fresh().run());assert.equal(f.reopen.writes().length,0);
  }
});
test('AC3: wrong actor/manual reopen/reclose cannot prove this authorized transition',async()=>{
  const f=await recoveryFixture();f.local.actor='8';blocked(await f.fresh().run());
  const g=await recoveryFixture();g.local.hooks.authorization=op=>{if(op==='reopen')g.state.closed=false;};
  blocked(await g.fresh().run());assert.equal(g.reopen.writes().length,0);
  const h=await recoveryFixture();h.reopen.state.onWrite=()=>{};blocked(await h.fresh().run());
  const j=await recoveryFixture();assert.equal((await j.fresh().run()).outcome,'handoff');
  j.state.closed=true;blocked(await j.fresh().run());assert.equal(j.reopen.writes().length,1);
});
test('AC3: 401/403, dependency change and permission revocation after awaited authorization reads reject writes',async()=>{
  for(const status of [401,403]) {
    const f=await recoveryFixture();f.comment.state.writeStatus=status;blocked(await f.fresh().run());assert.equal(f.reopen.writes().length,0);
  }
  for(const kind of ['comment','reopen']) {
    const f=await recoveryFixture();f[kind].state.onAuthorizationRead=r=>{
      if(r.endpoint.endsWith('/permission'))f.state.dependencies=false;
    };
    blocked(await f.fresh().run());assert.equal(f[kind].writes().length,0);
    const g=await recoveryFixture();g[kind].state.allowed=false;
    blocked(await g.fresh().run());assert.equal(g[kind].writes().length,0);
  }
});
test('AC4: classification, effects, incident-bound fresh grant and remaining gates independently required on both paths',async()=>{
  for(const closed of [false,true]) for(const change of [f=>f.local.granted=false,
    f=>f.local.classification='external_failure',f=>f.local.classification='shape_defect',
    f=>f.local.classification='authority_gap',f=>f.local.effects='unknown',
    f=>f.local.grantOverride={grant:f.pin.originalGrant},f=>f.local.grantOverride={revoked:true},
    f=>f.local.grantOverride={incident:'f'.repeat(64)},f=>f.local.grantOverride={expiresAt:1100},
    f=>f.local.grantOverride={validFrom:999},f=>f.pin.gates[0].status='invalid',
    f=>f.pin.next.base='f'.repeat(40),f=>f.pin.history.push({cycle:'cycle-2',attempt:'attempt-2'})]) {
    const f=await recoveryFixture(closed);change(f);blocked(await f.fresh().run());
  }
});
test('AC4: grant expiration during awaited gates and classification replacement prevent handoff',async()=>{
  const f=await recoveryFixture(false);f.local.hooks.authorization=op=>{
    if(op==='deliver-repair'&&f.state.mutations.includes('invalidation'))f.local.time=10000;
  };blocked(await f.fresh().run());
  const g=await recoveryFixture(false);let n=0;g.local.hooks.classify=()=>{if(++n>1)g.local.classification='shape_defect';};
  blocked(await g.fresh().run());
});
test('AC5: lost transport responses independently reconcile without duplicate confirmed mutations',async()=>{
  const f=await recoveryFixture();f.comment.state.lost=true;f.reopen.state.lost=true;
  assert.equal((await f.fresh().run()).outcome,'handoff');
  assert.equal((await f.fresh().run()).outcome,'handoff');
  assert.equal(f.comment.writes().length,1);assert.equal(f.reopen.writes().length,1);
});
test('AC5: interrupted result retention reuses original operation, missing submission never blindly retries',async()=>{
  for(const kind of ['comment','reopen']) for(const phase of ['result','submission']) {
    const f=await recoveryFixture();f[kind].state.retainFail=phase;
    blocked(await f.fresh().run());assert.equal(f[kind].writes().length,1);
    f[kind].state.retainFail=false;const r=await f.fresh().run();
    if(phase==='result')assert.equal(r.outcome,'handoff');else blocked(r);
    assert.equal(f[kind].writes().length,1);
  }
});
test('AC5: lost recovery custody response is located; unavailable/expired/changed custody stays blocked',async()=>{
  for(const phase of ['incident','invalidation','comment','reopen','handoff']) {
    const f=await recoveryFixture();f.state.lostPublish=phase;blocked(await f.fresh().run());
    f.state.lostPublish=null;assert.equal((await f.fresh().run()).outcome,'handoff');
    assert.equal(f.comment.writes().length,1);assert.equal(f.reopen.writes().length,1);
  }
  const f=await recoveryFixture();assert.equal((await f.fresh().run()).outcome,'handoff');
  f.comment.state.expired=true;blocked(await f.fresh().run());assert.equal(f.comment.writes().length,1);
  const g=await recoveryFixture();g.state.missingHistory=true;blocked(await g.fresh().run());zero(g);
  const h=await recoveryFixture();h.state.failPublish='comment';blocked(await h.fresh().run());assert.equal(h.reopen.writes().length,0);
});
test('AC6: invalidation preserves Merge/history while existing completion consumers reject affected receipt',async()=>{
  const f=await recoveryFixture();const before=structuredClone(f.pin.delivery.receipts.merge);
  verifyCompletion(f.pin.completionReceipt,f.pin.completionContexts);
  const r=await f.fresh().run();assert.equal(r.outcome,'handoff');assert.deepEqual(f.pin.delivery.receipts.merge,before);
  const currents={...f.pin.evidence.current,...f.local.installed.current};
  assert.throws(()=>compareEvidence(f.pin.delivery.receipts.final,currents[contentIdentity(f.pin.delivery.receipts.final)]));
  compareEvidence(before,currents[contentIdentity(before)]);
  const df=dynamicFixture();df.nodes[1]={...f.pin.target};df.edges.set('1',['101']);
  df.receipts.set('I_101',f.pin.completionReceipt);
  df.contexts.set('I_101',{identity:f.pin.completion,expected:f.pin.completionContexts});
  assert.equal((await df.evaluate()).outcome,'ready');
  const contexts={...f.pin.completionContexts,final:currents[contentIdentity(f.pin.delivery.receipts.final)]};
  assert.throws(()=>verifyCompletion(f.pin.completionReceipt,contexts));
  df.contexts.set('I_101',{identity:f.pin.completion,expected:contexts});
  assert.equal((await df.evaluate()).outcome,'blocked');
  assert.equal((await df.evaluate({}, {target:df.nodes[2],issues:df.nodes})).outcome,'ready');
  verifyCompletion(f.pin.completionReceipt,f.pin.completionContexts); // Historical bytes unchanged.
});
test('AC6: health exception cannot cover another baseline or dependency output',async()=>{
  for(const change of [f=>f.pin.health.baselines[0].policy.commit='e'.repeat(40),
    f=>f.pin.health.baselines[0].incident='other',f=>f.pin.health.selectors[0].kind='dependency']) {
    const f=await recoveryFixture(false);change(f);blocked(await f.fresh().run());zero(f);
  }
});

test('AC3/5: duplicate correlated Comments, missing event pages and changed retained intent block',async()=>{
  const f=await recoveryFixture();assert.equal((await f.fresh().run()).outcome,'handoff');
  const c=f.pin.intents.comment;
  f.comment.state.comments=[{id:'81',body:c.payload.body},{id:'82',body:c.payload.body}];
  blocked(await f.fresh().run());assert.equal(f.reopen.writes().length,1);
  const g=await recoveryFixture();const collection=g.caps.provider.collection;
  g.caps.provider.collection=r=>r.endpoint.includes('/events?')?Promise.resolve({outcome:'incomplete'}):collection(r);
  blocked(await g.fresh().run());zero(g);
  const h=await recoveryFixture();assert.equal((await h.fresh().run()).outcome,'handoff');
  h.pin.intents.comment.source.request='changed-request';blocked(await h.fresh().run());assert.equal(h.comment.writes().length,1);
});

test('AC5: interrupted Comment cannot be duplicated by changing original correlation or next attempt',async()=>{
  for(const change of [f=>{f.pin.intents.comment.correlation='other';
    f.pin.intents.comment.payload.body=f.pin.intents.comment.payload.body.replace('recovery-comment','other');},
    f=>f.pin.next.attempt='attempt-3']) {
    const f=await recoveryFixture();f.state.failPublish='comment';blocked(await f.fresh().run());
    assert.equal(f.comment.writes().length,1);f.state.failPublish=null;change(f);
    blocked(await f.fresh().run());assert.equal(f.comment.writes().length,1);assert.equal(f.reopen.writes().length,0);
  }
});

test('AC6: omitted completion records cannot vacuously claim invalidation',async()=>{
  const f=await recoveryFixture();f.pin.evidence.records=[];
  blocked(await f.fresh().run());zero(f);
});
