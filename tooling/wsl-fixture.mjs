// Synthetic Windows/guest OS observations; real WSL adapter, guest bridge, Linux
// backend and Docker process fixture. No Windows, WSL, model or login claim.
import {createWindowsWslBackend,createAgentLifecycle} from '../src/index.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexFixture} from './codex-fixture.mjs';
const guestModule=await import(new URL('./wsl-guest.mjs',import.meta.resolve('@nibfin/core')));
export function wslFixture(role='deliver') {
  const f=codexFixture(role), hash='a'.repeat(64), commands=[], requests=[], flags={};
  const profile={arch:'x64',context:'service',sid:'S-1-5-21-1000',cwd:'C:\\Nibfin Host',wsl:'C:\\Windows\\System32\\wsl.exe',
    distribution:'Debian-Nibfin',user:'member',uid:1000,node:'/opt/node/bin/node',bridge:'/opt/nibfin/src/wsl-guest.mjs',
    nodeVersion:process.version,nodeHash:hash,bridgeHash:hash,wslHash:hash,
    files:[{path:'C:\\Nibfin Host',identity:'host-dir-1'},{path:'C:\\Windows\\System32\\wsl.exe',identity:'wsl-file-1'}]};
  const host={platform:'win32',arch:'x64',sid:profile.sid,context:'service',distribution:profile.distribution,
    wslVersion:2,available:true,files:profile.files.map((v,n)=>({...v,canonical:v.path,reparse:false,storage:'local',kind:n?'file':'directory',...(n?{hash}:{})}))};
  const guest={platform:'linux',arch:'x64',uid:1000,user:'member',kernel:'6.6.87.2-microsoft-standard-WSL2',
    node:process.version,nodeHash:hash,bridgeHash:hash,nodePath:profile.node,bridgePath:profile.bridge,filesystem:0xef53};
  const {process:docker,...linux}=f.config;
  const serve=guestModule.createWslGuest({observe:async()=>structuredClone(guest),process:docker});
  const config={profile,linux,observeHost:async()=>{if(flags.hostThrow)throw Error('HOST-SECRET');return structuredClone(host);},
    process:command=>{
      commands.push(structuredClone(command));
      if(flags.spawnFail)throw Error('HOST-SECRET');
      const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();
      child.stdin.on('close',()=>child.emit('close',null));
      child.kill=()=>{flags.closed=true;child.stdin.destroy();child.stdout.destroy();child.emit('close',null);return true;};
      guestModule.serveWslGuest(child.stdin,child.stdout,async(op,value)=>{
        requests.push({op,value:structuredClone(value)});
        if(flags.before===op)throw Error('TRANSPORT-SECRET');
        const response=await serve(op,value);
        if(flags.after===op)throw Error('TRANSPORT-SECRET');
        return flags.response===op?flags.value:response;
      });
      return child;
    }};
  const backend=createWindowsWslBackend(config);
  const life=createAgentLifecycle({environment:f.environment,instanceId:linux.instanceId,backend,current:()=>structuredClone(f.current)});
  f.backend=backend;f.life=life;
  f.collect=async()=>{
    for(let n=0;n<300;n++){const result=await life.collect(f.input.execution.id);if(result.result.status!=='pending')return result;await f.wait();}
    throw Error('WSL fixture did not finish');
  };
  return {...f,profile,host,guest,config,backend,life,commands,requests,wslFlags:flags};
}
