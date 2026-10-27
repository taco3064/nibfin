import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as core from '../src/index.mjs';
import {configure,validateHostOptions} from '../host/entry.mjs';
import {hostIdentityFixture} from '../tooling/host-identity-fixture.mjs';
const secret='CREDENTIAL-SENTINEL';
const writes=f=>f.calls.filter(r=>r.method!=='GET').length;
const issue='/repos/example-org/core/issues/101',repo='/repos/example-org/core';
const permission=repo+'/collaborators/member/permission';
const base=await hostIdentityFixture();
// Reuse signing material only; every tested adapter and provider is constructed fresh.
async function fixture(mode) {return hostIdentityFixture(mode);}
function entry(f) {
  let captured;
  const facade={...core,createHostIdentityAdapters:c=>{captured=core.createHostIdentityAdaptersForTest(c,f.facility);return captured;}};
  const host=configure({core:facade,mode:'lookup',context:f.context,deployment:{options:f.config.options,
    identity:f.identityConfiguration(),capabilities:{lookup:async argument=>{
      f.state.lookup++;f.handoffs.push(argument);assert.equal(typeof argument.provider.request,'function');
      return {repository:f.context.repository,repositoryId:f.context.repositoryId,number:'101'};
    }}}});
  return {invoke:()=>core.createWorkflowEntry(host).invoke('lookup',{nibfin_request:'request',nibfin_correlation:'correlation'},f.context),
    adapter:captured};
}

test('maintained protected host invokes real source/target composition, inert and public-only',async()=>{
  for(const ownership of ['User','Organization']) {
    const f=await fixture();f.replies[repo].owner.type=ownership;
    const e=entry(f);assert.equal(f.calls.length,0);assert.equal(f.state.lookup,0);
    assert.deepEqual(await e.invoke(),{status:'resolved',issue:'101'});
    assert.equal(f.calls.some(r=>r.endpoint==='/user'),false);
    const identity=await e.adapter.authenticate(f.argument);
    assert.deepEqual(identity,{repository:f.context.repository,repositoryId:f.context.repositoryId,run:{id:'44',attempt:'1'},
      visibility:'public',ownership:ownership==='User'?'personal':'organization'});
    assert(!JSON.stringify(f.handoffs).includes(secret));assert(!JSON.stringify(identity).includes('token'));
  }
  const f=await fixture();
  for(const change of [c=>delete c.source,c=>delete c.authorization,c=>c.api.kind='local',c=>c.api.transport=()=>{},
    c=>c.source.policy.now=1,c=>c.operations.push({method:'POST',endpoint:'https://evil.test',target:'123',operation:'deliver'})]) {
    const c={...f.config,api:{...f.config.api},source:{...f.config.source,policy:{...f.policy}},operations:[...f.config.operations]};
    change(c);assert.throws(()=>core.createHostIdentityAdaptersForTest(c,f.facility));
  }
  assert.equal(f.calls.length,0);
  assert.throws(()=>configure({core,mode:'lookup',context:f.context,deployment:{options:f.config.options,
    capabilities:{authenticate:()=>{},lookup:()=>{}}}}));
});

test('source rejection matrix blocks host and writes before any provider/downstream call',async()=>{
  const changes=[{iss:'https://evil.test'},{aud:'wrong'},{exp:1},{nbf:2},{iat:2},
    ...['repository','repository_id','repository_owner_id','actor_id','workflow_ref','workflow_sha','ref','event_name','run_id','run_attempt',
      'job_workflow_ref','job_workflow_sha','check_run_id','runner_environment'].flatMap(k=>[{[k]:'wrong'},{[k]:undefined}])];
  for(const change of changes) {
    const f=base;f.calls.length=0;f.state.lookup=0;f.state.token=await f.sign(change);
    const e=entry(f);assert.equal((await e.invoke()).status,'blocked',JSON.stringify(change));
    assert.notEqual((await f.write(e.adapter)).outcome,'submitted');assert.equal(f.calls.length,0);assert.equal(f.state.lookup,0);
  }
  for(const bad of ['invalid',(await base.sign()).slice(0,-8)+'forgedxx']) {
    base.state.token=bad;base.calls.length=0;assert.equal((await entry(base).invoke()).status,'blocked');assert.equal(base.calls.length,0);
  }
  base.state.token=await base.sign();
  for(const k of Object.keys(base.association)) {
    const original=base.association[k];base.association[k]='999';base.calls.length=0;
    assert.equal((await entry(base).invoke()).status,'blocked');assert.equal(base.calls.length,0);base.association[k]=original;
  }
});

