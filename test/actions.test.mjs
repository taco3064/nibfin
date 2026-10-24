import test from 'node:test';
import assert from 'node:assert/strict';
import {actionsFixture} from '../tooling/actions-fixture.mjs';
import {createActionsVerifier, actionsIssuer, actionsDiscovery, actionsJwks, verifyNativeNeeds} from '../src/index.mjs';
const f = await actionsFixture();
const ok = async (v, token, e=f.expected, observation) => (await v.authenticate(token,e,observation)).ok;
test('real synthetic signatures, claims and finite time boundaries', async () => {
  const v=f.verifier(); assert.equal(await ok(v,await f.sign()),true);
  for (const k of ['repository_id','repository_owner_id','actor_id','run_id','run_attempt','workflow_ref','workflow_sha','ref','event_name','repository_visibility']) {
    assert.equal(await ok(v,await f.sign({[k]:'foreign'})),false,k);
    assert.equal(await ok(v,await f.sign({[k]:undefined})),false,k);
  }
  for (const changes of [{iss:'https://evil.test'},{aud:'foreign'},{exp:995},{nbf:1006},{iat:1006},
    {iat:694},{sub:''},{jti:undefined},{exp:undefined},{iat:'990'},{nbf:undefined}]) {
    assert.equal(await ok(v,await f.sign(changes)),false,JSON.stringify(changes));
  }
  assert.equal(await ok(v,await f.sign({iat:695,nbf:695})),true);
  assert.equal(await ok(v,await f.sign({nbf:1005})),true);
  const token=await f.sign(); const parts=token.split('.');
  parts[1]=Buffer.from(JSON.stringify({sub:'tampered'})).toString('base64url');
  for (const bad of [parts.join('.'),'invalid','a.b.c',token.slice(0,-5)+'xxxxx',
    Buffer.from('{"alg":"none"}').toString('base64url')+'.e30.',await f.sign({}, {kid:'missing'}),
    await f.sign({}, {jku:'https://evil.test'})]) assert.equal(await ok(v,bad),false);
  assert.equal(await ok(v,await f.sign(),{...f.expected,tolerance:Infinity}),false);
});
test('production exact discovery, bounded refresh and sanitized transport failures', async () => {
  const calls=[]; const transport=async url=>{calls.push(url); return {status:200,url,body:JSON.stringify(
    url===actionsDiscovery?{issuer:actionsIssuer,jwks_uri:actionsJwks,id_token_signing_alg_values_supported:['RS256']}:f.jwks)};};
  const v=createActionsVerifier({transport});
  assert.equal(await ok(v,await f.sign()),true);
  assert.deepEqual(calls,[actionsDiscovery,actionsJwks]);
  assert.equal(await ok(v,await f.sign({}, {kid:'new'})),false);
  assert.equal(await ok(v,await f.sign({}, {kid:'new'})),false);
  assert.equal(calls.length,3);
  for (const body of [{issuer:'evil',jwks_uri:actionsJwks},
    {issuer:actionsIssuer,jwks_uri:'https://evil.test',id_token_signing_alg_values_supported:['RS256']},
    {issuer:actionsIssuer,jwks_uri:actionsJwks,id_token_signing_alg_values_supported:['none']}]) {
    assert.equal(await ok(createActionsVerifier({transport:async url=>({status:200,url,body:JSON.stringify(body)})}),await f.sign()),false);
  }
  for (const response of [{status:302,url:actionsDiscovery,body:'secret'},
    {status:200,url:'https://evil.test',body:'{}'},{status:200,url:actionsDiscovery,body:'invalid'}]) {
    assert.deepEqual(await createActionsVerifier({transport:async()=>response}).authenticate(await f.sign(),f.expected),{ok:false,category:'source-rejected'});
  }
  assert.equal(await ok(createActionsVerifier({transport:()=>new Promise(()=>{}),timeoutMs:5}),await f.sign()),false);
  assert.equal(await ok(createActionsVerifier({transport,maxRequests:2}),await f.sign({}, {kid:'unknown'})),false);
  const rotating=createActionsVerifier({transport:async url=>({status:200,url,body:JSON.stringify(url===actionsDiscovery?
    {issuer:actionsIssuer,jwks_uri:actionsJwks,id_token_signing_alg_values_supported:['RS256']}:
    {keys:[{...f.jwks.keys[0],kid:'new'}]})})});
  assert.equal(await ok(rotating,await f.sign({}, {kid:'new'})),true);
});
test('explicit reusable and independent job/runner association policy', async () => {
  const e={...f.expected,reusable:'required',job_workflow_ref:'shared/core/.github/workflows/reuse.yml@v1',
    job_workflow_sha:'c'.repeat(40),job:'required',check_run_id:'55',jobId:'56',runner:'required',runnerId:'57',runner_environment:'self-hosted'};
  const claims=Object.fromEntries(['job_workflow_ref','job_workflow_sha','check_run_id','runner_environment'].map(k=>[k,e[k]]));
  const obs=Object.fromEntries(['repository_id','run_id','run_attempt','check_run_id','jobId','runnerId'].map(k=>[k,e[k]]));
  const token=await f.sign(claims);const v=f.verifier();
  assert.equal(await ok(v,token,e,obs),true);
  assert.equal(await ok(v,token,e),false);
  for (const k of Object.keys(obs)) assert.equal(await ok(v,token,e,{...obs,[k]:'999'}),false,k);
  for (const k of Object.keys(claims)) assert.equal(await ok(v,await f.sign({...claims,[k]:'wrong'}),e,obs),false,k);
  // Owner type and registration level are deliberately not authentication predicates.
  for (const ownership of ['personal','organization']) assert.equal(await ok(v,token,{...e,ownership},obs),true);
});
function receipt() {
  const h='b'.repeat(64);return {version:1,stage:'deliver',binding:{authority:h,grant:h,policy:h,core:h,runtime:h,
    instructions:h,repositoryId:f.expected.repository_id,issueId:'I_1',scopeHash:h,shapeHash:h},
    execution:{role:'deliver',skill:'deliver',id:'author',request:'request',result:'result',source:{repositoryId:f.expected.repository_id,
      workflow:h,runId:'44',attempt:'1'}},inputs:{publication:h,candidate:{base:'a'.repeat(40),tree:'b'.repeat(40),diff:h,paths:['src/actions.mjs'],artifacts:[{path:'out/nibfin-core.tgz',digest:h}],hooks:[{path:'hooks/check',event:'pre-commit',digest:h}],emptyHooksReason:null}},result:{version:1,outcome:'ready',failureClass:'none',summary:'ok',conflicts:[]}};
}
test('complete predecessor comparison, independent consumer, replay and freshness', async () => {
  const v=f.verifier(),source=await v.authenticate(await f.sign(),f.expected),r=receipt();
  const args={source,receipt:r,current:{expected:structuredClone(r),consumed:[]},now:1000,maxAge:300,recordedAt:995,consumerExecution:'validator'};
  assert.equal(v.predecessor(args).ok,true);
  const mutateLeaves=(value,visit,path=[])=>{for(const [k,x] of Object.entries(value)) {
    if(x && typeof x==='object')mutateLeaves(x,visit,[...path,k]);else visit([...path,k]);}};
  mutateLeaves(r,path=>{const changed=structuredClone(r);let p=changed;for(const k of path.slice(0,-1))p=p[k];p[path.at(-1)]='foreign';
    assert.equal(v.predecessor({...args,receipt:changed}).ok,false,path.join('.'));});
  for(const change of [{source:{...source}},{receipt:null},{consumerExecution:'author'},
    {current:{expected:r,consumed:['result']}},{now:1300},{recordedAt:1001},
    {receipt:{...r,result:{...r.result,outcome:'blocked',failureClass:'external_failure'}}}]) assert.equal(v.predecessor({...args,...change}).ok,false);
  assert.equal('authorized' in source,false);
});
test('native needs exact fixed dependency and contradictions',()=>{
  const expected={fixedWorkflow:true,unweakened:true,repositoryId:'42',workflow:'pinned',runId:'44',attempt:'1',predecessorJob:'build',consumerJob:'test'};
  const dependency={...expected,result:'success'};const jobsObservation={...expected,status:'queued',conclusion:null};
  assert.equal(verifyNativeNeeds({expected,dependency,jobsObservation}).ok,true);
  for(const k of ['repositoryId','workflow','runId','attempt','predecessorJob','consumerJob']) assert.equal(verifyNativeNeeds({expected,dependency:{...dependency,[k]:'foreign'}}).ok,false);
  for(const result of ['failure','cancelled','skipped',null]) assert.equal(verifyNativeNeeds({expected,dependency:{...dependency,result}}).ok,false);
  for(const k of ['fixedWorkflow','unweakened']) assert.equal(verifyNativeNeeds({expected:{...expected,[k]:false},dependency}).ok,false);
  assert.equal(verifyNativeNeeds({expected,dependency,jobsObservation:{...jobsObservation,status:'completed',conclusion:'failure'}}).ok,false);
});
test('key mismatch, malformed key sets, algorithm rejection and real bounded rotation',async()=>{
  const other=await actionsFixture();
  assert.equal(await ok(other.verifier(),await f.sign()),false);
  const unsigned=Buffer.from(JSON.stringify({alg:'HS256',kid:'synthetic-local'})).toString('base64url')+'.e30.e30';
  assert.equal(await ok(f.verifier(),unsigned),false);
  const discovery={issuer:actionsIssuer,jwks_uri:actionsJwks,id_token_signing_alg_values_supported:['RS256']};
  for(const keys of [[],[{}],[{kty:'RSA',kid:'synthetic-local',n:'bad',e:'bad'}]]) {
    const v=createActionsVerifier({transport:async url=>({status:200,url,body:JSON.stringify(url===actionsDiscovery?discovery:{keys})})});
    assert.equal(await ok(v,await f.sign()),false);
  }
  for(const status of [401,403,404,500]) assert.equal(await ok(createActionsVerifier({transport:async url=>({status,url,body:'private detail'})}),await f.sign()),false);
  let reads=0;
  const v=createActionsVerifier({transport:async url=>({status:200,url,body:JSON.stringify(url===actionsDiscovery?discovery:
    (++reads===1?f.jwks:{keys:[{...f.jwks.keys[0],kid:'rotated'}]}))})});
  assert.equal(await ok(v,await f.sign()),true);
  assert.equal(await ok(v,await f.sign({}, {kid:'rotated'})),true);
  assert.equal(reads,2);
  assert.equal(await ok(v,await f.sign({}, {kid:'third'})),false);
  assert.equal(reads,2);
});
