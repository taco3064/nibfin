import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {fanoutFixture} from '../tooling/fanout-fixture.mjs';
import {completionFixture} from '../tooling/completion-fixture.mjs';
import {controlledIntent,canonicalJSON,resolveFanoutWakeup} from '../src/index.mjs';
const wake=f=>f.fresh().wake(f.input);
const success=r=>assert.deepEqual(r.outcomes.map(o=>o.outcome),['confirmed-success','confirmed-success']);

test('AC1 first producer completion/readback and recovered receipt feed fanout',async()=>{
  const producer=await completionFixture();
  assert.equal((await producer.fresh().close()).outcome,'closed');
  assert.equal(producer.state.history.has('receipt'),false);
  const first=await producer.fresh().complete();assert.equal(first.outcome,'completed');
  const retry=await producer.fresh().complete();assert.equal(retry.reused,true);
  const f=fanoutFixture();
  // Exercise the actual producer receipt and independent producer stage expectations.
  f.b.repository='example-org/core';f.b.repositoryId='42';f.b.issueId='I_101';f.b.databaseId='61';
  f.completions.set(f.b.issueId,first.receipt);f.contexts.set(f.b.issueId,structuredClone({...producer.pin.contexts,...producer.state.stageExpectations}));
  f.c.repository='example-org/recipient';f.c.repositoryId='45';
  // Source and C now share a repository but retain distinct stable node IDs.
  f.input.issues=f.input.issues.filter(n=>n.issueId!=='I_Z');
  const r=await wake(f);success(r);assert.equal(f.writes().length,2);
  f.completions.set(f.b.issueId,retry.receipt);success(await wake(f));assert.equal(f.writes().length,2);
});

test('AC1 missing, partial, forged and stale evidence never discovers or posts',async()=>{
  const changes=[f=>f.completions.delete(f.b.issueId),f=>{f.state.bytes=Buffer.from('{');},
    f=>{f.state.bytes=Buffer.from(JSON.stringify({delivered:true}));},
    ...['publication','accept','final','closure','delivered'].map(stage=>f=>{delete f.completions.get(f.b.issueId).payload.receipts[stage];}),
    ...['scopeHash','shapeHash','grant'].map(k=>f=>{f.contexts.get(f.b.issueId).accept.expected.binding[k]='f'.repeat(64);}),
    f=>{f.completions.get(f.b.issueId).identity='f'.repeat(64);},
    f=>{f.contexts.get(f.b.issueId).final.expected.result={outcome:'failed'};}];
  for(const change of changes){const f=fanoutFixture();change(f);assert.equal((await wake(f)).outcome,'blocked');assert.equal(f.writes().length,0);assert.equal(f.calls.length,0);}
});

test('AC2/3/5 exact C/D public destination transport, source identity distinct, no A/Z/catalog fanout',async()=>{
  const f=fanoutFixture();success(await wake(f));assert.equal(f.writes().length,2);
  const requests=[...f.requests.values()];
  for(const [i,r] of requests.entries()) {
    const target=[f.c,f.d][i],post=f.writes()[i];
    assert.equal(post.endpoint,`/repos/${target.repository}/actions/workflows/50/dispatches`);
    assert.deepEqual(JSON.parse(post.body),{ref:'main',inputs:{nibfin_request:r.id,nibfin_correlation:r.id,nibfin_issue:target.number,nibfin_stage:'resolve'}});
    assert.equal(r.intent.source.repositoryId,f.b.repositoryId);assert.equal(r.intent.binding.repositoryId,target.repositoryId);
    assert.notEqual(r.intent.source.runId,r.intent.binding.runId);
    assert.equal(r.origin.identity,f.completions.get(f.b.issueId).identity);
    assert.equal((await f.consumer(r,target)).outcome,target===f.c?'waiting':'ready');
  }
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.ok(f.writes().every(c=>c.method==='POST'));
  const empty=fanoutFixture();empty.state.discovery=[];assert.deepEqual((await wake(empty)).outcomes,[]);assert.equal(empty.writes().length,0);
});

