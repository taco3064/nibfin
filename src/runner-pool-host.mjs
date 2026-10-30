import {validateExecutionPool} from './execution-pool.mjs';
import {contentIdentity} from './evidence.mjs';
import {canonicalJSON} from './canonical.mjs';
import {githubId,memberRunnerLabel} from './identity.mjs';
import {validDisplayStage} from './action-display.mjs';
const need=(ok,code)=>{if(!ok)throw Error('runner-pool-host:'+code);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const phases=['prepare-intent','prepared','registration-intent','issued','admitted','launch-intent','active',
 'outcome-retained','remove-intent','removed','cleaned','released'];
const seal=value=>{const {identity,...body}=value;return {...body,identity:contentIdentity(body)};};
/** First-party infrastructure owner. Protected source independently authenticates
 * each current queued Job. Physical allocation is not delivery selection or
 * permission. Runtime owns verified distribution/admission, process custody,
 * private JIT configuration, original-work retention and confirmed cleanup.
 * No executable capability or credential can be supplied by a workflow input.
 */
export function createRunnerPoolHost({configuration,memberId,capacity,records,source,provider,runtime}={}){
 const pool=validateExecutionPool(configuration);need(pool.version===2,'repository-local-pool-required');githubId(memberId);
 need(['reserve','release'].every(k=>typeof capacity?.[k]==='function')
  &&['read','write'].every(k=>typeof records?.[k]==='function')&&['inspect','blocked'].every(k=>typeof source?.[k]==='function')
  &&typeof provider?.request==='function'
  &&['prepare','storeConfiguration','installAdmission','start','observe','retainOutcome','cleanup'].every(k=>typeof runtime?.[k]==='function'),'capabilities');
 const busy=new Set();
 function validate(record,request){
  const {identity,...body}=record;
  need(hash(identity)&&identity===contentIdentity(body)&&record.version===1&&same(record.request,request)
   &&record.memberId===memberId&&phases.includes(record.phase)&&hash(record.lease.identity)
   &&same(record.lease.request,request)&&Number.isSafeInteger(record.lease.slot)&&record.lease.slot>=1&&record.lease.slot<=pool.capacity
   &&record.lease.identity===contentIdentity({pool:contentIdentity(pool),request,slot:record.lease.slot})
   &&record.runnerName==='nibfin-'+record.lease.identity.slice(0,40),'record');
  return record;
 }
 async function save(old,patch){
  const next=seal({...old,...patch});
  need((await records.write({id:next.request.id,expected:old.identity??null,value:next}))?.status==='retained','retention');return next;
 }
 return Object.freeze({async advance(id,{signal}={}){
  need(typeof id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(id),'selector');
  if(busy.has(id))return {status:'waiting',reason:'request-active'};busy.add(id);
  let record;
  try{
   const approved=await source.inspect(id,{signal});
   need(approved?.authorized===true&&hash(approved.identity)&&approved.memberId===memberId&&validDisplayStage(approved.stage)
    &&/^[1-9][0-9]*$/.test(approved.issue),'source');
   const request=approved.request;need(request.id===id&&pool.targets.some(t=>t.repository===request.repository&&t.repositoryId===request.repositoryId),'target');
   const fresh=async()=>{need(!signal?.aborted,'cancelled');const current=await source.inspect(id,{signal});
    need(current.authorized===true&&current.identity===approved.identity&&current.memberId===memberId&&same(current.request,request)
     &&current.issue===approved.issue&&current.stage===approved.stage,'source-changed');return current;};
   record=await records.read(id);
   if(record){validate(record,request);need(record.sourceIdentity===approved.identity,'source-changed');
    if(record.phase==='released')return {status:'released',slot:record.lease.slot};}
   else{
    need(approved.status==='queued','not-queued');const reserved=await capacity.reserve(request);
    if(reserved.status==='waiting')return reserved;
    need(['reserved','retained'].includes(reserved.status),'allocation');
    record={version:1,request,memberId,lease:reserved.lease,runnerName:'nibfin-'+reserved.lease.identity.slice(0,40),
     issue:approved.issue,stage:approved.stage,sourceIdentity:approved.identity,phase:'prepare-intent'};
    record=await save(record,{});
    const prepared=await runtime.prepare(record,{signal});need(hash(prepared?.identity),'preparation');
    record=await save(record,{phase:'prepared',prepared:prepared.identity});
   }
   const api=async(method,endpoint,body)=>provider.request({method,endpoint,target:request.repositoryId,
    operation:'runner-pool',correlation:id,signal,...(body===undefined?{}:{body})});
   const root='/repos/'+request.repository;
   if(record.phase==='prepared'){
    await fresh();record=await save(record,{phase:'registration-intent'});
    const response=await api('POST',root+'/actions/runners/generate-jitconfig',{name:record.runnerName,runner_group_id:1,
     labels:['self-hosted','linux','x64',memberRunnerLabel(memberId),'nibfin-request-'+id],work_folder:'_work'});
    need(response.outcome==='submitted','registration-unconfirmed');const r=response.data?.runner;
    githubId(r?.id);need(r.name===record.runnerName&&r.ephemeral===true
     &&typeof response.data.encoded_jit_config==='string'&&response.data.encoded_jit_config.length<=2097152
     &&/^[A-Za-z0-9+/]+={0,2}$/.test(response.data.encoded_jit_config),'registration-response');
    const stored=await runtime.storeConfiguration(record,response.data,{signal});need(hash(stored?.identity),'configuration-retention');
    record=await save(record,{phase:'issued',runnerId:r.id,configuration:stored.identity});
   }
   if(record.phase==='issued'){
    await fresh();const checked=await runtime.installAdmission(record,{signal});need(checked?.status==='installed'&&hash(checked.identity),'admission');
    record=await save(record,{phase:'admitted',admission:checked.identity});
   }
   if(record.phase==='admitted'){
    await fresh();record=await save(record,{phase:'launch-intent'});
    const started=await runtime.start(record,{signal});need(started?.status==='started'&&started.lease===record.lease.identity,'launch-unconfirmed');
    record=await save(record,{phase:'active'});
   }
   if(['active','launch-intent'].includes(record.phase)){
    const observation=await runtime.observe(record,{signal});need(observation?.lease===record.lease.identity,'process-binding');
    if(observation.status==='running')return {status:'running',slot:record.lease.slot,runnerId:record.runnerId};
    need(observation.status==='terminated'&&observation.job?.id===request.jobId&&observation.job.run_id===request.runId
     &&observation.job.status==='completed'&&observation.job.runner_id===record.runnerId,'execution-unconfirmed');
    const retained=await runtime.retainOutcome(record,observation,{signal});need(retained?.status==='retained'&&hash(retained.identity),'outcome-retention');
    record=await save(record,{phase:'outcome-retained',outcome:retained.identity});
   }
   if(['outcome-retained','remove-intent'].includes(record.phase)){
    await fresh();let remote=await api('GET',root+'/actions/runners/'+record.runnerId);
    if(!(remote.outcome==='failed'&&remote.diagnostic?.status===404)){
     need(remote.outcome==='read'&&remote.data?.id===record.runnerId&&remote.data.name===record.runnerName&&remote.data.busy===false,'remote-unconfirmed');
     need(record.phase!=='remove-intent','removal-reconciliation-required');
     record=await save(record,{phase:'remove-intent'});await fresh();
     const removed=await api('DELETE',root+'/actions/runners/'+record.runnerId);need(removed.outcome==='submitted','removal-unconfirmed');
     await fresh();remote=await api('GET',root+'/actions/runners/'+record.runnerId);
     need(remote.outcome==='failed'&&remote.diagnostic?.status===404,'removal-readback');
    }
    record=await save(record,{phase:'removed'});
   }
   if(record.phase==='removed'){
    const cleaned=await runtime.cleanup(record,{signal});need(cleaned?.status==='completed'&&cleaned.lease===record.lease.identity,'cleanup-unconfirmed');
    record=await save(record,{phase:'cleaned'});
   }
   if(record.phase==='cleaned'){
    need((await capacity.release(request)).status==='released','release-unconfirmed');record=await save(record,{phase:'released'});
    return {status:'released',slot:record.lease.slot};
   }
   // A crash during preparation/registration never becomes permission to replay.
   need(false,'original-intent-reconciliation-required');
  }catch{
   let notification='unavailable';try{const r=await source.blocked({request:id,phase:record?.phase??'source',
    reason:'registration-or-execution-unconfirmed',...(record?{record:structuredClone(record)}:{})});
    if(r?.status==='retained')notification='retained';}catch{}
   return {status:'unresolved',reason:'registration-or-execution-unconfirmed',notification,...(record?{slot:record.lease.slot}:{})};
  }
  finally{busy.delete(id);}
 }});
}
