import test from'node:test';import assert from'node:assert/strict';
import{validateExecutionPool,poolInventoryRead,projectExecutionContext,validatePoolDispatch,poolDispatchAccess}from'../src/execution-pool.mjs';
import{operationsFixture,operationInput}from'../tooling/operations-fixture.mjs';
import{validateMemberBinding}from'../src/collaboration.mjs';
import{observeRunnerBindings}from'../src/runners.mjs';
import{hostedGithubTransport,createHostIdentityAdaptersForTest}from'../src/host-identity.mjs';
import{createHostRouting}from'../src/host-routing.mjs';
import{createGithubProvider}from'../src/provider.mjs';
import{validateHostOptions,configure}from'../host/entry.mjs';
import * as core from '../src/index.mjs';
import{hostIdentityFixture}from'../tooling/host-identity-fixture.mjs';
const identity=(repository,repositoryId)=>({version:1,repository,repositoryId,ownerId:'7',ownerType:'User'});
const source=identity('example/core','41'),targets=[source,identity('example/cli','42'),identity('example/action','43')];
const pool={version:1,source,targets},registration={level:'repository',id:'41'};
const dispatchPolicy={version:1,repository:'example/cli',repositoryId:'42',workflow:'50',ref:'main',
  sha:'b'.repeat(40),workflowDigest:'d'.repeat(64)};
function pooledOperation(){
  const input=operationInput('dispatch');input.binding.repository='example/cli';
  input.payload.ref='main';input.payload.refIdentity={sha:dispatchPolicy.sha,workflowDigest:dispatchPolicy.workflowDigest};
  input.payload.executionSource={repository:source.repository,repositoryId:source.repositoryId};
  return input;
}
const dispatchOptions={executionPool:pool,poolDispatch:dispatchPolicy};

test('pooled dispatch retains logical authorization and independently reads back the actual source Run',async()=>{
  const f=operationsFixture(pooledOperation());
  f.state.beforeWrite=r=>assert.equal(r.endpoint,'/repos/example/core/actions/workflows/50/dispatches');
  const result=await f.fresh(undefined,undefined,dispatchOptions).execute(f.input);
  assert.equal(result.outcome,'confirmed-success',JSON.stringify(result));
  assert.equal(result.observation.endpoint,'/repos/example/core/actions/runs/70');
  assert.equal(f.writes().length,1);
  assert.ok(f.calls.some(r=>r.checkpoint&&r.endpoint==='/repos/example/cli/issues/101'));
  assert.ok(!f.calls.some(r=>r.checkpoint&&r.endpoint==='/repos/example/core/issues/101'));
  assert.equal((await f.fresh(undefined,undefined,dispatchOptions).execute(f.input)).outcome,'confirmed-success');
  assert.equal(f.writes().length,1);
});

test('pool membership never supplies dispatch permission or a substitute protected workflow',async()=>{
  for(const edit of [v=>v.payload.executionSource.repository='example/action',v=>v.payload.executionSource.repositoryId='43',
    v=>delete v.payload.executionSource,v=>v.payload.ref='other',v=>v.payload.refIdentity.sha='e'.repeat(40),
    v=>v.payload.refIdentity.workflowDigest='e'.repeat(64),v=>{v.target.id='51';v.target.workflow='51';},
    v=>v.binding.repository='example/action']){
    const f=operationsFixture(pooledOperation());edit(f.input);
    assert.equal((await f.fresh(undefined,undefined,dispatchOptions).execute(f.input)).outcome,'unknown');
    assert.equal(f.writes().length,0);
  }
  const f=operationsFixture(pooledOperation());
  assert.equal((await f.fresh().execute(f.input)).outcome,'unknown');assert.equal(f.writes().length,0);
  assert.throws(()=>validatePoolDispatch(pool,{...dispatchPolicy,repositoryId:'43'}));
});

