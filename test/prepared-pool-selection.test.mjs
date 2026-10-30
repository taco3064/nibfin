import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssigneeSelector} from '../src/selection.mjs';
import {contentIdentity} from '../src/evidence.mjs';
const pool={version:2,id:'member-default',capacity:2,targets:[{version:1,repository:'example/project',repositoryId:'100',ownerId:'7',ownerType:'User'}]};
function fixture(){
 let authorized=true,ready='ready';const calls=[],checks=[];
 const issue={id:'123',node_id:'I_123',number:55,repository_url:'https://api.github.com/repos/example/project',labels:[{name:'scope'}],assignees:[{id:'7',login:'member'}]};
 const input={target:{id:'100',owner:'example',repository:'project',ownerId:'7',ownerType:'User'},registration:{level:'repository',id:'100'},
  executionPool:pool,issueId:'I_123',number:'55',operation:'request-0',conditions:{platform:'linux',labels:['x64','nibfin-request-request-0']},records:[],
  execution:{repositoryId:'100',issueId:'I_123',operation:'request-0',observedAt:1000,state:'new'}};
 const options={executionPool:pool,maxCheckpointMs:100,now:()=>1000,
  provider:{request:async r=>{calls.push(r);if(r.endpoint==='/repos/example/project/issues/55')return {outcome:'read',observedAt:1000,data:structuredClone(issue)};
   if(r.endpoint==='/repos/example/project/collaborators/member/permission')return {outcome:'read',observedAt:1000,data:{permission:'write',user:{id:'7',login:'member'}}};
   throw Error('No online Runner inventory exists');}},
  authorizationFor:member=>({eligibility:async()=>({ok:authorized,observation:{repositoryId:'100',issueId:'I_123',memberId:member.id,operation:'request-0',observedAt:1000}})}),
  poolReadiness:async q=>{checks.push(q);return {memberId:q.memberId,pool:contentIdentity(pool),status:ready,observedAt:1000};}};
 return {input,issue,options,calls,checks,setAuthorization:v=>authorized=v,setReadiness:v=>ready=v};
}
test('authenticated prepared member is routable with zero registered Runners; no fake online observation or JIT write',async()=>{
 const f=fixture(),selector=createAssigneeSelector(f.options);assert.equal(f.calls.length,0);assert.equal(f.checks.length,0);
 const selected=await selector.select(f.input);assert.equal(selected.outcome,'selected');assert.equal(selected.reason,'prepared_member');
 assert.equal(selected.memberId,'7');assert.deepEqual(selected.routing.labels,['self-hosted','linux','x64','nibfin-request-request-0','nibfin-user-7']);
 assert.equal(f.checks.length,1);assert.ok(f.calls.every(r=>r.method==='GET'&&!r.endpoint.includes('/actions/runners')));
 assert.equal(selected.observation.source,'github-api');assert.ok(!JSON.stringify(selected).includes('online'));
});
test('prepared capacity cannot bypass scope, current authorization, protected pool or request binding',async()=>{
 for(const mutate of [f=>f.setAuthorization(false),f=>f.input.executionPool={...pool,capacity:3},
  f=>f.input.registration={level:'organization',id:'7'},f=>f.input.conditions.labels=['x64'],
  f=>f.input.conditions.labels.push('nibfin-request-second'),f=>f.input.conditions.labels[1]='nibfin-request-UPPER']){
  const f=fixture();mutate(f);const r=await createAssigneeSelector(f.options).select(f.input);assert.equal(r.outcome,'blocked');assert.ok(!r.routing);
 }
 const f=fixture();f.issue.labels=[];assert.equal((await createAssigneeSelector(f.options).select(f.input)).reason,'missing_scope');assert.equal(f.checks.length,0);
});
test('unavailable host stays waiting; readiness cannot be supplied as untrusted input data',async()=>{
 const f=fixture();f.setReadiness('unavailable');f.input.poolReadiness={status:'ready'};
 assert.equal((await createAssigneeSelector(f.options).select(f.input)).outcome,'waiting');
 assert.throws(()=>createAssigneeSelector({...f.options,executionPool:undefined}),/protected pool/);
 assert.throws(()=>createAssigneeSelector({...f.options,poolReadiness:undefined}),/protected pool/);
});
