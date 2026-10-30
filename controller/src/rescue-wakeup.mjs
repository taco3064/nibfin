// Host notification transport only: no stage execution, lock removal or repair.
import {watch} from 'node:fs';
import {mkdir,readFile} from 'node:fs/promises';
import {binding,digest} from './core.mjs';
import {coreDigest,verifyGrant,verifyCoreUpgrade} from './authority.mjs';
import {Store} from './store.mjs';
import {positive,rescueWorkflow,rescueStop,verifyRescueSource,cleanRescueText} from './rescue-policy.mjs';
import {activeIssueContainers} from './rescue-remedies.mjs';
import {ciContinuation} from './rescue-continuation.mjs';
import {rescueCaseStore,rescueIndexStore,eligibleRescueRecheck,deferCase,recordRecheckFailure,updateRescueCase} from './rescue.mjs';

const wakeStore=(runtime,id)=>new Store(runtime.config.stateDirectory,'rescue-wakeup:'+id);
const wakeKey=c=>digest({caseId:c.request.id,nextCheckAt:c.nextCheckAt??c.request.createdAt,deferredChecks:c.deferredChecks??0});
export async function loadRescueWakeupGrant(runtime){
 const bundle=await runtime.github.grant(runtime.config.grantSource),key=await readFile(runtime.config.publicKeyPath,'utf8'),grant=verifyGrant(bundle,key),installed=await coreDigest(runtime.root);
 const amendment=[bundle.coreUpgrade,...(bundle.coreUpgrades??[])].find(a=>a?.payload?.toCoreDigest===installed);
 const approval=verifyCoreUpgrade(amendment,grant,installed,key);
 if(!approval.rescue||grant.policy.executionMode!=='actions-v1'||grant.policy.actionExecution?.repository!=='retired-private-source'||digest(grant.policy.actionExecution)!==digest(runtime.config.actionExecution))throw Error('Rescue notification transport is not enrolled');
 runtime.coreUpgrade=approval;
 const [repository,file]=await Promise.all([runtime.github.repository('retired-private-source'),runtime.github.api('/repos/retired-private-source/contents/'+rescueWorkflow+'?ref=main')]);
 if(repository.private!==true||file.sha!==approval.rescue.workflowBlob)throw Error('Rescue notification workflow pin changed');
 return grant;
}
export async function pendingRescueWakeups(runtime,grant){
 const index=await rescueIndexStore(runtime,grant).read(),cases=[];
 for(const id of Object.keys(index.cases??{})){
  const c=await rescueCaseStore(runtime,id).read();
  if(!c.request||!eligibleRescueRecheck(c))continue;
  const outbox=await wakeStore(runtime,id).read();
  if(c.outcome==='PENDING'&&Object.keys(outbox.attempts??{}).length)continue;
  if(!outbox.attempts?.[wakeKey(c)])cases.push({id,state:c});
 }
 return cases.sort((a,b)=>Date.parse(a.state.nextCheckAt??a.state.request.createdAt)-Date.parse(b.state.nextCheckAt??b.state.request.createdAt));
}
export async function wakeCase(runtime,grant,id){
 const c=await rescueCaseStore(runtime,id).read(),expected={expectedRevision:c.revision};
 if(!eligibleRescueRecheck(c))return{caseId:id,outcome:'SKIPPED'};
 // Completion webhooks may arrive before the local deferred deadline. The
 // Action would return without changing the case, consuming this wake key and
 // leaving no timer. Keep the wait local and do not create dispatch intent.
 if(c.outcome==='DEFERRED'&&Date.parse(c.nextCheckAt)>Date.now())return{caseId:id,outcome:'WAITING'};
 try{
  if(c.request.id!==id||digest(c.request.authority)!==digest(binding(grant.manifest,grant.policy)))throw rescueStop('RESCUE_AUTHORITY_CHANGED','Pending notification belongs to a different authority');
  if(c.resumeDispatch&&(!c.resumeRunId||c.resumeDispatch.status!=='confirmed')||!c.resumeRunId&&c.actions?.length)throw rescueStop('RESCUE_SIDE_EFFECT_UNCERTAIN','Prior repair or dispatch is uncertain; automatic notification stopped');
  const source=await verifyRescueSource(runtime,grant,c.resumeRunId??c.request.sourceRunId,{completed:false});
  if(!c.resumeRunId&&source.run_attempt!==c.request.sourceAttempt)throw rescueStop('RESCUE_SOURCE_CHANGED','Source attempt changed');
  let waiting=source.status!=='completed'||source.jobs.some(j=>j.status!=='completed');
  let code=c.resumeRunId?'RESCUE_CONTINUATION_ACTIVE':'RESCUE_SOURCE_ACTIVE';
  if(!waiting){
   const issue=grant.manifest.issues.find(i=>i.id===c.request.issueId);
   if(!issue&&c.request.issueId)throw rescueStop('RESCUE_TARGET_UNAVAILABLE','Pending notification has no enrolled Issue');
   waiting=issue&&(await activeIssueContainers(runtime,issue,grant,{unit:c.request.unit})).length>0;code='RESCUE_AGENT_ACTIVE';
  }
  if(waiting){await deferCase(runtime,id,code,'Host observed active work; no Actions runner was allocated',expected);return{caseId:id,...await rescueCaseStore(runtime,id).read()};}
  const unit=c.request.unit?await new Store(runtime.config.stateDirectory,c.request.unit).read():{};
  const issue=grant.manifest.issues.find(i=>i.id===c.request.issueId),stored=unit.issues?.[c.request.issueId];
  const readiness=issue&&stored?await ciContinuation(runtime,grant,issue,stored,c.request.code):null;
  const observation=digest({runId:String(source.id),attempt:source.run_attempt,conclusion:source.conclusion,
   completion:unit.completion??null,receipt:unit.actionReceipts?.at(-1)??null,blocked:stored?.blocked??null,...(readiness?{readiness}:{})});
  const outbox=wakeStore(runtime,id),key=wakeKey(c);
  return await outbox.metadataLease(async()=>{
   let s=await outbox.read();if(s.attempts?.[key])return{caseId:id,outcome:'ALREADY_NOTIFIED'};
   if(s.observation===observation){await deferCase(runtime,id,'RESCUE_CONTINUATION_ACTIVE','Completed source and formal Issue evidence have not changed; no Actions runner was allocated',expected);return{caseId:id,outcome:'UNCHANGED'};}
   const current=await rescueCaseStore(runtime,id).read();if(!eligibleRescueRecheck(current)||wakeKey(current)!==key)return{caseId:id,outcome:'SKIPPED'};
   if(current.outcome==='DEFERRED'&&Date.parse(current.nextCheckAt)>Date.now())return{caseId:id,outcome:'WAITING'};
   s=await outbox.transaction(s.revision,v=>({...v,observation,attempts:{...v.attempts,[key]:{status:'attempted',at:new Date().toISOString()}}}));
   try{
    const result=await runtime.github.api('/repos/retired-private-source/actions/workflows/nibfin-rescue.yml/dispatches','POST',{ref:'main',inputs:{request_id:id,source_run_id:c.request.sourceRunId,issue_ref:c.request.issueRef,reason_code:'PENDING_WAKEUP',mode:'repair'},return_run_details:true},'2022-11-28');
    if(!positive(result?.workflow_run_id))throw rescueStop('RESCUE_DISPATCH_UNKNOWN','Pending notification returned no Run ID');
    await outbox.transaction(s.revision,v=>({...v,attempts:{...v.attempts,[key]:{...v.attempts[key],status:'confirmed',runId:String(result.workflow_run_id)}}}));
    return{caseId:id,outcome:'NOTIFIED',rescueRunId:String(result.workflow_run_id)};
   }catch(error){
    // Preserve the attempted outbox across crashes/restarts. Never replay POST.
    await updateRescueCase(runtime,id,v=>v.revision!==c.revision?v:{...v,outcome:'UNRESOLVED',repairCode:'RESCUE_WAKEUP_DISPATCH_UNKNOWN',nextCheckAt:null,verification:cleanRescueText(error.message)});
    return{caseId:id,outcome:'UNRESOLVED',code:'RESCUE_WAKEUP_DISPATCH_UNKNOWN'};
   }
  });
 }catch(error){return recordRecheckFailure(runtime,id,error,expected);}
}
export async function wakeRescueCases(runtime,grant){
 const cases=await pendingRescueWakeups(runtime,grant),results=[];
 for(const {id,state:c} of cases){
  if(c.nextCheckAt&&Date.parse(c.nextCheckAt)>Date.now())continue;
  results.push(await wakeCase(runtime,grant,id));if(results.length>=10)break;
 }
 for(const result of results)console.log(JSON.stringify({kind:'nibfin-rescue-host-wakeup',caseId:result.caseId,outcome:result.outcome,rescueRunId:result.rescueRunId??null}));
 return{outcome:results.some(r=>r.outcome==='UNRESOLVED')?'UNRESOLVED':'RECHECKED',results};
}
export async function startRescueWakeups(runtime,loadGrant=()=>loadRescueWakeupGrant(runtime),{watchDirectory=watch,setTimer=setTimeout,clearTimer=clearTimeout,onError=error=>console.error(JSON.stringify({kind:'nibfin-rescue-host-error',reason:cleanRescueText(error.message)}))}={}){
 const grant=await loadGrant(),index=rescueIndexStore(runtime,grant),watchers=new Map();let timer=null,closed=false,running=false,again=false;
 await mkdir(index.directory,{recursive:true});
 const refresh=async()=>{
  if(closed)return;if(running){again=true;return;}running=true;clearTimer(timer);timer=null;let pending=[];
  try{
   const current=await index.read();
   for(const id of Object.keys(current.cases??{}))if(!watchers.has(id)){
    const watcher=watchDirectory(rescueCaseStore(runtime,id).directory,()=>{void refresh();});watcher.on?.('error',onError);watchers.set(id,watcher);
   }
   pending=await pendingRescueWakeups(runtime,grant);
   if(pending.some(({state:c})=>!c.nextCheckAt||Date.parse(c.nextCheckAt)<=Date.now())){
    const fresh=await loadGrant();if(closed)return;
    if(digest(binding(fresh.manifest,fresh.policy))!==digest(binding(grant.manifest,grant.policy)))throw Error('Rescue authority changed; restart notification service for the new grant');
    await wakeRescueCases(runtime,fresh);pending=await pendingRescueWakeups(runtime,fresh);
   }
   if(!closed&&pending.length)timer=setTimer(()=>{void refresh();},Math.min(2147483647,Math.max(0,Date.parse(pending[0].state.nextCheckAt??pending[0].state.request.createdAt)-Date.now())));
  }catch(error){
   if(closed)return;onError(error);
   // Authority reads can fail before any case is dispatched. Persist bounded
   // backoff for those due cases too, rather than silently losing their timer.
   for(const {id,state:c} of pending)if(!c.nextCheckAt||Date.parse(c.nextCheckAt)<=Date.now())await recordRecheckFailure(runtime,id,error,{expectedRevision:c.revision});
   const remaining=await pendingRescueWakeups(runtime,grant);
   if(!closed&&remaining.length)timer=setTimer(()=>{void refresh();},Math.min(2147483647,Math.max(0,Date.parse(remaining[0].state.nextCheckAt??remaining[0].state.request.createdAt)-Date.now())));
  }
  finally{running=false;if(again&&!closed){again=false;queueMicrotask(()=>{void refresh();});}}
 };
 const indexWatcher=watchDirectory(index.directory,()=>{void refresh();});indexWatcher.on?.('error',onError);
 await refresh();
 return{close(){closed=true;clearTimer(timer);indexWatcher.close();for(const watcher of watchers.values())watcher.close();},refresh};
}