test('target, member, Assignee and signed Grant independently reject and recheck writes',async()=>{
  const changes=[f=>f.replies[repo].id='99',f=>f.replies[repo].private=true,f=>f.replies[repo].owner.type='Unknown',
    f=>f.replies[repo].full_name='other/core',f=>f.replies[issue].node_id='I_wrong',f=>f.replies[issue].assignees=[],
    f=>f.replies['/users/member'].id=43,f=>f.replies[permission].permission='read',f=>f.replies[permission].permission='triage',
    f=>f.replies[permission].permission='unknown',f=>f.checkpoint.grant.signature='forged',f=>f.state.time=2000,
    f=>f.checkpoint.grantContext.expectedWork[0].currentBody.body='changed',f=>f.checkpoint.request.repository.id='99'];
  for(const change of changes) {
    const f=await fixture(),a=f.make();assert.equal((await f.write(a)).outcome,'submitted');
    change(f);assert.notEqual((await f.write(a)).outcome,'submitted');assert.equal(writes(f),1);
  }
});

test('stored process gh environment excludes overrides; missing/wrong login and 401/403 are safe',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nibfin-gh-identity-'));
  const executable=join(dir,'gh');
  const envKeys=['GH_TOKEN','GITHUB_TOKEN','GH_HOST','GH_CONFIG_DIR'];const old=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  try {
    for(const k of envKeys)process.env[k]=secret;
    const script=state=>`#!/usr/bin/env node\nconst fs=require('node:fs');
if(['GH_TOKEN','GITHUB_TOKEN','GH_HOST','GH_CONFIG_DIR'].some(k=>process.env[k]))process.exit(99);
if(process.argv[2]==='auth')process.exit(${state==='missing'?1:0});
const endpoint=process.argv.at(-1);
const data=endpoint.endsWith('/user')?{id:${state==='wrong'?8:7},login:'operator'}:
 {id:'9007199254740993',full_name:'example-org/core',private:false,visibility:'public',owner:{login:'example-org',type:'Organization'}};
fs.writeFileSync(${JSON.stringify(join(dir,'env'))},JSON.stringify(process.env));
console.log('HTTP/2 ${state==='401'?'401':state==='403'?'403':'200'} OK\\ncontent-type: application/json\\n\\n'+JSON.stringify(data));\n`;
    const f=await fixture('compute');f.config.api.executable=executable;
    for(const state of ['ok','missing','wrong','401','403']) {
      await writeFile(executable,script(state));await chmod(executable,0o700);
      const a=core.createHostIdentityAdaptersForTest(f.config,{...f.facility,transport:core.localGhTransport({executable})});
      if(state==='ok') {
        assert.equal((await a.authenticate(f.argument)).run.id,'44');
        const env=JSON.parse(await readFile(join(dir,'env'),'utf8'));
        assert.equal(env.HOME,(await import('node:os')).userInfo().homedir);
        assert(!JSON.stringify(env).includes(secret));
      } else await assert.rejects(a.authenticate(f.argument),/host-identity:rejected/);
      const eligibility=await a.eligibility();assert(!JSON.stringify(eligibility).includes(secret));
      if(['401','403'].includes(state))assert.equal(eligibility.diagnostic.status,Number(state));
    }
  } finally {
    for(const k of envKeys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];
    await rm(dir,{recursive:true,force:true});
  }
});

