import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createLinuxCodexBackend,createAgentLifecycle,startGithubReadBroker,redactRuntimeText,rejectSecrets} from '../src/index.mjs';
import {codexFixture} from '../tooling/codex-fixture.mjs';

test('actual builder rejects mismatched proxy source/command/mount/image, isolation and membership observations',async()=>{
 const mutations=[
  c=>c.State.Running=false,c=>c.Image='sha256:'+'f'.repeat(64),c=>c.Config.Cmd=['/attacker.mjs'],
  c=>c.Config.Entrypoint=['/bin/sh'],c=>c.Mounts[0].RW=true,c=>c.Mounts[0].Source='/untrusted/proxy.mjs',
  c=>c.HostConfig.CapAdd=['SYS_ADMIN'],c=>c.HostConfig.Memory=0,c=>c.HostConfig.Privileged=true,
  c=>c.NetworkSettings.Networks.extra={},c=>c.NetworkSettings.Networks[Object.keys(c.NetworkSettings.Networks).find(k=>k!=='bridge')].IPAddress='172.30.1.99'
 ];
 for(const mutate of mutations){
  const f=codexFixture();try {
   const backend=createLinuxCodexBackend({...f.config,process:async command=>{
    const r=await f.config.process(command);
    if(command.args[2]==='inspect'&&command.args[3].startsWith('nibfin-gateway-')){const [c]=JSON.parse(r.output);mutate(c);r.output=JSON.stringify([c]);}
    return r;
   }});
   assert.equal((await backend.readiness()).login,'unavailable');
   assert.equal(f.calls.some(c=>c.args.at(-1)==='probe'||c.args.at(-1)==='execute'),false);
  }finally{await f.dispose();}
 }
 for(const change of [n=>n.Internal=false,n=>n.Options={},n=>n.Driver='host',n=>n.Containers={},n=>n.Containers.intruder={Name:'unowned',IPv4Address:'172.30.1.4/24'}]) {
  const f=codexFixture();try{const backend=createLinuxCodexBackend({...f.config,process:async c=>{
   const r=await f.config.process(c);if(c.args[2]==='network'&&c.args[3]==='inspect'){const [n]=JSON.parse(r.output);change(n);r.output=JSON.stringify([n]);}return r;
  }});assert.equal((await backend.readiness()).login,'unavailable');}finally{await f.dispose();}
 }
});

test('actual role observation rejects escalations, home/socket exposure and writable review mount',async()=>{
 for(const mutate of [c=>c.HostConfig.Privileged=true,c=>c.HostConfig.CapAdd=['SYS_ADMIN'],c=>c.HostConfig.SecurityOpt=['seccomp=unconfined'],
   c=>c.Mounts.push({Type:'bind',Source:'/var/run/docker.sock',Destination:'/docker.sock',RW:true}),
   c=>c.Mounts.push({Type:'bind',Source:'/home/member',Destination:'/home',RW:false}),
   c=>c.Mounts.find(m=>m.Destination==='/work').RW=true,c=>c.Config.Env.push('GH_TOKEN=forbidden')]){
  const f=codexFixture('accept');try{
   const backend=createLinuxCodexBackend({...f.config,process:async command=>{
    const r=await f.config.process(command);
    if(command.args[2]==='inspect'&&!command.args[3].startsWith('nibfin-gateway-')){
      const [c]=JSON.parse(r.output);if(!c.probe)mutate(c);r.output=JSON.stringify([c]);
    }return r;
   }});
   const life=createAgentLifecycle({environment:f.environment,instanceId:f.config.instanceId,backend,current:()=>structuredClone(f.current)});
   const result=await life.start(f.input);assert.notEqual(result.start?.status,'started');
   assert.equal(f.calls.some(c=>c.args[2]==='start'&&c.args.at(-1)===[...f.containers.values()].find(c=>!c.probe)?.Name?.slice(1)),false);
  }finally{await f.dispose();}
 }
});

test('upstream credential forms protect Candidate output as well as transcripts and results',async()=>{
 const f=codexFixture('deliver');try{
  assert.equal((await f.life.start(f.input)).start.status,'started');await f.collect();
  for(const form of ['LOGIN-SENTINEL',Buffer.from('LOGIN-SENTINEL').toString('base64url'),Buffer.from('LOGIN-SENTINEL').toString('hex').toUpperCase(),encodeURIComponent('LOGIN-SENTINEL')]){
   writeFileSync(join(f.environment.instances[0].workspace,'candidate.txt'),form);
   assert.throws(()=>f.backend.assertCandidate(f.input.execution.id),/candidate-credential/);
   assert.throws(()=>rejectSecrets({discarded:form},['LOGIN-SENTINEL']));
   assert.notEqual(redactRuntimeText(form,['LOGIN-SENTINEL']),form);
  }
  writeFileSync(join(f.environment.instances[0].workspace,'candidate.txt'),'ordinary output');
  assert.deepEqual(f.backend.assertCandidate(f.input.execution.id),{status:'verified'});
 }finally{await f.dispose();}
});

test('authorized Agent gets a narrow broker client/socket, never host GitHub authentication',async()=>{
 const f=codexFixture('accept');let server;
 try{
  const directory=join(f.root,'github-read');
  server=await startGithubReadBroker({directory,repositories:['example-org/public-project'],run:async()=>({stdout:'{}'})});
  const backend=createLinuxCodexBackend({...f.config,githubRead:{directory,repositories:['example-org/public-project']}});
  assert.equal((await backend.readiness()).login,'available');
  const probe=f.calls.find(c=>c.args.at(-1)==='probe');
  const mounts=probe.args.flatMap((v,i)=>v==='--mount'?[probe.args[i+1]]:[]);
  assert(mounts.find(m=>m.includes('dst=/github-read,')).endsWith(',readonly'));
  assert(mounts.find(m=>m.includes('dst=/usr/local/bin/gh,')).endsWith(',readonly'));
  assert.doesNotMatch(JSON.stringify(probe),/hosts.yml|GH_TOKEN|GITHUB_TOKEN|\.config\/gh/);
  assert(mounts.every(m=>!m.includes('docker.sock')));
  writeFileSync(join(directory,'unexpected-file'),'host data');
  assert.equal((await backend.readiness()).login,'unavailable');
 }finally{if(server)await new Promise(r=>server.close(r));await f.dispose();}
});


test('read-only bootstrap uses the mounted guarded helper before model invocation and reports failures as diagnostics',async()=>{
 const {prepareReadonlyVerification}=await import(new URL('agent-session.mjs',import.meta.resolve('@nibfin/core')));
 const request={access:'read',prompt:'role',verificationPolicy:{budget:{stopVerificationAt:Date.now()+10000}}};
 const calls=[],logs=[];
 const result=prepareReadonlyVerification(request,(file,args,options)=>{calls.push({file,args,options});return {status:1,stdout:'preparation failed',stderr:'diagnostic'};},
  {exists:()=>true,write:(...args)=>logs.push(args)});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['/verification-runner.mjs','--','node','/verification-prepare.mjs','/work','/tmp']);
 assert.equal(calls[0].options.cwd,'/work');assert.doesNotMatch(JSON.stringify(calls),/GH_TOKEN|GITHUB_TOKEN|LOGIN/);
 assert.match(result.prompt,/Failure is not a test result/);assert.equal(logs[0][0],'/verification/node-preparation.log');assert.match(logs[0][1],/preparation failed/);
 prepareReadonlyVerification({...request,access:'write'},()=>assert.fail('writer does not auto-prepare'),{exists:()=>true,write:()=>assert.fail()});
});