test('pooled dispatch cannot replay unknown effects or accept a logical-target Run as source readback',async()=>{
  for(const scenario of ['lost','absent','wrong-run','denied']){
    const f=operationsFixture(pooledOperation());
    if(scenario==='lost')f.state.lost=true;
    if(scenario==='absent')f.state.onWrite=()=>{f.state.effect=false;};
    if(scenario==='wrong-run')f.state.mutate=d=>({...d,repository:{id:'42'}});
    if(scenario==='denied')f.state.allowed=false;
    const expected=scenario==='lost'?'confirmed-success':scenario==='denied'?'confirmed-no-effect':'unknown';
    assert.equal((await f.fresh(undefined,undefined,dispatchOptions).execute(f.input)).outcome,expected,scenario);
    assert.equal(f.writes().length,scenario==='denied'?0:1);
    await f.fresh(undefined,undefined,dispatchOptions).execute(f.input);
    assert.equal(f.writes().length,scenario==='denied'?0:1);
  }
});

test('source transport requires an installed dispatch policy, exact workflow/ref and both repository credentials',async()=>{
  let covered=true;const calls=[];
  const make=policy=>hostedGithubTransport({repository:'example/cli',repositoryId:'42',executionPool:pool,
    ...(policy?{poolDispatch:policy}:{}),now:()=>1100,
    getCredential:()=>({token:'test-token',expiresAt:2000,repositoryIds:covered?['41','42']:['42'],permissions:{actions:'write'}}),
    fetcher:async(url,request)=>{calls.push({url,request});const r=new Response('{}');Object.defineProperty(r,'url',{value:url});return r;}});
  const transport=make(dispatchPolicy),write={method:'POST',endpoint:'/repos/example/core/actions/workflows/50/dispatches',
    operation:'dispatch',target:'50',body:JSON.stringify({ref:'main',inputs:{nibfin_correlation:'request-1'}})};
  assert.equal((await make()(write)).status,403);
  assert.equal((await transport(write)).status,200);const count=calls.length;
  for(const change of [r=>r.target='51',r=>r.operation='label',r=>r.endpoint=r.endpoint.replace('/50/','/51/'),
    r=>r.body=JSON.stringify({ref:'other',inputs:{}}),r=>r.endpoint='/repos/example/action/actions/workflows/50/dispatches']){
    const r=structuredClone(write);change(r);assert.equal((await transport(r)).status,403);
  }
  assert.equal(calls.length,count);covered=false;assert.equal((await transport(write)).failure,'authentication');
  assert.equal(calls.length,count);
  covered=true;
  // Use the real provider HTTP projection too: it omits target/operation after
  // completing its own authorization checkpoint, rather than passing fixtures.
  const provider=createGithubProvider({identity:'hosted-authorized',transport,authorize:()=>true,attempts:1,now:()=>1100});
  const submitted=await provider.request({...write,body:JSON.parse(write.body)});
  assert.equal(submitted.outcome,'submitted',JSON.stringify(submitted));
  assert.equal(calls.at(-1).request.body,write.body);
  for(const endpoint of ['/repos/example/core/actions/workflows/50/runs?event=workflow_dispatch&per_page=100',
    '/repos/example/core/actions/runs/70'])assert.equal(poolDispatchAccess(pool,dispatchPolicy,{...write,method:'GET',endpoint}),true);
  for(const endpoint of ['/repos/example/core/actions/workflows/51/runs?event=workflow_dispatch',
    '/repos/example/core/actions/workflows/50/runs?event=workflow_dispatch&event=issues',
    '/repos/example/core/actions/runs/70/artifacts','/repos/example/core/contents/private'])
    assert.equal(poolDispatchAccess(pool,dispatchPolicy,{...write,method:'GET',endpoint}),false);
});
const target=t=>({owner:'example',repository:t.repository.split('/')[1],id:t.repositoryId,ownerId:'7',ownerType:'User'});
const records=id=>['21','22'].map((runnerId,i)=>({version:2,instanceId:'local-'+i,runnerId,memberId:'8',
  repositoryId:id,executionRepositoryId:'41',registration,platform:'linux'}));