function credential(overrides={}) {return {token:secret,installationId:'7',expiresAt:10000,repositoryIds:['9007199254740993'],
  permissions:{administration:'write',organization_self_hosted_runners:'write',issues:'write',metadata:'read'},organization:'example-org',...overrides};}
test('hosted transport enforces official endpoint permission classes, origin and token custody',async()=>{
  const endpoints=[['GET',repo+'/actions/runners','administration','read'],
    ['POST',repo+'/actions/runners/registration-token','administration','write'],
    ['POST','/orgs/example-org/actions/runners/registration-token','organization_self_hosted_runners','write']];
  for(const [method,endpoint,permission,level] of endpoints) {
    for(const granted of ['none','read','write']) {
      const calls=[];
      const t=core.hostedGithubTransport({repository:'example-org/core',repositoryId:'9007199254740993',organization:'example-org',now:()=>1100,
        getCredential:()=>credential({permissions:{[permission]:granted}}),fetcher:async (url,args)=>{
          calls.push({url,args});assert.equal(args.redirect,'error');assert.equal(args.headers.Authorization,'Bearer '+secret);
          const response=new Response('{}',{status:200});Object.defineProperty(response,'url',{value:url});return response;
        }});
      const result=await t({method,endpoint,headers:{},body:method==='POST'?'{}':undefined});
      const allowed=granted==='write'||granted==='read'&&level==='read';assert.equal(calls.length,allowed?1:0);
      assert.equal(result.status,allowed?200:403);
      assert.equal(core.githubEndpointPermission(method,endpoint),permission+':'+level);
    }
  }
  let calls=0;const t=core.hostedGithubTransport({repository:'example-org/core',repositoryId:'9007199254740993',now:()=>1100,
    getCredential:()=>credential(),fetcher:async()=>{calls++;throw Error(secret);}});
  for(const endpoint of ['https://evil.test/user','/repos/other/core/actions/runners','/orgs/other/actions/runners','/user'])
    assert.equal((await t({method:'GET',endpoint})).status,403);
  assert.equal(calls,0);
  const failure=await t({method:'POST',endpoint:repo+'/actions/runners/registration-token'});
  assert.equal(failure.failure,'transport');assert(!JSON.stringify(failure).includes(secret));
});

test('management uses exact operation inventory and current admin rights; unknown writes reconcile once',async()=>{
  const f=await fixture('compute');
  const operations=[['GET',repo+'/actions/runners'],['POST',repo+'/actions/runners/registration-token'],
    ['POST','/orgs/example-org/actions/runners/registration-token']];
  f.config.api.organization='example-org';
  for(const [method,endpoint] of operations) {
    f.config.operations.push({method,endpoint,target:'123',operation:'deliver'});
    f.replies[endpoint]={id:123};
    f.checkpoint.write={method,endpoint,target:'123'};
    const a=f.make(),r={method,endpoint,target:'123',operation:'deliver',correlation:'runner'};
    assert.equal((await a.provider.request(r)).outcome,method==='GET'?'read':'submitted');
    if(endpoint.startsWith('/orgs/'))f.replies['/user/memberships/orgs/example-org'].role='member';
    else f.replies[repo].permissions.admin=false;
    const count=f.calls.length;assert.equal((await a.provider.request(r)).diagnostic.kind,'denied');
    assert(!f.calls.slice(count).some(c=>c.endpoint===endpoint));
    f.replies[repo].permissions.admin=true;f.replies['/user/memberships/orgs/example-org'].role='admin';
  }
  const g=await fixture(),a=g.make();
  for(const patch of [{identity:'local-stored-login'},{endpoint:'https://evil.test'},{headers:{Authorization:secret}},{target:'99'}])
    assert.equal((await a.provider.request({method:'PATCH',endpoint:issue,target:'123',operation:'deliver',correlation:'bad',...patch})).diagnostic.kind,'unsupported');
  assert.equal(writes(g),0);
  g.state.reply=r=>{if(r.method==='PATCH')throw Error(secret);return {status:200,body:JSON.stringify(g.replies[r.endpoint])};};
  const result=await g.write(a);assert.equal(result.outcome,'unknown');assert.equal(writes(g),1);
  const read={endpoint:issue,target:'123',operation:'deliver',correlation:'readback'};
  assert.equal((await a.provider.reconcile(result,read,d=>d.node_id==='I_101')).outcome,'verified');
  assert.equal((await a.provider.reconcile(result,read,()=>false)).outcome,'unknown');assert.equal(writes(g),1);
  assert(!JSON.stringify(result).includes(secret));
});

