import {createHash} from 'node:crypto';

const id=v=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const repository=v=>typeof v==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(v)&&!v.split('/')[0].includes('--')&&!['.','..'].includes(v.split('/')[1]);
const path=v=>typeof v==='string'&&/^\/[a-zA-Z0-9._/-]+$/.test(v)&&!v.split('/').some(x=>x==='.'||x==='..')&&!v.includes('//')&&!v.endsWith('/');
const keys=['version','repository','repositoryId','ownerId','runnerId','runnerName','runnerDirectory','workerSha256','workflowPath','workflowSha256','jobName','allowedActorIds','ref'];
const deny=code=>Object.freeze({allowed:false,code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const workflowPath=v=>typeof v==='string'&&/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(v);
function workflowMatches(workflow,path,digest){
  if(!workflow||workflow.type!=='file'||workflow.path!==path||workflow.encoding!=='base64'
    ||!Number.isSafeInteger(workflow.size)||workflow.size<1||workflow.size>65536
    ||typeof workflow.content!=='string'||workflow.content.length>100000
    ||!/^[a-zA-Z0-9+/=\r\n]+$/.test(workflow.content))return false;
  const encoded=workflow.content.replace(/[\r\n]/g,''),bytes=Buffer.from(encoded,'base64');
  return bytes.length===workflow.size&&bytes.toString('base64')===encoded&&sha(bytes)===digest
    &&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===workflow.sha;
}

/** Admission narrows a locally installed Runner to reviewed workflow bytes.
 * It grants no Issue, Agent, registration or write authority. The trusted host
 * supplies the policy and authenticated API observations; model input cannot.
 */
export function runnerJobPolicy(input) {
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||
    Object.keys(input).sort().join(' ')!==[...keys,...('events' in input?['events']:[]),...('registrationLevel' in input?['registrationLevel']:[]),...('workflowDependencies' in input?['workflowDependencies']:[])].sort().join(' ')||input.version!==1||
    input.registrationLevel!==undefined&&!['repository','organization'].includes(input.registrationLevel)||
    !repository(input.repository)||!['repositoryId','ownerId','runnerId'].every(k=>id(input[k]))||
    !['workerSha256','workflowSha256'].every(k=>hash(input[k]))||!path(input.runnerDirectory)||
    typeof input.runnerName!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/.test(input.runnerName)||
    !workflowPath(input.workflowPath)||
    typeof input.jobName!=='string'||!input.jobName.trim()||input.jobName.length>128||/[\x00-\x1f\x7f]/.test(input.jobName)||
    typeof input.ref!=='string'||!/^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(input.ref)||/\.\.|\/\/|\/$/.test(input.ref)||
    !Array.isArray(input.allowedActorIds)||!input.allowedActorIds.length||input.allowedActorIds.length>32||
    input.allowedActorIds.some(x=>!id(x))||new Set(input.allowedActorIds).size!==input.allowedActorIds.length||
    input.events!==undefined&&(!Array.isArray(input.events)||!input.events.length||input.events.length>2||new Set(input.events).size!==input.events.length||input.events.some(e=>!['workflow_dispatch','workflow_run'].includes(e))))
    throw Error('runner-job-gate:invalid-policy');
  let dependencies;
  if(Object.hasOwn(input,'workflowDependencies')){
    const values=input.workflowDependencies,seen=new Set([input.workflowPath]);
    if(!Array.isArray(values)||values.length<1||values.length>8)throw Error('runner-job-gate:invalid-dependencies');
    dependencies=values.map(v=>{
      if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join(' ')!=='path sha256'
        ||!workflowPath(v.path)||!hash(v.sha256)||seen.has(v.path))throw Error('runner-job-gate:invalid-dependencies');
      seen.add(v.path);return Object.freeze({...v});
    });
  }
  return Object.freeze({...input,allowedActorIds:Object.freeze([...input.allowedActorIds]),events:Object.freeze([...(input.events??['workflow_dispatch'])]),
    ...(dependencies?{workflowDependencies:Object.freeze(dependencies)}:{})});
}

