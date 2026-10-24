import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompletion, createDependencyEvaluator} from '@nibfin/core';
import {dynamicFixture, dynamicNode} from '../tooling/dynamic-fixture.mjs';
import {chain,chainContext} from '../tooling/evidence-fixture.mjs';

function complete(f, num) {
  const n = f.nodes.find(n=>n.number===num);
  // Expected chain and submitted chain are built separately from trusted fixture constants.
  const make = () => chain(false,false,rs=>{for (const r of Object.values(rs)) {
    r.binding.repositoryId=n.repositoryId; r.binding.issueId=n.issueId;
  }});
  const expected = chainContext(make());
  const receipt = createCompletion(make(),expected);
  f.contexts.set(n.issueId,{expected,identity:receipt.identity});
  f.receipts.set(n.issueId,receipt);
  return {expected,receipt,n};
}
const code = r=>r.findings[0]?.reason;

test('AC1/2: native independent roots, lossless identity and B→C/D',async()=>{
  const f=dynamicFixture(); f.edges.set('3',['2']); f.edges.set('4',['2']); f.edges.set('5',['5']);
  for (const num of ['1','2']) assert.equal((await f.evaluate({}, {...f.input,target:f.nodes[Number(num)-1]})).outcome,'ready');
  for (const num of ['3','4']) assert.equal((await f.evaluate({}, {...f.input,target:f.nodes[Number(num)-1]})).outcome,'waiting');
  complete(f,'2');
  for (const num of ['3','4']) {
    const r=await f.evaluate({}, {...f.input,target:f.nodes[Number(num)-1]});
    assert.equal(r.outcome,'ready'); assert.equal(r.completions[0].issue.databaseId,'9007199254740994');
    assert.equal(r.edges.length,1);
  }
  assert.ok(f.calls.every(r=>r.method==='GET'));
  assert.ok(f.calls.some(r=>r.endpoint.endsWith('/dependencies/blocked_by?per_page=100')));
  assert.ok(f.calls.every(r=>/^\/repos\//.test(r.endpoint)));
});

test('AC1: actual array pagination, invalid identities and incomplete/foreign pages',async()=>{
  const f=dynamicFixture(); f.edges.set('1',['2']); complete(f,'2');complete(f,'3');
  const base='/repos/example-org/core/issues/1/dependencies/blocked_by';
  f.changeResponse=(r,v)=>r.endpoint===base+'?per_page=100' ? {...v,headers:{link:`<https://api.github.com${base}?page=2>; rel="next"`}}
    : r.endpoint===base+'?page=2' ? {...v,body:JSON.stringify([f.body(f.nodes[2])])}:v;
  assert.equal((await f.evaluate()).completions.length,2);
  for (const link of ['https://evil.example/secret', 'https://api.github.com/repos/other/core/issues/1/dependencies/blocked_by?page=2',
    `https://api.github.com${base}?page=1&page=2`, `https://api.github.com${base}?unexpected=1`]) {
    f.changeResponse=(r,v)=>r.endpoint===base+'?per_page=100'?{...v,headers:{link:`<${link}>; rel="next"`}}:v;
    assert.equal((await f.evaluate()).outcome,'blocked');
    assert.ok(!f.calls.some(r=>r.endpoint.includes('/other/')));
  }
  const mutations=[d=>({...d,id:'7'}),d=>({...d,node_id:'I_other'}),d=>({...d,number:99}),
    d=>({...d,pull_request:{}}),d=>({...d,repository_url:'https://api.github.com/repos/other/core'}),
    d=>({...d,url:'https://evil.example/issue'})];
  for (const mutate of mutations) {
    f.changeResponse=(r,v)=>r.endpoint.includes('/dependencies/')&&r.endpoint.includes('/issues/1/')
      ? {...v,body:JSON.stringify([mutate(f.body(f.nodes[1]))])}:v;
    assert.equal((await f.evaluate()).outcome,'blocked');
    f.changeResponse=(r,v)=>r.endpoint==='/repos/example-org/core/issues/1'?{...v,body:JSON.stringify(mutate(f.body(f.nodes[0])))}:v;
    assert.equal((await f.evaluate()).outcome,'blocked');
  }
  for (const body of ['{}','null','[','[null]']) {
    f.changeResponse=(r,v)=>r.endpoint.includes('/dependencies/')?{...v,body}:v;
    assert.equal((await f.evaluate()).outcome,'blocked');
  }
  f.changeResponse=(r,v)=>r.endpoint.includes('/dependencies/')?{...v,headers:{link:`<https://api.github.com${base}?page=2>; rel="next"`}}:v;
  assert.equal((await f.evaluate()).outcome,'blocked');
});

test('AC3: cycles, missing/transitive upstreams, diamond, traversal budgets',async()=>{
  for (const edges of [[['1',['1']]],[['1',['2']],['2',['3']],['3',['1']]]]) {
    const f=dynamicFixture();for (const [n,parents] of edges) f.edges.set(n,parents);
    assert.equal(code(await f.evaluate()),'cycle');
    assert.ok(f.calls.length<=9);
  }
  const f=dynamicFixture(); f.edges.set('1',['2','3']);f.edges.set('2',['4']);f.edges.set('3',['4']);
  complete(f,'2');complete(f,'3');complete(f,'4');
  assert.equal((await f.evaluate()).outcome,'ready');
  assert.equal(f.calls.filter(r=>r.endpoint==='/repos/example-org/core/issues/4').length,1);
  f.contexts.delete('I_4');assert.equal((await f.evaluate()).outcome,'waiting');
  complete(f,'4');
  for (const options of [{maxNodes:2},{maxDepth:1},{maxEdges:1},{maxReads:2}]) {
    assert.equal((await f.evaluate(options)).outcome,'blocked');
  }
  f.changeResponse=(r,v)=>r.endpoint.includes('/issues/4')?{status:404,headers:{},body:'secret'}:v;
  assert.equal(code(await f.evaluate()),'not_found_or_inaccessible');
  f.changeResponse=(r,v)=>r.endpoint.includes('/issues/4/dependencies')?{status:403,headers:{},body:'secret'}:v;
  assert.equal(code(await f.evaluate()),'denied');
});

test('AC4: explicit cross-repository catalog and current N04-compatible observations',async()=>{
  const f=dynamicFixture(); Object.assign(f.nodes[1],dynamicNode('2','personal/project','43'));
  f.edges.set('1',['2']);complete(f,'2');
  assert.equal((await f.evaluate()).outcome,'ready');
  assert.equal(code(await f.evaluate({}, {...f.input,issues:[f.nodes[0]]})),'unauthorized_upstream');
  f.denied.add('I_2');assert.equal(code(await f.evaluate()),'unauthorized');
  f.denied.clear();f.denied.add('I_1');assert.equal(code(await f.evaluate()),'unauthorized');
  f.denied.clear();
  for (const ownerType of ['User','Organization']) {
    f.changeResponse=(r,v)=>r.endpoint==='/repos/personal/project'?{...v,body:JSON.stringify({...JSON.parse(v.body),owner:{type:ownerType}})}:v;
    assert.equal((await f.evaluate()).outcome,'ready');
  }
  f.changeResponse=(r,v)=>r.endpoint==='/repos/personal/project'?{...v,body:JSON.stringify({...JSON.parse(v.body),private:true,visibility:'private'})}:v;
  assert.equal(code(await f.evaluate()),'repository');
  for (const observation of [null,{issueId:'I_2',repositoryId:'43',operation:'deliver',startedAt:1,observedAt:2},
    {issueId:'I_2',repositoryId:'wrong',operation:'readiness',startedAt:1,observedAt:2}]) {
    f.authorization=()=>({ok:true,observation});assert.equal(code(await f.evaluate()),'unauthorized');
  }
});

test('AC5: full N06 completion, missing stages, forged/stale current bindings',async()=>{
  const f=dynamicFixture();f.edges.set('1',['2']);
  const reset=()=>complete(f,'2');
  reset();assert.equal((await f.evaluate()).outcome,'ready');
  for (const receipt of [{state:'closed'},{labels:['delivered']},{merged:true},{aggregate:'COMPLETE'},null]) {
    reset();f.receipts.set('I_2',receipt);assert.equal(code(await f.evaluate()),'completion_invalid');
  }
  for (const stage of Object.keys(reset().receipt.payload.receipts)) {
    const {receipt}=reset();delete receipt.payload.receipts[stage];assert.equal(code(await f.evaluate()),'completion_invalid');
  }
  for (const field of ['scopeHash','shapeHash','grant','policy','authority','core','instructions','repositoryId','issueId']) {
    const {expected}=reset();expected.publication.expected.binding[field] += 'x';
    assert.equal(code(await f.evaluate()),'completion_invalid');
  }
  for (const [stage,field] of [['pr','head'],['pr','base'],['deliver','candidate']]) {
    const {expected}=reset();expected[stage].expected.inputs[field]='changed';
    assert.equal(code(await f.evaluate()),'completion_invalid');
  }
  for (const field of ['runId','attempt']) {
    const {expected}=reset();expected.ci.expected.execution.source[field]='2';
    assert.equal(code(await f.evaluate()),'completion_invalid');
  }
  reset();f.contexts.get('I_2').identity='a'.repeat(64);assert.equal(code(await f.evaluate()),'completion_invalid');
  reset();f.receipts.get('I_2').identity='a'.repeat(64);assert.equal(code(await f.evaluate()),'completion_invalid');
  // A valid chain for another Issue is still not this upstream's completion.
  const other=complete(f,'3');f.contexts.set('I_2',{expected:other.expected,identity:other.receipt.identity});
  f.receipts.set('I_2',other.receipt);assert.equal(code(await f.evaluate()),'completion_invalid');
});

test('AC5: custody composition requires successful retrieval before completion verification',async()=>{
  const f=dynamicFixture();f.edges.set('1',['2']);const {receipt}=complete(f,'2');
  f.contexts.get('I_2').custody={ref:{artifactId:'91'},expected:{independent:true},path:'completion.json'};
  let calls=0;
  const custody={retrieve:async input=>{
    calls++;assert.deepEqual(input.expected,{independent:true});
    return {outcome:'retrieved',payloads:new Map([['completion.json',Buffer.from(JSON.stringify(receipt))]])};
  }};
  assert.equal((await f.evaluate({custody})).outcome,'ready');assert.equal(calls,1);
  assert.equal(code(await f.evaluate()),'custody_unavailable');
  for (const kind of ['expired','denied','not_found_or_inaccessible','invalid_evidence']) {
    assert.equal(code(await f.evaluate({custody:{retrieve:async()=>({outcome:'failed',diagnostic:{kind,body:'secret'}})}})),'custody_'+kind);
  }
  assert.equal(code(await f.evaluate({custody:{retrieve:async()=>({outcome:'retrieved',payloads:new Map()})}})),'completion_invalid');
});

test('AC6: fresh checkpoints add/remove edges and invalidate completion/authorization',async()=>{
  const f=dynamicFixture();const evaluator=createDependencyEvaluator(f.options);
  const run=()=>evaluator.evaluate(f.input);
  assert.equal((await run()).outcome,'ready');f.edges.set('1',['2']);assert.equal((await run()).outcome,'waiting');
  f.edges.delete('1');assert.equal((await run()).outcome,'ready');
  f.denied.add('I_1');assert.equal(code(await run()),'unauthorized');f.denied.clear();
  f.edges.set('1',['2']);complete(f,'2');assert.equal((await run()).outcome,'ready');
  f.contexts.get('I_2').expected.accept.expected.binding.scopeHash='a'.repeat(64);assert.equal(code(await run()),'completion_invalid');
  complete(f,'2');f.denied.add('I_2');assert.equal(code(await run()),'unauthorized');
  f.denied.clear();f.edges.set('2',['3']);assert.equal((await run()).outcome,'waiting');
  complete(f,'3');assert.equal((await run()).outcome,'ready');
});

test('AC7: failure sanitization, timeout, cancellation and input snapshots',async()=>{
  const f=dynamicFixture();
  for (const [status,kind] of [[401,'authentication'],[403,'denied'],[404,'not_found_or_inaccessible'],[500,'server']]) {
    f.changeResponse=()=>({status,headers:{},body:'SECRET credential provider body'});
    const r=await f.evaluate();assert.equal(r.outcome,'blocked');assert.ok(!JSON.stringify(r).includes('SECRET'));
    assert.equal(code(r),kind);
  }
  f.changeResponse=(_r,v)=>v;
  const controller=new AbortController();controller.abort();assert.equal(code(await f.evaluate({},f.input,{signal:controller.signal})),'cancelled');
  assert.equal(code(await f.evaluate({authorize:()=>new Promise(()=>{}),timeoutMs:10})),'timeout');
  assert.equal(code(await f.evaluate({current:()=>{throw Error('SECRET');}}, {...f.input,target:f.nodes[0]})),undefined);
  f.edges.set('1',['2']);assert.equal(code(await f.evaluate({current:()=>{throw Error('SECRET');}})),'unavailable');
  let release;const pending=new Promise(resolve=>release=resolve);
  const request=structuredClone(f.input);
  const started=f.evaluate({authorize:async n=>{await pending;return f.options.authorize(n);}},request);
  request.target.number='999';request.issues.length=0;release();
  assert.equal((await started).outcome,'waiting');
  assert.throws(()=>createDependencyEvaluator({...f.options,maxNodes:Infinity}));
});

test('AC5 integration: real N19 custody transport and N06 completion consumption',async()=>{
  const {custodyFixture}=await import('../tooling/custody-fixture.mjs');
  const {prepareCustodyManifest,contentIdentity,byteDigest}=await import('@nibfin/core');
  const f=dynamicFixture();f.edges.set('1',['2']);const {receipt,n}=complete(f,'2');
  const c=custodyFixture();
  const expected={...c.expected,issueId:n.issueId};
  const payloads=new Map([...c.payloads,['completion.json',Buffer.from(JSON.stringify(receipt))]]);
  const manifest=prepareCustodyManifest(expected,payloads);
  c.state.bytes=c.encode(payloads,manifest);
  const ref={...c.ref(),manifestIdentity:contentIdentity(manifest),archiveDigest:byteDigest(c.state.bytes)};
  f.contexts.get(n.issueId).custody={ref,expected,path:'completion.json'};
  assert.equal((await f.evaluate({custody:c.fresh()})).outcome,'ready');
  c.state.expires='2020-01-01T00:00:00Z';
  assert.equal(code(await f.evaluate({custody:c.fresh()})),'custody_expired');
  c.state.expires='2030-01-01T00:00:00Z';c.state.status=403;
  assert.equal(code(await f.evaluate({custody:c.fresh()})),'custody_denied');
  assert.ok(c.calls.every(r=>r.method==='GET'));
});

test('AC4 integration: real N04 signed Grant/member check composes with planner',async()=>{
  const {generateKeyPairSync}=await import('node:crypto');
  const {grantFixture,grantContext}=await import('../tooling/grant-fixture.mjs');
  const {bodyDigest,signGrant,createAuthorizationBoundary}=await import('@nibfin/core');
  const p=grantFixture(bodyDigest);p.permissions[0].operations=['readiness'];
  const keys=generateKeyPairSync('ed25519');
  const grant=signGrant(p,{keyId:'owner-1',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})});
  const context=grantContext(p,keys.publicKey.export({type:'spki',format:'pem'}));context.request.operation='readiness';
  const f=dynamicFixture();Object.assign(f.nodes[0],{repositoryId:p.work[0].repository.id,issueId:'I_101',number:'101'});
  let permission='write';
  const boundary=createAuthorizationBoundary({identity:'hosted-authorized',maxCheckpointMs:100,now:()=>1100,
    getCheckpoint:()=>({request:context.request,grant,grantContext:context,member:{id:'7',login:'member'},
      operator:{trusted:true,source:'hosted-authorized',kind:'service',id:'app'}}),
    transport:async r=>({status:200,headers:{},body:JSON.stringify(
      r.endpoint==='/repos/example-org/core'?{id:p.work[0].repository.id,full_name:'example-org/core',private:false,visibility:'public',owner:{login:'example-org',type:'Organization'}}:
      r.endpoint.endsWith('/issues/101')?{...f.body(f.nodes[0]),assignees:[{id:'7',login:'member'}]}:
      r.endpoint==='/users/member'?{id:'7',login:'member'}:{permission,user:{id:'7',login:'member'}})})});
  const input={target:f.nodes[0],issues:[f.nodes[0]]};
  const authorize=()=>boundary.eligibility({correlation:'planner'});
  assert.equal((await f.evaluate({authorize},input)).outcome,'ready');
  permission='read';assert.equal(code(await f.evaluate({authorize},input)),'unauthorized');
});

test('AC3/7: bounded stalled reads, mid-check cancellation, invalid prerequisites',async()=>{
  const f=dynamicFixture();
  const hung={request:()=>new Promise(()=>{}),collection:f.provider.collection};
  assert.equal(code(await f.evaluate({provider:hung,timeoutMs:10})),'timeout');
  const c=new AbortController();let calls=0;
  const provider={request:async r=>{calls++;c.abort();return f.provider.request(r);},collection:f.provider.collection};
  assert.equal(code(await f.evaluate({provider},f.input,{signal:c.signal})),'cancelled');assert.equal(calls,1);
  assert.equal((await f.evaluate({provider:{request:f.provider.request,collection:async()=>({outcome:'incomplete'})}})).outcome,'blocked');
  const r=await f.evaluate({authorize:async n=>({ok:true,observation:{repositoryId:n.repositoryId,issueId:n.issueId,
    operation:'readiness',startedAt:1,observedAt:2,secret:'SECRET'}})});
  assert.equal(r.outcome,'ready');assert.ok(!JSON.stringify(r).includes('SECRET'));
});