const actual=t=>({id:t.repositoryId,full_name:t.repository,private:false,visibility:'public',owner:{id:'7',login:'example',type:'User'},permissions:{admin:true}});
const runners=['21','22'].map(id=>({id,name:'runner-'+id,os:'linux',status:'online',busy:false,
  labels:['self-hosted','linux','x64','nibfin-user-8'].map(name=>({name,type:'custom'}))}));
function fixture(t=targets[1]){
  const calls=[],routes=Object.fromEntries(targets.map(t=>['/repos/'+t.repository,actual(t)]));
  routes['/repos/example/core/actions/runners?per_page=100']={total_count:2,runners};
  const underlying=createGithubProvider({attempts:1,now:()=>1100,transport:async r=>{
    assert.equal(r.method,'GET');const data=routes[r.endpoint];
    return {status:data?200:404,body:JSON.stringify(data??{})};
  }});
  const provider={request:r=>{calls.push(r);return underlying.request(r);}};
  return {calls,routes,provider,input:{target:target(t),registration,executionPool:pool,records:records(t.repositoryId),
    conditions:{platform:'linux',labels:['self-hosted','linux','x64']},correlation:'pool-test'}};
}
test('one explicit source and finite same-owner targets; invalid and ambiguous pools are rejected',()=>{
  const before=structuredClone(pool),checked=validateExecutionPool(pool);assert.deepEqual(pool,before);
  assert.ok(Object.isFrozen(checked)&&Object.isFrozen(checked.targets)&&Object.isFrozen(checked.source));
  const edits=[p=>p.version=2,p=>p.targets=[],p=>p.targets.push({...p.targets[1]}),p=>p.targets[1].repositoryId='41',
    p=>p.targets[1].ownerId='9',p=>p.targets[1].repository='other/cli',p=>p.targets[1].ownerType='Organization',
    p=>p.targets.shift(),p=>p.source.repository='Example/Core',p=>p.source.token='not-allowed'];
  for(const edit of edits){const p=structuredClone(pool);edit(p);assert.throws(()=>validateExecutionPool(p));}
});
test('the same two real registrations serve all three logical targets without target inventory fabrication',async()=>{
  const inventories=new Set();
  for(const t of targets){const f=fixture(t),r=await observeRunnerBindings(f.provider,f.input);
    assert.equal(r.outcome,'matched',JSON.stringify(r));assert.equal(r.inventory,'complete');
    assert.deepEqual(r.instances.map(i=>i.runnerId),['21','22']);
    f.calls.filter(c=>c.endpoint.includes('/actions/runners')).forEach(c=>inventories.add(c.endpoint));
    assert.ok(f.calls.every(c=>c.target===t.repositoryId));
  }
  assert.deepEqual([...inventories],['/repos/example/core/actions/runners?per_page=100']);
});
test('a pooled record cannot bypass legacy binding scope or substitute another source',async()=>{
  const r=records('42')[0];assert.throws(()=>validateMemberBinding(r,{repositoryId:'42',registration}));
  assert.equal(validateMemberBinding(r,{repositoryId:'42',registration,executionPool:pool}),r);
  for(const edit of [f=>delete f.input.executionPool,f=>f.input.records[0].version=1,
    f=>f.input.records[0].executionRepositoryId='42',f=>f.input.records[0].repositoryId='43',
    f=>f.input.registration={level:'repository',id:'42'},f=>f.input.target.id='99']){
    const f=fixture();edit(f);assert.notEqual((await observeRunnerBindings(f.provider,f.input)).outcome,'matched');
  }
});
test('source visibility, identity, owner and denied inventory are rechecked through actual provider observations',async()=>{
  for(const edit of [f=>f.routes['/repos/example/core'].private=true,
    f=>f.routes['/repos/example/core'].id='999',f=>f.routes['/repos/example/core'].owner.id='999',
    f=>delete f.routes['/repos/example/core/actions/runners?per_page=100']]){
    const f=fixture();edit(f);assert.notEqual((await observeRunnerBindings(f.provider,f.input)).outcome,'matched');
  }
});
test('cross-repository transport exposes only exact read-only source inventory with source token coverage',async()=>{
  const calls=[];let covered=true;
  const transport=hostedGithubTransport({repository:'example/cli',repositoryId:'42',executionPool:pool,now:()=>1100,
    getCredential:()=>({token:'test-token',expiresAt:2000,repositoryIds:covered?['41','42']:['42'],permissions:{administration:'read'}}),
    fetcher:async(url,request)=>{calls.push({url,method:request.method});const response=new Response('{}');
      Object.defineProperty(response,'url',{value:url});return response;}});
  assert.equal((await transport({method:'GET',endpoint:'/repos/example/core/actions/runners?per_page=100&page=2'})).status,200);
  const count=calls.length;
  for(const endpoint of ['/repos/example/core/contents/token','/repos/example/core/collaborators/member/permission',
    '/repos/other/core/actions/runners','/repos/example/core/actions/runners?page=1&page=2',
    '/repos/example/core/actions/runners?per_page=101','/repos/example/core/actions/runners?path=anything'])
    assert.equal((await transport({method:'GET',endpoint})).status,403,endpoint);
  for(const method of ['POST','DELETE','PATCH'])assert.equal((await transport({method,endpoint:'/repos/example/core/actions/runners'})).status,403);
  assert.equal(calls.length,count);covered=false;
  assert.equal((await transport({method:'GET',endpoint:'/repos/example/core/actions/runners'})).failure,'authentication');
  assert.equal(calls.length,count);
  assert.equal(poolInventoryRead(pool,{endpoint:'/repos/example/core/actions/runners?page=1001'}),false);
});
test('pool configuration stays protected and cannot enter unrelated host modes or group routing',()=>{
  const options={version:1,repository:'example/cli',repositoryId:'42',environment:'nibfin-member',authentication:'actions-oidc',routing:'authenticated',executionPool:pool};
  assert.deepEqual(validateHostOptions(options,'execute',validateExecutionPool).executionPool,pool);
  assert.throws(()=>validateHostOptions(options,'execute'));
  for(const edit of [o=>o.repositoryId='43',o=>o.groupId='3',o=>delete o.routing]){
    const o=structuredClone(options);edit(o);assert.throws(()=>validateHostOptions(o,'execute',validateExecutionPool));
  }
  assert.throws(()=>validateHostOptions({...options,environment:'nibfin-hosted'},'lookup'));
  assert.deepEqual(validateHostOptions({...options,environment:'nibfin-hosted'},'lookup',validateExecutionPool).executionPool,pool);
  const unpooled={...options,environment:'nibfin-hosted'};delete unpooled.executionPool;
  assert.throws(()=>validateHostOptions(unpooled,'lookup',validateExecutionPool));
  for(const mode of ['wake','registration','rescue'])
    assert.throws(()=>validateHostOptions({...options,environment:'nibfin-hosted'},mode,validateExecutionPool));
});
test('actual Runner verification binds logical target, real source, operator and observed Runner independently',async()=>{
  const f=fixture(),member={id:'8',login:'member'},run={id:'101',attempt:'1'};
  f.routes['/repos/example/cli/issues/1']={id:'100',node_id:'I_1',number:1,repository_url:'https://api.github.com/repos/example/cli',assignees:[member],labels:[{name:'scope'}]};
  f.routes['/users/member']=member;f.routes['/repos/example/cli/collaborators/member/permission']={permission:'write',user:member};
  const input={...f.input,issueId:'I_1',number:'1',operation:'deliver',execution:{repositoryId:'42',issueId:'I_1',operation:'deliver',observedAt:1100,state:'new'}};
  const request={id:'retained'},route={labels:['self-hosted','linux','x64','nibfin-user-8']};
  let observation={runnerId:'21',operatorId:'8',repository:'example/cli',repositoryId:'42',sourceRepository:'example/core',sourceRepositoryId:'41',run};
  const routing=createHostRouting({executionPool:pool,mode:'execute',now:()=>1100,maxCheckpointMs:50,
    adapters:{routing:{provider:f.provider},memberEligibility:async m=>({ok:true,observation:{repositoryId:'42',issueId:'I_1',memberId:m.id,operation:'deliver',observedAt:1100}}),observeExecution:async()=>observation},
    current:()=>({target:{repository:'example/cli',repositoryId:'42'},invocation:{run},selectionInput:input})});
  routing.bindResolution({memberId:'8',request,route});assert.equal((await routing.selector.select(input)).outcome,'selected');
  assert.equal(await routing.verifyRunner({memberId:'8',request,route}),true);
  for(const patch of [{runnerId:'99'},{operatorId:'9'},{repositoryId:'43'},{sourceRepositoryId:'42'},{sourceRepository:'example/action'},{run:{id:'102',attempt:'1'}}]){
    const before=observation;observation={...before,...patch};assert.equal(await routing.verifyRunner({memberId:'8',request,route}),false);observation=before;
  }
  const forged={...input,executionPool:{...pool,targets:[source]}};
  assert.equal((await routing.selector.select(forged)).reason,'execution_pool_unavailable');
});
test('signed Actions source policy must match the protected pool before authority is consulted',async()=>{
  for(const mode of ['lookup','resolve']){
  const f=await hostIdentityFixture(mode),source=identity('example-org/automation','91');source.ownerId='17';
  const target=identity('example-org/core','9007199254740993');target.ownerId='17';
  const p={version:1,source,targets:[source,target]};
  Object.assign(f.config.options,{routing:'authenticated',executionPool:p});
  Object.assign(f.policy,{repository:source.repository,repository_owner_id:'17',workflow_ref:source.repository+'/.github/workflows/stage.yml@refs/heads/main'});
  f.state.token=await f.sign({repository:f.policy.repository,repository_owner_id:'17',workflow_ref:f.policy.workflow_ref});
  f.replies['/repos/example-org/core'].owner.type='User';
  f.replies['/repos/example-org/automation']={...actual(source),owner:{id:'17',login:'example-org',type:'User'}};
  const adapter=createHostIdentityAdaptersForTest(f.config,f.facility);
  assert.equal((await adapter.authenticate(f.argument)).repositoryId,target.repositoryId);
  const count=f.calls.length;f.config.source.policy.repository_id='other';
  assert.throws(()=>createHostIdentityAdaptersForTest(f.config,f.facility));assert.equal(f.calls.length,count);
  }
});
test('approved pool context preserves the physical dispatch and Run while selecting only its protected logical target',()=>{
  const options={version:1,repository:'example/cli',repositoryId:'42',environment:'nibfin-member',authentication:'actions-oidc',routing:'authenticated',executionPool:pool};
  const context={repository:'example/core',repositoryId:'41',run:{id:'100',attempt:'1'},eventName:'workflow_dispatch',
    event:{repository:{id:'41'},inputs:{target:'untrusted/other'}},env:{secret:'must-not-project'}};
  const before=structuredClone(context),result=projectExecutionContext({options,mode:'execute',context});
  assert.deepEqual(context,before);assert.equal(result.repository,'example/cli');assert.equal(result.repositoryId,'42');
  assert.deepEqual(result.run,context.run);assert.deepEqual(result.event,context.event);assert.equal(result.env,undefined);
  for(const patch of [{repository:'example/action'},{repositoryId:'42'},{eventName:'issues'}])
    assert.throws(()=>projectExecutionContext({options,mode:'execute',context:{...context,...patch}}));
  assert.throws(()=>projectExecutionContext({options:{...options,repositoryId:'99'},mode:'execute',context}));
  assert.equal(projectExecutionContext({options:{...options,environment:'nibfin-hosted'},mode:'lookup',context}).repositoryId,'42');
  for(const mode of ['wake','registration','rescue'])assert.throws(()=>projectExecutionContext({options,mode,context}));
});

