import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.mjs';
function fixture(capacity=2){
 const pool={version:2,id:'member-default',capacity,targets:Array.from({length:10},(_,i)=>({version:1,
  repository:'example/project-'+i,repositoryId:String(100+i),ownerId:'7',ownerType:'User'}))};
 let allocation=core.initialRunnerPoolCapacity(pool),tail=Promise.resolve();const jobs=new Map(),runners=new Map(),calls=[],blocks=[],retained=[];
 const flags={unknown:false,running:true,cleanup:true,startUnknown:false,changed:false},created=new Map();
 const records={read:async id=>structuredClone(jobs.get(id)??null),write:async({id,expected,value})=>{
  if((jobs.get(id)?.identity??null)!==expected)return{status:'conflict'};jobs.set(id,structuredClone(value));return{status:'retained'};}};
 const slots=core.createRunnerPoolCapacity({configuration:pool,records:{update:fn=>{
  const next=tail.then(()=>{const value=fn(structuredClone(allocation));if(value)allocation=structuredClone(value);return allocation;});tail=next.catch(()=>{});return next;
 }},observeRelease:async lease=>({lease:lease.identity,processTerminated:!flags.running,registrationRemoved:!runners.has(lease.request.id),cleanupConfirmed:flags.cleanup})});
 const request=i=>({id:'request-'+i,repository:'example/project-'+i,repositoryId:String(100+i),jobId:String(200+i),runId:String(300+i),attempt:'1'});
 const source={inspect:async id=>{const i=Number(id.slice(8)),r=request(i);return {authorized:!flags.denied,request:r,
  identity:core.contentIdentity({r,revision:flags.changed?'changed':'original'}),memberId:'7',issue:'55',stage:'deliver',status:'queued'};},
  blocked:async value=>{blocks.push(value);return{status:'retained'};}};
 const provider=core.createGithubProvider({attempts:1,authorize:r=>r.operation==='runner-pool'&&['POST','DELETE'].includes(r.method),transport:async r=>{
  calls.push(r);const match=r.endpoint.match(/project-([0-9]+)/),id='request-'+match[1];
  if(r.method==='POST'){
   if(flags.unknown)throw Error('lost response after unknown effect');const body=JSON.parse(r.body),runner={id:String(1000+Number(match[1])),name:body.name,ephemeral:true,busy:false};
   runners.set(id,runner);return{status:201,body:JSON.stringify({runner,encoded_jit_config:Buffer.from('JIT-SECRET-FIXTURE').toString('base64')})};
  }
  if(r.method==='DELETE'){runners.delete(id);return{status:204,body:''};}
  return{status:runners.has(id)?200:404,body:JSON.stringify(runners.get(id)??{})};
 }});
 const runtime={prepare:async r=>({identity:core.contentIdentity(r.request)}),storeConfiguration:async(r,data)=>{
  created.set(r.request.id,data.encoded_jit_config);return {identity:core.contentIdentity({id:r.request.id})};},
  installAdmission:async r=>({status:'installed',identity:core.contentIdentity({admission:r.request.id})}),
  start:async r=>{flags.starts=(flags.starts??0)+1;if(flags.startUnknown)throw Error('process may already exist');return{status:'started',lease:r.lease.identity};},
  observe:async r=>({lease:r.lease.identity,status:flags.running?'running':'terminated',job:{id:r.request.jobId,run_id:r.request.runId,runner_id:r.runnerId,status:'completed',conclusion:'failure'}}),
  retainOutcome:async(r,observation)=>{retained.push(observation);return {status:'retained',identity:core.contentIdentity(observation)};},
  cleanup:async r=>({status:flags.cleanup?'completed':'unresolved',lease:r.lease.identity})};
 const make=()=>core.createRunnerPoolHost({configuration:pool,memberId:'7',capacity:slots,records,source,provider,runtime});
 return {make,request,flags,allocation:()=>allocation,jobs,runners,calls,blocks,retained,created};
}
test('on-demand lifecycle registers only the Job repository, installs admission before launch and retains work before removal',async()=>{
 const f=fixture(),host=f.make();assert.equal((await host.advance('request-0')).status,'running');
 assert.equal(f.calls.filter(r=>r.method==='POST').length,1);assert.ok(f.calls[0].endpoint.startsWith('/repos/example/project-0/'));
 const body=JSON.parse(f.calls[0].body);assert.ok(body.labels.includes('nibfin-request-request-0'));
 const privateRecord=JSON.stringify(f.jobs.get('request-0'));assert.ok(!privateRecord.includes('JIT-SECRET'));assert.ok(!privateRecord.includes(f.created.get('request-0')));
 f.flags.running=false;const r=await f.make().advance('request-0');assert.equal(r.status,'released');assert.equal(f.retained.length,1);
 assert.equal(f.jobs.get('request-0').phase,'released');assert.equal(Object.keys(f.allocation().leases).length,0);
 assert.equal((await host.advance('request-0')).status,'released');assert.equal(f.flags.starts,1);
});
test('unknown JIT writes retain capacity, notify diagnosis and cannot be replayed after a host restart',async()=>{
 const f=fixture();f.flags.unknown=true;
 assert.equal((await f.make().advance('request-0')).status,'unresolved');assert.equal(f.jobs.get('request-0').phase,'registration-intent');
 assert.equal((await f.make().advance('request-0')).diagnosis,'retained');assert.equal(f.calls.filter(r=>r.method==='POST').length,1);
 assert.equal(Object.keys(f.allocation().leases).length,1);assert.equal(f.flags.starts,undefined);assert.equal(f.blocks.length,2);
});
test('lost launch acknowledgement adopts the actual running process instead of launching a duplicate',async()=>{
 const f=fixture();f.flags.startUnknown=true;assert.equal((await f.make().advance('request-0')).status,'unresolved');
 assert.equal(f.jobs.get('request-0').phase,'launch-intent');assert.equal((await f.make().advance('request-0')).status,'running');
 assert.equal(f.flags.starts,1);assert.equal(f.calls.filter(r=>r.method==='POST').length,1);
});
test('failed cleanup keeps its slot and original result until confirmed, even when the GitHub Job failed',async()=>{
 const f=fixture();await f.make().advance('request-0');f.flags.running=false;f.flags.cleanup=false;
 assert.equal((await f.make().advance('request-0')).status,'unresolved');assert.equal(Object.keys(f.allocation().leases).length,1);
 assert.equal(f.retained[0].job.conclusion,'failure');assert.equal(f.jobs.get('request-0').phase,'removed');
 f.flags.cleanup=true;assert.equal((await f.make().advance('request-0')).status,'released');assert.equal(f.retained.length,1);
});
test('ten concurrent project Jobs use at most six physical slots and never multiply capacity per repository',async()=>{
 const f=fixture(6),host=f.make(),results=await Promise.all(Array.from({length:10},(_,i)=>host.advance('request-'+i)));
 assert.equal(results.filter(r=>r.status==='running').length,6);assert.equal(results.filter(r=>r.status==='waiting').length,4);
 assert.equal(f.calls.filter(r=>r.method==='POST').length,6);assert.equal(Object.keys(f.allocation().leases).length,6);
});
test('changed authority or a denied source cannot register or resume an existing request',async()=>{
 const f=fixture();f.flags.denied=true;assert.equal((await f.make().advance('request-0')).status,'unresolved');assert.equal(f.calls.length,0);
 f.flags.denied=false;await f.make().advance('request-0');f.flags.changed=true;
 assert.equal((await f.make().advance('request-0')).status,'unresolved');assert.equal(f.flags.starts,1);
});
