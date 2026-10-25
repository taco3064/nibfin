import {readFileSync, realpathSync, lstatSync, statfsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
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
      backend=createLinuxCodexBackend({...config.linux,...(run?{process:run}:{}),task:()=>task});
      return {status:'initialized'};
    }
    if(!backend || !['readiness','start','collect','stop','termination','cleanup'].includes(op)) fail();
    await context();
    if(op==='start') {
      task=value.task;
      try {return await backend.start(value.input);}
      catch {return {status:'unknown'};} // Backend retained ownership; session is still reconcilable.
    }
    return backend[op](value);
  };
}

// A single sequential session retains Linux ownership through lost Docker replies.
// No role text is interpreted as commands, modules, executable paths or configuration.
export function serveWslGuest(input=process.stdin,output=process.stdout,request=createWslGuest()) {
  let buffer=Buffer.alloc(0), chain=Promise.resolve(), last=0, failed=false;
  const abort=()=>{failed=true;input.destroy();};
  input.on('data',data=>{
    if(failed)return;
    buffer=Buffer.concat([buffer,data]);if(buffer.length>2097152)return abort();
    let end;
    while((end=buffer.indexOf(10))!==-1) {
      const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
      chain=chain.then(async()=>{
        if(failed)return;
        let message;
        try {
          message=JSON.parse(line.toString('utf8'));
          if(Object.keys(message).sort().join(',')!=='id,op,value' || message.id!==last+1 || typeof message.op!=='string')return abort();
          last=message.id;
          const value=await request(message.op,message.value);
          const reply=JSON.stringify({id:last,ok:true,value})+'\n';
          if(Buffer.byteLength(reply)>2097152)return abort();output.write(reply);
        } catch {if(message?.id===last)output.write(JSON.stringify({id:last,ok:false,value:null})+'\n');else abort();}
      });
    }
  });
  input.on('end',()=>{if(buffer.length)abort();});
}
if(process.argv[1]===bridge) serveWslGuest();