test('AC2/3 denied C never suppresses D; private, unlisted, identity and current edge checks',async()=>{
  const changes=[f=>f.state.denied.add(f.c.issueId),f=>f.state.private.add(f.c.repository),
    f=>{f.input.issues=f.input.issues.filter(n=>n!==f.c);},f=>f.edges.set(f.c.issueId,[]),
    f=>{f.state.readHook=async r=>r.endpoint===`/repos/${f.c.repository}/issues/101`?{status:200,body:JSON.stringify({...f.body(f.c),node_id:'I_fake'})}:null;},
    f=>{f.state.readHook=async r=>r.endpoint===`/repos/${f.c.repository}`?{status:403,body:'ghp_secret'}:null;}];
  for(const change of changes){const f=fanoutFixture();change(f);const r=await wake(f);assert.equal(r.outcomes[0].outcome,'blocked');assert.equal(r.outcomes[1].outcome,'confirmed-success');assert.equal(f.writes().length,1);assert.ok(!JSON.stringify(r).includes('ghp_secret'));}
});

test('AC4 opaque consumer resolves all current and recursive predecessors, delayed hints do not execute stages',async()=>{
  const f=fanoutFixture();success(await wake(f));const r=[...f.requests.values()][0];
  assert.equal((await f.consumer(r,f.c)).outcome,'waiting');f.complete(f.e);
  assert.equal((await f.consumer(r,f.c)).outcome,'ready');
  f.edges.set(f.e.issueId,[f.a]);assert.equal((await f.consumer(r,f.c)).outcome,'waiting');
  f.complete(f.a);assert.equal((await f.consumer(r,f.c)).outcome,'ready');
  f.completions.get(f.b.issueId).identity='f'.repeat(64);assert.equal((await f.consumer(r,f.c)).outcome,'blocked');
  assert.equal(f.writes().length,2);
  assert.equal((await f.consumer(r,f.c,{authenticate:async()=>false})).outcome,'blocked');
  assert.equal((await f.consumer(r,f.d)).outcome,'blocked');
  for(const field of ['role','command','workflow','ref','authorized']) {
    const inputs={...r.intent.payload.inputs,[field]:'injected'};
    assert.equal((await f.consumer(r,f.c,{inputs})).outcome,'blocked');
  }
  assert.equal((await resolveFanoutWakeup({inputs:r.intent.payload.inputs,lookup:async()=>null})).outcome,'blocked');
});

test('AC5 configured workflow/ref/version and repository injection rejected',async()=>{
  for(const change of [f=>{f.workflow.ref='https://evil.test';},f=>{f.workflow.ref='../bad';},
    f=>{f.workflow.sha='c'.repeat(40);f.state.readHook=async r=>r.endpoint.includes('/commits/')?{status:200,body:JSON.stringify({sha:'b'.repeat(40)})}:null;},
    f=>{f.workflow.digest='f'.repeat(64);},f=>{f.workflow.path='secrets/token';},
    f=>{f.state.readHook=async r=>r.endpoint.includes('/actions/workflows/')?{status:200,body:'{"id":51,"path":"evil"}'}:null;}]) {
    const f=fanoutFixture();change(f);const r=await wake(f);assert.ok(r.outcomes.every(o=>o.outcome==='blocked'));assert.equal(f.writes().length,0);
  }
  const f=fanoutFixture();f.input.issues[0]={...f.c,repositoryId:'99'};assert.equal((await wake(f)).outcome,'blocked');assert.equal(f.writes().length,0);
  const g=fanoutFixture();await wake(g);
  const v=structuredClone([...g.requests.values()][0].intent);
  v.payload.endpoint='evil';assert.throws(()=>controlledIntent(v));
});

