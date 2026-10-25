import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, chmodSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {verifyWorkspace} from './workspace.mjs';
import {canonicalJSON} from './grants.mjs';
import {byteDigest, contentIdentity, compareEvidence} from './evidence.mjs';
import {linuxCodexProfile} from './codex.mjs';
import {validateHookObservation} from './obligations.mjs';

const fail = code => {throw new TypeError(`hooks:${code}`);};
const same = (a,b) => {if(canonicalJSON(a)!==canonicalJSON(b)) fail('mismatch');};
const cleanEnv = Object.freeze({PATH:'/usr/bin:/bin', LANG:'C'});
const copy = v => JSON.parse(canonicalJSON(v));
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function git(root,args,input) {
  return execFileSync('git',['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','core.attributesFile=/dev/null','-c','diff.external=',...args],{cwd:root,input,
    env:{...cleanEnv,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_TERMINAL_PROMPT:'0'},
    timeout:30000,maxBuffer:48*1024*1024,stdio:['pipe','pipe','pipe']});
}
/** External boundary only: bounded output is discarded to avoid credential/log disclosure. */
export function hookProcess(command) {
  return new Promise(resolve => {
    let child, timer, timedOut=false, output='', overflow=false;
    const finish = result => {clearTimeout(timer);resolve(result);};
    try {
      child=spawn(command.file,command.args,{env:command.env,cwd:'/',shell:false,stdio:['ignore',command.output?'pipe':'ignore','ignore']});
      child.stdout?.on('data',chunk=>{
        if(Buffer.byteLength(output)+chunk.length>1048576) {overflow=true;child.kill('SIGKILL');}
        else output+=chunk.toString('utf8');
      });
      child.on('error',()=>finish({outcome:'unknown'}));
      child.on('close',(code,signal)=>finish({outcome:timedOut?'timeout':signal||overflow?'unknown':code===0?'success':code===127?'missing-tool':'nonzero',...(command.output?{output}:{})}));
      timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},command.timeout);
    } catch {finish({outcome:'unknown'});}
  });
}
function files(root,prefix='',budget={entries:0,bytes:0},depth=0) {
  if(depth>64) fail('output-limit');
  const out=[];
  for(const name of readdirSync(join(root,prefix)).sort()) {
    if(!prefix && name==='.git') continue;
    if(++budget.entries>20000) fail('output-limit');
    const path=prefix+name, stat=lstatSync(join(root,path));
    if(stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('unsafe-output');
    if(stat.isDirectory()) out.push(...files(root,path+'/',budget,depth+1));
    else {
      if(stat.size>8*1024*1024 || (budget.bytes+=stat.size)>128*1024*1024) fail('output-limit');
      out.push({path,mode:stat.mode&0o111?'100755':'100644',digest:byteDigest(readFileSync(join(root,path)))});
    }
  }
  return out;
}
function observe(root,message,baseTree,expectedMetadata) {
  for(const p of [root,join(root,'.git')]) {
    const stat=lstatSync(p);if(stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe-output');
  }
  const msg=lstatSync(message);
  if(!msg.isFile() || msg.isSymbolicLink() || msg.size>1048576) fail('unsafe-message');
  const metadata=files(root,'.git/').filter(e=>e.path!=='.git/index');
  if(expectedMetadata) same(metadata,expectedMetadata);
  return {metadata,files:files(root),index:git(root,['write-tree']).toString().trim(),
    paths:git(root,['diff-index','--cached','--name-only','--no-renames','-z',baseTree,'--']).toString('base64'),
    message:byteDigest(readFileSync(message))};
}
function materialize(workspace,job) {
  const root=join(job,'repo');mkdirSync(root);
  git(root,['init','--template=','--object-format=sha1']);
  for(const object of workspace.objects) {
    same(git(root,['hash-object','-w','-t',object.type,'--stdin'],object.bytes).toString().trim(),object.oid);
  }
  git(root,['update-ref','HEAD',workspace.candidate.base]);
  git(root,['read-tree',workspace.candidate.tree]);git(root,['checkout-index','-a','-f']);
  for(const source of workspace.sources) {
    const target=join(root,source.path);mkdirSync(join(target,'..'),{recursive:true});
    writeFileSync(target,source.bytes);chmodSync(target,source.mode==='100755'?0o755:0o644);
  }
  return root;
}
function context(input) {
  const {workspace,expected,phase,message,observation,executionId}=input;
  verifyWorkspace(workspace,expected);
  if(!['pre-accept','pre-commit'].includes(phase) || !Buffer.isBuffer(message)
      || message.length>1048576 || typeof executionId!=='string' || !executionId.trim()) fail('phase-input');
  if(!input.profile || !/^sha256:[a-f0-9]{64}$/.test(input.profile.image)) fail('backend-binding');
  same(input.profile,{id:'linux-amd64-rootless-hooks-v1',image:input.profile.image,docker:linuxCodexProfile.docker});
  const validation=validateHookObservation(observation);
  if(!validation.ok) fail('configuration-prerequisite');
  same(validation.hooks,workspace.metadata.inventory.hooks);
  const binding={workspace:expected,profile:copy(input.profile),phase,message:byteDigest(message),executionId,
    observation:contentIdentity(observation),first:null,accept:null};
  if(phase==='pre-commit') {
    const firstInput={...input,phase:'pre-accept',executionId:input.firstExecutionId};
    verifyHookReceipt(input.first,firstInput,input.firstReceiptCurrent);
    const accept=compareEvidence(input.accept,input.acceptCurrent);
    if(accept.stage!=='accept' || accept.result.outcome!=='accepted') fail('acceptance');
    same(accept.inputs.candidate,expected.candidate);
    same(accept.inputs.hooks,input.firstStageIdentity);
    const stage=compareEvidence(input.firstStage,input.firstStageCurrent);
    if(stage.stage!=='pre-accept-hooks') fail('first-stage');
    same(stage.inputs.candidate,expected.candidate);same(stage.inputs.receipt,input.first.identity);
    same(contentIdentity(stage),input.firstStageIdentity);
    for(const key of ['authority','grant','policy','core','runtime','repositoryId','issueId','scopeHash','shapeHash']) {
      same(stage.binding[key],accept.binding[key]);
    }
    same(stage.binding.policy,expected.binding.policy);
    same(stage.binding.scopeHash,expected.binding.scopeHash);same(stage.binding.shapeHash,expected.binding.shapeHash);
    binding.first=input.first.identity;binding.accept=contentIdentity(accept);
  }
  return binding;
}
/** Verify against separately protected current inputs, never receipt-authored expectations. */
export function verifyHookReceipt(receipt,input,current) {
  const binding=context(input);
  if(!receipt || !digest(receipt.identity) || !current || !digest(current.identity)
      || !Array.isArray(current.consumed) || current.consumed.includes(receipt.identity)) fail('receipt-current-or-replay');
  same(receipt.identity,current.identity);
  const {identity,...payload}=receipt;
  same(Object.keys(payload).sort(),['binding','comparisons','hooks','status','version']);
  same(identity,contentIdentity(payload));same(payload.binding,binding);
  same(payload.version,1);same(payload.status,input.workspace.candidate.hooks.length?'success':'not-applicable');
  same(payload.hooks,input.workspace.candidate.hooks.map(h=>({...h,outcome:'success'})));
  same(payload.comparisons,{candidate:true,sources:true,index:true,paths:true,message:true,cleanup:true});
  return copy(receipt);
}
/** Trusted Core config; uses the existing Linux rootless Docker transport, no Agent mounts. */
export function createHookRunner({image,socket,process:run=hookProcess,timeout=30000}) {
  if(!/^sha256:[a-f0-9]{64}$/.test(image) || !/^\/run\/user\/[1-9][0-9]*\/docker.sock$/.test(socket)
      || typeof run!=='function' || !Number.isInteger(timeout) || timeout<50 || timeout>3600000) fail('backend');
  async function command(args,ms=timeout,output=false) {
    try {
      const result=await run(Object.freeze({file:'/usr/bin/docker',args:Object.freeze(['--host',`unix://${socket}`,...args]),
        env:cleanEnv,timeout:ms,output}));
      if(output) return result?.outcome==='success' && typeof result.output==='string' && Buffer.byteLength(result.output)<=1048576?result.output:null;
      return ['success','nonzero','timeout','unknown','missing-tool'].includes(result?.outcome)?result.outcome:'unknown';
    } catch {return output?null:'unknown';}
  }
  const profile=Object.freeze({id:'linux-amd64-rootless-hooks-v1',image,docker:linuxCodexProfile.docker});
  let unresolved=false;
  return Object.freeze({profile,async execute(original) {
    if(unresolved) fail('reconciliation-required');
    if(!Buffer.isBuffer(original.message)) fail('message-bytes');
    // Snapshot mutable caller inputs before the first await. Workspace handles remain protected.
    const input={...original,message:Buffer.from(original.message??[]),expected:copy(original.expected),
      observation:copy(original.observation)};
    same(input.profile,profile);
    const binding=context(input), hooks=input.workspace.candidate.hooks;
    let job, name, error=null, cleanup=true;const residual=[];
    try {
      if(hooks.length) {
        let info;try {info=JSON.parse(await command(['info','--format','{{json .}}'],15000,true));}
        catch {fail('backend-observation');}
        if(info?.ServerVersion!==profile.docker || info.OSType!=='linux' || info.Architecture!=='x86_64'
            || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.includes('name=rootless')) fail('unsupported-backend');
        job=mkdtempSync(join(tmpdir(),'nibfin-hooks-'));
        const root=materialize(input.workspace,job), message=join(job,'message');
        writeFileSync(message,input.message);chmodSync(message,0o600);
        const before=observe(root,message,input.workspace.metadata.baseTree);
        same(before.index,input.expected.candidate.tree);
        // Baseline is independently derived from the verified objects and retained sources.
        for(const hook of hooks) {
          name='nibfin-hook-'+randomUUID();
          const args=hook.event==='pre-commit'?[]:['/job/message',...(hook.event==='prepare-commit-msg'?['message']:[])];
          const script='command -v git >/dev/null && command -v sh >/dev/null || exit 127\nexec sh "$@"';
          const outcome=await command(['run','--name',name,'--pull=never','--network=none','--read-only',
            '--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=128',
            '--user','0:0','--platform','linux/amd64','--no-healthcheck','--log-driver','none',
            '--ipc','private','--cgroupns','private','--memory','1g','--cpus','2','--mount',`type=bind,src=${job},dst=/job,bind-propagation=rprivate,bind-recursive=disabled`,
            '--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--workdir','/job/repo',
            '--env','HOME=/nonexistent','--env','PATH=/usr/bin:/bin','--env','GIT_CONFIG_NOSYSTEM=1',
            '--env','GIT_CONFIG_GLOBAL=/dev/null','--entrypoint','/bin/sh',image,'-c',script,'hook',`./${hook.path}`,...args]);
          const removed=await command(['rm','-f',name],15000);
          const ownedName=name;name=null;
          if(removed!=='success') {cleanup=false;residual.push(ownedName);fail('container-cleanup');}
          if(outcome!=='success') fail(`execution-${outcome}`);
          same(observe(root,message,input.workspace.metadata.baseTree,before.metadata),before);
        }
      }
    } catch(e) {error=e.message.startsWith('hooks:')?e.message:e.code==='ENOENT'?'hooks:missing-tool-or-file':'hooks:observation-or-materialization';}
    finally {
      if(name && await command(['rm','-f',name],15000)!=='success') {cleanup=false;residual.push(name);}
      if(job) {try {rmSync(job,{recursive:true,force:true});} catch {cleanup=false;residual.push(job);}}
    }
    if(!cleanup) unresolved=true;
    if(error || !cleanup) return {ok:false,diagnostic:error??'hooks:scratch-cleanup',cleanup,
      residual:cleanup?null:`reconcile owned resources before retry: ${residual.join(',')}`};
    const payload={version:1,binding,status:hooks.length?'success':'not-applicable',
      hooks:hooks.map(h=>({...h,outcome:'success'})),
      comparisons:{candidate:true,sources:true,index:true,paths:true,message:true,cleanup:true}};
    const receipt={...payload,identity:contentIdentity(payload)};
    verifyHookReceipt(receipt,input,{identity:receipt.identity,consumed:[]});return {ok:true,receipt};
  }});
}
