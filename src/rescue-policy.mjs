// Adapted from upstream rescue-policy.mjs (PR54), completion routing at PR57.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {contentIdentity,byteDigest} from './evidence.mjs';
import {repositoryCoordinates,githubId,canonicalJSON} from './index.mjs';
export const rescueWorkflow='.github/workflows/nibfin-rescue.yml';
export const rescueNeed=(ok,code)=>{if(!ok)throw Object.assign(Error('rescue:'+code),{code});};
export const rescueSame=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
export const rescueHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
export function validateRescuePolicy(p) {
  rescueNeed(p&&p.version===1&&p.visibility==='public','policy');
  const parts=p.repository?.split('/');rescueNeed(parts?.length===2&&repositoryCoordinates(...parts).key===p.repository,'repository');
  githubId(p.repositoryId);
  rescueNeed(p.ref==='main'&&/^\.github\/workflows\/[\w-]+\.ya?ml$/.test(p.stageWorkflow)
    &&p.stageWorkflow!==rescueWorkflow&&sha(p.stageBlob)&&sha(p.rescueBlob)
    &&Array.isArray(p.actorIds)&&p.actorIds.length>0&&new Set(p.actorIds).size===p.actorIds.length,'policy');
  p.actorIds.forEach(githubId);
  rescueNeed(Array.isArray(p.historical)&&p.historical.every(h=>sha(h.head)&&sha(h.blob)&&['stage','rescue'].includes(h.kind)),'history');
  rescueNeed(Number.isSafeInteger(p.maxRepairs)&&p.maxRepairs>=1&&p.maxRepairs<=3
    &&Number.isSafeInteger(p.cooldownMs)&&p.cooldownMs>=30000&&p.cooldownMs<=3600000
    &&Number.isSafeInteger(p.jobTimeoutMinutes)&&p.jobTimeoutMinutes>=1&&p.jobTimeoutMinutes<=360,'budget');
  rescueNeed(rescueHash(p.authority)&&Number.isSafeInteger(p.expiresAt),'authority');
  return structuredClone(p);
}
/** Exact bytes are authenticated before JSON, including ping. */
export function authenticateRescueWebhook(secret,bytes,headers) {
  rescueNeed(Buffer.isBuffer(secret)&&secret.length>=32&&secret.length<=256&&Buffer.isBuffer(bytes)&&bytes.length<=1048576,'webhook-size');
  const sig=headers?.['x-hub-signature-256'];
  rescueNeed(typeof sig==='string'&&/^sha256=[a-f0-9]{64}$/.test(sig)
    &&timingSafeEqual(Buffer.from(sig.slice(7),'hex'),createHmac('sha256',secret).update(bytes).digest()),'signature');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
/** Provider reads are trusted capabilities, never event-selected endpoints. */
export function createRescueProvenance({policy,provider,timeoutMs=30000}) {
  const p=validateRescuePolicy(policy),root='/repos/'+p.repository;
  rescueNeed(typeof provider?.request==='function'&&typeof provider?.collection==='function','provider');
  rescueNeed(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,'read-budget');
  async function call(work) {
    const controller=new AbortController();let timer;
    try {return await Promise.race([work(controller.signal),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('rescue:read'),{code:'read'}));},timeoutMs);})]);}
    finally {clearTimeout(timer);}
  }
  const read=async endpoint=>{const r=await call(signal=>provider.request({method:'GET',endpoint,target:p.repositoryId,operation:'rescue-read',correlation:'rescue',signal}));rescueNeed(r?.outcome==='read','read');return r.data;};
  async function verify(id,attempt,{kind='stage',completed=true}={}) {
    githubId(id);githubId(String(attempt));rescueNeed(['stage','rescue'].includes(kind),'source');
    const path=kind==='stage'?p.stageWorkflow:rescueWorkflow;
    const run=await read(root+'/actions/runs/'+id+'/attempts/'+attempt);
    rescueNeed(String(run.id)===id&&String(run.run_attempt)===String(attempt)&&run.repository?.private===false
      &&String(run.repository?.id)===p.repositoryId&&run.repository?.full_name?.toLowerCase()===p.repository
      &&run.path===path&&run.event==='workflow_dispatch'&&run.head_branch===p.ref&&sha(run.head_sha)
      &&p.actorIds.includes(String(run.actor?.id))&&p.actorIds.includes(String(run.triggering_actor?.id)),'source');
    if(completed)rescueNeed(run.status==='completed','source-active');
    const at=await read(root+'/contents/'+path+'?ref='+run.head_sha),current=await read(root+'/contents/'+path+'?ref='+p.ref);
    const pin=kind==='stage'?p.stageBlob:p.rescueBlob;
    rescueNeed(current.sha===pin&&(at.sha===pin||p.historical.some(h=>h.kind===kind&&h.head===run.head_sha&&h.blob===at.sha)),'workflow-pin');
    const endpoint=root+'/actions/runs/'+id+'/attempts/'+attempt+'/jobs';
    let pages=0;const jobs=await call(signal=>provider.collection({signal,method:'GET',endpoint:endpoint+'?per_page=100',envelope:'jobs',target:p.repositoryId,
      operation:'rescue-read',correlation:'rescue',allowPage:v=>++pages<=10&&v.split('?')[0]===endpoint}));
    rescueNeed(jobs?.outcome==='complete'&&Array.isArray(jobs.data)&&jobs.data.length<=1000,'jobs');
    if(completed)rescueNeed(jobs.data.every(j=>j.status==='completed'),'source-active');
    return {...run,jobs:jobs.data,identity:contentIdentity({run,blob:at.sha,jobs:jobs.data})};
  }
  async function timeout(source) {
    if(source.conclusion==='timed_out')return {kind:'provider-run-timeout',runId:String(source.id),attempt:String(source.run_attempt)};
    if(source.conclusion!=='cancelled'||source.status!=='completed'||!source.jobs?.length||source.jobs.some(j=>j.status!=='completed'))return null;
    const jobs=source.jobs.filter(j=>j.name==='execute');if(jobs.length!==1)return null;
    const j=jobs[0],elapsed=Date.parse(j.completed_at)-Date.parse(j.started_at),minutes=p.jobTimeoutMinutes;
    const prefix='https://api.github.com'+root+'/check-runs/';
    if(j.conclusion!=='cancelled'||!Number.isFinite(elapsed)||elapsed<minutes*60000||elapsed>(minutes+5)*60000
      ||!j.check_run_url?.startsWith(prefix)||!(/^[1-9]\d*$/.test(j.check_run_url.slice(prefix.length))))return null;
    const endpoint=root+'/check-runs/'+j.check_run_url.slice(prefix.length)+'/annotations';
    let pages=0;const a=await call(signal=>provider.collection({signal,method:'GET',endpoint: endpoint+'?per_page=100',target:p.repositoryId,
      operation:'rescue-read',correlation:'rescue',allowPage:v=>++pages<=10&&v.split('?')[0]===endpoint}));
    rescueNeed(a?.outcome==='complete','annotations');
    const duration=Math.floor(minutes/60)+'h'+minutes%60+'m0s';
    if(!a.data.some(v=>v.annotation_level==='failure'&&v.message==='The job has exceeded the maximum execution time of '+duration))return null;
    return {kind:'provider-job-timeout',runId:String(source.id),attempt:String(source.run_attempt),jobId:String(j.id),minutes};
  }
  async function backfill({from,to,maxRuns}) {
    rescueNeed(Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&to>=from&&to-from<=86400000
      &&Number.isSafeInteger(maxRuns)&&maxRuns>=1&&maxRuns<=100,'backfill-window');
    const endpoint=root+'/actions/workflows/'+p.stageWorkflow.split('/').at(-1)+'/runs';let pages=0;
    const created=encodeURIComponent(new Date(from).toISOString()+'..'+new Date(to).toISOString());
    const r=await call(signal=>provider.collection({method:'GET',endpoint:endpoint+'?event=workflow_dispatch&status=completed&created='+created+'&per_page=100',
      envelope:'workflow_runs',target:p.repositoryId,operation:'rescue-read',correlation:'rescue',signal,
      allowPage:v=>++pages<=2&&v.split('?')[0]===endpoint}));
    rescueNeed(r?.outcome==='complete'&&Array.isArray(r.data)&&r.data.length<=maxRuns,'backfill-limit');
    return r.data.filter(v=>Date.parse(v.created_at)>=from&&Date.parse(v.created_at)<=to);
  }
  async function workflow(kind) {
    rescueNeed(['notification','continuation'].includes(kind),'workflow-kind');
    const path=kind==='notification'?rescueWorkflow:p.stageWorkflow;
    const meta=await read(root+'/actions/workflows/'+path.split('/').at(-1));githubId(String(meta.id));
    rescueNeed(meta.path===path&&meta.state==='active','workflow');
    const commit=await read(root+'/commits/'+p.ref);rescueNeed(sha(commit.sha),'workflow-head');
    const file=await read(root+'/contents/'+path+'?ref='+commit.sha);
    rescueNeed(file.path===path&&file.type==='file'&&file.sha===(kind==='notification'?p.rescueBlob:p.stageBlob)
      &&file.encoding==='base64'&&typeof file.content==='string','workflow-pin');
    return {id:String(meta.id),path,ref:p.ref,refIdentity:{sha:commit.sha,workflowDigest:byteDigest(Buffer.from(file.content,'base64'))}};
  }
  return Object.freeze({verify,timeout,backfill,workflow,policy:p});
}