test('AC6 fresh instances reuse confirmed effects, loss reconciles and missing/ambiguous history never resends',async()=>{
  const f=fanoutFixture();success(await wake(f));success(await wake(f));assert.equal(f.writes().length,2);
  for(const [name,change] of [['lost',o=>{o.state.lost=true;}],['missing-runs',o=>{o.state.runs=[];}],
    ['ambiguous',o=>{o.state.total=2;const run={id:'70',workflow_id:o.input.target.id,event:'workflow_dispatch',head_sha:o.input.binding.head,display_title:'nibfin-operation:'+o.input.correlation,repository:{id:o.input.binding.repositoryId}};o.state.runs=[run,{...run,id:'71'}];}],['custody',o=>{o.state.expired=true;}],
    ['history',o=>{o.state.historyUnavailable=true;}],['interrupted',o=>{o.state.retainFail='result';}]]) {
    const g=fanoutFixture();const orig=g.options.operations;
    g.options.operations=async args=>{const ops=await orig(args);change(g.op.get(args.request.id));return ops;};
    const first=await wake(g);assert.equal(g.writes().length,['history','custody'].includes(name)?0:2,name);
    const count=g.writes().length;await wake(g);assert.equal(g.writes().length,count,name);
    if(name==='lost')success(first);else assert.ok(first.outcomes.every(o=>o.outcome==='unknown'),name);
  }
});

test('AC6 source or recipient changes after discovery stop new POSTs, retain earlier observed writes',async()=>{
  for(const boundary of ['intent','authorization']) {
    const f=fanoutFixture(),orig=f.options.operations;
    f.options.operations=async args=>{const ops=await orig(args),o=f.op.get(args.request.id);
      const revoke=()=>{if(args.request.target.issueId===f.d.issueId)f.state.denied.add(f.d.issueId);};
      if(boundary==='intent')o.state.onPublish=phase=>{if(phase==='attempt')revoke();};else o.state.onAuthorizationRead=revoke;
      return ops;};
    const r=await wake(f);assert.equal(r.outcomes[0].outcome,'confirmed-success');assert.equal(r.outcomes[1].outcome,boundary==='intent'?'unknown':'confirmed-no-effect');assert.equal(f.writes().length,1);
  }
  const f=fanoutFixture(),orig=f.options.operations;
  f.options.operations=async args=>{const ops=await orig(args);f.op.get(args.request.id).state.onWrite=()=>{f.completions.get(f.b.issueId).identity='f'.repeat(64);};return ops;};
  const r=await wake(f);assert.equal(r.outcomes[0].outcome,'confirmed-success');assert.equal(r.outcomes[1].outcome,'blocked');assert.equal(f.writes().length,1);
});

test('AC6 changed bindings cannot silently reuse the original correlation',async()=>{
  const f=fanoutFixture();success(await wake(f));const old=[...f.requests.keys()];
  f.state.cycle='cycle-2';assert.equal((await wake(f)).outcome,'blocked');assert.equal(f.writes().length,2);
  f.state.receiptCycle='cycle-2';success(await wake(f));assert.ok([...f.requests.keys()].slice(2).every(id=>!old.includes(id)));
  const request=[...f.requests.values()][0];request.intent.binding.repositoryId='999';
  assert.equal((await f.consumer(request,f.c)).outcome,'blocked');
});

test('AC7 incomplete/malformed/duplicate Blocking discovery fails before any POST',async()=>{
  for(const modify of [
    ()=>({status:403,body:'secret'}),()=>({status:200,body:'not json'}),
    f=>({status:200,body:JSON.stringify([f.body(f.c),f.body(f.c)])}),
    f=>({status:200,body:JSON.stringify([f.body(f.c),{...f.body(f.d),id:f.c.databaseId}])}),
    f=>({status:200,body:JSON.stringify([f.body(f.c),{...f.body(f.d),url:'https://evil.test/secret'}])}),
    f=>({status:200,body:JSON.stringify([f.body(f.c)]),headers:{link:`<https://api.github.com/repos/${f.b.repository}/issues/101/dependencies/blocking?page=2>; rel="next"`}}),
    f=>({status:200,body:JSON.stringify([f.body(f.c)]),headers:{link:'<https://evil.test/secret>; rel="next"'}})]) {
    const f=fanoutFixture();f.state.readHook=async r=>r.endpoint.includes('/dependencies/blocking')? (r.endpoint.includes('page=2')?{status:500,body:'secret'}:modify(f)):null;
    assert.equal((await wake(f)).outcome,'blocked');assert.equal(f.writes().length,0);
  }
});

