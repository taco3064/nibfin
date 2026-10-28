// Adapted upstream negative cases; actual Agent/Hook entrypoints are also tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import {dockerSecurity,dockerCommand,verifyDockerSecurity,assertDockerInfo} from '../src/docker-security.mjs';
const config=()=>({user:'0:0',dockerSecurity:{mode:'rootless',socket:'/run/user/1000/docker.sock'}});
const info=()=>({SecurityOptions:['name=rootless','name=seccomp,profile=builtin'],CgroupVersion:'2',CgroupDriver:'systemd',MemoryLimit:true,PidsLimit:true,CpuCfsPeriod:true,CpuCfsQuota:true});
test('upstream socket pinning strips ambient Docker overrides and never permits legacy/rootful fallback',async()=>{
 const calls=[],run=dockerCommand(config(),async(...args)=>{calls.push(args);return {stdout:JSON.stringify(info())};});
 await run('docker',['ps'],{env:{DOCKER_HOST:'tcp://evil:2375',DOCKER_CONTEXT:'rootful',DOCKER_CONFIG:'/untrusted',DOCKER_API_VERSION:'1.0',DOCKER_TLS_VERIFY:'1',PATH:'/usr/bin'}});
 assert.deepEqual(calls[0][1],['--host','unix:///run/user/1000/docker.sock','ps']);assert.deepEqual(calls[0][2].env,{PATH:'/usr/bin'});
 await verifyDockerSecurity(config(),run);
 for(const change of [{SecurityOptions:['name=seccomp,profile=builtin']},{SecurityOptions:['name=rootless']},{CgroupVersion:'1'},{CgroupDriver:'none'},{MemoryLimit:false},{PidsLimit:false},{CpuCfsPeriod:false},{CpuCfsQuota:false}]){
  assert.throws(()=>assertDockerInfo({...info(),...change}));
  await assert.rejects(verifyDockerSecurity(config(),async()=>({stdout:JSON.stringify({...info(),...change})})));
 }
 for(const socket of [undefined,'tcp://localhost:2375','/var/run/docker.sock','/run/user/0/docker.sock','/run/user/1000/../docker.sock'])assert.throws(()=>dockerSecurity({...config(),dockerSecurity:{mode:'rootless',socket}}));
 assert.throws(()=>dockerSecurity({user:'1000:1000'}));assert.throws(()=>dockerSecurity({...config(),user:'1000:1000'}));
 assert.throws(()=>dockerSecurity({...config(),dockerSecurity:{...config().dockerSecurity,fallback:true}}));
 let attempts=0;await assert.rejects(verifyDockerSecurity(config(),dockerCommand(config(),async()=>{attempts++;throw Error('unavailable');})));assert.equal(attempts,1);
});
