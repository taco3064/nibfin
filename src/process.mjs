// Adapted from Kairo d1b47d5e073cf15bdcdc1fbbec098401649878d9 src/process.mjs.
// One Linux process owner; retain Nibfin's subreaper for escaped descendants.
import {runVerificationChild} from './verification-child.mjs';
export async function command(executable,args,{cwd='/',env=process.env,timeout=120000,limit=16777216,signal}={}) {
  const file=executable.startsWith('/')?executable:({gh:'/usr/bin/gh',docker:'/usr/bin/docker'})[executable];
  if(!file)throw Error('process: absolute executable required');
  const result=await runVerificationChild({file,args,cwd,env,timeoutMs:timeout},{signal,maxBytes:limit});
  if(result.status!=='passed')throw Object.assign(Error('process: command failed'),{status:result.status,exitCode:result.exitCode});
  return {stdout:result.log,stderr:''};
}
export async function containerProcess(input) {
  const result=await runVerificationChild({file:input.file,args:input.args,cwd:'/',env:input.env,timeoutMs:input.timeout},
    {signal:input.signal,maxBytes:input.limit??1048576});
  return {ok:result.status==='passed',output:result.status==='passed'||input.failureOutput?result.log:'',status:result.status,exitCode:result.exitCode};
}
