import test from 'node:test';
import assert from 'node:assert/strict';
import {validateExecutionPool,projectExecutionContext} from '../src/execution-pool.mjs';
import {initialRunnerPoolCapacity,createRunnerPoolCapacity} from '../src/runner-pool-capacity.mjs';
import {workflowInstallation} from '../src/workflow-install.mjs';
const configuration=()=>({version:2,id:'member-pool',capacity:6,targets:Array.from({length:10},(_,i)=>({version:1,
 repository:'example/project-'+i,repositoryId:String(100+i),ownerId:'7',ownerType:'User'}))});
const request=i=>({id:'request-'+i,repository:'example/project-'+i,repositoryId:String(100+i),jobId:String(1000+i),runId:String(2000+i),attempt:'1'});
function fixture(){
 let value=initialRunnerPoolCapacity(configuration()),tail=Promise.resolve(),proof={};
 const records={update:fn=>{const next=tail.then(async()=>{const proposed=await fn(structuredClone(value));if(proposed)value=structuredClone(proposed);return structuredClone(value);});tail=next.catch(()=>{});return next;}};
 return {capacity:createRunnerPoolCapacity({configuration:configuration(),records,observeRelease:async lease=>({lease:lease.identity,...proof})}),
  state:()=>structuredClone(value),proof:v=>proof=v};
}
test('ten repositories share six physical slots; concurrent reservations cannot create ten runners',async()=>{
 const f=fixture(),results=await Promise.all(Array.from({length:10},(_,i)=>f.capacity.reserve(request(i))));
 assert.equal(results.filter(r=>r.status==='reserved').length,6);assert.equal(results.filter(r=>r.status==='waiting').length,4);
 assert.equal(new Set(Object.values(f.state().leases).map(l=>l.slot)).size,6);
 assert.equal((await f.capacity.reserve(request(0))).status,'retained');assert.equal(Object.keys(f.state().leases).length,6);
 await assert.rejects(f.capacity.reserve({...request(0),jobId:'9999'}),/request-reuse/);
 assert.equal((await f.capacity.release(request(0))).status,'retained');assert.equal((await f.capacity.reserve(request(6))).status,'waiting');
 f.proof({processTerminated:true,registrationRemoved:true,cleanupConfirmed:true});assert.equal((await f.capacity.release(request(0))).status,'released');
 assert.equal((await f.capacity.reserve(request(0))).status,'completed');
 assert.equal((await f.capacity.reserve(request(6))).lease.slot,1);assert.equal(Object.keys(f.state().leases).length,6);
 await assert.rejects(f.capacity.reserve({...request(9),repository:'outside/project'}),/repository/);
});
test('workflow installation keeps all stage, delivery and rescue files in each project with no central source',()=>{
 const pool=validateExecutionPool(configuration());assert.equal(pool.capacity,6);assert.equal(pool.targets.length,10);assert.equal(pool.source,undefined);
 for(const target of pool.targets){
  const plan=workflowInstallation({commit:'a'.repeat(40),hostRepository:'taco3064/nibfin',hostCommit:'b'.repeat(40),executionPool:pool,repository:target.repository});
  for(const name of ['nibfin-stage.yml','nibfin-delivery.yml','nibfin-rescue.yml'])assert.ok(plan.files.has('.github/workflows/'+name));
  assert.equal(plan.repository,target.repository);assert.equal(plan.deployments,undefined);
  assert.ok(![...plan.files.keys()].some(p=>/nibfin-stage-[0-9]+/.test(p)));
  const options={repository:target.repository,repositoryId:target.repositoryId,authentication:'actions-oidc',executionPool:pool};
  const context={repository:target.repository,repositoryId:target.repositoryId,run:{id:'2000',attempt:'1'},eventName:'workflow_dispatch'};
  assert.equal(projectExecutionContext({options,mode:'compute',context}).repository,target.repository);
  assert.throws(()=>projectExecutionContext({options,mode:'compute',context:{...context,repository:'example/central',repositoryId:'999'}}));
 }
 assert.throws(()=>workflowInstallation({commit:'a'.repeat(40),hostRepository:'taco3064/nibfin',hostCommit:'b'.repeat(40),executionPool:pool}),/pool-repository-required/);
 assert.throws(()=>validateExecutionPool({...configuration(),source:configuration().targets[0]}));
});
test('capacity and membership are independent, including one slot for many projects and multiple owners',()=>{
 assert.equal(validateExecutionPool({...configuration(),capacity:1}).targets.length,10);
 const p=configuration();p.targets[9]={...p.targets[9],repository:'other-org/project',ownerId:'8',ownerType:'Organization'};
 assert.equal(validateExecutionPool(p).targets[9].ownerType,'Organization');
 for(const capacity of [0,129,1.5,'6'])assert.throws(()=>validateExecutionPool({...p,capacity}));
});
