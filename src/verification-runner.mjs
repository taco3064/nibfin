import {preparedCommandInputs} from './node-verification.mjs';
// Adapted from upstream d1b47d5e073cf15bdcdc1fbbec098401649878d9.
// Receipts/lock/deadline contract reused; execution delegates to the single Linux
// subreaper owner so descendants which call setsid cannot escape reconciliation.
import {mkdir,readFile,writeFile,unlink,open} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runVerificationChild} from './verification-child.mjs';
import {redactCredentials,containsCredentials} from './credential-output.mjs';
export function verificationBudget(timeoutMs,now=Date.now(),reserveMs=Math.min(300000,Math.floor(timeoutMs/5))) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>86400000||!Number.isSafeInteger(now)||
    !Number.isSafeInteger(reserveMs)||reserveMs<0||reserveMs>=timeoutMs)throw Error('verification: invalid budget');
  return {schemaVersion:1,startedAt:now,deadlineAt:now+timeoutMs,stopVerificationAt:now+timeoutMs-reserveMs,timeoutMs,reserveMs};
}
export function validateBudget(budget) {
  const expected=verificationBudget(budget?.timeoutMs,budget?.startedAt,budget?.reserveMs);
  if(Object.keys(expected).some(k=>expected[k]!==budget[k]))throw Error('verification: invalid budget');return budget;
}
export async function runVerification(executable,args,{directory='/verification/commands',budget,cwd=process.cwd(),env=process.env,
  signal,stdout=process.stdout,stderr=process.stderr,protocol=false,maxBytes=16777216,secrets=[],pathMappings=[]}={}) {
  validateBudget(budget);
  if(typeof executable!=='string'||!executable.startsWith('/')||!Array.isArray(args)||args.some(a=>typeof a!=='string')||
    containsCredentials(JSON.stringify({executable,args,cwd,env}),secrets))throw Error('verification: invalid command');
  await mkdir(directory,{recursive:true,mode:0o700});
  const id=randomUUID(),lock=join(directory,'active.lock'),receiptPath=join(directory,id+'.json'),logPath=join(directory,id+'.log');
  let handle;
  try{handle=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')return {status:'busy',exitCode:75,signal:null,log:''};throw Error('verification: retention unavailable');}
  let release=false,outputError,progress=false,retainedRecord;
  const ownsLane=async()=>{try{return JSON.parse(await readFile(lock,'utf8')).id===id;}catch{return false;}};const outputAbort=new AbortController();
  const outputs=[...new Set([stdout,stderr].filter(Boolean))],writes=new Set();
  const failed=e=>{outputError=e?.code??'OUTPUT_ERROR';outputAbort.abort();};
  const forward=text=>{
    if(!stdout||outputError)return;
    let done;const pending=new Promise(resolve=>{done=resolve;});writes.add(pending);
    try{stdout.write(text,e=>{if(e)failed(e);writes.delete(pending);done();});}
    catch(e){failed(e);writes.delete(pending);done();}
  };
  for(const output of outputs)output.on('error',failed);
  try {
    await handle.writeFile(JSON.stringify({id,pid:process.pid}));
    const inputs=preparedCommandInputs(cwd,{pathMappings});
    const startedAt=Date.now(),remaining=budget.stopVerificationAt-startedAt;
    const result=signal?.aborted?{status:'cancelled',exitCode:130,signal:null,log:''}:remaining<=0?
      {status:'budget_exhausted',exitCode:124,signal:null,log:''}:
      await runVerificationChild({file:executable,args,cwd,env,timeoutMs:remaining},{signal:AbortSignal.any([outputAbort.signal,...(signal?[signal]:[])]),maxBytes,
        onOutput:()=>{if(!progress&&stdout&&!protocol){progress=true;forward('Verification command running.\n');}}});
    if(result.status==='timeout')result.status='budget_exhausted';
    if(result.status==='budget_exhausted')result.exitCode=124;
    if(result.status==='cancelled')result.exitCode=130;
    if(result.status==='spawn_failed')result.exitCode=1;
    const after=preparedCommandInputs(cwd,{pathMappings});
    if(inputs&&after?.source!==inputs.source)throw Error('verification: prepared input changed');
    const log=redactCredentials(result.log,secrets);
    // PR54 closed-output guard. Only a fixed progress marker streams while the
    // child runs; sensitive command logs remain buffered until sanitized. EPIPE
    // aborts the owned subreaper and all descendants before receipt/lane release.
    await Promise.all([...writes]);
    if(!outputError&&!protocol)forward(log);
    await Promise.all([...writes]);
    await new Promise(done=>setImmediate(done));
    if(outputError&&result.status!=='unresolved'){result.status='output_error';result.exitCode=74;}
    if(!await ownsLane()){result.status='unresolved';result.exitCode=1;}
    const record={schemaVersion:1,id,executable,args,cwd,env,...(outputError?{errorCode:outputError}:{}),startedAt,finishedAt:Date.now(),deadlineAt:budget.stopVerificationAt,
      status:result.status,exitCode:result.exitCode,signal:result.signal,inputs,logPath,execution:budget.execution??null,logDigest:createHash('sha256').update(log).digest('hex')};
    await writeFile(logPath,log,{flag:'wx',mode:0o600});
    await writeFile(receiptPath,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
    if(protocol) {
      forward(JSON.stringify({...record,receiptPath,log}));
      await Promise.all([...writes]);await new Promise(done=>setImmediate(done));
      if(outputError&&record.status!=='unresolved') {
        record.status='output_error';record.exitCode=74;record.errorCode=outputError;
        await writeFile(receiptPath,JSON.stringify(record,null,2)+'\n',{mode:0o600});
      }
    }
    retainedRecord=record;release=record.status!=='unresolved';
    return {...record,receiptPath,log};
  } finally {
    for(const output of outputs)output.removeListener('error',failed);
    await handle.close();
    // Retention/reconciliation failure retains ownership and prevents another command.
    if(release){
      if(!await ownsLane()){
        if(retainedRecord){retainedRecord.status='unresolved';retainedRecord.exitCode=1;await writeFile(receiptPath,JSON.stringify(retainedRecord,null,2)+'\n',{mode:0o600});}
        throw Error('verification: ownership changed');
      }
      await unlink(lock);
    }
  }
}
export async function mountedSecrets() {
  const values=[];
  for(const path of ['/tmp/home/.codex/auth.json','/login.json']) {
    try {const login=JSON.parse(await readFile(path,'utf8'));values.push(...Object.values(login.tokens??{api_key:login.api_key}).filter(v=>typeof v==='string'&&v));}catch(e){if(e.code!=='ENOENT')throw Error('verification: login unavailable');}
  }
  return values;
}
export async function main(args=process.argv.slice(2)) {
  const budget=JSON.parse(await readFile('/input/verification-budget.json','utf8'));
  // Fixed read-only host input maps Core-prepared manifests to mounted paths.
  const pathMappings=JSON.parse(await readFile('/input/verification-paths.json','utf8'));
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try {
    if(args[0]==='--protocol') {
      const input=JSON.parse(args[1]);
      const limited={...budget,stopVerificationAt:Math.min(budget.stopVerificationAt,Date.now()+input.timeoutMs)};
      // Command timeout may shorten, never reset, the enclosing execution budget.
      const commandBudget={...verificationBudget(Math.max(1,limited.stopVerificationAt-budget.startedAt),budget.startedAt,0),execution:budget.execution};
      const result=await runVerification(input.file,input.args,{budget:commandBudget,cwd:input.cwd,env:input.env,
        signal:controller.signal,stdout:process.stdout,stderr:null,protocol:true,secrets:await mountedSecrets(),pathMappings});
      return result.status==='output_error'?74:0;
    }
    if(args[0]!=='--'||!args[1])throw Error('verification: expected -- executable [arguments]');
    const executable=args[1].startsWith('/')?args[1]:({node:'/usr/local/bin/node',npm:'/usr/local/bin/npm',git:'/usr/bin/git',sh:'/bin/sh'})[args[1]];
    if(!executable)throw Error('verification: use an absolute executable path');
    const result=await runVerification(executable,args.slice(2),{budget,signal:controller.signal,secrets:await mountedSecrets(),pathMappings});
    console.error(JSON.stringify({kind:'nibfin-verification',...result,log:undefined}));return result.status==='passed'?0:result.exitCode||1;
  } finally {process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('verification: command or evidence retention failed');process.exitCode=1;});
