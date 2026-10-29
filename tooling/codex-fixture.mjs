import {dockerObservation} from './docker-observation-fixture.mjs';
import {createHash} from 'node:crypto';
// SYNTHETIC Docker boundary: real host child processes, no daemon, login or model.
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLinuxCodexBackend, createAgentLifecycle, selectInstructions, bodyDigest,
  skillForRole, outcomesForRole, linuxCodexProfile, createLinuxClaudeBackend, linuxClaudeProfile, createLinuxGeminiBackend, linuxGeminiProfile} from '../src/index.mjs';
export function codexFixture(role='shape', custom, agent='codex') {
  const root=mkdtempSync(join(tmpdir(),'nibfin-codex-')), hash='a'.repeat(64);
  const environment={id:'member',agent,loginSpace:join(root,'login'),instances:[0,1].map(n=>({id:'instance-'+n,
    workspace:join(root,'work'+n),registration:join(root,'registration'+n),service:join(root,'service'+n)}))};
  for (const p of [environment.loginSpace,...environment.instances.flatMap(i=>[i.workspace,i.registration,i.service])]) mkdirSync(p);
  writeFileSync(join(environment.loginSpace,agent==='gemini'?'gemini-api-key.json':agent==='claude'?'anthropic-api-key.json':'auth.json'),JSON.stringify(agent==='gemini'?{auth_mode:'gemini-api-key',api_key:'LOGIN-SENTINEL'}:agent==='claude'?{auth_mode:'anthropic-api-key',api_key:'LOGIN-SENTINEL'}:{auth_mode:'chatgpt',tokens:{access_token:'LOGIN-SENTINEL'}}));
  const skill=skillForRole(role), repository=custom?{[skill]:{mode:'override',content:custom}}:{};
  const approvals=custom?{repository:{[skill]:{configurationIdentity:bodyDigest(JSON.stringify(repository[skill]))}}}:{};
  const instructions=selectInstructions({role,skill,repository,approvals});
  const execution={id:role+'-execution',request:'request',result:'result',role,skill,source:null};
  const binding={authority:hash,grant:hash,policy:hash,core:hash,runtime:hash,instructions:instructions.identity,
    repositoryId:'42',issueId:'I_fixture',scopeHash:hash,shapeHash:hash};
  const candidate={base:'a'.repeat(40),tree:'b'.repeat(40),diff:hash,paths:[],artifacts:[],hooks:[],emptyHooksReason:'No configured hooks'};
  const inputs={shape:{body:hash},'shape-validator':{body:hash,author:'author'},'shape-diagnosis':{body:hash},
    deliver:{publication:hash,candidate},accept:{candidate,hooks:hash,deliver:'writer'},
    'shaper-review':{candidate,pr:hash,ci:hash,head:'c'.repeat(40),base:'a'.repeat(40),author:'author',validator:'validator',deliver:'writer',accept:'reviewer'}}[role];
  const result={version:1,outcome:outcomesForRole(role)[0],failureClass:'none',summary:'SYNTHETIC fixture only',conflicts:[]};
  const expected={version:1,stage:role,execution,binding,inputs,result}, current={expected,consumed:[]};
  const networks=new Map(), gateways=new Map();
  const calls=[], containers=new Map(), flags={}, children=new Set();
  const image='sha256:'+'1'.repeat(64);
  const respond=value=>({ok:true,output:typeof value === 'string'?value:JSON.stringify(value)});
  const processBoundary=async command=>{
    calls.push(structuredClone(command)); const args=command.args.slice(2), [op]=args;
    if (flags.throw === op) throw Error('ERROR-SENTINEL');
    if (flags.malformed === op) return respond('malformed ERROR-SENTINEL');
    if (op === 'network') {
      if(args[1]==='create'){const name=args.at(-1);networks.set(name,{Name:name,Internal:true,EnableIPv6:false,Options:{'com.docker.network.bridge.gateway_mode_ipv4':'isolated'},Driver:'bridge',Labels:{'nibfin.egress':name}});return respond(name);}
      if(args[1]==='ls')return respond([...networks.keys()].join('\n'));
      if(args[1]==='inspect')return respond([networks.get(args[2])]);
      if(args[1]==='connect'){const name=args.at(-1),network=args.at(-2);gateways.get(name).NetworkSettings.Networks[network]={IPAddress:'172.30.1.2',Aliases:['nibfin-egress']};networks.get(network).Containers={[name]:{Name:name,IPv4Address:'172.30.1.2/24'}};return respond('');}
      if(args[1]==='rm'){networks.delete(args[2]);return respond('');}
    }
    if (op === 'create' && args.includes('/gateway.mjs')) {
      const name=args[args.indexOf('--name')+1],network=args[args.indexOf('--label')+1].split('=')[1];
      const observed=dockerObservation(args,image);
      gateways.set(name,{...observed,Id:name,Name:'/'+name,Image:image,Config:{...observed.Config,Labels:{'nibfin.egress':network}},
        State:{Running:false},HostConfig:observed.HostConfig,NetworkSettings:{Networks:{bridge:{}}}});
      return respond(name);
    }
    if(op==='inspect' && gateways.has(args[1]))return respond([gateways.get(args[1])]);
    if(op==='start' && gateways.has(args.at(-1))){gateways.get(args.at(-1)).State.Running=true;return respond('');}
    if(op==='rm' && gateways.has(args.at(-1))){gateways.delete(args.at(-1));return respond('');}
    if(op==='container' && args.includes('--filter'))return respond([...gateways.keys()].join('\n'));
    if (op === 'version') return respond(JSON.stringify(flags.docker ?? linuxCodexProfile.docker));
    if (op === 'info') return respond({ServerVersion:flags.serverDocker??linuxCodexProfile.docker,OSType:'linux',Architecture:'x86_64',
      CgroupVersion:'2',CgroupDriver:flags.cgroupDriver??'systemd',MemoryLimit:flags.memory ?? true,PidsLimit:true,CpuCfsQuota:true,CpuCfsPeriod:true,
      SecurityOptions:flags.security ?? ['name=rootless','name=seccomp,profile=builtin']});
    if (op === 'image') return respond([{Id:flags.image ?? image,Os:'linux',Architecture:'amd64',Config:{Env:flags.imageEnvironment??['PATH=/usr/local/bin:/usr/bin:/bin']}}]);
    if (op === 'create') {
      if (flags.noCreate && args.at(-1)==='execute') return {ok:false,output:''};
      const name=args[args.indexOf('--name')+1], probe=args.at(-1)==='probe';
      const mounts=args.flatMap((v,i)=>v==='--mount'?[args[i+1]]:[]);
      const observed=dockerObservation(args,image);
      containers.set(name,{...observed,Id:name,Name:'/'+name,Image:image,Config:{...observed.Config,Labels:{'nibfin.execution':name}},
        State:{Running:false,Status:'created',ExitCode:0},env:args.flatMap((v,i)=>v==='--env'?[args[i+1]]:[]),
        HostConfig:{...observed.HostConfig,NetworkMode:args[args.indexOf('--network')+1],Dns:['127.0.0.1'],DnsSearch:['.']},NetworkSettings:{Networks:{[args[args.indexOf('--network')+1]]:{IPAddress:'172.30.1.3'}}},probe,mounts});
      return flags.lostCreate && !probe ? {ok:false,output:''}:respond(name);
    }
    if (op === 'inspect') {
      const c=containers.get(args[1]); return c?respond([c]):{ok:false,output:''};
    }
    if (op === 'container') return respond([...containers.keys()].map(name=>JSON.stringify({Names:name})).join('\n'));
    if (op === 'rm') {
      if (flags.removeFail) return {ok:false,output:''};
      containers.delete(args[1]);return flags.lostRemove?{ok:false,output:''}:respond('');
    }
    if (op === 'stop') {
      if (flags.stopFail) return {ok:false,output:'ERROR-SENTINEL'};
      const c=containers.get(args.at(-1));
      if (!flags.ackOnly) {
        const ended=c?.child && c.State.Running?new Promise(resolve=>c.child.once('exit',resolve)):Promise.resolve();
        c?.child?.kill('SIGTERM');for(const controller of c?.execControllers??[])controller.abort();await ended;
      }
      return respond('');
    }
    if(op==='exec' && gateways.has(args[1]))return respond(createHash('sha256').update(readFileSync(new URL('egress-gateway.mjs',import.meta.resolve('@nibfin/core')))).digest('hex'));
    if(op==='exec') {
      const c=containers.get(args[3]);if(!c?.State.Running)return {ok:false,output:''};
      const mounted=c.mounts.find(m=>m.includes('dst=/verification,'))?.match(/src=([^,]+)/)[1];
      const value=JSON.parse(args.at(-1)),translate=v=>typeof v==='string'&&v.startsWith('/verification')?mounted+v.slice('/verification'.length):v;
      value.cwd=translate(value.cwd);value.args=value.args.map(translate);
      value.env=Object.fromEntries(Object.entries(value.env).map(([k,v])=>[k,translate(v)]));
      const {runVerification,verificationBudget}=await import(new URL('verification-runner.mjs',import.meta.resolve('@nibfin/core')));
      const controller=new AbortController();
      if(!c.execControllers)Object.defineProperty(c,'execControllers',{value:new Set()});c.execControllers.add(controller);
      try{
        const requestDirectory=c.mounts.find(m=>m.includes('dst=/input,')).match(/src=([^,]+)/)[1];
        const budget=JSON.parse(readFileSync(join(requestDirectory,'verification-budget.json')));
        const bounded={...verificationBudget(Math.min(budget.stopVerificationAt,Date.now()+value.timeoutMs)-budget.startedAt,budget.startedAt,0),execution:budget.execution};
        return respond(await runVerification(value.file,value.args,{directory:join(mounted,'commands'),budget:bounded,cwd:value.cwd,env:value.env,signal:controller.signal,stdout:null,stderr:null,secrets:['LOGIN-SENTINEL']}));
      }finally{c.execControllers.delete(controller);}
    }
    if (op === 'start') {
      const c=containers.get(args.at(-1)); c.State={Running:true,Status:'running',ExitCode:0};
      const probe={verificationSupervisor:flags.verificationSupervisor??true,network:[...(agent==='codex'?['chatgpt.com','auth.openai.com']:agent==='claude'?['api.anthropic.com']:['generativelanguage.googleapis.com']),...(c.env.includes('NIBFIN_NODE_WORKLOAD=1')?['registry.npmjs.org','cdn.playwright.dev','playwright.download.prss.microsoft.com']:[])].map(hostname=>({hostname,kind:'verified'})),diagnostic:flags.diagnostic ?? 'ready',node:linuxCodexProfile.node,platform:'linux',arch:'x64',guest:true,version:flags.tool ?? (agent==='gemini'?linuxGeminiProfile.gemini:agent==='claude'?linuxClaudeProfile.claude:linuxCodexProfile.codex),login:flags.login ?? true};
      let output=probe;
      if (!c.probe) {
        const mount=c.mounts.find(m=>m.includes('dst=/input,'));
        const input=mount.match(/src=([^,]+)/)[1];
        const request=JSON.parse(readFileSync(join(input,'request.json')));
        output={...request.context,result};
        if (flags.mutate) flags.mutate(output);
        if(request.context.outputFormat==='shape-author-v1') {
          // Synthetic provider output still passes the maintained entry decoder.
          const authored={body:output.shapeBody,result:output.result};
          if(agent==='codex') {
            const {decodeRoleOutput}=await import(new URL('agent-session.mjs',import.meta.resolve('@nibfin/core')));
            output=decodeRoleOutput(request.context,authored);
          } else output.result=authored;
        }
        if(agent==='gemini') {
          output={response:JSON.stringify(output.result),session_id:'UNTRUSTED-CLI-SESSION'};
          if(flags.envelope)flags.envelope(output);
        }
        if(agent==='claude') {
          output={type:'result',subtype:'success',is_error:false,structured_output:output.result,session_id:'UNTRUSTED-CLI-SESSION'};
          if(flags.envelope)flags.envelope(output);
        }
      }
      const text=flags.output !== undefined && !c.probe?flags.output:JSON.stringify(output);
      // Each start crosses an actual child-process boundary with the supplied clean env.
      const code=`let v='';process.stdin.on('data',b=>v+=b);process.stdin.on('end',()=>{
        if(process.env.NIBFIN_SENTINEL_CREDENTIAL)process.exit(90);
        ${!c.probe&&flags.edit?`require('node:fs').writeFileSync(${JSON.stringify(join(environment.instances[0].workspace,flags.edit.path))},${JSON.stringify(flags.edit.content)});`:''}
        setTimeout(()=>{process.stdout.write(v);process.exit(${flags.exit && !c.probe?flags.exit:0});},${!c.probe?(flags.delay??5):1});});`;
      const child=spawn(process.execPath,['-e',code],{env:command.env,stdio:['pipe','pipe','ignore']});
      Object.defineProperty(c,'child',{value:child,configurable:true});children.add(child);
      const completion=new Promise(resolveResult=>{
        let stdout='', size=0;
        child.stdout.on('data',b=>{size+=b.length;if(size>command.limit){child.kill('SIGKILL');}else stdout+=b;});
        child.on('exit',async code=>{
          children.delete(child);c.State={Running:false,Status:'exited',ExitCode:code??137};
          if(['claude','gemini'].includes(agent) && !c.probe && code===0 && size<=command.limit) {
            try {
              const mod=await import(new URL(agent+'-entry.mjs',import.meta.resolve('@nibfin/core')));
              const parse=mod[agent+'Result'];
              const source=c.mounts.find(m=>m.includes('dst=/input,')).match(/src=([^,]+)/)[1];
              const request=JSON.parse(readFileSync(join(source,'request.json')));
              stdout=JSON.stringify(parse(stdout,request.context,['LOGIN-SENTINEL']));
            } catch {stdout='';}
          }
          if(!c.probe&&flags.mutateCollected&&code===0) {
            const collected=JSON.parse(stdout);flags.mutateCollected(collected);stdout=JSON.stringify(collected);
          }
          resolveResult({ok:code===0 && size<=command.limit,output:(code===0 || command.failureOutput) && size<=command.limit?stdout:''});
        });
      });
      child.stdin.end(text);
      if (flags.attachTimeout && !c.probe) return new Promise(r=>setTimeout(()=>r({ok:false,output:''}),10));
      if (flags.lostStart && !c.probe) return {ok:false,output:''};
      return completion;
    }
    throw Error('Unexpected boundary command');
  };
  const config={root,image,egress:{image},socket:'/run/user/1000/docker.sock',environment,instanceId:'instance-0',
    process:processBoundary,timeout:1000,task:()=>({prompt:'SYNTHETIC task; hostile repo $(touch /escape); no credentials',inputs})};
  const backend=(agent==='gemini'?createLinuxGeminiBackend:agent==='claude'?createLinuxClaudeBackend:createLinuxCodexBackend)(config);
  const life=createAgentLifecycle({environment,instanceId:'instance-0',backend,current:()=>structuredClone(current)});
  const input={execution,binding,instructions:{identity:instructions.identity,content:instructions.content},visibility:'public',ownership:'personal'};
  const wait=()=>new Promise(resolveWait=>setTimeout(resolveWait,10));
  async function collect() {
    for(let n=0;n<300;n++) {const s=await life.collect(execution.id);if(s.result.status!=='pending')return s;await wait();}
    throw Error('Fixture did not finish');
  }
  async function dispose() {for(const child of children)child.kill('SIGKILL');while(children.size)await wait();rmSync(root,{recursive:true,force:true});}
  return {root,environment,expected,current,input,config,backend,life,calls,flags,containers,collect,wait,dispose};
}
