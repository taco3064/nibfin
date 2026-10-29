import test from'node:test';import assert from'node:assert/strict';
import{validateExecutionPool,poolInventoryRead}from'../src/execution-pool.mjs';
import{validateMemberBinding}from'../src/collaboration.mjs';
import{observeRunnerBindings}from'../src/runners.mjs';
import{hostedGithubTransport,createHostIdentityAdaptersForTest}from'../src/host-identity.mjs';
import{createHostRouting}from'../src/host-routing.mjs';
import{createGithubProvider}from'../src/provider.mjs';
import{validateHostOptions}from'../host/entry.mjs';
import{hostIdentityFixture}from'../tooling/host-identity-fixture.mjs';
const identity=(repository,repositoryId)=>({version:1,repository,repositoryId,ownerId:'7',ownerType:'User'});
const source=identity('example/core','41'),targets=[source,identity('example/cli','42'),identity('example/action','43')];
const pool={version:1,source,targets},registration={level:'repository',id:'41'};
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
  const f=await hostIdentityFixture('resolve'),source=identity('example-org/automation','91');source.ownerId='17';
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
});
