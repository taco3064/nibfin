import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {binding,digest} from './core.mjs';
import {projectUnit,unitId} from './dynamic.mjs';
import {Store} from './store.mjs';
import {sessionRole} from './role-session.mjs';
import {candidateContract} from './candidate-contract.mjs';
import {rescueStop,cleanRescueText} from './rescue-policy.mjs';

const uuid=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value??'');
async function safeJson(path,limit=1024*1024){
 const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit||await realpath(path)!==resolve(path))throw Error('Unsafe AI recovery evidence');
 return JSON.parse(await readFile(path,'utf8'));
}
export async function inspectAiRepairTarget(runtime,grant,issue,state,source){
 if(runtime.coreUpgrade?.rescueAssistance?.aiRepair!==true)return null;
 const stored=state.issues?.[issue.id],blocked=stored?.blocked;
 if(state.pending||state.completion||blocked?.outcome!=='blocked'||!['external_failure','implementation_defect'].includes(blocked.failureClass)||blocked.contractConflicts?.length||!uuid(blocked.executionId)||!['shape','deliver','accept','shape-validator','shaper-review'].includes(blocked.stage))return null;
 try{
  const root=join(runtime.config.stateDirectory,'executions',blocked.executionId),context=await safeJson(join(root,'context.json')),result=await safeJson(join(root,'validated-result.json'));
  const projected=projectUnit(grant,issue),effective=projected.manifest.issues[0];
  if(digest(context.binding??null)!==digest(binding(projected.manifest,projected.policy)))return null;
  if(context.issue?.id!==issue.id||context.issue.repository!==issue.repository||context.issue.scopeHash!==effective.scopeHash||context.cohort?.id!==unitId(grant,issue)||context.skillSelection?.stage!==blocked.stage||String(context.executionContext?.action?.runId)!==String(source.id)||Object.entries(result).some(([k,v])=>digest(v)!==digest(blocked[k]??null)))return null;
  if(digest(context.candidate??null)!==digest(stored.candidate??null)||digest(context.shape??null)!==digest(stored.shape?.body??null)||!/^[a-f0-9]{40}$/.test(context.repositoryObservation?.base??''))return null;
  const role=sessionRole(blocked.stage);
  if(role){const key=digest({repository:issue.repository,issue:issue.id,scope:effective.scopeHash,binding:context.binding,role}),session=await new Store(runtime.config.stateDirectory,'role-session:'+key).read();
   if(session.sessionStatus!=='ready'||session.lastExecution!==blocked.executionId||!uuid(session.sessionId))return null;
  }
  const workspace=runtime.workspace(projected,effective,stored,['shape','shape-validator'].includes(blocked.stage));
  if(await workspace.preparedBase()!==context.repositoryObservation.base)return null;
  return{kind:'ai-repair',executionId:blocked.executionId,stage:blocked.stage,base:context.repositoryObservation.base,context,result,workspace,targetHash:digest({context,result,blocked,candidate:stored.candidate??null,shape:stored.shape??null})};
 }catch{return null;}
}
export function validateAiRepairPlan(result){
 if(result?.outcome!=='ready'||!['external_failure','implementation_defect'].includes(result.failureClass)||result.contractConflicts?.length||!result.evidenceReferences?.length||typeof result.rootCause!=='string'||!result.rootCause.trim())throw rescueStop('RESCUE_AI_UNRESOLVED',cleanRescueText(result?.rootCause||result?.summary||'AI could not establish a permitted repair'));
 let plan;try{plan=JSON.parse(result.body);}catch{throw rescueStop('RESCUE_AI_PLAN_INVALID','AI returned no typed repair plan');}
 if(!plan||Object.keys(plan).sort().join(',')!=='action,steps'||plan.action!=='retry-original-role'||!Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>8||plan.steps.some(s=>typeof s!=='string'||!s.trim()||s.length>1500))throw rescueStop('RESCUE_AI_PLAN_INVALID','AI plan exceeds the bounded original-role capability');
 return{action:plan.action,steps:plan.steps.map(cleanRescueText)};
}
export async function diagnoseAiRepair(runtime,issue,target,caseId,recordDiagnosis=async()=>{}){
 const path=join(runtime.config.stateDirectory,'executions',target.executionId,'transcript.json');
 let transcript;try{transcript=await safeJson(path,16*1024*1024);}catch{throw rescueStop('RESCUE_AI_EVIDENCE_MISSING','Original execution transcript is unavailable for AI diagnosis');}
 const evidence={stdout:cleanRescueText(String(transcript.stdout??'').slice(-24000)),stderr:cleanRescueText(String(transcript.stderr??'').slice(-12000)),reason:cleanRescueText(transcript.reason??'')};
 const timeout=runtime.agent.executionTimeoutMs;
 try{
  runtime.agent.executionTimeoutMs=Math.min(timeout??runtime.agent.config?.timeoutMs??180000,180000);
  const diagnosis=await runtime.agent.execute('rescue-diagnosis',{...target.context,skillSelection:{identity:'rescue',stage:'rescue-diagnosis',scope:'builtin'},rescue:{caseId,originalExecutionId:target.executionId,originalRole:target.stage,blocked:target.result,transcript:evidence},task:'Diagnose this stopped execution. Propose a concrete repair through the original authorized role. No host mutation, gate bypass or resolution claim.'},target.workspace.work,{mode:'default'});
  await recordDiagnosis(diagnosis);
  return{diagnosis,plan:validateAiRepairPlan(diagnosis.result)};
 }finally{runtime.agent.executionTimeoutMs=timeout;}
}
export async function applyAiRepair(runtime,grant,issue,unit,state,source,target,recovery,caseId){
 const fresh=await inspectAiRepairTarget(runtime,grant,issue,state,source);
 if(fresh?.targetHash!==target.targetHash)throw rescueStop('RESCUE_EVIDENCE_CHANGED','AI recovery target changed');
 const proof={kind:'ai-repair',stage:target.stage,executionId:target.executionId,targetHash:target.targetHash,diagnosisExecutionId:recovery.diagnosis.executionId,diagnosisHash:recovery.diagnosis.resultHash,plan:recovery.plan};
 let seed;
 if(target.stage==='deliver'){
  const stored=state.issues[issue.id],attempt=stored.repairs??0;
  if(stored.candidate||!stored.shape?.body||!Number.isSafeInteger(attempt)||attempt<0||attempt>=Number.MAX_SAFE_INTEGER)throw rescueStop('RESCUE_AI_SOURCE_UNSAFE','AI Writer recovery has no exact unaccepted source');
  const projected=projectUnit(grant,issue),next=runtime.workspace(projected,projected.manifest.issues[0],{repairs:attempt+1});
  try{await lstat(next.root);throw rescueStop('RESCUE_AI_SOURCE_UNSAFE','AI Writer recovery target already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  seed={...await target.workspace.snapshotRepair(target.base,candidateContract(stored.shape.body)),sourceAttempt:attempt,targetAttempt:attempt+1};
 }
 await unit.transaction(state.revision,v=>{
  const stored=v.issues[issue.id];v.rescueRecoveries=[...(v.rescueRecoveries??[]),{caseId,blocked:stored.blocked,proof,...(seed?{seed}:{}),at:new Date().toISOString()}];
  delete stored.blocked;stored.rescueContinuation=proof;
  if(seed){stored.repairs=seed.targetAttempt;stored.repairSeed=seed;}
  stored.repairFindings=[...(stored.repairFindings??[]),'AI Rescue diagnosis: '+cleanRescueText(recovery.diagnosis.result.rootCause),...recovery.plan.steps];
  return v;
 });
 return proof;
}