function receipt(f) {
  const h='b'.repeat(64);return {version:1,stage:'deliver',binding:{authority:h,grant:h,policy:h,core:h,runtime:h,instructions:h,
    repositoryId:f.policy.repository_id,issueId:'I_1',scopeHash:h,shapeHash:h},
    execution:{role:'deliver',skill:'deliver',id:'author',request:'request',result:'result',source:{repositoryId:f.policy.repository_id,
      workflow:h,runId:'43',attempt:'1'}},inputs:{publication:h,candidate:{base:'a'.repeat(40),tree:'b'.repeat(40),diff:h,paths:['src/actions.mjs'],
      artifacts:[],hooks:[],emptyHooksReason:'No installed hooks'}},result:{version:1,outcome:'ready',failureClass:'none',summary:'ok',conflicts:[]}};
}
test('source never substitutes for complete independent predecessor or fixed native needs',async()=>{
  const f=await fixture();
  const expected={fixedWorkflow:true,unweakened:true,repositoryId:f.policy.repository_id,workflow:f.policy.workflowDigest,
    runId:'44',attempt:'1',predecessorJob:'build',consumerJob:'test'};
  const dependency={...expected,result:'success'},jobsObservation={...expected,status:'queued',conclusion:null};
  f.config.source.continuation={kind:'native-needs',expected,getEvidence:()=>({dependency,jobsObservation})};
  assert.equal((await f.make().authenticate(f.argument)).run.id,'44');
  for(const change of [()=>expected.unweakened=false,()=>dependency.attempt='2',()=>dependency.runId='45',
    ()=>dependency.result='failure',()=>jobsObservation.conclusion='failure']) {
    const saved=[structuredClone(expected),structuredClone(dependency),structuredClone(jobsObservation)];change();
    await assert.rejects(f.make().authenticate(f.argument));
    for(const [v,s] of [[expected,saved[0]],[dependency,saved[1]],[jobsObservation,saved[2]]])Object.assign(v,s);
  }
  const r=receipt(f),previousPolicy={...f.policy,run_id:'43'},previousAssociation={...f.association,run_id:'43'};
  const e={token:await f.sign({run_id:'43'}),association:previousAssociation,receipt:r,recordedAt:1};
  const continuation={kind:'cross-run',policy:previousPolicy,current:{expected:structuredClone(r),consumed:[]},maxAge:300,
    consumerExecution:'validator',getEvidence:()=>e};f.config.source.continuation=continuation;
  assert.equal((await f.make().authenticate(f.argument)).run.id,'44');
  for(const mutate of [()=>e.receipt=null,()=>e.receipt={output:'partial'},()=>e.recordedAt=-1000,
    ()=>e.receipt.execution.source.attempt='2',()=>continuation.consumerExecution='author',
    ()=>e.receipt.result.outcome='blocked']) {
    const saved=structuredClone(e),consumer=continuation.consumerExecution;mutate();
    await assert.rejects(f.make().authenticate(f.argument));Object.assign(e,saved);continuation.consumerExecution=consumer;
  }
});

