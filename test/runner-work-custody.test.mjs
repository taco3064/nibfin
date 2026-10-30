import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunnerWorkCustody} from '../src/runner-work-custody.mjs';
import {contentIdentity} from '../src/evidence.mjs';
const configuration={version:2,id:'member-default',capacity:2,targets:[{version:1,repository:'example/project',repositoryId:'100',ownerId:'7',ownerType:'User'}]};
const request={id:'request-0',repository:'example/project',repositoryId:'100',jobId:'200',runId:'300',attempt:'1'};
const seal=body=>({...body,identity:contentIdentity(body)});
function fixture(){
 const lease={request,slot:1,identity:contentIdentity({pool:contentIdentity(configuration),request,slot:1})};
 const record=seal({request,lease,runnerId:'700',phase:'active'});
 let stored=null,snapshot=null,captures=0;const flags={terminated:true,removed:true,changed:false,lost:false};
 const query={lease:lease.identity,request,process:'a'.repeat(64),job:{id:'200',run_id:'300',run_attempt:1,runner_id:'700',status:'completed',conclusion:'failure'}};
 const create=()=>createRunnerWorkCustody({configuration,expected:async()=>structuredClone(record),
  records:{read:async()=>stored,write:async({expected,value})=>{assert.equal(stored?.identity??null,expected);stored=value;
   if(flags.lost&&value.phase==='retained')throw Error('lost reply');return {status:'retained'};}},
  snapshots:{capture:async()=>{captures++;snapshot=contentIdentity({lease:lease.identity,original:'UNACCEPTED WORK'});return {lease:lease.identity,identity:snapshot};},
   verify:async()=>({lease:lease.identity,identity:snapshot,verified:!flags.changed})},
  resources:{observe:async()=>({lease:lease.identity,processesTerminated:flags.terminated,resourcesRemoved:flags.removed})}});
 return {query,create,flags,get stored(){return stored;},get captures(){return captures;}};
}
test('failed Job work is preserved once and only actual resource observations permit release',async()=>{
 const f=fixture(),owner=f.create();assert.deepEqual(await owner.read(f.query),{status:'absent'});
 f.flags.terminated=false;await assert.rejects(owner.retain(f.query),/work-still-running/);assert.equal(f.captures,0);
 f.flags.terminated=true;f.flags.removed=false;const kept=await owner.retain(f.query);
 assert.equal(kept.status,'retained');assert.equal(f.stored.job.conclusion,'failure');
 assert.deepEqual(await owner.read(f.query),kept);assert.equal(f.captures,1);
 const state=await owner.observe(f.query);assert.equal(state.workRetained,true);assert.equal(state.resourcesRemoved,false);
 f.flags.removed=true;assert.equal((await owner.observe(f.query)).resourcesRemoved,true);
 assert.deepEqual(await owner.retain(f.query),kept);assert.equal(f.captures,1);
});
test('lost acknowledgement recovers retained bytes but changed work, process or request cannot certify custody',async()=>{
 const f=fixture();f.flags.lost=true;await assert.rejects(f.create().retain(f.query),/lost reply/);
 f.flags.lost=false;assert.equal((await f.create().read(f.query)).status,'retained');assert.equal(f.captures,1);
 await assert.rejects(f.create().retain({...f.query,process:'b'.repeat(64)}),/outcome-changed/);
 await assert.rejects(f.create().read({...f.query,request:{...request,jobId:'201'}}),/binding/);
 f.flags.changed=true;await assert.rejects(f.create().read(f.query),/retained-bytes/);
 await assert.rejects(f.create().observe(f.query),/retained-bytes/);
});
test('an interrupted capture is retained as unresolved and never silently repeated',async()=>{
 const f=fixture();f.flags.changed=true;await assert.rejects(f.create().retain(f.query),/captured-bytes/);
 f.flags.changed=false;assert.equal((await f.create().read(f.query)).status,'unresolved');
 await assert.rejects(f.create().retain(f.query),/original-capture-reconciliation-required/);assert.equal(f.captures,1);
});
