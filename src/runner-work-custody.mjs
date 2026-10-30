import {canonicalJSON} from './canonical.mjs';
import {contentIdentity} from './evidence.mjs';
import {validateExecutionPool} from './execution-pool.mjs';
import {githubId} from './identity.mjs';
const need=(ok,code)=>{if(!ok)throw Error('runner-work-custody:'+code);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const seal=body=>({...body,identity:contentIdentity(body)});

/** Core owns preservation of an actual Runner's original work. This receipt is
 * infrastructure custody, never Candidate, Acceptance or delivery authority.
 * Physical reads/copies live in the maintained host; no capability comes from a
 * workflow input, Issue body, public configuration or a model response.
 */
export function createRunnerWorkCustody({configuration,expected,records,snapshots,resources}={}){
 const pool=validateExecutionPool(configuration);need(pool.version===2,'configuration');
 need(typeof expected==='function'&&['read','write'].every(k=>typeof records?.[k]==='function')
  &&['capture','verify'].every(k=>typeof snapshots?.[k]==='function')&&typeof resources?.observe==='function','capabilities');
 async function binding(query){
  need(hash(query?.lease)&&query.request&&typeof query.request.id==='string','selector');
  const record=await expected(query.request.id);
  need(record&&record.lease?.identity===query.lease&&same(record.request,query.request)
   &&same(record.lease.request,query.request)&&Number.isSafeInteger(record.lease.slot)
   &&record.lease.slot>=1&&record.lease.slot<=pool.capacity
   &&record.lease.identity===contentIdentity({pool:contentIdentity(pool),request:record.request,slot:record.lease.slot})
   &&pool.targets.some(t=>t.repository===record.request.repository&&t.repositoryId===record.request.repositoryId),'binding');
  const {identity,...body}=record;need(hash(identity)&&identity===contentIdentity(body),'expected-integrity');
  for(const k of ['repositoryId','jobId','runId','attempt'])githubId(record.request[k]);
  return record;
 }
 function receipt(value,record){
  const {identity,...body}=value;
  need(value.version===1&&hash(identity)&&identity===contentIdentity(body)
   &&value.lease===record.lease.identity&&same(value.request,record.request)
   &&['intent','retained'].includes(value.phase)&&hash(value.process),'receipt');
  const job=value.job;
  need(job?.id===record.request.jobId&&job.run_id===record.request.runId
   &&String(job.run_attempt)===record.request.attempt&&job.runner_id===record.runnerId&&job.status==='completed'
   &&typeof job.conclusion==='string'&&job.conclusion.length>0,'job');
  if(value.phase==='retained')need(hash(value.snapshot),'snapshot');
  return value;
 }
 async function retained(record){
  const found=await records.read(record.lease.identity);if(found===null)return null;
  receipt(found,record);if(found.phase!=='retained')return found;
  const verified=await snapshots.verify({lease:found.lease,identity:found.snapshot,request:structuredClone(found.request)});
  need(verified?.lease===found.lease&&verified.identity===found.snapshot&&verified.verified===true,'retained-bytes');return found;
 }
 async function observed(record,signal){
  const observation=await resources.observe({lease:record.lease.identity,request:structuredClone(record.request),signal});
  need(observation?.lease===record.lease.identity&&typeof observation.processesTerminated==='boolean'
   &&typeof observation.resourcesRemoved==='boolean','resource-observation');return observation;
 }
 const result=value=>({status:'retained',lease:value.lease,identity:value.identity});
 return Object.freeze({
  async read(query){const record=await binding(query),value=await retained(record);
   if(value===null)return {status:'absent'};
   return value.phase==='retained'?result(value):{status:'unresolved',lease:value.lease,reason:'original-capture-intent-retained'};
  },
  async retain(query){
   const record=await binding(query);need(hash(query.process),'process');
   const body={version:1,lease:query.lease,request:structuredClone(query.request),job:structuredClone(query.job),process:query.process};
   let value=await retained(record);
   if(value){need(same(value.job,body.job)&&value.process===body.process,'outcome-changed');
    if(value.phase==='retained')return result(value);
    // An uncertain copy must be reconciled, never recaptured as a fresh result.
    need(false,'original-capture-reconciliation-required');}
   const state=await observed(record,query.signal);need(state.processesTerminated===true,'work-still-running');
   const intent=seal({...body,phase:'intent'});receipt(intent,record);
   need((await records.write({lease:query.lease,expected:null,value:intent}))?.status==='retained','intent-retention');
   const snapshot=await snapshots.capture({lease:query.lease,request:structuredClone(query.request),process:query.process,signal:query.signal});
   need(snapshot?.lease===query.lease&&hash(snapshot.identity),'capture');
   const checked=await snapshots.verify({lease:query.lease,identity:snapshot.identity,request:structuredClone(query.request)});
   need(checked?.lease===query.lease&&checked.identity===snapshot.identity&&checked.verified===true,'captured-bytes');
   const after=await observed(record,query.signal);need(after.processesTerminated===true,'termination-changed');
   value=seal({...body,phase:'retained',snapshot:snapshot.identity});receipt(value,record);
   need((await records.write({lease:query.lease,expected:intent.identity,value}))?.status==='retained','outcome-retention');
   return result(value);
  },
  async observe(query){const record=await binding(query),value=await retained(record),state=await observed(record,query.signal);
   return {lease:query.lease,...(value?.phase==='retained'?{retention:value.identity}:{}),
    workRetained:value?.phase==='retained',processesTerminated:state.processesTerminated,resourcesRemoved:state.resourcesRemoved};
  }
 });
}
