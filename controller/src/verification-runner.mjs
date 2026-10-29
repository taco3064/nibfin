// Credential-free Agent utility: only this file is mounted, never private Core.
// Local command receipts do not establish Acceptance, CI or delivery completion.
import {mkdir,readFile,writeFile,unlink,open} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function verificationBudget(timeoutMs,now=Date.now()) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>86400000||!Number.isSafeInteger(now))throw Error('Invalid Agent execution budget');
  const reserveMs=Math.min(300000,Math.floor(timeoutMs/5));
  return{schemaVersion:1,startedAt:now,deadlineAt:now+timeoutMs,stopVerificationAt:now+timeoutMs-reserveMs,timeoutMs,reserveMs};
}
export function validateBudget(budget) {
  const expected=verificationBudget(budget?.timeoutMs,budget?.startedAt);
  if(Object.keys(expected).some(k=>expected[k]!==budget[k]))throw Error('Invalid verification budget');
  return budget;
}
export async function runVerification(executable,args,{directory='/io/verification',budget,cwd=process.cwd(),env=process.env,signal,stdout=process.stdout,stderr=process.stderr,killGraceMs=2000}={}) {
  validateBudget(budget);
  if(typeof executable!=='string'||!executable||!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error('Invalid verification command');
  await mkdir(directory,{recursive:true,mode:0o700});
  const id=randomUUID(),lock=join(directory,'active.lock'),receiptPath=join(directory,id+'.json'),logPath=join(directory,id+'.log');
  let handle;
  try{handle=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')return{status:'busy',exitCode:75,reason:'Another verification owns the lane; await its result instead of overlapping or retrying in a loop'};throw e;}
  let log,child,timer,forceTimer,reason=null,groupOpen=true,outputErrorCode;
  const writes=new Set(),outputs=[...new Set([stdout,stderr].filter(Boolean))];
  const record={schemaVersion:1,id,executable,args,cwd,startedAt:Date.now(),deadlineAt:budget.stopVerificationAt,logPath};
  const kill=kind=>{
    if(reason)return;reason=kind;
    if(child?.pid){
      const send=sig=>{try{if(process.platform==='win32')child.kill(sig);else process.kill(-child.pid,sig);}catch(e){if(e.code!=='ESRCH')throw e;}};
      send('SIGTERM');forceTimer=setTimeout(()=>send('SIGKILL'),killGraceMs);
    }
  };
  const abort=()=>kill('cancelled');
  const outputError=error=>{outputErrorCode=error?.code??'OUTPUT_ERROR';kill('output_error');};
  const forward=(target,bytes)=>{
    if(!target||reason==='output_error')return;
    let done;const pending=new Promise(resolveWrite=>{done=resolveWrite;});writes.add(pending);
    const complete=error=>{if(error)outputError(error);writes.delete(pending);done();};
    try{target.write(bytes,complete);}catch(error){complete(error);}
  };
  try{
    for(const output of outputs)output.on('error',outputError);
    await handle.writeFile(JSON.stringify({id,pid:process.pid,startedAt:record.startedAt}));
    if(record.startedAt>=budget.stopVerificationAt||signal?.aborted){reason=signal?.aborted?'cancelled':'budget_exhausted';return await finish(reason,reason==='cancelled'?130:124);}
    log=createWriteStream(logPath,{flags:'wx',mode:0o600});
    child=spawn(executable,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],shell:false});
    log.on('error',outputError);
    child.stdout.on('data',b=>{forward(log,b);forward(stdout,b);});child.stderr.on('data',b=>{forward(log,b);forward(stderr,b);});
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>kill('budget_exhausted'),Math.max(1,budget.stopVerificationAt-Date.now()));
    const result=await new Promise(resolveResult=>{
      child.once('error',error=>resolveResult({error}));child.once('close',(code,terminationSignal)=>resolveResult({code,terminationSignal}));
    });
    clearTimeout(timer);
    await Promise.all([...writes]);
    await new Promise(r=>setImmediate(r));
    // Retain ownership through escalation, including normal descendants left
    // after the command itself exits in response to SIGTERM.
    if(forceTimer)await new Promise(r=>setTimeout(r,killGraceMs+20));
    groupOpen=false;
    return await finish(reason||(result.error?'spawn_failed':result.code===0?'passed':'failed'),reason==='budget_exhausted'?124:reason==='cancelled'?130:reason==='output_error'?74:result.code??1,outputErrorCode??result.error?.code,result.terminationSignal);
  }finally{
    signal?.removeEventListener('abort',abort);clearTimeout(timer);clearTimeout(forceTimer);
    if(groupOpen&&child?.pid){try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
    try{
      if(log&&!log.closed&&!log.destroyed)await new Promise((resolveLog,reject)=>{log.once('error',reject);log.end(resolveLog);});
    }finally{
      for(const output of outputs)output.removeListener('error',outputError);
      await handle.close();
      const owner=JSON.parse(await readFile(lock,'utf8'));if(owner.id!==id)throw Error('Verification lane ownership changed');await unlink(lock);
    }
  }
  async function finish(status,exitCode,errorCode,terminationSignal){
    const receipt={...record,finishedAt:Date.now(),status,exitCode,...(errorCode?{errorCode}:{}),...(terminationSignal?{terminationSignal}:{})};
    await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});return{...receipt,receiptPath};
  }
}
export async function main(args=process.argv.slice(2)) {
  if(args[0]!=='--'||!args[1])throw Error('Usage: node /verification-runner.mjs -- <executable> [arguments...]');
  const budget=JSON.parse(await readFile('/io/verification-budget.json','utf8')),controller=new AbortController();
  const abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{const result=await runVerification(args[1],args.slice(2),{budget,signal:controller.signal});console.error(JSON.stringify({kind:'kairo-verification',...result}));return result.exitCode;}
  finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});}
