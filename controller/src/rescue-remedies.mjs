import {readFile,lstat,unlink,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Store} from './store.mjs';
import {digest} from './core.mjs';
import {issueLeaseId,unitId} from './dynamic.mjs';
import {command} from './process.mjs';
import {rescueStop} from './rescue-policy.mjs';
import {dockerCommand,verifyDockerSecurity} from './docker-security.mjs';

export const retryableRescueCodes=new Set(['GITHUB_READ_UNAVAILABLE','GITHUB_RATE_LIMIT','ACTION_PREDECESSOR_PENDING','ACTIONS_JOB_READBACK_TIMEOUT','MERGE_READBACK_PENDING','DISPATCH_READBACK_PENDING']);
export function processAlive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;return true;}}
export function lockEvidence(lock,source,alive=processAlive){
 const start=Date.parse(lock?.startedAt),earliest=Date.parse(source.run_started_at??source.created_at),end=Date.parse(source.updated_at);
 return source.status==='completed'&&source.jobs?.length>0&&source.jobs.every(j=>j.status==='completed')&&Number.isSafeInteger(lock?.pid)&&lock.pid>0&&Number.isFinite(start)&&start>=earliest-60000&&start<=end+60000&&!alive(lock.pid);
}
export async function activeIssueContainers(runtime,issue,grant,{unit}={}){
 const run=dockerCommand(runtime.config.agent,runtime.rescueCommand??command);
 const ids=(await run('docker',['ps','--filter','name=nibfin-','--format','{{.ID}}'],{timeout:10000})).stdout.trim().split('\n').filter(Boolean);
 if(!ids.length)return[];
 const containers=JSON.parse((await run('docker',['inspect',...ids],{timeout:10000})).stdout);
 const prefix=resolve(runtime.config.stateDirectory,'workspaces',digest(unit??unitId(grant,issue)));
 return containers.filter(c=>c.State?.Running&&c.Mounts?.some(m=>m.Destination==='/work'&&(m.Source===prefix||m.Source.startsWith(prefix+'/')))).map(c=>c.Id);
}
export async function recoverRescueLocks(runtime,grant,issue,source,{beforeRemove=async()=>{},onRemoved=async()=>{},writerSession=null}={}){
 if((await activeIssueContainers(runtime,issue,grant)).length)throw rescueStop('RESCUE_AGENT_ACTIVE','An Agent for this Issue is still running; no lock is removed');
 const root=runtime.config.stateDirectory,unit=new Store(root,unitId(grant,issue)),lease=new Store(root,issueLeaseId(issue));
 const targets=[join(lease.directory,'execution.lock'),join(unit.directory,'execution.lock'),join(unit.directory,'lock')],removed=[],pids=new Set();
 const remove=async(path,requirePid=false)=>{
  let stat,bytes;try{stat=await lstat(path);bytes=await readFile(path);}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||await realpath(path)!==resolve(path))throw rescueStop('RESCUE_LOCK_UNSAFE','Unexpected lock file type');
  const record=JSON.parse(bytes);if(requirePid&&!pids.has(record.pid))return;
  if(!lockEvidence(record,source))throw rescueStop('RESCUE_LOCK_ACTIVE_OR_UNKNOWN','Lock owner is alive or cannot be attributed to the completed source');
  await beforeRemove();
  const fresh=await lstat(path);if(fresh.ino!==stat.ino||fresh.mtimeMs!==stat.mtimeMs||!(await readFile(path)).equals(bytes))throw rescueStop('RESCUE_LOCK_CHANGED','Lock changed during recovery');
  await unlink(path);pids.add(record.pid);const evidence={path,pid:record.pid,startedAt:record.startedAt};removed.push(evidence);await onRemoved(evidence);
 };
 for(const path of targets)await remove(path);
 if(writerSession)for(const file of ['execution.lock','lock'])await remove(join(writerSession.directory,file),true);
 for(let slot=0;slot<grant.policy.maxParallel;slot++)await remove(join(new Store(root,`actions-capacity:${grant.policy.grantId}:${slot}`).directory,'execution.lock'),true);
 return removed;
}
export async function ghFailureEvidence(runtime,issue,blocked,sourceRunId){
 if(blocked?.failureClass!=='external_failure'||blocked.outcome!=='blocked'||!(/^[a-f0-9-]{36}$/i).test(blocked.executionId??''))return false;
 const root=join(runtime.config.stateDirectory,'executions',blocked.executionId);
 try{
  const context=JSON.parse(await readFile(join(root,'context.json'),'utf8'));
  if(context.issue?.id!==issue.id||String(context.executionContext?.action?.runId)!==String(sourceRunId))return false;
  const path=join(root,'transcript.json'),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)return false;
  const transcript=JSON.parse(await readFile(path,'utf8'));
  return transcript.stdout.split('\n').some(line=>{try{const item=JSON.parse(line).item;return item?.type==='command_execution'&&Number.isInteger(item.exit_code)&&item.exit_code!==0&&/(?:^|&&|;)\s*(?:\/usr\/(?:local\/)?bin\/)?gh(?:\s|$)/.test(item.command??'')&&/(?:gh[^\n]*not found|connect (?:ENOENT|ECONNREFUSED)[^\n]*github-read)/i.test(item.aggregated_output??'');}catch{return false;}});
 }catch{return false;}
}
export async function probeGithubRead(runtime,repository){
 const c=runtime.config.agent,run=dockerCommand(c,runtime.rescueCommand??command);
 await verifyDockerSecurity(c,run);
 const args=['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','128m','--user',c.user,
  '--mount',`type=bind,src=${resolve(runtime.root,'src','agent-gh-client.mjs')},dst=/usr/local/bin/gh,readonly`,
  '--mount','type=bind,src=/run/nibfin-github-read,dst=/github-read,readonly','--entrypoint','gh',c.image,'repo','view','--repo',repository,'--json','nameWithOwner,isPrivate'];
 const read=async()=>{const result=JSON.parse((await run('docker',args,{timeout:45000})).stdout);if(result.nameWithOwner!==repository||result.isPrivate!==false)throw Error('Read probe returned another repository');return result;};
 try{return{status:'healthy',observation:await read(),restarted:false};}
 catch{
  await run('sudo',['-n','/usr/bin/systemctl','restart','nibfin-github-read.service'],{timeout:15000});
  return{status:'healthy',observation:await read(),restarted:true};
 }
}
