import {appendFile} from 'node:fs/promises';
import {binding,digest} from './core.mjs';
import {Store} from './store.mjs';
import {unitId,issueLeaseId} from './dynamic.mjs';
import {ActionOutbox} from './action-outbox.mjs';
import {ownerHold} from './owner-hold.mjs';
import {rescueWorkflow,rescueStop,hash,positive,cleanRescueText,rescueLog,validateRescuePolicy,verifyRescueSource,providerTimeoutEvidence} from './rescue-policy.mjs';
import {recoverRescueLocks,ghFailureEvidence,probeGithubRead,retryableRescueCodes,activeIssueContainers} from './rescue-remedies.mjs';
import {verificationContinuation,ciContinuation} from './rescue-continuation.mjs';
import {inspectInterruptedWriter,restoreInterruptedWriter,writerSessionStore} from './rescue-writer.mjs';
import {detectRescueSource} from './rescue-detection.mjs';
import {rescueConclusion} from './rescue-result.mjs';
import {inspectAiRepairTarget,diagnoseAiRepair,applyAiRepair} from './rescue-ai.mjs';
import {issueReference} from './action-display.mjs';

const caseStore=(runtime,id)=>{if(!hash(id))throw Error('Invalid Rescue case ID');return new Store(runtime.config.stateDirectory,'rescue-case:'+id);};
const indexStore=(runtime,grant)=>new Store(runtime.config.stateDirectory,'rescue-index:'+grant.policy.grantId);
const sourceOf=state=>String(state.pending?.executionContext?.action?.runId??state.lastDecision?.executionContext?.action?.runId??state.events?.at(-1)?.executionContext?.action?.runId??'');
const stopCode=error=>error.code??(error.requestMethod==='GET'&&[502,503,504].includes(error.status)?'GITHUB_READ_UNAVAILABLE':'UNCLASSIFIED');
const snapshot=(state,issue)=>({blockedHash:digest(state.issues?.[issue.id]?.blocked??null),candidateHash:digest(state.issues?.[issue.id]?.candidate??null),pendingHash:digest(state.pending??null)});