test('approved deployment loader reaches production authentication and hosted transport with explicit local HTTP fixtures',async()=>{
  // Simulate official HTTPS responses in-process. All signatures/roots here are local;
  // no GitHub account, network, actual provider identity or platform success is claimed.
  const f=await fixture(),calls=[],handoffs=[],originalFetch=globalThis.fetch;
  const response=(url,data,status=200)=>{
    const r=new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
    Object.defineProperty(r,'url',{value:url});return r;
  };
  let apiStatus=200;
  globalThis.fetch=async (url,args)=>{
    calls.push({url,args});
    if(url===core.actionsDiscovery) {
      assert.equal(args.credentials,'omit');
      return response(url,{issuer:core.actionsIssuer,jwks_uri:core.actionsJwks,id_token_signing_alg_values_supported:['RS256']});
    }
    if(url===core.actionsJwks)return response(url,f.facility.jwks);
    assert.equal(url,'https://api.github.com'+repo);assert.equal(args.headers.Authorization,'Bearer '+secret);
    return response(url,apiStatus===200?f.replies[repo]:{privateBody:secret},apiStatus);
  };
  try {
    const source=`export const capabilities={lookup:{lookup:async ({identity})=>({repository:identity.repository,repositoryId:identity.repositoryId,number:'101'})}};
export const identity={lookup:{now:()=>1100,
source:{policy:${JSON.stringify(f.policy)},getToken:()=>${JSON.stringify(f.state.token)},getAssociation:()=>(${JSON.stringify(f.association)}),continuation:{kind:'none'}},
api:{kind:'hosted',operator:{id:'7',login:'operator'},getCredential:()=>(${JSON.stringify(credential())})},
authorization:{getCheckpoint:()=>({}),maxCheckpointMs:50},operations:[]}};`;
    const text=JSON.stringify({lookup:f.config.options});
    const hash=bytes=>core.byteDigest(Buffer.from(bytes));
    const deployment=await core.loadProtectedDeployment({source,options:text,
      approval:{sourceSha256:hash(source),optionsSha256:hash(text)},validate:validateHostOptions,mode:'lookup'});
    const lookup=deployment.capabilities.lookup;
    deployment.capabilities.lookup=async args=>{handoffs.push(args);return lookup(args);};
    const host=configure({core,mode:'lookup',context:f.context,deployment});assert.equal(calls.length,0);
    const invoke=()=>core.createWorkflowEntry(host).invoke('lookup',{nibfin_request:'request',nibfin_correlation:'correlation'},f.context);
    assert.deepEqual(await invoke(),{status:'resolved',issue:'101'});
    assert.deepEqual(calls.map(c=>c.url),[core.actionsDiscovery,core.actionsJwks,'https://api.github.com'+repo]);
    assert(!JSON.stringify(handoffs).includes(secret));assert(!JSON.stringify(handoffs).includes(f.state.token));
    assert(!Object.hasOwn(handoffs[0],'api'));assert(!Object.hasOwn(handoffs[0],'source'));
    for(const status of [401,403]) {
      apiStatus=status;const count=handoffs.length,result=await invoke();assert.equal(result.status,'blocked');
      assert.equal(handoffs.length,count);assert(!JSON.stringify(result).includes(secret));
    }
    // A synthetic verifier/root is not a production configuration field.
    assert.throws(()=>core.createHostIdentityAdapters({...f.config,verifier:f.make()}));
    assert.throws(()=>core.createHostIdentityAdapters({...f.config,source:{...f.config.source,jwks:f.facility.jwks}}));
  } finally {globalThis.fetch=originalFetch;}
});