test('pooled lookup reaches only its protected logical target after source authentication and creates no Runner routing state',async()=>{
  const f=await hostIdentityFixture('lookup'),source={...identity('example-org/automation','91'),ownerId:'17'},
    target={...identity('example-org/core','9007199254740993'),ownerId:'17'},executionPool={version:1,source,targets:[source,target]};
  Object.assign(f.config.options,{routing:'authenticated',executionPool});
  Object.assign(f.policy,{repository:source.repository,repository_owner_id:'17',workflow_ref:source.repository+'/.github/workflows/stage.yml@refs/heads/main'});
  f.state.token=await f.sign({repository:f.policy.repository,repository_owner_id:'17',workflow_ref:f.policy.workflow_ref});
  f.replies['/repos/example-org/core'].owner.type='User';
  f.replies['/repos/example-org/automation']={...actual(source),owner:{id:'17',login:'example-org',type:'User'}};
  const physical={repository:source.repository,repositoryId:source.repositoryId,run:{id:f.policy.run_id,attempt:f.policy.run_attempt},
    eventName:'workflow_dispatch',event:{inputs:{target:'untrusted/other'}}};
  const context=projectExecutionContext({options:f.config.options,mode:'lookup',context:physical});
  const {options,mode,...identityConfiguration}=f.config;
  let calls=0,lookupTarget={repository:target.repository,repositoryId:target.repositoryId,number:'101'};
  const host=configure({core:{...core,createHostIdentityAdapters:c=>createHostIdentityAdaptersForTest(c,f.facility)},mode,context,
    deployment:{options,identity:identityConfiguration,capabilities:{lookup:async argument=>{
      calls++;assert.equal(argument.identity.repositoryId,target.repositoryId);assert.deepEqual(argument.context,undefined);return lookupTarget;
    }}}});
  assert.equal(host.bindResolution,undefined);assert.equal(host.runnerObservation,undefined);
  const entry=core.createWorkflowEntry(host),input={nibfin_request:'retained-request',nibfin_correlation:'original-correlation'};
  assert.deepEqual(await entry.invoke('lookup',input,context),{status:'resolved',issue:'101'});assert.equal(calls,1);
  lookupTarget={...lookupTarget,repository:'untrusted/other'};
  assert.equal((await entry.invoke('lookup',input,context)).status,'blocked');
  const before=calls;f.state.token=await f.sign({repository:'untrusted/other'});
  assert.equal((await entry.invoke('lookup',input,context)).status,'blocked');assert.equal(calls,before);
  assert.ok(f.calls.every(r=>r.method==='GET'));assert.deepEqual(f.handoffs,[]);
});

