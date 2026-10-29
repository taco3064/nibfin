import {readFileSync,lstatSync,realpathSync,readlinkSync,writeFileSync,renameSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,basename} from 'node:path';
import {userInfo} from 'node:os';
import {pathToFileURL} from 'node:url';
import {runnerJobPolicies,verifyRunnerJobAdmission} from '../src/runner-job-gate.mjs';

const fail=code=>{throw Error(code);};
const ids=new Set(['id','agentId','runner_id','run_id','repository_id','workflow_id']);
function json(text){return JSON.parse(text.replace(/^\uFEFF/,''),(k,v,c)=>ids.has(k)&&typeof v==='number'?c.source:v);}
function bounded(path,limit=100000){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>limit||realpathSync(path)!==path)fail('unsafe-file');return readFileSync(path);}

// Official .runner GitHubUrl identifies its registration scope, not always a repo.
export function localRunnerRegistration(value){
  try{
    if(typeof value!=='string'||value.length>512)fail('local-registration');
    const url=new URL(value),parts=url.pathname.replace(/\/$/,'').slice(1).split('/');
    if(url.origin!=='https://github.com'||url.username||url.password||url.search||url.hash||![1,2].includes(parts.length)
      ||parts.some(p=>!p||!/[a-z0-9]/i.test(p))||value.toLowerCase().replace(/\/$/,'')!=='https://github.com/'+parts.join('/').toLowerCase())fail('local-registration');
    return Object.freeze({repository:parts.join('/').toLowerCase(),registrationLevel:parts.length===1?'organization':'repository'});
  }catch{fail('local-registration');}
}

// The hook is a Worker child. Never select a process from event data, a stale PID
// file or a name search. Retain /proc start time to prevent a replaced PID kill.
export function currentRunnerWorker(){
  if(process.platform!=='linux')return null;
  let pid=process.ppid;
  for(let n=0;n<6&&Number.isSafeInteger(pid)&&pid>1;n++){
    const exe=readlinkSync(`/proc/${pid}/exe`),status=readFileSync(`/proc/${pid}/status`,'utf8');
    if(basename(exe)==='Runner.Worker'&&basename(dirname(exe))==='bin'){
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
      return {pid,exe,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
    }
    pid=Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
  }
  return null;
}
function abortWorker(worker){
  if(!worker)return false;
  const exe=readlinkSync(`/proc/${worker.pid}/exe`),stat=readFileSync(`/proc/${worker.pid}/stat`,'utf8');
  if(exe!==worker.exe||stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]!==worker.start)fail('worker-changed');
  process.kill(worker.pid,'SIGKILL');return true;
}

export function runJobHook(policyPath){
  let worker=null,policy=null,result={allowed:false,code:'unavailable'};
  try{
    worker=currentRunnerWorker();if(!worker)fail('unsupported-worker-layout');
    const s=lstatSync(policyPath);if(s.uid!==process.getuid()||(s.mode&0o077))fail('unsafe-policy');
    const policies=runnerJobPolicies(json(bounded(policyPath).toString()));policy=policies[0];
    if(worker.exe!==join(policy.runnerDirectory,'bin/Runner.Worker'))fail('worker-installation');
    const workerSha256=createHash('sha256').update(bounded(worker.exe,1048576)).digest('hex');
    const local=json(bounded(join(policy.runnerDirectory,'.runner')).toString());
    const home=userInfo().homedir;
    const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,GH_CONFIG_DIR:join(home,'.config/gh'),LANG:'C'};
    const api=endpoint=>{
      const out=execFileSync('/usr/bin/gh',['api',endpoint],{env,encoding:'utf8',timeout:10000,maxBuffer:1000000,stdio:['ignore','pipe','pipe']});
      return json(out);
    };
    const context={repository:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,attempt:Number(process.env.GITHUB_RUN_ATTEMPT)};
    const candidates=policies.filter(p=>p.repository===context.repository);
    if(!candidates.length||!/^[1-9][0-9]*$/.test(context.runId??'')||!Number.isSafeInteger(context.attempt)||context.attempt<1)fail('invocation');
    policy=candidates[0];
    const prefix=`/repos/${policy.repository}`,run=api(`${prefix}/actions/runs/${context.runId}`);
    if(!/^[a-f0-9]{40}$/.test(run.head_sha??''))fail('run');
    const jobs=api(`${prefix}/actions/runs/${context.runId}/attempts/${context.attempt}/jobs?per_page=100`);
    if(!Number.isSafeInteger(jobs.total_count)||jobs.total_count>100||!Array.isArray(jobs.jobs)||jobs.jobs.length!==jobs.total_count)fail('job-inventory');
    const matches=jobs.jobs.filter(j=>j.runner_id===policy.runnerId&&j.runner_name===policy.runnerName&&j.status==='in_progress');
    if(matches.length!==1)fail('job-identity');
    const selected=candidates.filter(p=>p.workflowPath===run.path&&p.jobName===matches[0].name&&p.ref==='refs/heads/'+run.head_branch&&p.events.includes(run.event));
    if(selected.length!==1)fail('unapproved-workflow');policy=selected[0];
    const workflow=api(`${prefix}/contents/${policy.workflowPath}?ref=${run.head_sha}`);
    result=verifyRunnerJobAdmission(policy,{context,run,job:matches[0],workflow,localRunner:{id:local.agentId,name:local.agentName,
      ...localRunnerRegistration(local.gitHubUrl),workerSha256}});
  }catch(error){result={allowed:false,code:/^[a-z-]+$/.test(error.message)?error.message:'observation-unavailable'};}
  // Private diagnostic only, never raw provider output, process arguments or tokens.
  try{
    if(!policy||!worker)throw Error('No validated private audit destination');
    const file=join(dirname(policyPath),'last-admission.json'),pending=file+'.'+randomUUID();
    const bytes=JSON.stringify({at:new Date().toISOString(),...result,worker:{pid:worker.pid,exe:worker.exe}})+'\n';
    writeFileSync(join(dirname(policyPath),'admission-'+Date.now()+'-'+randomUUID()+'.json'),bytes,{flag:'wx',mode:0o600});
    writeFileSync(pending,bytes,{flag:'wx',mode:0o600});renameSync(pending,file);
  }catch{result={allowed:false,code:'audit-unavailable'};}
  if(result.allowed){process.stdout.write('Nibfin Runner job admission verified.\n');return 0;}
  process.stderr.write(`Nibfin Runner job denied (${result.code}); aborting Worker before workflow steps.\n`);
  if(worker)abortWorker(worker);
  return 1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=runJobHook(process.argv[2]);
}