test('source acquisition is bounded/cancellable and protected predicates are snapshotted',async()=>{
  const f=await fixture();f.config.source.timeoutMs=5;
  f.config.source.getToken=()=>new Promise(resolve=>setTimeout(()=>resolve(f.state.token),25));
  await assert.rejects(f.make().authenticate(f.argument));assert.equal(f.calls.length,0);
  const g=await fixture(),a=g.make(),controller=new AbortController();controller.abort();
  await assert.rejects(a.authenticate({...g.argument,signal:controller.signal}));assert.equal(g.calls.length,0);
  const expected={fixedWorkflow:true,unweakened:true,repositoryId:g.policy.repository_id,workflow:g.policy.workflowDigest,
    runId:'44',attempt:'1',predecessorJob:'build',consumerJob:'test'};
  const dependency={...expected,result:'failure'};
  g.config.source.continuation={kind:'native-needs',expected,getEvidence:()=>({dependency,expected:{...expected,unweakened:true}})};
  const b=g.make();g.config.source.continuation.kind='none';g.policy.actor_id='999';g.config.api.operator.id='999';
  await assert.rejects(b.authenticate(g.argument));assert.equal(g.calls.length,0);
});

test('hosted credential identity/scope/expiry and upstream 401/403 are never promoted to permission',async()=>{
  for(const change of [{installationId:'8'},{repositoryIds:['99']},{expiresAt:1100},{permissions:{administration:'read'}}]) {
    let count=0;const t=core.hostedGithubTransport({repository:'example-org/core',repositoryId:'9007199254740993',operatorId:'7',now:()=>1100,
      getCredential:()=>credential(change),fetcher:async()=>{count++;throw Error(secret);}});
    const result=await t({method:'POST',endpoint:repo+'/actions/runners/registration-token'});
    assert.equal(count,0);assert(!JSON.stringify(result).includes(secret));
    assert(result.failure==='authentication'||result.status===403);
  }
  for(const status of [401,403]) {
    const f=await fixture();
    const t=core.hostedGithubTransport({repository:'example-org/core',repositoryId:f.context.repositoryId,operatorId:'7',now:()=>1100,
      getCredential:()=>credential(),fetcher:async url=>{
        const r=new Response(JSON.stringify({privateError:secret}),{status});Object.defineProperty(r,'url',{value:url});return r;
      }});
    const a=core.createHostIdentityAdaptersForTest(f.config,{...f.facility,transport:t});
    const result=await a.eligibility();assert.equal(result.diagnostic.status,status);assert(!JSON.stringify(result).includes(secret));
    assert.equal((await f.write(a)).outcome,'failed');
  }
});

test('maintained provider feeds the existing repository runner observer including bounded pagination',async()=>{
  const f=await fixture('compute'),id=f.context.repositoryId;
  f.config.operations.push(...[repo,repo+'/actions/runners'].map(endpoint=>({method:'GET',endpoint,target:id,operation:'deliver'})));
  const runner={id:99,name:'registered',os:'linux',status:'online',busy:false,
    labels:['self-hosted','linux','nibfin-user-42'].map(name=>({name,type:'custom'}))};
  f.replies[repo+'/actions/runners?per_page=100']={total_count:1,runners:[runner]};
  const a=f.make(),provider={request:r=>a.provider.request({...r,operation:'deliver'})};
  const target={owner:'example-org',repository:'core',id,ownerId:'17',ownerType:'Organization'};
  const input={target,registration:{level:'repository',id},records:[{instanceId:'one',runnerId:'99',memberId:'42',repositoryId:id,
    platform:'linux',registration:{level:'repository',id}}],conditions:{labels:['self-hosted','linux'],platform:'linux'},correlation:'observer'};
  const result=await core.observeRunners(provider,input);assert.equal(result.outcome,'matched');
  assert(f.calls.some(c=>c.endpoint===repo+'/actions/runners?per_page=100'));
  for(const query of ['?per_page=101','?page=0','?page=1&page=2','?name=foreign','?per_page=100&token=secret']) {
    const count=f.calls.length;
    assert.equal((await provider.request({method:'GET',endpoint:repo+'/actions/runners'+query,target:id,correlation:'bad'})).diagnostic.kind,'unsupported');
    assert.equal(f.calls.length,count);
  }
  f.replies[repo].permissions.admin=false;
  assert.equal((await core.observeRunners(provider,input)).outcome,'unavailable');
});

