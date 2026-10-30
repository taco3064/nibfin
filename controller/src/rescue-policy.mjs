import {appendFile} from 'node:fs/promises';
import {digest} from './core.mjs';
import {waitForActionIdentity} from './action-identity.mjs';

export const rescueWorkflow='.github/workflows/nibfin-rescue.yml';
export const positive=value=>/^[1-9]\d{0,19}$/.test(String(value??''));
export const hash=value=>/^[a-f0-9]{64}$/.test(value??'');
export const rescueStop=(code,reason)=>Object.assign(Error(reason),{code});
export function validateRescuePolicy(value){
 if(!value||value.schemaVersion!==1||!(/^[a-f0-9]{40}$/).test(value.workflowBlob??'')||!Number.isInteger(value.maxRepairsPerIssue)||value.maxRepairsPerIssue<1||value.maxRepairsPerIssue>3||!Number.isInteger(value.cooldownSeconds)||value.cooldownSeconds<30||value.cooldownSeconds>3600||Object.keys(value).some(k=>!['schemaVersion','workflowBlob','maxRepairsPerIssue','cooldownSeconds'].includes(k)))throw Error('Invalid bounded signed Rescue policy');
 return value;
}
export function validateRescueContinuations(value){
 // Keep the original nested Rescue policy stable for live older validators.
 // This separate amendment capability is understood only by the new Core.
 if(!Array.isArray(value)||!value.length||new Set(value).size!==value.length||value.some(k=>!['verification-budget','ci-change'].includes(k)))throw Error('Invalid signed Rescue continuation capability');return value;
}
export function validateRescueAssistance(value){
 if(!value||value.schemaVersion!==1||value.aiRepair!==true&&value.verificationIo!==true||Object.keys(value).some(k=>!['schemaVersion','aiRepair','verificationIo'].includes(k))||value.aiRepair!==undefined&&value.aiRepair!==true||value.verificationIo!==undefined&&value.verificationIo!==true)throw Error('Invalid signed Rescue assistance capability');return value;
}
export function cleanRescueText(value){return String(value??'').slice(0,6000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'?').replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g,'[REDACTED]').replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g,'[REDACTED]').replace(/(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,]+/ig,'$1[REDACTED]').replace(/([?&](?:token|sig|signature|access_token|jwt)=)[^&\s]+/ig,'$1[REDACTED]');}
export async function rescueLog(report,{summary=process.env.GITHUB_STEP_SUMMARY,log=console.log}={}){
 const safe=JSON.parse(JSON.stringify(report,(_key,value)=>typeof value==='string'?cleanRescueText(value):value));
 log(JSON.stringify({kind:'nibfin-rescue',...safe}));
 if(summary){
  const text=value=>cleanRescueText(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','&#124;').replaceAll('`','&#96;').replaceAll('\n','<br>');
  const rows=[['Outcome',safe.outcome??'UNRESOLVED'],['Target',safe.issueRef??safe.sourceRunId??'Unknown'],['Code',safe.code??'UNKNOWN'],['Cause',safe.reason??'No verified reason available'],['Actions',(safe.actions??[]).join('; ')||'No mutation'],['AI diagnosis',safe.aiDiagnosis?JSON.stringify(safe.aiDiagnosis):'Not invoked'],['Verification',safe.verification??'Not verified'],['Next case',safe.nextCaseId??''],['Next check',safe.nextCheckAt??''],['Source Run',safe.sourceUrl??''],['Continuation Run',safe.resumeUrl??'']];
  await appendFile(summary,'## upstream Rescue\n\n| Field | Record |\n|---|---|\n'+rows.map(([a,b])=>'| '+a+' | '+text(b)+' |').join('\n')+'\n\n');
 }
 return safe;
}
export async function verifyRescueSource(runtime,grant,id,{completed=true}={}){
 if(!positive(id))throw rescueStop('RESCUE_SOURCE_INVALID','Invalid source Run ID');
 const policy=runtime.actionExecutionPolicy(grant),root='/repos/'+policy.repository;
 const run=await runtime.github.api(root+'/actions/runs/'+id);
 if(String(run.id)!==String(id)||run.repository?.full_name!==policy.repository||String(run.repository?.id)!==String(policy.repositoryId)||run.event!=='workflow_dispatch'||run.path!==policy.workflowPath||run.head_branch!=='main'||!policy.actorIds.map(String).includes(String(run.actor?.id))||!policy.actorIds.map(String).includes(String(run.triggering_actor?.id)))throw rescueStop('RESCUE_SOURCE_INVALID','Source is not an approved private Core stage');
 if(completed&&run.status!=='completed')throw rescueStop('RESCUE_SOURCE_ACTIVE','Source Run is still active; preserve its work');
 const file=await runtime.github.api(root+'/contents/'+policy.workflowPath+'?ref='+run.head_sha);
 if(![policy.workflowBlob,policy.previousWorkflowBlob,policy.originalWorkflowBlob].filter(Boolean).includes(file.sha))throw rescueStop('RESCUE_SOURCE_INVALID','Source workflow bytes were not approved');
 const jobs=await runtime.github.list(root+'/actions/runs/'+id+'/attempts/'+run.run_attempt+'/jobs','jobs');
 if(completed&&jobs.some(job=>job.status!=='completed'))throw rescueStop('RESCUE_SOURCE_ACTIVE','A source job remains active');
 return{...run,jobs};
}
// A cancelled Run alone never authorizes recovery. Require the provider's
// annotation on the exact execute job, its signed duration and terminal jobs.
export async function providerTimeoutEvidence(runtime,grant,source){
 const minutes=runtime.coreUpgrade?.executionLimits?.jobTimeoutMinutes;
 if(source.conclusion!=='cancelled'||source.status!=='completed'||!Number.isSafeInteger(minutes)||minutes<1||!source.jobs?.length||source.jobs.some(j=>j.status!=='completed'))return null;
 const jobs=source.jobs.filter(j=>j.name==='execute');if(jobs.length!==1)return null;
 const job=jobs[0],elapsed=Date.parse(job.completed_at)-Date.parse(job.started_at),root='/repos/'+runtime.actionExecutionPolicy(grant).repository;
 const prefix='https://api.github.com'+root+'/check-runs/';
 if(!positive(job.id)||job.conclusion!=='cancelled'||!Number.isFinite(elapsed)||elapsed<minutes*60000||elapsed>(minutes+5)*60000||!job.check_run_url?.startsWith(prefix)||!positive(job.check_run_url.slice(prefix.length)))return null;
 const annotations=await runtime.github.list(root+'/check-runs/'+job.check_run_url.slice(prefix.length)+'/annotations');
 const duration=Math.floor(minutes/60)+'h'+minutes%60+'m0s';
 if(!annotations.some(a=>a.annotation_level==='failure'&&a.message==='The job has exceeded the maximum execution time of '+duration))return null;
 return{kind:'provider-job-timeout',sourceRunId:String(source.id),sourceAttempt:source.run_attempt,jobId:String(job.id),jobTimeoutMinutes:minutes};
}
export async function verifyRescueInvocation(runtime,grant,event){
 const approval=validateRescuePolicy(runtime.coreUpgrade?.rescue),env=runtime.environment,policy=runtime.actionExecutionPolicy(grant),root='/repos/'+policy.repository;
 if(env.GITHUB_REPOSITORY!==policy.repository||!['workflow_dispatch','workflow_run'].includes(env.GITHUB_EVENT_NAME)||!positive(env.GITHUB_RUN_ID)||!positive(env.GITHUB_RUN_ATTEMPT)||!['rescue','verify-result'].includes(env.GITHUB_JOB))throw rescueStop('RESCUE_ORIGIN_INVALID','Rescue requires its dedicated pinned Actions job');
 const run=await runtime.github.api(root+'/actions/runs/'+env.GITHUB_RUN_ID);
 const owner=policy.actorIds.map(String),bot='41898282';
 if(run.repository?.full_name!==policy.repository||String(run.repository?.id)!==String(policy.repositoryId)||run.path!==rescueWorkflow||run.event!==env.GITHUB_EVENT_NAME||run.head_branch!=='main'||run.run_attempt!==Number(env.GITHUB_RUN_ATTEMPT)||run.head_sha!==env.GITHUB_SHA||![...owner,bot].includes(String(run.actor?.id))||![...owner,bot].includes(String(run.triggering_actor?.id)))throw rescueStop('RESCUE_ORIGIN_INVALID','Rescue identity differs from the approved private origin');
 if(env.GITHUB_EVENT_NAME==='workflow_run'){
  const hint=event?.workflow_run;
  if(event?.repository?.private!==true||!positive(hint?.id)||hint.repository?.full_name!==policy.repository||hint.path!==policy.workflowPath||hint.event!=='workflow_dispatch'||hint.status!=='completed')throw rescueStop('RESCUE_ORIGIN_INVALID','Completion recovery requires an approved private Core hint');
 }else if((String(run.actor.id)===bot||String(run.triggering_actor.id)===bot)&&(!positive(event?.inputs?.source_run_id)||event?.inputs?.request_id))throw rescueStop('RESCUE_ORIGIN_INVALID','Automated fallback must identify an independently verified failed source Run');
 const [atRun,current,repository]=await Promise.all([runtime.github.api(root+'/contents/'+rescueWorkflow+'?ref='+run.head_sha),runtime.github.api(root+'/contents/'+rescueWorkflow+'?ref=main'),runtime.github.repository(policy.repository)]);
 const pins=[approval.workflowBlob,runtime.coreUpgrade?.rescuePreviousWorkflowBlob].filter(Boolean);
 if(repository.private!==true||!pins.includes(atRun.sha)||current.sha!==approval.workflowBlob)throw rescueStop('RESCUE_PIN_CHANGED','Rescue workflow is not the exact signed private workflow');
 const job=await waitForActionIdentity(async()=>{
  const jobs=await runtime.github.list(root+'/actions/runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs','jobs');
  const matches=jobs.filter(j=>j.name===env.GITHUB_JOB&&j.status==='in_progress'&&j.runner_name===env.RUNNER_NAME&&policy.runnerIds.map(String).includes(String(j.runner_id)));
  if(matches.length!==1)throw rescueStop('ACTIONS_JOB_PENDING','Awaiting enrolled Rescue job readback');return matches[0];
 });
 return{runId:String(run.id),attempt:run.run_attempt,jobId:String(job.id),runnerId:String(job.runner_id),workflowBlob:atRun.sha,identityHash:digest({run:run.id,attempt:run.run_attempt,job:job.id,blob:atRun.sha})};
}
