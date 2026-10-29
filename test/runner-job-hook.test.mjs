import{test}from'node:test';import assert from'node:assert/strict';
import{mkdtemp,mkdir,copyFile,writeFile,readFile,chmod,rm}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';import{spawn}from'node:child_process';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])test(`denied hook cancellation ${signal} aborts its Worker while the child is still waiting`,{skip:process.platform!=='linux'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'nibfin-hook-signal-'));let parent,guard;
 try{
  await mkdir(join(root,'bin'));const worker=join(root,'bin/Runner.Worker');
  await copyFile('/usr/bin/bash',worker);await chmod(worker,0o700);
  const hook=join(root,'runner-job-hook.sh');await copyFile(new URL('../host/runner-job-hook.sh',import.meta.url),hook);await chmod(hook,0o700);
  const ready=join(root,'ready.json');
  // This is an OS/process fixture, not an Agent or API readiness override. It
  // deliberately ignores termination so the shell must interrupt wait itself.
  await writeFile(join(root,'runner-job-hook.mjs'),`import{writeFileSync,readFileSync}from'node:fs';const stat=readFileSync('/proc/self/stat','utf8');writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,ppid:process.ppid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(3),30000);`);
  parent=spawn(worker,['-c','/usr/bin/bash "$1"; result=$?; exit "$result"','--',hook],
   {env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:root,LANG:'C',NIBFIN_RUNNER_JOB_POLICY:ready},stdio:'ignore'});
  const deadline=Date.now()+5000;
  while(!guard&&Date.now()<deadline){try{guard=JSON.parse(await readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;await delay(20);}}
  assert.ok(guard,'fixture entry did not start');
  const hookPid=guard.ppid;
  const status=await readFile(`/proc/${hookPid}/status`,'utf8');assert.equal(Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]),parent.pid);
  const exit=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker survived denied hook signal')),2000);parent.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});parent.once('error',error=>{clearTimeout(timer);reject(error);});});
  process.kill(hookPid,signal);
  assert.equal((await exit).signal,'SIGKILL');
 }finally{
  if(guard){try{const stat=await readFile(`/proc/${guard.pid}/stat`,'utf8');if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]===guard.start)process.kill(guard.pid,'SIGKILL');}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}}
  if(parent&&parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