test('AC7 limits, timeout, cancellation, late capability completion and exception sanitization',async()=>{
  for(const opts of [{maxTargets:1},{maxReads:1},{maxPages:1}]) {
    const f=fanoutFixture();if(opts.maxPages)f.state.readHook=async r=>r.endpoint.includes('/dependencies/blocking')?{status:200,body:JSON.stringify([f.body(f.c)]),headers:{link:`<https://api.github.com/repos/${f.b.repository}/issues/101/dependencies/blocking?page=2>; rel="next"`}}:null;
    assert.equal((await f.fresh(opts).wake(f.input)).outcome,'blocked');assert.equal(f.writes().length,0);
  }
  const f=fanoutFixture();f.state.sourceHook=()=>new Promise(()=>{});
  assert.equal((await f.fresh({timeoutMs:10}).wake(f.input)).reason,'timeout');
  const g=fanoutFixture(),controller=new AbortController();controller.abort();
  assert.equal((await g.fresh().wake(g.input,{signal:controller.signal})).reason,'cancelled');assert.equal(g.writes().length,0);
  const h=fanoutFixture();h.state.targetHook=()=>{throw Error('ghp_secret');};const result=await wake(h);
  assert.ok(!canonicalJSON(result).includes('ghp_secret'));assert.equal(h.writes().length,0);
});

