import {randomUUID} from 'node:crypto';
import {createRoleBudget,createVerificationLane} from './verification.mjs';
import {prepareNodeVerification} from './node-verification.mjs';
import {readFileSync, realpathSync, lstatSync, statfsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createLinuxClaudeBackend} from './claude.mjs';
import {createLinuxGeminiBackend} from './gemini.mjs';
import {createLinuxCodexBackend} from './codex.mjs';
import {canonicalJSON} from './grants.mjs';
const fail=()=>{throw Error('wsl:guest-context');};
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const bridge=fileURLToPath(import.meta.url);
export function observeWslGuest(config) {
  const paths=[config.linux.root,config.profile.node,bridge];
  for(const p of paths) {
    if(realpathSync(p)!==p) fail();
    for(let part=p;part!=='/';part=part.slice(0,part.lastIndexOf('/'))||'/') if(lstatSync(part).isSymbolicLink()) fail();
  }
  return {platform:process.platform,arch:process.arch,uid:process.getuid(),user:userInfo().username,
    kernel:readFileSync('/proc/sys/kernel/osrelease','utf8').trim(),node:process.version,
    nodeHash:hash(process.execPath),bridgeHash:hash(bridge),nodePath:process.execPath,bridgePath:bridge,
    // ext4 is the deliberately narrow supported guest resource filesystem.
    filesystem:statfsSync(config.linux.root).type};
}

/** OS/process injection only; all configuration and Linux decisions remain real. */
export function createWslGuest({observe=observeWslGuest,process:run}={}) {
  let backend=null, config=null, task=null, pin=null;
  const verification=new Map(),preparedCopies=new Map();
  function laneFor(execution) {
    if(!verification.has(execution)) {
      const payloads=[];
      const budget=createRoleBudget({deadlineAt:config.linux.deadlineAt,reserveMs:config.linux.reserveMs});
      const lane=createVerificationLane({execution,budget,guard:value=>backend.assertVerificationInput(execution,value),process:c=>backend.verificationProcess(execution,c),
        retain:async payload=>{const reference='guest:'+randomUUID();payloads.push({reference,...payload});return reference;}});
      verification.set(execution,{lane,payloads});
    }return verification.get(execution);
  }
  async function verified(op,value) {
    const state=laneFor(value.execution);state.payloads.length=0;let result;
    if(op==='prepareNode') {
      const descriptor=config.linux.environment.instances.find(i=>i.id===config.linux.instanceId);
      const prepared=await prepareNodeVerification({source:descriptor.workspace,scratch:backend.verificationRoot(),
        lane:state.lane,project:value.project??'.',npm:'/usr/local/bin/npm'});
      const id=randomUUID();if(prepared.status==='prepared')preparedCopies.set(id,{execution:value.execution,prepared});
      result={id,status:prepared.status,directory:prepared.directory,cwd:prepared.cwd??null,cache:prepared.cache,
        sourceIdentity:prepared.sourceIdentity,receipt:prepared.receipt};
    }else if(op==='nodeCommand') {
      const p=preparedCopies.get(value.id);if(p?.execution!==value.execution)fail();
      result=await p.prepared.command(value.command,{reuse:value.reuse===true});
    }else result=await state.lane.command(value.command,{reuse:value.reuse===true});
    return {result,payloads:state.payloads.splice(0)};
  }
  async function context() {
    const o=await observe(config), p=config.profile;
    if (!o || o.platform!=='linux' || o.arch!=='x64' || o.uid!==p.uid || o.user!==p.user
        || !/microsoft.*WSL2/i.test(o.kernel) || o.node!==p.nodeVersion || o.nodeHash!==p.nodeHash
        || o.bridgeHash!==p.bridgeHash || o.nodePath!==p.node || o.bridgePath!==p.bridge || o.filesystem!==0xef53) fail();
    const now=canonicalJSON(o);if(pin!==null && now!==pin) fail();pin=now;
  }
  return async function request(op,value) {
    if(op==='initialize') {
      if(config) fail();config=JSON.parse(canonicalJSON(value));await context();
      const factory={codex:createLinuxCodexBackend,claude:createLinuxClaudeBackend,gemini:createLinuxGeminiBackend}[config.linux.environment.agent];
      if(!factory) fail();
      backend=factory({...config.linux,...(run?{process:run}:{}),task:()=>task});
      return {status:'initialized'};
    }
    if(!backend || !['readiness','start','collect','stop','termination','cleanup','verificationProcess','verificationRoot','prepareNode','nodeCommand','verificationCommand'].includes(op)) fail();
    await context();
    if(op==='start') {
      task=value.task;
      try {return await backend.start(value.input);}
      catch {return {status:'unknown'};} // Backend retained ownership; session is still reconcilable.
    }
    if(['prepareNode','nodeCommand','verificationCommand'].includes(op))return verified(op,value);
    if(op==='verificationProcess')return backend.verificationProcess(value.execution,value.command);
    return backend[op](value);
  };
}

// A single sequential session retains Linux ownership through lost Docker replies.
// No role text is interpreted as commands, modules, executable paths or configuration.
export function serveWslGuest(input=process.stdin,output=process.stdout,request=createWslGuest()) {
  let buffer=Buffer.alloc(0),chain=Promise.resolve(),last=0,failed=false,pending=0;
  const abort=()=>{failed=true;input.destroy();};
  input.on('data',data=>{
    if(failed)return;
    buffer=Buffer.concat([buffer,data]);if(buffer.length>2097152)return abort();
    let end;
    while((end=buffer.indexOf(10))!==-1) {
      const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);let message;
      try {
        message=JSON.parse(line.toString('utf8'));
        if(Object.keys(message).sort().join(',')!=='id,op,value'||message.id!==last+1
            ||typeof message.op!=='string'||++pending>32)return abort();
        last=message.id;
      }catch{return abort();}
      const handle=async()=>{
        if(failed)return;
        try {
          const value=await request(message.op,message.value);
          const reply=JSON.stringify({id:message.id,ok:true,value})+'\n';
          if(Buffer.byteLength(reply)>2097152)return abort();output.write(reply);
        }catch{output.write(JSON.stringify({id:message.id,ok:false,value:null})+'\n');}
        finally{pending--;}
      };
      // Cancellation is an owned stop operation, not a replacement launch. It must
      // reach the backend while a long preparation/verification request is pending.
      if(message.op==='stop')handle();else chain=chain.then(handle);
    }
  });
  input.on('end',()=>{if(buffer.length)abort();});
}
if(process.argv[1]===bridge) serveWslGuest();
