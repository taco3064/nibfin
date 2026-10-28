// Fixed Linux verification owner. Never imports checkout modules.
import {constants as osConstants} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
const supervisor=fileURLToPath(new URL('./verification-supervisor.py',import.meta.url));
export function probeVerificationSupervisor() {
  const r=spawnSync('/usr/bin/python3',['-I','-S',supervisor,'--probe'],
    {env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:2000,maxBuffer:4096});
  return r.status===0&&!r.error&&r.stdout.trim()==='nibfin-subreaper-v1';
}
export function runVerificationChild(command,{signal:callerSignal,maxBytes=1048576}={}) {
  if(process.platform!=='linux'||!command||typeof command.file!=='string'||!command.file.startsWith('/')||!Array.isArray(command.args)
      ||command.args.some(v=>typeof v!=='string')||typeof command.cwd!=='string'||!command.cwd.startsWith('/')
      ||!Number.isSafeInteger(command.timeoutMs)||command.timeoutMs<1||!command.env||typeof command.env!=='object'
      ||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('verification-child:input');
  return new Promise(resolve=>{
    let child,timer,watchdog,bytes=0,parts=[],proof='',reason=null,done=false;
    const cancel=()=>{reason='cancelled';child?.kill('SIGTERM');};
    const finish=(code)=>{
      if(done)return;done=true;clearTimeout(timer);clearTimeout(watchdog);
      callerSignal?.removeEventListener('abort',cancel);
      process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);
      let result={status:'unresolved',exitCode:null,signal:null,log:Buffer.concat(parts).toString('utf8')};
      try {
        const p=JSON.parse(proof);
        if(code!==0||p.reconciled!==true||!Number.isInteger(p.exitCode)
            ||typeof p.cancelled!=='boolean'||typeof p.timeout!=='boolean')throw Error();
        result={...result,status:reason??(p.spawnFailed?'spawn_failed':p.timeout?'timeout':p.cancelled?'cancelled':p.exitCode===0?'passed':'failed'),
          exitCode:p.exitCode>=0?p.exitCode:null,signal:p.exitCode<0?Object.keys(osConstants.signals).find(k=>osConstants.signals[k]===-p.exitCode)??null:null};
      }catch{}
      resolve(result);
    };
    if(callerSignal?.aborted)return resolve({status:'cancelled',exitCode:null,signal:null,log:''});
    try {
      child=spawn('/usr/bin/python3',['-I','-S',supervisor,JSON.stringify({file:command.file,args:command.args,timeoutMs:command.timeoutMs,deadlineAt:Date.now()+command.timeoutMs})],
        {cwd:command.cwd,env:command.env,shell:false,stdio:['ignore','pipe','pipe','pipe']});
      const data=part=>{bytes+=part.length;if(bytes>maxBytes){reason='output-limit';child.kill('SIGTERM');}else parts.push(part);};
      child.stdout.on('data',data);child.stderr.on('data',data);
      child.stdio[3].on('data',part=>{proof+=part.toString('utf8');if(proof.length>4096){proof='invalid';child.kill('SIGTERM');}});
      child.on('error',()=>{reason='failed';});child.on('close',finish);
      callerSignal?.addEventListener('abort',cancel,{once:true});
      process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
      timer=setTimeout(()=>{reason='timeout';child.kill('SIGTERM');},command.timeoutMs+1000);
      // A supervisor that cannot reconcile is never a pass. The caller must stop
      // its enclosing container and refuse further lane admission.
      watchdog=setTimeout(()=>child.kill('SIGKILL'),command.timeoutMs+3000);
      if(callerSignal?.aborted)cancel();
    }catch{finish(null);}
  });
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url) {
  try {const result=await runVerificationChild(JSON.parse(process.argv[2]));process.stdout.write(JSON.stringify(result));}
  catch {process.exitCode=1;}
}
