// Operator-only, credential-free native smoke. Never installs, signs or resumes work.
import {readFile,mkdtemp,rm,lstat,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dockerSecurity,dockerCommand,verifyDockerSecurity} from '../src/docker-security.mjs';
const config=JSON.parse(await readFile(process.argv[2],'utf8')),agent=config.agent;
if(process.platform!=='linux'||!dockerSecurity(agent)||!/^sha256:[a-f0-9]{64}$/.test(agent.image))throw Error('Explicit Linux rootless runtime and immutable image required');
const run=dockerCommand(agent);await verifyDockerSecurity(agent,run);
const parent=await realpath(tmpdir()),scratch=await mkdtemp(join(parent,'nibfin-rootless-probe-'));
const container='nibfin-rootless-probe-'+randomUUID();
await writeFile(join(scratch,'sentinel'),'credential-free fixture\n',{mode:0o600});
const probe=`const fs=require('node:fs'),os=require('node:os');
const need=(value,message)=>{if(!value)throw Error(message);};
need(process.getuid()===0,'mapped UID differs');
need(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()==='134217728','memory limit not effective');
need(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()==='32','PID limit not effective');
const [quota,period]=fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(/\\s+/).map(Number);
need(quota/period===0.5,'CPU limit not effective');
need(Object.values(os.networkInterfaces()).flat().every(a=>a.internal),'network namespace is not offline');
let denied=false;try{fs.writeFileSync('/forbidden','x');}catch(e){denied=e.code==='EROFS';}need(denied,'root filesystem writable');
need(fs.readFileSync('/probe/sentinel','utf8')==='credential-free fixture\\n','host UID mapping cannot read input');
fs.writeFileSync('/probe/mapped-output','fixture',{mode:0o600});
console.log(JSON.stringify({memory:true,cpu:true,pids:true,offline:true,readonlyRoot:true,mappedUid:true}));`;
try{
 const output=await run('docker',['run','--rm','--pull','never','--name',container,'--network','none','--read-only','--user','0:0',
  '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--cpus','0.5','--pids-limit','32',
  '--mount',`type=bind,src=${scratch},dst=/probe,bind-propagation=rprivate,bind-recursive=disabled`,
  '--entrypoint','node',agent.image,'-e',probe],{timeout:45000});
 if((await lstat(join(scratch,'mapped-output'))).uid!==process.getuid())throw Error('Rootless output did not map to the operator UID');
 console.log(JSON.stringify({status:'PASSED',socket:agent.dockerSecurity.socket,image:agent.image,observations:JSON.parse(output.stdout),credentialsMounted:false,workResumed:false}));
}finally{
 // Reconcile only this generated name, including after a lost/timed-out launch reply.
 const residual=(await run('docker',['ps','-aq','--filter','name=^/'+container+'$'])).stdout.trim();
 if(residual){await run('docker',['rm','--force',container]);if((await run('docker',['ps','-aq','--filter','name=^/'+container+'$'])).stdout.trim())throw Error('Probe container cleanup unresolved');}
 if(!scratch.startsWith(parent+'/nibfin-rootless-probe-')||await realpath(scratch)!==scratch)throw Error('Unexpected probe cleanup path');
 await rm(scratch,{recursive:true});
}