test('final source guard never awaits work after Grant validation and rejects source expiry during authorization',async()=>{
  const f=await fixture();let acquisitions=0,mutationTime;
  f.config.source.getToken=()=>{if(++acquisitions===2)f.state.time=2100;return f.state.token;};
  f.state.reply=r=>{if(r.method==='PATCH')mutationTime=f.state.time;
    return {status:200,body:JSON.stringify(r.method==='PATCH'?{id:123}:f.replies[r.endpoint])};};
  assert.equal((await f.write(f.make())).outcome,'submitted');
  assert.equal(acquisitions,1);assert(mutationTime<f.checkpoint.grant.payload.expiresAt);
  const g=await fixture();g.config.source.getToken=()=>{g.state.time=2100;return g.state.token;};
  assert.equal((await g.write(g.make())).outcome,'failed');assert.equal(writes(g),0);
  const h=await fixture();h.extendGrant(100000);h.state.token=await h.sign({exp:2});
  h.state.reply=r=>{if(r.endpoint===permission)h.state.time=2100;
    return {status:200,body:JSON.stringify(r.method==='PATCH'?{id:123}:h.replies[r.endpoint])};};
  assert.equal((await h.write(h.make())).outcome,'failed');assert.equal(writes(h),0);
});

test('source time is checked after acquisition and target reads before public downstream execution',async()=>{
  const f=await fixture();f.state.token=await f.sign({exp:2});
  f.config.source.getToken=()=>{f.state.time=2100;return f.state.token;};
  assert.equal((await entry(f).invoke()).status,'blocked');assert.equal(f.calls.length,0);assert.equal(f.state.lookup,0);
  const g=await fixture();g.state.reply=r=>{g.state.time=61000;return {status:200,body:JSON.stringify(g.replies[r.endpoint])};};
  assert.equal((await entry(g).invoke()).status,'blocked');assert.equal(g.state.lookup,0);
});

test('maximum source age remains binding across authorization, including predecessor policy and tolerance',async()=>{
  for(const predecessor of [false,true])for(const tolerance of [0,1]) {
    const boundary=(2+tolerance)*1000;
    for(const finalTime of [boundary-1,boundary]) {
      const f=await fixture();f.extendGrant(100000);f.state.time=boundary-1;
      let agePolicy=f.policy,token=f.state.token,association=f.association;
      if(predecessor) {
        const r=receipt(f);
        agePolicy={...f.policy,run_id:'43'};token=await f.sign({run_id:'43'});
        association={...f.association,run_id:'43'};
        f.config.source.continuation={kind:'cross-run',policy:agePolicy,
          current:{expected:structuredClone(r),consumed:[]},consumerExecution:'validator',maxAge:300,
          getEvidence:()=>({token,association,receipt:r,recordedAt:1})};
      }
      agePolicy.maxAge=1;agePolicy.tolerance=tolerance;
      const verifier=core.createSyntheticActionsVerifierForTest(f.facility.jwks);
      assert.equal((await verifier.authenticate(token,{...agePolicy,now:Math.floor((boundary-1)/1000)},association)).ok,true);
      assert.equal((await verifier.authenticate(token,{...agePolicy,now:boundary/1000},association)).ok,false);
      f.state.reply=r=>{if(r.endpoint===permission)f.state.time=finalTime;
        return {status:200,body:JSON.stringify(r.method==='PATCH'?{id:123}:f.replies[r.endpoint])};};
      const result=await f.write(f.make());
      assert.equal(result.outcome,finalTime<boundary?'submitted':'failed',JSON.stringify({predecessor,tolerance,finalTime,result}));
      assert.equal(writes(f),finalTime<boundary?1:0);
    }
  }
});


