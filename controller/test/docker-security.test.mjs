import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {dockerSecurity,dockerCommand,verifyDockerSecurity} from '../src/docker-security.mjs';
import {CodexAgent} from '../src/agent.mjs';
import {runHooks} from '../src/hooks.mjs';
import {activeIssueContainers,probeGithubRead} from '../src/rescue-remedies.mjs';
import {runtimeConfigurationHash,verifyRuntimeHardening} from '../src/runtime-configuration.mjs';
import {digest,canonical} from '../src/core.mjs';
import {resolve} from 'node:path';

const rootless=()=>({image:'sha256:'+'a'.repeat(64),network:'kairo-agent-private',user:'0:0',authDirectory:'/operator/login',dockerSecurity:{mode:'rootless',socket:'/run/user/1000/docker.sock'}});
const info=()=>({SecurityOptions:['name=rootless','name=seccomp,profile=builtin'],CgroupVersion:'2',CgroupDriver:'systemd',MemoryLimit:true,PidsLimit:true,CpuCfsPeriod:true,CpuCfsQuota:true});
test('rootless mode pins every command to a local socket, clears ambient Docker overrides and never falls back',async()=>{
 const config=rootless(),calls=[],run=dockerCommand(config,async(...args)=>{calls.push(args);return{stdout:JSON.stringify(info())};});
 await run('docker',['ps'],{env:{DOCKER_HOST:'tcp://evil:2375',DOCKER_CONTEXT:'rootful',DOCKER_CONFIG:'/untrusted',DOCKER_API_VERSION:'1.0',PATH:'/usr/bin'}});
 assert.deepEqual(calls[0][1],['--host','unix:///run/user/1000/docker.sock','ps']);assert.deepEqual(calls[0][2].env,{PATH:'/usr/bin'});
 await verifyDockerSecurity(config,run);
 for(const change of [{SecurityOptions:['name=seccomp,profile=builtin']},{CgroupVersion:'1'},{CgroupDriver:'none'},{MemoryLimit:false},{PidsLimit:false},{CpuCfsPeriod:false},{CpuCfsQuota:false},{SecurityOptions:['name=rootless']}])
  await assert.rejects(verifyDockerSecurity(config,async()=>({stdout:JSON.stringify({...info(),...change})})),/no rootful fallback/);
 for(const socket of ['tcp://localhost:2375','/var/run/docker.sock','/run/user/0/docker.sock','/run/user/1000/../docker.sock'])assert.throws(()=>dockerSecurity({...config,dockerSecurity:{mode:'rootless',socket}}));
 assert.throws(()=>dockerSecurity({...config,user:'1000:1000'}));
 assert.throws(()=>dockerSecurity({...config,dockerSecurity:{...config.dockerSecurity,fallback:true}}));
 let attempts=0;const failed=dockerCommand(config,async()=>{attempts++;throw Error('unavailable');});
 await assert.rejects(verifyDockerSecurity(config,failed),/unavailable/);assert.equal(attempts,1);
});
test('Agent checks rootless capabilities before login, exposes one auth file and retains read-only reviews',async()=>{
 const config=rootless(),calls=[],agent=new CodexAgent(config,'/core','/state',async(_cmd,args)=>{calls.push(args);return{stdout:JSON.stringify({...info(),MemoryLimit:false})};});
 agent.verifyEgress=async()=>assert.fail('daemon failure must block before egress/login');
 await assert.rejects(agent.login('/candidate','/io'),/no rootful fallback/);assert.equal(calls.length,1);
 const args=agent.executionArgs('/candidate','/io',false);
 assert(args.includes('--read-only'));assert(args.includes('--cap-drop=ALL'));assert(args.some(x=>x.endsWith('dst=/work,readonly')));
 assert(args.some(x=>x===`type=bind,src=${resolve('/operator/login','auth.json')},dst=/auth/auth.json,readonly,bind-propagation=rprivate,bind-recursive=disabled`));
 assert(!args.some(x=>x.includes('src=/operator/login,dst=')));
 const legacy={...config,user:'0:0'};delete legacy.dockerSecurity;
 assert.throws(()=>new CodexAgent(legacy,'/core','/state').args('/w','/io',false),/Root Agent/);
});
test('Hooks and Rescue use the same rootless daemon without mounting Agent login into Hooks',async()=>{
 const config=rootless(),calls=[],run=async(_cmd,args)=>{calls.push(args);const operation=args[2];return{stdout:operation==='info'?JSON.stringify(info()):operation==='ps'?'':JSON.stringify({nameWithOwner:'taco3064/nibfin',isPrivate:false}),stderr:''};};
 const git={tree:'b'.repeat(40),base:'c'.repeat(40),commitMessage:'Deliver\n',directory:'/git',paths:['a.mjs']};
 const result=await runHooks(config,'/candidate',[{path:'check.sh',event:'pre-commit'}],run,git);
 assert.equal(result.status,'passed');assert(calls.every(args=>args[0]==='--host'&&args[1]==='unix:///run/user/1000/docker.sock'));
 const launch=calls.find(args=>args[2]==='run');assert(launch.includes('none'));assert(!launch.some(x=>x.includes('/operator/login')));
 const runtime={config:{agent:config,stateDirectory:'/state'},root:'/core',rescueCommand:run};
 assert.deepEqual(await activeIssueContainers(runtime,{},{manifest:{},policy:{}}),[]);
 const probe=await probeGithubRead(runtime,'taco3064/nibfin');assert.equal(probe.status,'healthy');
 assert(calls.every(args=>args[0]==='--host'));
});
test('a signed runtime hardening retains exact original authority and changes only rootless daemon settings',()=>{
 const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'pem'});
 const previousAgent={...rootless(),user:'1000:1000'};delete previousAgent.dockerSecurity;
 const prior={runnerId:'same-runner',stateDirectory:'/state',controlMode:'owner-project',agent:previousAgent,grantSource:{repository:'private/control'}};
 const config={...prior,agent:rootless()},installed='d'.repeat(64);
 const grant={recordId:'same-authority',manifest:{id:'same-membership'},policy:{controlMode:'owner-project',runtimeHash:runtimeConfigurationHash(prior)}};
 const payload={schemaVersion:1,kind:'owner-runtime-hardening',grantRecordId:grant.recordId,manifestHash:digest(grant.manifest),policyHash:digest(grant.policy),fromRuntimeHash:grant.policy.runtimeHash,toRuntimeHash:runtimeConfigurationHash(config),toCoreDigest:installed,previousAgent,reason:'Rootless cutover'};
 const bundle=p=>({payload:p,signature:sign(null,Buffer.from(canonical(p)),keys.privateKey).toString('base64')});
 assert.equal(verifyRuntimeHardening(bundle(payload),grant,config,installed,publicKey).verified,true);
 for(const altered of [{...config,runnerId:'foreign'},{...config,agent:{...config.agent,network:'host'}},{...config,agent:{...config.agent,image:'sha256:'+'f'.repeat(64)}}]){
  const signed={...payload,toRuntimeHash:runtimeConfigurationHash(altered)};
  assert.throws(()=>verifyRuntimeHardening(bundle(signed),grant,altered,installed,publicKey));
 }
 assert.throws(()=>verifyRuntimeHardening({...bundle(payload),payload:{...payload,reason:'tampered'}},grant,config,installed,publicKey));
 assert.throws(()=>verifyRuntimeHardening(bundle({...payload,toCoreDigest:'e'.repeat(64)}),grant,config,installed,publicKey));
 assert.equal(runtimeConfigurationHash(prior),grant.policy.runtimeHash);
});