/** One instance may serve separately pinned Controller and Rescue workflows. */
export function runnerJobPolicies(input){
  const values=input?.schemaVersion===1&&Object.keys(input).sort().join(' ')==='policies schemaVersion'?input.policies:[input];
  if(!Array.isArray(values)||!values.length||values.length>32)throw Error('runner-job-gate:invalid-policy-set');
  const policies=values.map(runnerJobPolicy),first=policies[0],identities=new Set(),targets=new Map(),targetIds=new Map();
  const level=first.registrationLevel??'repository';
  for(const p of policies){
    if((p.registrationLevel??'repository')!==level||['ownerId','runnerId','runnerName','runnerDirectory','workerSha256'].some(k=>p[k]!==first[k])
      ||level==='repository'&&(p.repository!==first.repository||p.repositoryId!==first.repositoryId)
      ||level==='organization'&&p.repository.split('/')[0]!==first.repository.split('/')[0])throw Error('runner-job-gate:conflicting-installation');
    if(targets.has(p.repository)&&targets.get(p.repository)!==p.repositoryId||targetIds.has(p.repositoryId)&&targetIds.get(p.repositoryId)!==p.repository)
      throw Error('runner-job-gate:conflicting-target');
    targets.set(p.repository,p.repositoryId);targetIds.set(p.repositoryId,p.repository);
    const identity=JSON.stringify([p.repository,p.workflowPath,p.ref,p.jobName]);
    if(identities.has(identity))throw Error('runner-job-gate:duplicate-policy');
    identities.add(identity);
  }
  return Object.freeze(policies);
}

/** Evaluate real provider observations. Caller must abort the Worker on any
 * denial/error: a failing pre-job hook alone does not stop always() steps.
 */
export function verifyRunnerJobAdmission(input,observation) {
  const p=runnerJobPolicy(input),o=observation;
  if(!o||!o.context||!id(o.context.runId)||!Number.isSafeInteger(o.context.attempt)||o.context.attempt<1||
    o.context.repository!==p.repository)return deny('invocation');
  const {run,job,workflow,localRunner}=o,c=o.context;
  const level=p.registrationLevel??'repository',scope=level==='organization'?p.repository.split('/')[0]:p.repository;
  if(!localRunner||localRunner.id!==p.runnerId||localRunner.name!==p.runnerName||
    (localRunner.registrationLevel??'repository')!==level||localRunner.repository!==scope||localRunner.workerSha256!==p.workerSha256)return deny('local-runner');
  if(!run||run.id!==c.runId||run.run_attempt!==c.attempt||!p.events.includes(run.event)||
    run.status!=='in_progress'||run.head_branch!==p.ref.slice(11)||run.path!==p.workflowPath||
    !/^[a-f0-9]{40}$/.test(run.head_sha??''))return deny('run');
  if(run.repository?.id!==p.repositoryId||run.repository?.full_name?.toLowerCase()!==p.repository||
    run.repository?.owner?.id!==p.ownerId||run.head_repository?.id!==p.repositoryId)return deny('repository');
  if(level==='organization'&&run.repository.owner.type!=='Organization')return deny('registration-scope');
  if(!p.allowedActorIds.includes(run.actor?.id)||!p.allowedActorIds.includes(run.triggering_actor?.id))return deny('actor');
  if(!job||job.run_id!==c.runId||job.status!=='in_progress'||job.name!==p.jobName||
    job.runner_id!==p.runnerId||job.runner_name!==p.runnerName||job.head_sha!==run.head_sha||
    job.run_attempt!==undefined&&job.run_attempt!==c.attempt)return deny('job');
  if(!workflowMatches(workflow,p.workflowPath,p.workflowSha256))return deny('workflow-source');
  if(p.workflowDependencies){
    if(!Array.isArray(o.workflowDependencies)||o.workflowDependencies.length!==p.workflowDependencies.length
      ||!p.workflowDependencies.every((d,i)=>workflowMatches(o.workflowDependencies[i],d.path,d.sha256)))return deny('workflow-dependency');
  }
  return Object.freeze({allowed:true,code:'verified',runId:c.runId,attempt:c.attempt,runnerId:p.runnerId,workflowSha256:p.workflowSha256});
}
