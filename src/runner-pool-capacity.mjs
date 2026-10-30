import {validateExecutionPool} from './execution-pool.mjs';
import {contentIdentity} from './evidence.mjs';
import {canonicalJSON} from './canonical.mjs';
import {githubId} from './identity.mjs';
const need=(ok,code)=>{if(!ok)throw Error('runner-pool:'+code);};
const fields=(v,keys)=>need(v&&Object.getPrototypeOf(v)===Object.prototype
 &&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' '),'schema');
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const poolConfiguration=value=>{const p=validateExecutionPool(value);need(p.version===2,'repository-local-pool-required');return p;};
export function initialRunnerPoolCapacity(configuration){
 const p=poolConfiguration(configuration);return {version:1,pool:contentIdentity(p),leases:{},completed:{}};
}
/** Infrastructure allocation only: never selects an Issue, advances a delivery
 * stage, authenticates a Job, registers a Runner, or certifies a cleanup.
 * Protected host supplies serialized durable transactions and live release
 * observations. Neither callback is deserialized from an event or model result.
 */
export function createRunnerPoolCapacity({configuration,records,observeRelease}={}){
 const p=poolConfiguration(configuration),pool=contentIdentity(p);
 need(typeof records?.update==='function'&&typeof observeRelease==='function','capabilities');
 function request(r){
  fields(r,'id repository repositoryId jobId runId attempt');
  need(typeof r.id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(r.id),'request');
  for(const k of ['repositoryId','jobId','runId','attempt'])githubId(r[k]);
  need(p.targets.some(t=>t.repository===r.repository&&t.repositoryId===r.repositoryId),'repository');
  return structuredClone(r);
 }
 function state(s){
  fields(s,'version pool leases completed');need(s.version===1&&s.pool===pool&&s.leases&&Object.getPrototypeOf(s.leases)===Object.prototype
   &&s.completed&&Object.getPrototypeOf(s.completed)===Object.prototype,'state');
  for(const [id,value]of Object.entries(s.completed))need(/^[A-Za-z0-9_-]{1,80}$/.test(id)&&/^[a-f0-9]{64}$/.test(value),'completed');
  const slots=new Set();need(Object.keys(s.leases).length<=p.capacity,'capacity');
  for(const [id,l]of Object.entries(s.leases)){
   fields(l,'request slot identity');const r=request(l.request);
   need(r.id===id&&Number.isSafeInteger(l.slot)&&l.slot>=1&&l.slot<=p.capacity&&!slots.has(l.slot)
    &&l.identity===contentIdentity({pool,request:r,slot:l.slot}),'lease');slots.add(l.slot);
  }return s;
 }
 return Object.freeze({
  async reserve(value){
   const r=request(value);let result;
   await records.update(s=>{
    state(s);if(s.completed[r.id]){need(s.completed[r.id]===contentIdentity(r),'request-reuse');result={status:'completed',identity:s.completed[r.id]};return null;}
    const existing=s.leases[r.id];
    if(existing){need(same(existing.request,r),'request-reuse');result={status:'retained',lease:structuredClone(existing)};return null;}
    const used=new Set(Object.values(s.leases).map(l=>l.slot));let slot=1;while(used.has(slot))slot++;
    if(slot>p.capacity){result={status:'waiting',reason:'capacity-exhausted'};return null;}
    const lease={request:r,slot,identity:contentIdentity({pool,request:r,slot})};s.leases[r.id]=lease;
    result={status:'reserved',lease:structuredClone(lease)};return state(s);
   });need(result,'transaction');return result;
  },
  async release(value){
   const r=request(value);let lease,completed=false;
   await records.update(s=>{state(s);if(s.completed[r.id]){need(s.completed[r.id]===contentIdentity(r),'request-reuse');completed=true;return null;}
    lease=structuredClone(s.leases[r.id]);need(lease&&same(lease.request,r),'missing-lease');return null;});
   if(completed)return {status:'released',already:true};
   const proof=await observeRelease(structuredClone(lease));
   // Unknown remote deregistration, a live process or cleanup failure keeps
   // consuming the original slot. It is never treated as free after a timeout.
   if(proof?.lease!==lease.identity||proof.processTerminated!==true||proof.registrationRemoved!==true||proof.cleanupConfirmed!==true)
    return {status:'retained',reason:'release-unconfirmed',lease};
   await records.update(s=>{state(s);need(same(s.leases[r.id],lease),'lease-changed');delete s.leases[r.id];s.completed[r.id]=contentIdentity(r);return state(s);});
   return {status:'released',slot:lease.slot};
  }
 });
}
