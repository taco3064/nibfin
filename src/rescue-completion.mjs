// PR57 completion inbox adapter. Signature-before-parse and successful-source
// zero-allocation predicates retain their upstream ordering.
import {lstat,readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {contentIdentity} from './evidence.mjs';
import {authenticateRescueWebhook,validateRescuePolicy,rescueNeed as need,rescueSame as same} from './rescue-policy.mjs';
const outside=(root,path)=>{const v=relative(resolve(root),resolve(path));return v==='..'||v.startsWith('../')||isAbsolute(v);};
export async function loadRescueCompletionSecret(path,{uid,excludedRoots}) {
  need(isAbsolute(path)&&Number.isSafeInteger(uid)&&Array.isArray(excludedRoots)
    &&excludedRoots.length>=3&&excludedRoots.every(root=>outside(root,path)),'secret-boundary');
  const s=await lstat(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===uid
    &&(s.mode&0o077)===0&&await realpath(path)===resolve(path),'secret-permissions');
  const bytes=await readFile(path);need(bytes.length>=32&&bytes.length<=256,'secret-length');return bytes;
}
export function createRescueCompletionReceiver({policy,secret,records,provenance,controller,attribute,now=Date.now}) {
  const p=validateRescuePolicy(policy);
  need(typeof attribute==='function','attribution');
  async function receive(bytes,headers) {
    const e=authenticateRescueWebhook(secret,bytes,headers);
    if(headers['x-github-event']==='ping')return {status:'IGNORED',reason:'PING'};
    if(headers['x-github-event']!=='workflow_run'||e.action!=='completed')return {status:'IGNORED',reason:'UNRELATED_EVENT'};
    const r=e.workflow_run;
    if(e.repository?.private!==false||e.repository.full_name?.toLowerCase()!==p.repository
      ||String(e.repository.id)!==p.repositoryId||!(/^[1-9]\d*$/.test(String(r?.id)))
      ||!Number.isSafeInteger(r.run_attempt)||r.run_attempt<1||!(/^[a-f0-9]{40}$/.test(r.head_sha??''))
      ||r.path!==p.stageWorkflow||r.event!=='workflow_dispatch'||r.head_branch!==p.ref||r.status!=='completed'
      ||!p.actorIds.includes(String(r.actor?.id))||!p.actorIds.includes(String(r.triggering_actor?.id)))
      return {status:'IGNORED',reason:'UNRELATED_SOURCE'};
    const source={runId:String(r.id),attempt:String(r.run_attempt),head:r.head_sha};
    const matches=Object.values((await records.read()).cases).filter(c=>same(c.source,source)
      ||String(c.continuation?.observation?.id)===source.runId);
    if(r.conclusion==='success'&&!matches.length)return {status:'IGNORED',reason:'NORMAL_COMPLETION'};
    if(!['success','failure','timed_out','cancelled','startup_failure'].includes(r.conclusion))return {status:'IGNORED',reason:'NO_RECOVERY_SIGNAL'};
    return enqueue(source);
  }
  async function enqueue(source) {
    const id=contentIdentity({authority:p.authority,source});
    await records.update(s=>{if(s.inbox[id])return null;s.inbox[id]={id,authority:p.authority,source,
      status:'pending',checks:0,nextCheckAt:now()};return s;});
    return {status:'ACCEPTED',id};
  }
  async function backfill(window) {
    const runs=await provenance.backfill(window),results=[];
    for(const hint of runs) {
      const source=await provenance.verify(String(hint.id),String(hint.run_attempt));
      const key={runId:String(source.id),attempt:String(source.run_attempt),head:source.head_sha};
      const cases=Object.values((await records.read()).cases).filter(c=>same(c.source,key));
      if(source.conclusion==='success'&&!cases.length){results.push({status:'IGNORED',reason:'NORMAL_COMPLETION'});continue;}
      if(source.conclusion==='cancelled'&&!await provenance.timeout(source)){results.push({status:'IGNORED',reason:'MANUAL_CANCELLATION'});continue;}
      if(['success','failure','timed_out','startup_failure','cancelled'].includes(source.conclusion))results.push(await enqueue(key));
    }
    return {status:'complete',results};
  }
  async function process() {
    const results=[];
    for(const original of Object.values((await records.read()).inbox).filter(n=>n.status==='pending'&&n.nextCheckAt<=now()).slice(0,10)) {
      try {
        need(original.authority===p.authority&&now()<p.expiresAt,'authority');
        const source=await provenance.verify(original.source.runId,original.source.attempt);
        need(source.head_sha===original.source.head,'source-changed');
        if(source.conclusion==='cancelled'&&!await provenance.timeout(source)) {
          await records.update(s=>{s.inbox[original.id]={...s.inbox[original.id],status:'ignored',reason:'MANUAL_CANCELLATION',nextCheckAt:null};return s;});
          results.push({status:'ignored'});continue;
        }
        const matches=Object.values((await records.read()).cases).filter(c=>same(c.source,original.source)
          ||String(c.continuation?.observation?.id)===original.source.runId);
        if(!matches.length&&source.conclusion!=='success') {
          // Attribute only from the original retained stage request/session.
          const found=await attribute(source);
          need(found&&same(found.target.source,{runId:original.source.runId,attempt:original.source.attempt}),'unattributed');
          const id=await controller.register({...found,source:original.source});
          await controller.wake(id);
        } else for(const c of matches)await controller.wake(c.id);
        await records.update(s=>{s.inbox[original.id]={...s.inbox[original.id],status:'processed',nextCheckAt:null};return s;});
        results.push({status:'processed'});
      } catch(e) {
        // Only bounded local reads retry. A write outcome is reconciled by the
        // original controlled operation and is never treated as a read failure.
        const transient=['read','jobs','source-active','annotations'].includes(e.code);
        await records.update(s=>{const n=s.inbox[original.id];const checks=n.checks+1,retry=transient&&checks<8;
          s.inbox[original.id]={...n,checks,status:retry?'pending':'unresolved',reason:e.code??'unavailable',
            nextCheckAt:retry?now()+Math.min(900000,15000*2**(checks-1)):null};return s;});
        results.push({status:transient&&original.checks+1<8?'pending':'unresolved'});
      }
    }
    return results;
  }
  return Object.freeze({receive,process,backfill});
}