async function registerCase(runtime,grant,source,issue,failure){
 const unit=issue?unitId(grant,issue):null,state=issue?await new Store(runtime.config.stateDirectory,unit).read():null;
 const stored=state?.issues?.[issue.id],blocked=stored?.blocked;
 const id=digest({authority:binding(grant.manifest,grant.policy),sourceRunId:String(source.id),sourceAttempt:source.run_attempt,unit});
 const store=caseStore(runtime,id);
 await store.metadataLease(async()=>{const s=await store.read();if(s.request)return;
  const reason=cleanRescueText(blocked?[blocked.rootCause,blocked.summary,...(blocked.blockingFindings??[])].filter(Boolean).join('\n'):failure.reason||(failure.code==='MERGE_REQUIREMENTS_PENDING'?'Core is waiting for GitHub repository merge requirements; recheck the exact reviewed PR':'Core reported '+(failure.code??'an unknown blocked result')));
  await store.transaction(s.revision,v=>({...v,request:{id,authority:binding(grant.manifest,grant.policy),sourceRunId:String(source.id),sourceAttempt:source.run_attempt,
   issueId:issue?.id??null,issueRef:issue?issue.repository.split('/')[1]+'#'+issue.number:'Run #'+source.id,repository:issue?.repository??null,unit,
   code:failure.code??'UNKNOWN',reason,stage:blocked?.stage??state?.pending?.operation??null,
   baseline:issue?snapshot(state,issue):null,createdAt:new Date().toISOString()},actions:[],outcome:'PENDING'}));
 });
 const index=indexStore(runtime,grant);await index.metadataLease(async()=>{const s=await index.read();if(s.cases?.[id])return;await index.transaction(s.revision,v=>({...v,cases:{...v.cases,[id]:{sourceRunId:String(source.id),issueId:issue?.id??null}}}));});
 return id;
}
async function updateCase(runtime,id,update){const store=caseStore(runtime,id);return store.metadataLease(async()=>{const state=await store.read();return store.transaction(state.revision,update);});}
function baseReport(state){const r=state.request;return{caseId:r.id,nextCaseId:state.nextCaseId??null,issueRef:r.issueRef,sourceRunId:r.sourceRunId,sourceUrl:'https://github.com/retired-private-source/actions/runs/'+r.sourceRunId,code:r.code,reason:r.reason,actions:state.actions??[],aiDiagnosis:state.aiDiagnosis??null,resolutionSource:state.resolutionSource??null,outcome:state.outcome??'UNRESOLVED',nextCheckAt:state.nextCheckAt??null,resumeRunId:state.resumeRunId??null,resumeUrl:state.resumeRunId?'https://github.com/retired-private-source/actions/runs/'+state.resumeRunId:null,verification:state.verification??'Not verified'};}
async function emitCase(runtime,id){return rescueLog(baseReport(await caseStore(runtime,id).read()));}
async function dispatchRun(runtime,workflow,inputs){
 const result=await runtime.github.api('/repos/'+runtime.config.actionExecution.repository+'/actions/workflows/'+workflow+'/dispatches','POST',{ref:'main',inputs,return_run_details:true},'2022-11-28');
 if(!positive(result?.workflow_run_id))throw rescueStop('RESCUE_DISPATCH_UNKNOWN','Dispatch returned no Run ID; do not repeat an uncertain write');return String(result.workflow_run_id);
}
export async function dispatchRescue(runtime,grant,id){
 const store=caseStore(runtime,id);
 return store.metadataLease(async()=>{let state=await store.read();if(state.rescueDispatch)return state.rescueDispatch;
  state=await store.transaction(state.revision,v=>({...v,rescueDispatch:{status:'attempted',at:new Date().toISOString()}}));
  try{const runId=await dispatchRun(runtime,'nibfin-rescue.yml',{request_id:id,source_run_id:state.request.sourceRunId,issue_ref:state.request.issueRef,reason_code:state.request.code,mode:'repair'});
   await store.transaction(state.revision,v=>({...v,rescueDispatch:{...v.rescueDispatch,status:'confirmed',runId}}));return{status:'confirmed',runId};
  }catch(error){await store.transaction(state.revision,v=>({...v,rescueDispatch:{...v.rescueDispatch,status:'unknown',code:stopCode(error)},outcome:'UNRESOLVED',verification:'Rescue dispatch outcome unknown; automatic replay is disabled'}));throw error;}
 });
}
export async function queueActionRescues(runtime,output,event,error=null){
 if(!runtime.coreUpgrade?.rescue||!runtime.actionIdentity||runtime.rescueInvocation)return[];
 const grant=await runtime.grant(),index=await indexStore(runtime,grant).read();
 const resumed=Object.entries(index.cases??{}).filter(([,c])=>c.resumeRunId===String(runtime.actionIdentity.runId));
 if(resumed.length){
  for(const[id]of resumed){
   let c=await updateCase(runtime,id,s=>({...s,coreReturn:{runId:String(runtime.actionIdentity.runId),status:error?'ERROR':output.status??'UNKNOWN',code:error?stopCode(error):null,at:new Date().toISOString()}}));

  }
  console.error(JSON.stringify({kind:'nibfin-rescue-resume-observed',runId:String(runtime.actionIdentity.runId),cases:resumed.map(([id])=>id),verification:'Completion sentinel must independently verify the completed Run and state'}));return[];
 }
 const failures=error?[{status:'BLOCKED',code:stopCode(error),reason:cleanRescueText(error.message)}]:(output.results??[output]).filter(r=>r.status==='BLOCKED'||r.status==='WAITING'&&['EEXIST','ACTION_PREDECESSOR_PENDING','MERGE_REQUIREMENTS_PENDING'].includes(r.code));
 const ids=[];
 for(const failure of failures){
  let issue=grant.manifest.issues.find(i=>i.id===(failure.issueId??event?.inputs?.issue_id));
  if(!issue&&event?.inputs?.request_id)try{const item=await new ActionOutbox(runtime.config.stateDirectory,runtime.github,grant.policy.actionExecution).read(event.inputs.request_id);issue=grant.manifest.issues.find(i=>i.id===item.request.issueId);}catch{}
  if(!issue){const attributed=[];for(const i of grant.manifest.issues){const s=await new Store(runtime.config.stateDirectory,unitId(grant,i)).read();if(sourceOf(s)===String(runtime.actionIdentity.runId))attributed.push(i);}if(attributed.length===1)issue=attributed[0];}
  const source={id:runtime.actionIdentity.runId,run_attempt:runtime.actionIdentity.runAttempt};
  const id=await registerCase(runtime,grant,source,issue,failure);ids.push(id);
  await emitCase(runtime,id);
  console.error(JSON.stringify({kind:'nibfin-rescue-request',runId:String(runtime.actionIdentity.runId),caseId:id,issueRef:issue?issue.repository.split('/')[1]+'#'+issue.number:'Run '+runtime.actionIdentity.runId,code:failure.code??'UNKNOWN'}));
 }
 return ids;
}
async function consumeRepairBudget(runtime,grant,unit){
 const policy=validateRescuePolicy(runtime.coreUpgrade.rescue),store=new Store(runtime.config.stateDirectory,'rescue-budget:'+unit);
 return store.metadataLease(async()=>{const s=await store.read(),now=Date.now();
  if((s.attempts??0)>=policy.maxRepairsPerIssue)throw rescueStop('RESCUE_BUDGET_EXHAUSTED','Automatic repair budget exhausted for this Issue cycle');
  if(s.lastAttemptAt&&now-Date.parse(s.lastAttemptAt)<policy.cooldownSeconds*1000)throw rescueStop('RESCUE_COOLDOWN','A recent recovery already ran; preserve the cooldown');
  return store.transaction(s.revision,v=>({...v,attempts:(v.attempts??0)+1,lastAttemptAt:new Date(now).toISOString()}));
 });
}
async function findCase(runtime,grant,event){
 const input=event.inputs??{};
 if(input.request_id){if(!hash(input.request_id))throw Error('Invalid Rescue case ID');return input.request_id;}
 const source=await verifyRescueSource(runtime,grant,input.source_run_id),index=await indexStore(runtime,grant).read();
 const resumed=Object.entries(index.cases??{}).find(([,c])=>c.resumeRunId===String(source.id));
 // A second proven provider timeout is a new incident under the SAME Issue
 // repair budget; failed implementations and ambiguous cancellations do not loop.
 const repeatedTimeout=resumed&&await providerTimeoutEvidence(runtime,grant,source);
 if(resumed&&!repeatedTimeout)return resumed[0];
 const known=Object.entries(index.cases??{}).filter(([,c])=>c.sourceRunId===String(source.id));if(known.length===1)return known[0][0];
 const targets=[];for(const issue of grant.manifest.issues){const state=await new Store(runtime.config.stateDirectory,unitId(grant,issue)).read();if(sourceOf(state)===String(source.id)&&(state.pending||state.issues?.[issue.id]?.blocked||state.lastDecision?.status==='BLOCKED'))targets.push(issue);}
 if(source.conclusion==='success'&&!targets.length)return null;
 const issue=targets.length===1?targets[0]:null;
 const id=await registerCase(runtime,grant,source,issue,{code:repeatedTimeout?'RUN_TIMEOUT':source.conclusion==='timed_out'?'RUN_TIMEOUT':source.conclusion==='success'?'CORE_BLOCKED':'RUN_FAILED',reason:targets.length>1?'Multiple current Issues reference this Run; no target is guessed':'Source Run concluded '+source.conclusion+(issue?'; inspect preserved pending state':' without a uniquely attributable current blocked Issue')});
 if(repeatedTimeout)await updateCase(runtime,id,s=>({...s,parentCaseId:resumed[0]}));
 return id;
}
async function verifyCase(runtime,grant,id){
 const c=await caseStore(runtime,id).read(),issue=grant.manifest.issues.find(i=>i.id===c.request?.issueId);
 if(!c.resumeRunId)return emitCase(runtime,id);
 if(!issue||unitId(grant,issue)!==c.request.unit){await updateCase(runtime,id,s=>({...s,outcome:'UNRESOLVED',verification:'Issue Scope/cycle changed; old repair does not apply'}));return emitCase(runtime,id);}
 const run=await verifyRescueSource(runtime,grant,c.resumeRunId,{completed:false});
 if(run.status!=='completed'){await deferCase(runtime,id,'RESCUE_CONTINUATION_ACTIVE','Continuation Run is still '+run.status+'; resolution remains unverified');return emitCase(runtime,id);}
 const state=await new Store(runtime.config.stateDirectory,c.request.unit).read(),stored=state.issues?.[issue.id];
 // The durable host verifier also covers a lost completion notification. It
 // queues only a provider-proven new timeout of the still-current pending work.
 if(!ownerHold(runtime,issue)&&String(state.pending?.executionContext?.action?.runId)===String(run.id)&&await providerTimeoutEvidence(runtime,grant,run)){
  const next=await findCase(runtime,grant,{inputs:{source_run_id:String(run.id)}});
  if(next!==id){
   await dispatchRescue(runtime,grant,next);
   await updateCase(runtime,id,s=>({...s,outcome:'UNRESOLVED',nextCheckAt:null,nextCaseId:next,verification:'Continuation timed out again; a distinct bounded recovery case was queued: '+next}));
   return emitCase(runtime,id);
  }
 }
 const receipt=state.actionReceipts?.find(r=>String(r.action?.runId)===c.resumeRunId&&r.completedAt);
 const resolved=run.conclusion==='success'&&!stored?.blocked&&Boolean(receipt);
 // Full completion is established only by reconcileExternalCompletion, which
 // independently verifies the exact finalization receipt and provider Run.
 await updateCase(runtime,id,s=>{
  if(resolved){const next=deferredState(s,'RESCUE_CONTINUATION_ACTIVE','Authorized continuation produced a stage receipt; waiting for verified Issue completion');return{...next,outcome:next.outcome==='UNRESOLVED'?'UNRESOLVED':'STAGE_RECOVERED'};}
  return{...s,outcome:'UNRESOLVED',nextCheckAt:null,verification:stored?.blocked?cleanRescueText(stored.blocked.summary??stored.blocked.rootCause):'Continuation did not produce verified stage progress; conclusion='+run.conclusion};
 });
 return emitCase(runtime,id);
}
const deferredCodes=new Set(['RESCUE_SOURCE_ACTIVE','RESCUE_AGENT_ACTIVE','RESCUE_COOLDOWN','RESCUE_CONTINUATION_ACTIVE','RESCUE_RECHECK_UNAVAILABLE','RESCUE_MERGE_PENDING']);
function deferredState(s,code,reason,delayMs=300000){
 const count=(s.deferredChecks??0)+1,exhausted=count>=72;return{...s,deferredChecks:count,outcome:exhausted?'UNRESOLVED':'DEFERRED',repairCode:exhausted?'RESCUE_RECHECK_EXHAUSTED':code,nextCheckAt:exhausted?null:new Date(Date.now()+delayMs).toISOString(),verification:exhausted?'Bounded deferred rechecks exhausted; operator diagnosis required':cleanRescueText(reason)};
}
export async function deferCase(runtime,id,code,reason,{expectedRevision}={}){
 await updateCase(runtime,id,s=>expectedRevision!==undefined&&s.revision!==expectedRevision?s:deferredState(s,code,reason));
}
export async function recordRecheckFailure(runtime,id,error,{expectedRevision}={}){
 const code=stopCode(error),transient=error.code==='EEXIST'||error.requestMethod==='GET'&&(
  ['GITHUB_READ_UNAVAILABLE','GITHUB_RATE_LIMIT'].includes(code)||error.name==='TimeoutError'||
  ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(error.cause?.code));
 await updateCase(runtime,id,s=>{
  // A concurrent completion notification may already have verified this case.
  if(expectedRevision!==undefined&&s.revision!==expectedRevision||!['PENDING','DEFERRED','PENDING_VERIFICATION','STAGE_RECOVERED'].includes(s.outcome))return s;
  const next={...s,recheckError:{code,at:new Date().toISOString()}};
  return transient?deferredState(next,'RESCUE_RECHECK_UNAVAILABLE',error.message,
   Math.max(300000*2**Math.min(s.deferredChecks??0,3),(error.retryAt??0)-Date.now())):
   {...next,outcome:'UNRESOLVED',repairCode:code,nextCheckAt:null,verification:cleanRescueText(error.message)};
 });
 return emitCase(runtime,id);
}
export async function runRescue(runtime,event,{verifyOnly=false}={}){
 const inputs=event.inputs??{};
 if(Object.keys(inputs).some(k=>!['request_id','source_run_id','issue_ref','reason_code','mode'].includes(k))||!['repair','diagnose'].includes(inputs.mode??'repair'))throw Error('Invalid typed Rescue input');
 runtime.rescueInvocation=event;const grant=await runtime.grant();
 if(!runtime.rescueIdentity||!runtime.coreUpgrade?.rescue)throw Error('Rescue capability was not authenticated');
 if(runtime.environment?.GITHUB_EVENT_NAME==='workflow_run'){
  event=await detectRescueSource(runtime,grant,event);
  if(!event)return rescueLog({outcome:'NOT_NEEDED',actions:[],verification:'No failure or exact Core recovery marker; no repair was needed'});
 }
 return runCase(runtime,grant,event,{verifyOnly});
}
export const eligibleRescueRecheck=c=>c.outcome==='PENDING'&&!c.rescueDispatch||c.outcome==='DEFERRED'&&deferredCodes.has(c.repairCode)||['PENDING_VERIFICATION','STAGE_RECOVERED'].includes(c.outcome)&&Boolean(c.resumeRunId);
export {caseStore as rescueCaseStore,indexStore as rescueIndexStore,updateCase as updateRescueCase};
async function reconcileExternalCompletion(runtime,grant,id,c){
 const issue=grant.manifest.issues.find(i=>i.id===c.request.issueId);
 if(!issue||unitId(grant,issue)!==c.request.unit)return false;
 const state=await new Store(runtime.config.stateDirectory,c.request.unit).read(),receipt=state.actionReceipts?.at(-1);
 if(state.pending||state.issues?.[issue.id]?.blocked||state.completion?.status!=='COMPLETE'||!receipt?.completedAt||!['close','mark-delivered'].includes(receipt.operation)||state.completion.receiptHash!==digest(receipt)||!positive(receipt.action?.runId))return false;
 const run=await verifyRescueSource(runtime,grant,receipt.action.runId,{completed:false});
 if(run.status!=='completed'||run.conclusion!=='success'||run.run_attempt!==Number(receipt.action.runAttempt)||run.jobs.some(j=>j.status!=='completed'))return false;
 const recoveryReceipt=c.resumeRunId&&state.actionReceipts?.some(r=>String(r.action?.runId)===c.resumeRunId&&r.completedAt)&&state.rescueRecoveries?.some(r=>r.caseId===id);
 const resolutionSource=recoveryReceipt?(c.aiDiagnosis?.status==='completed'?'verified-ai-repair':'verified-rescue-continuation'):'verified-external-completion';
 await updateCase(runtime,id,s=>({...s,outcome:'RESOLVED',nextCheckAt:null,resolutionSource,completionRunId:String(run.id),verification:'Current Issue completion and its exact successful finalization Run are verified. Resolution attribution: '+resolutionSource+'. External completion is not counted as an automatic repair.'}));
 return true;
}
async function runCase(runtime,grant,event,{verifyOnly=false}={}){
 const inputs=event.inputs??{};
 const id=await findCase(runtime,grant,event);
 if(!id)return rescueLog({outcome:'NOT_NEEDED',sourceRunId:inputs.source_run_id,actions:[],verification:'Successful source has no current blocked target or recovery case; no repair was needed'});
 const store=caseStore(runtime,id),initial=await store.read();
 if(!initial.request||digest(initial.request.authority)!==digest(binding(grant.manifest,grant.policy)))throw Error('Rescue request belongs to another authority');
 if(await reconcileExternalCompletion(runtime,grant,id,initial))return emitCase(runtime,id);
 if(verifyOnly||initial.resumeRunId)return verifyCase(runtime,grant,id);
 return new Store(runtime.config.stateDirectory,'rescue-repair:'+id).lease(async()=>{
  let c=await store.read();
  const retryDeferred=c.outcome==='DEFERRED'&&deferredCodes.has(c.repairCode)&&!c.resumeDispatch&&!c.actions?.length;
  if(c.outcome==='DEFERRED'&&!retryDeferred){
   await updateCase(runtime,id,s=>({...s,outcome:'UNRESOLVED',repairCode:'RESCUE_SIDE_EFFECT_UNCERTAIN',nextCheckAt:null,verification:'Deferred repair has prior side effects or dispatch intent; operator reconciliation required'}));
   return emitCase(runtime,id);
  }
  if(c.repairStartedAt&&!retryDeferred||['RESOLVED','STAGE_RECOVERED','SUPERSEDED','UNRESOLVED'].includes(c.outcome))return emitCase(runtime,id);
  if(retryDeferred&&inputs.request_id&&c.nextCheckAt&&Date.parse(c.nextCheckAt)>Date.now())return emitCase(runtime,id);
  await updateCase(runtime,id,s=>({...s,rescueRunId:runtime.rescueIdentity.runId}));
  try{
   const source=await verifyRescueSource(runtime,grant,c.request.sourceRunId);
   if(source.run_attempt!==c.request.sourceAttempt)throw rescueStop('RESCUE_SOURCE_CHANGED','Source Run attempt changed');
   const issue=grant.manifest.issues.find(i=>i.id===c.request.issueId);
   if(!issue||unitId(grant,issue)!==c.request.unit)throw rescueStop('RESCUE_TARGET_UNAVAILABLE','No exact current Issue cycle can be repaired');
   const timeout=await providerTimeoutEvidence(runtime,grant,source);
   if(source.conclusion==='cancelled'&&!timeout)throw rescueStop('RESCUE_SOURCE_CANCELLED','Cancelled source has no exact provider timeout evidence; preserve the possible Owner stop');
   if(ownerHold(runtime,issue))throw rescueStop('OWNER_REAUTHORIZATION_REQUIRED','Owner hold is active; automatic recovery is disabled');
   const unit=new Store(runtime.config.stateDirectory,c.request.unit),state=await unit.read(),stored=state.issues?.[issue.id]??{};
   if(JSON.stringify(snapshot(state,issue))!==JSON.stringify(c.request.baseline))throw rescueStop('RESCUE_STATE_CHANGED','Work advanced since the blocked observation; no old state is restored');
   if(inputs.mode==='diagnose')throw rescueStop('RESCUE_DIAGNOSE_ONLY','Diagnosis only: original work and blocking evidence were preserved');
   if(state.pending?.writeAttempted||state.pending?.recoveryRequired)throw rescueStop('RESCUE_SIDE_EFFECT_UNCERTAIN','Pending write/cleanup is unconfirmed; no automatic replay');
   if((await activeIssueContainers(runtime,issue,grant)).length)throw rescueStop('RESCUE_AGENT_ACTIVE','Agent still active; recheck after it stops');
   const writer=timeout&&state.pending?.operation==='deliver'?await inspectInterruptedWriter(runtime,grant,issue,state,source,timeout):null;
   if(timeout&&state.pending&&!writer&&(!['accept','validate-shape'].includes(state.pending.operation)||String(state.pending.executionContext?.action?.runId)!==String(source.id)))throw rescueStop('RESCUE_MANUAL_REQUIRED','Timed-out stage has no proven independent review or preserved Writer session');
   const ghFailure=await ghFailureEvidence(runtime,issue,stored.blocked,c.request.sourceRunId);
   const continuation=await verificationContinuation(runtime,grant,issue,stored),ci=await ciContinuation(runtime,grant,issue,stored,c.request.code);
   if(ci?.kind==='ci-wait')throw rescueStop('RESCUE_MERGE_PENDING','Exact reviewed PR is waiting for GitHub merge requirements; no repair or merge bypass was attempted');
   const transient=retryableRescueCodes.has(c.request.code)&&!stored.blocked;
   const interrupted=(Boolean(timeout)||['RUN_TIMEOUT','RUN_FAILED','EEXIST'].includes(c.request.code))&&!stored.blocked;
   const ai=!ghFailure&&!continuation&&!ci&&!transient&&!interrupted?await inspectAiRepairTarget(runtime,grant,issue,state,source):null;
   if(!ghFailure&&!continuation&&!ci&&!transient&&!interrupted&&!ai)throw rescueStop('RESCUE_MANUAL_REQUIRED','No safely attributable signed recovery target; preserve authority, Scope and uncertain-write boundaries for diagnosis');
   let repairStarted=false;
   const beginRepair=async()=>{
    if(repairStarted)return;
    await consumeRepairBudget(runtime,grant,c.request.unit);
    await updateCase(runtime,id,s=>({...s,repairStartedAt:new Date().toISOString(),nextCheckAt:null}));
    repairStarted=true;
   };
   const actions=[];
   const writerStore=writer?writerSessionStore(runtime,writer):null;
   await recoverRescueLocks(runtime,grant,issue,source,{writerSession:writerStore,beforeRemove:beginRepair,onRemoved:async r=>{actions.push('Removed verified dead-process lock: '+r.path);await updateCase(runtime,id,s=>({...s,actions:[...actions]}));}});
   if(interrupted&&!actions.length)throw rescueStop('RESCUE_NO_KNOWN_REMEDY','Interrupted source has no safely recoverable stale lock');
   const sessionLease=work=>writerStore?writerStore.lease(work):work();
   await new Store(runtime.config.stateDirectory,issueLeaseId(issue)).lease(()=>unit.lease(()=>sessionLease(async()=>{
    const current=await unit.read();if(JSON.stringify(snapshot(current,issue))!==JSON.stringify(c.request.baseline))throw rescueStop('RESCUE_STATE_CHANGED','Current work changed before repair');
    if((await activeIssueContainers(runtime,issue,grant)).length)throw rescueStop('RESCUE_AGENT_ACTIVE','Agent still active');
    await beginRepair();
    if(ai){
     const fresh=await inspectAiRepairTarget(runtime,grant,issue,current,source);
     if(fresh?.targetHash!==ai.targetHash)throw rescueStop('RESCUE_EVIDENCE_CHANGED','AI diagnosis target changed');
     const before=await ai.workspace.captureAttempt(ai.base);
     await updateCase(runtime,id,s=>({...s,aiDiagnosis:{status:'attempted',at:new Date().toISOString(),originalExecutionId:ai.executionId},outcome:'UNRESOLVED',verification:'AI diagnosis started; resolution is not established'}));
     const recovery=await diagnoseAiRepair(runtime,issue,ai,id,diagnosis=>updateCase(runtime,id,s=>({...s,aiDiagnosis:{...s.aiDiagnosis,status:'completed',executionId:diagnosis.executionId,resultHash:diagnosis.resultHash,result:diagnosis.result}})));
     const freshGrant=runtime.readGrant?await runtime.readGrant():await runtime.grant();
     if(freshGrant.recordId!==grant.recordId||digest(binding(freshGrant.manifest,freshGrant.policy))!==digest(binding(grant.manifest,grant.policy)))throw rescueStop('RESCUE_AUTHORITY_CHANGED','Authority changed during AI diagnosis');
     if(ownerHold(runtime,issue))throw rescueStop('OWNER_REAUTHORIZATION_REQUIRED','Owner hold became active during AI diagnosis');
     await verifyRescueSource(runtime,freshGrant,source.id);
     if(digest(await ai.workspace.captureAttempt(ai.base))!==digest(before))throw rescueStop('RESCUE_AI_WORK_CHANGED','Read-only AI diagnosis changed the preserved source');
     if((await activeIssueContainers(runtime,issue,grant)).length)throw rescueStop('RESCUE_AGENT_ACTIVE','AI diagnosis cleanup is not complete');
     await applyAiRepair(runtime,freshGrant,issue,unit,current,source,ai,recovery,id);
     actions.push('AI diagnosed the stopped execution; preserved original source and conversation for bounded original-role repair through all normal gates');
    }else if(writer){
     await restoreInterruptedWriter(runtime,grant,issue,unit,current,source,timeout,writer,id);
     actions.push('Preserved stopped Writer source and original conversation as unaccepted repair input; fresh normal verification required');
    }else if(timeout&&current.pending){
     await unit.transaction(current.revision,v=>{v.rescueRecoveries=[...(v.rescueRecoveries??[]),{caseId:id,pending:v.pending,proof:timeout,at:new Date().toISOString()}];v.pending=null;return v;});
     actions.push('Archived provider-proven interrupted review; preserved candidate and Shape for fresh independent verification');
    }
    if(continuation){
     const proof=await verificationContinuation(runtime,grant,issue,current.issues[issue.id]);if(digest(proof)!==digest(continuation))throw rescueStop('RESCUE_EVIDENCE_CHANGED','Verification evidence changed');
     await unit.transaction(current.revision,v=>{const blocked=v.issues[issue.id].blocked;v.rescueRecoveries=[...(v.rescueRecoveries??[]),{caseId:id,blocked,proof,at:new Date().toISOString()}];v.issues[issue.id].rescueContinuation=proof;delete v.issues[issue.id].blocked;return v;});
     actions.push('Archived proven '+continuation.kind+' interruption; retained original source/base and role session for fresh required verification');
    }else if(ai){
     // AI only proposed the plan. Normal Core executes the actual repair.
    }else if(ci){
     const fresh=await ciContinuation(runtime,grant,issue,current.issues[issue.id],c.request.code);if(digest(fresh)!==digest(ci))throw rescueStop('RESCUE_EVIDENCE_CHANGED','CI readiness changed');
     actions.push(ci.kind==='ci-change'?'Observed changed exact-head CI; normal Core will independently revalidate its existing ci-change recovery':'GitHub reports the exact reviewed PR ready; normal Core will recheck all merge gates');
    }else
    if(ghFailure){
     if(runtime.coreUpgrade.agentGithubRead!==true)throw rescueStop('RESCUE_GH_CAPABILITY_MISSING','New Agent gh capability is not signed');
     const probe=await probeGithubRead(runtime,issue.repository);actions.push(probe.restarted?'Restarted the approved gh read service; pinned-image read passed':'Pinned-image gh read passed; a fresh container has the approved tool');
     await updateCase(runtime,id,s=>({...s,actions:[...actions]}));
     await unit.transaction(current.revision,v=>{const blocked=v.issues[issue.id].blocked;v.rescueRecoveries=[...(v.rescueRecoveries??[]),{caseId:id,blocked,proof:probe,at:new Date().toISOString()}];delete v.issues[issue.id].blocked;return v;});
    }else if(transient){await runtime.github.api('/user');actions.push('Fresh authenticated GitHub read passed; original state retained');}
   })));
   await updateCase(runtime,id,s=>({...s,actions,outcome:'PENDING_VERIFICATION',verification:'Known remedy verified; continuation is not yet proof of resolution',resumeDispatch:{status:'attempted',at:new Date().toISOString()}}));
   const resumeRunId=await dispatchRun(runtime,grant.policy.actionExecution.workflowPath.split('/').at(-1),{issue_id:issue.id,issue_ref:issueReference(issue)});
   await updateCase(runtime,id,s=>({...s,resumeRunId,nextCheckAt:new Date(Date.now()+300000).toISOString(),resumeDispatch:{...s.resumeDispatch,status:'confirmed',runId:resumeRunId}}));
   const index=indexStore(runtime,grant);await index.metadataLease(async()=>{const s=await index.read();await index.transaction(s.revision,v=>({...v,cases:{...v.cases,[id]:{...v.cases[id],resumeRunId}}}));});
  }catch(error){
   const latest=await store.read();
   if(error.code==='RESCUE_STATE_CHANGED'&&!latest.resumeDispatch&&!latest.actions?.length&&!latest.repairStartedAt)await updateCase(runtime,id,s=>({...s,outcome:'SUPERSEDED',nextCheckAt:null,repairCode:error.code,verification:cleanRescueText(error.message)+'; this case does not establish resolution'}));
   else if(deferredCodes.has(error.code)&&!latest.resumeDispatch&&!latest.actions?.length)await deferCase(runtime,id,error.code,error.message);
   else await updateCase(runtime,id,s=>({...s,outcome:'UNRESOLVED',nextCheckAt:null,verification:cleanRescueText(error.message),repairCode:stopCode(error)}));
  }
  return emitCase(runtime,id);
 });
}
export async function rescueOutputs(report,path=process.env.GITHUB_OUTPUT){if(path)for(const[key,value]of Object.entries({case_id:report.caseId??'',resume_run_id:report.resumeRunId??'',outcome:report.outcome??'UNRESOLVED',conclusion:rescueConclusion(report.outcome)}))await appendFile(path,key+'='+String(value)+'\n');}
