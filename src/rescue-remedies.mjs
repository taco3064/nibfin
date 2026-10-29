// Dead-process attribution and race guards adapted from Kairo PR54.
import {lstat,readFile,realpath,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {rescueNeed as need} from './rescue-policy.mjs';
export const retryableRescueCodes=new Set(['GITHUB_READ_UNAVAILABLE','GITHUB_RATE_LIMIT','ACTION_PREDECESSOR_PENDING','ACTIONS_JOB_READBACK_TIMEOUT','MERGE_READBACK_PENDING','DISPATCH_READBACK_PENDING']);
export function processAlive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
export function lockEvidence(lock,source,alive=processAlive) {
  const start=Date.parse(lock?.startedAt),first=Date.parse(source.run_started_at??source.created_at),end=Date.parse(source.updated_at);
  return source.status==='completed'&&source.jobs?.length>0&&source.jobs.every(j=>j.status==='completed')
    &&Number.isSafeInteger(lock?.pid)&&lock.pid>0&&Number.isFinite(start)&&start>=first-60000&&start<=end+60000
    &&String(lock.runId)===String(source.id)&&String(lock.attempt)===String(source.run_attempt)&&!alive(lock.pid);
}
/** Paths are protected host capabilities, never supplied by a plan or event. */
export async function recoverRescueLocks({paths,source,active,beforeRemove,removed,alive=processAlive}) {
  need(Array.isArray(paths)&&paths.length<=16&&[active,beforeRemove,removed].every(f=>typeof f==='function'),'lock-capability');
  const result=[];
  for(const path of paths) {
    need(await active()===false,'agent-active');
    let stat,bytes;try{stat=await lstat(path);bytes=await readFile(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=4096&&await realpath(path)===resolve(path),'lock-unsafe');
    const record=JSON.parse(bytes);need(lockEvidence(record,source,alive),'lock-active-or-unknown');
    await beforeRemove();need(await active()===false,'agent-active');
    const fresh=await lstat(path);need(fresh.ino===stat.ino&&fresh.mtimeMs===stat.mtimeMs
      &&(await readFile(path)).equals(bytes)&&lockEvidence(record,source,alive),'lock-changed');
    await unlink(path);const proof={pid:record.pid,runId:record.runId,attempt:record.attempt,startedAt:record.startedAt};
    result.push(proof);await removed(proof);
  }
  return result;
}
/** Availability probing has no restart/command capability. */
export async function probeRescueAvailability({provider,repository,repositoryId}) {
  const r=await provider.request({method:'GET',endpoint:'/repos/'+repository,target:repositoryId,operation:'rescue-probe',correlation:'rescue'});
  need(r?.outcome==='read'&&r.data?.private===false&&String(r.data.id)===repositoryId&&r.data.full_name?.toLowerCase()===repository,'probe');
  return {status:'healthy',repository,repositoryId};
}

/** Fixed deterministic adapter for protected host composition. Evidence loaders
 * read original existing receipts/state; plans cannot install callbacks/commands.
 * apply rechecks the precise proof before any narrowly supported side effect. */
export function createRescueRemedies({verification,ci,locks,provider,now=Date.now}={}) {
  return async ({case:c,source})=>{
    const {verificationRescueContinuation,ciRescueContinuation}=await import('./rescue-continuation.mjs');
    const {rescueSame:same}=await import('./rescue-policy.mjs');
    if(verification) {
      const original=await verification(c.target);
      if(original) {
        need(same(original.target,c.target)&&String(original.source.id)===c.source.runId,'verification-source');
        const proof=verificationRescueContinuation(original);
        return {kind:proof.kind,proof,apply:async()=>{
          const fresh=verificationRescueContinuation(await verification(c.target));need(same(fresh,proof),'verification-changed');return proof;
        }};
      }
    }
    if(ci) {
      const original=await ci(c.target);
      if(original) {
        need(same(original.target,c.target),'ci-source');
        // An unchanged observed pending exact-head check only defers locally.
        if(original.pending===true)return {kind:'ci-wait'};
        const proof=ciRescueContinuation(original);
        return {kind:'ci-change',proof,apply:async()=>{const fresh=ciRescueContinuation(await ci(c.target));need(same(fresh,proof),'ci-changed');return proof;}};
      }
    }
    if(locks) {
      const original=await locks(c.target,source);
      if(original?.paths?.length) {
        need(original.source.runId===c.source.runId&&original.source.attempt===c.source.attempt,'lock-source');
        const proof={kind:'dead-lock',source:c.source,locks:original.identities};
        return {kind:'dead-lock',proof,apply:async()=>{
          const fresh=await locks(c.target,source);need(same(fresh.identities,original.identities),'lock-changed');
          const removed=await recoverRescueLocks({...fresh,source,removed:original.removed,beforeRemove:original.beforeRemove});
          need(removed.length===original.paths.length&&removed.length>0,'lock-changed');return proof;
        }};
      }
    }
    if(provider&&retryableRescueCodes.has(c.originalCode??c.code)) {
      const proof=await probeRescueAvailability({provider,repository:c.target.repository,repositoryId:c.target.repositoryId});
      return {kind:'github-read',proof,apply:()=>probeRescueAvailability({provider,repository:c.target.repository,repositoryId:c.target.repositoryId})};
    }
    return null;
  };
}