test('pooled Issue wakeup authenticates at its logical repo before dispatching toward a separate source',async()=>{
  const f=await hostIdentityFixture('wake'),source={...identity('example-org/automation','91'),ownerId:'17'},
    target={...identity('example-org/core','9007199254740993'),ownerId:'17'},executionPool={version:1,source,targets:[source,target]};
  f.config.options.executionPool=executionPool;
  Object.assign(f.policy,{repository:target.repository,repository_id:target.repositoryId,repository_owner_id:'17',
    workflow_ref:target.repository+'/.github/workflows/nibfin-wakeup.yml@refs/heads/main',event_name:'issues'});
  f.association.repository_id=target.repositoryId;f.context.eventName='issues';
  const claims=Object.fromEntries(['repository','repository_id','repository_owner_id','workflow_ref','event_name'].map(k=>[k,f.policy[k]]));
  f.state.token=await f.sign(claims);f.replies['/repos/example-org/core'].owner.type='User';
  f.replies['/repos/example-org/automation']={...actual(source),owner:{id:'17',login:'example-org',type:'User'}};
  const options=validateHostOptions(f.config.options,'wake',validateExecutionPool);
  const context=projectExecutionContext({options,mode:'wake',context:f.context});
  assert.equal(context.repository,target.repository);
  assert.equal((await f.make().authenticate({mode:'wake',context})).repositoryId,target.repositoryId);
  assert.throws(()=>projectExecutionContext({options,mode:'wake',context:{...context,repository:source.repository,repositoryId:source.repositoryId}}));
  assert.throws(()=>projectExecutionContext({options,mode:'wake',context:{...context,eventName:'workflow_dispatch'}}));
  f.state.token=await f.sign({...claims,repository:source.repository,repository_id:source.repositoryId});
  await assert.rejects(f.make().authenticate({mode:'wake',context}));
});