test('hosted credential acquisition precedes final source and signed Grant expiry checks',async()=>{
  for(const expiry of ['source','grant'])for(const delayed of [false,true]) {
    const f=await fixture();f.config.authorization.maxCheckpointMs=5000;
    if(expiry==='source') {f.extendGrant(100000);f.state.token=await f.sign({exp:2});}
    let acquisitions=0,mutations=0;
    const transport=core.hostedGithubTransport({repository:'example-org/core',repositoryId:f.context.repositoryId,
      operatorId:'7',now:()=>f.state.time,getCredential:async()=>{
        // The tenth acquisition was the mutation credential in the old ordering.
        // With preparation it belongs to the final authorization reads instead.
        if(++acquisitions===10 && delayed) {await Promise.resolve();f.state.time=2100;}
        return credential();
      },fetcher:async (url,args)=>{
        const endpoint=new URL(url).pathname;
        if(args.method==='PATCH')mutations++;
        const response=new Response(JSON.stringify(args.method==='GET'?f.replies[endpoint]:{id:123}),{status:200});
        Object.defineProperty(response,'url',{value:url});return response;
      }});
    const adapter=core.createHostIdentityAdaptersForTest(f.config,{...f.facility,transport});
    const result=await f.write(adapter);
    assert.equal(acquisitions,10);
    assert.equal(result.outcome,delayed?'failed':'submitted',JSON.stringify({expiry,delayed,result}));
    assert.equal(mutations,delayed?0:1);
    assert(!JSON.stringify(result).includes(secret));
  }
});


test('local gh login preparation cannot dispatch a mutation after source or signed Grant expiry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nibfin-gh-expiry-'));
  try {
    const executable=join(dir,'gh'),statePath=join(dir,'state.json');
    for(const expiry of ['source','grant'])for(const delayAt of [0,8,13]) {
      const f=await fixture('compute');f.config.authorization.maxCheckpointMs=5000;
      if(expiry==='source') {f.extendGrant(100000);f.state.token=await f.sign({exp:2});}
      await writeFile(statePath,JSON.stringify({time:1100,auth:0,calls:[]}));
      f.config.now=()=>JSON.parse(readFileSync(statePath,'utf8')).time;
      await writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs'),path=${JSON.stringify(statePath)};
const state=JSON.parse(fs.readFileSync(path,'utf8'));
if(['GH_TOKEN','GITHUB_TOKEN','GH_HOST','GH_CONFIG_DIR'].some(k=>process.env[k]))process.exit(99);
if(process.argv[2]==='auth') {
  if(++state.auth===${delayAt})state.time=2100;
  fs.writeFileSync(path,JSON.stringify(state));process.exit(0);
}
const method=process.argv[process.argv.indexOf('--method')+1],endpoint=new URL(process.argv.at(-1)).pathname;
state.calls.push({method,endpoint,time:state.time});fs.writeFileSync(path,JSON.stringify(state));
const replies=${JSON.stringify(f.replies)};
console.log('HTTP/2 200 OK\\ncontent-type: application/json\\n\\n'+JSON.stringify(method==='GET'?replies[endpoint]:{id:123}));
`);
      await chmod(executable,0o700);
      const transport=core.localGhTransport({executable});
      const adapter=core.createHostIdentityAdaptersForTest(f.config,{...f.facility,transport});
      const result=await f.write(adapter),state=JSON.parse(await readFile(statePath,'utf8'));
      const mutations=state.calls.filter(c=>c.method==='PATCH');
      // 13 was the old mutation auth; 8 is preparation before final authorization.
      assert.equal(state.auth,13);
      assert.equal(result.outcome,delayAt?'failed':'submitted',JSON.stringify({expiry,delayAt,result}));
      assert.equal(mutations.length,delayAt?0:1);
      if(!delayAt)assert.equal(mutations[0].time,1100);
      assert(!JSON.stringify(result).includes(secret));
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