test('AC6 process restart recovers retained full handoff/custody with no second transport',async()=>{
  const f=fanoutFixture();success(await wake(f));
  const directory=mkdtempSync(join(tmpdir(),'nibfin-fanout-restart-'));
  try {
    const snapshot=[...f.op].map(([id,o])=>({id,input:o.input,records:[...o.records].map(([k,r])=>[k,{metadata:r.metadata,bytes:r.bytes.toString('base64')}]),history:[...o.history]}));
    const file=join(directory,'records.json');writeFileSync(file,JSON.stringify(snapshot));
    const fixtureURL=import.meta.resolve('../tooling/fanout-fixture.mjs');
    const program=`import {readFileSync} from 'node:fs';
      import {fanoutFixture} from ${JSON.stringify(fixtureURL)};
      import {operationsFixture} from ${JSON.stringify(new URL('./operations-fixture.mjs',fixtureURL).href)};
      const f=fanoutFixture();
      for(const saved of JSON.parse(readFileSync(process.argv[1]))) {
        const o=operationsFixture(saved.input);o.state.effect=true;
        for(const [k,r] of saved.records)o.records.set(k,{...r,bytes:Buffer.from(r.bytes,'base64')});
        for(const [k,r] of saved.history)o.history.set(k,r);
        f.op.set(saved.id,o);
      }
      const r=await f.fresh().wake(f.input);
      console.log(JSON.stringify({outcomes:r.outcomes.map(o=>o.outcome),writes:f.writes().length,
        receipts:[...f.requests.values()].map(r=>r.intent.payload.handoff.origin.identity)}));`;
    const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',program,file],{encoding:'utf8',timeout:10000}));
    assert.deepEqual(result.outcomes,['confirmed-success','confirmed-success']);assert.equal(result.writes,0);
    assert.deepEqual(result.receipts,[f.completions.get(f.b.issueId).identity,f.completions.get(f.b.issueId).identity]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('AC2 other predecessors need not be in fanout destination catalog or complete',async()=>{
  const f=fanoutFixture();f.input.issues=f.input.issues.filter(n=>n!==f.e);success(await wake(f));
  assert.equal((await f.consumer([...f.requests.values()][0],f.c)).outcome,'waiting');
});

test('AC3 actual recipient authorization boundary may deny C while D dispatches',async()=>{
  const f=fanoutFixture(),original=f.options.operations;
  f.options.operations=async args=>{const ops=await original(args);f.op.get(args.request.id).state.allowed=args.request.target.issueId!==f.c.issueId;return ops;};
  const r=await wake(f);assert.equal(r.outcomes[0].outcome,'confirmed-no-effect');assert.equal(r.outcomes[1].outcome,'confirmed-success');assert.equal(f.writes().length,1);
});

test('AC6 expired/deleted retained evidence after success stays unknown without a second POST',async()=>{
  for(const change of [o=>o.state.expired=true,o=>o.records.clear(),o=>o.history.clear()]) {
    const f=fanoutFixture();success(await wake(f));for(const o of f.op.values())change(o);
    const r=await wake(f);assert.ok(r.outcomes.every(o=>o.outcome==='unknown'));assert.equal(f.writes().length,2);
  }
});

test('AC7 complete two-page discovery, then fresh boundary detects invalidation during membership reads',async()=>{
  const f=fanoutFixture();const endpoint='/repos/'+f.b.repository+'/issues/101/dependencies/blocking';
  f.state.readHook=async r=>r.endpoint===endpoint+'?per_page=100'?{status:200,body:JSON.stringify([f.body(f.c)]),headers:{link:`<https://api.github.com${endpoint}?page=2>; rel="next"`}}
    :r.endpoint===endpoint+'?page=2'?{status:200,body:JSON.stringify([f.body(f.d)])}:null;
  success(await wake(f));assert.equal(f.writes().length,2);
  const g=fanoutFixture();g.state.readHook=async r=>{if(r.endpoint.includes('/dependencies/blocked_by'))g.completions.get(g.b.issueId).identity='f'.repeat(64);};
  const result=await wake(g);assert.ok(result.outcomes.every(o=>o.outcome==='blocked'));assert.equal(g.writes().length,0);
});

test('AC7 cancellation at discovery and pending operation timeout never claim no effect',async()=>{
  const f=fanoutFixture(),controller=new AbortController();
  f.state.readHook=async r=>{if(r.endpoint.includes('/dependencies/blocking'))controller.abort();};
  assert.equal((await f.fresh().wake(f.input,{signal:controller.signal})).outcome,'blocked');assert.equal(f.writes().length,0);
  const g=fanoutFixture();let started=false;
  g.options.operations=async()=>({execute:async()=>{started=true;return new Promise(()=>{});}});
  const result=await g.fresh({timeoutMs:1000}).wake(g.input);
  assert.equal(started,true);assert.equal(result.outcomes[0].outcome,'unknown');assert.equal(result.continuation,false);
});

test('AC4/7 recipient lookup/authentication are bounded and cannot replace cancellation',async()=>{
  const f=fanoutFixture();success(await wake(f));const request=[...f.requests.values()][0];
  assert.equal((await f.consumer(request,f.c,{authenticate:()=>new Promise(()=>{}),timeoutMs:10})).outcome,'blocked');
  const controller=new AbortController();controller.abort();let called=false;
  assert.equal((await f.consumer(request,f.c,{signal:controller.signal,lookup:async()=>{called=true;return request;}})).outcome,'blocked');assert.equal(called,false);
});

test('AC7 elapsed deadline also bounds synchronously resolved capability chains',async()=>{
  const f=fanoutFixture();f.state.sourceHook=()=>{const end=performance.now()+25;while(performance.now()<end){/* disposable local work */}};
  assert.equal((await f.fresh({timeoutMs:10}).wake(f.input)).reason,'timeout');assert.equal(f.writes().length,0);
});
