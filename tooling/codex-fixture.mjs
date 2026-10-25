// SYNTHETIC Docker boundary: real host child processes, no daemon, login or model.
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLinuxCodexBackend, createAgentLifecycle, selectInstructions, bodyDigest,
  skillForRole, outcomesForRole, linuxCodexProfile} from '../src/index.mjs';
export function codexFixture(role='shape', custom) {
  const root=mkdtempSync(join(tmpdir(),'nibfin-codex-')), hash='a'.repeat(64);
  const environment={id:'member',agent:'codex',loginSpace:join(root,'login'),instances:[0,1].map(n=>({id:'instance-'+n,
    workspace:join(root,'work'+n),registration:join(root,'registration'+n),service:join(root,'service'+n)}))};
  for (const p of [environment.loginSpace,...environment.instances.flatMap(i=>[i.workspace,i.registration,i.service])]) mkdirSync(p);
  writeFileSync(join(environment.loginSpace,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'LOGIN-SENTINEL'}}));
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
  const calls=[], containers=new Map(), flags={}, children=new Set();
  const image='sha256:'+'1'.repeat(64);
  const respond=value=>({ok:true,output:typeof value === 'string'?value:JSON.stringify(value)});
  const processBoundary=async command=>{
    calls.push(structuredClone(command)); const args=command.args.slice(2), [op]=args;
    if (flags.throw === op) throw Error('ERROR-SENTINEL');
    if (flags.malformed === op) return respond('malformed ERROR-SENTINEL');
    if (op === 'version') return respond(JSON.stringify(flags.docker ?? linuxCodexProfile.docker));
    if (op === 'info') return respond({ServerVersion:linuxCodexProfile.docker,OSType:'linux',Architecture:'x86_64',
      CgroupVersion:'2',MemoryLimit:flags.memory ?? true,PidsLimit:true,CpuCfsQuota:true,CpuCfsPeriod:true,
      SecurityOptions:flags.security ?? ['name=rootless','name=seccomp,profile=builtin']});
    if (op === 'image') return respond([{Id:flags.image ?? image,Os:'linux',Architecture:'amd64',Config:{Env:['PATH=/usr/local/bin:/usr/bin:/bin']}}]);
    if (op === 'create') {
      if (flags.noCreate && args.at(-1)==='execute') return {ok:false,output:''};
      const name=args[args.indexOf('--name')+1], probe=args.at(-1)==='probe';
      const mounts=args.flatMap((v,i)=>v==='--mount'?[args[i+1]]:[]);
      containers.set(name,{Name:'/'+name,Image:image,Config:{Labels:{'nibfin.execution':name}},
        State:{Running:false,Status:'created',ExitCode:0},probe,mounts});
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
      if (!flags.ackOnly) c?.child?.kill('SIGTERM');
      return respond('');
    }
    if (op === 'start') {
      const c=containers.get(args.at(-1)); c.State={Running:true,Status:'running',ExitCode:0};
      const probe={node:linuxCodexProfile.node,platform:'linux',arch:'x64',guest:true,version:flags.tool ?? linuxCodexProfile.codex,login:flags.login ?? true};
      let output=probe;
      if (!c.probe) {
        const mount=c.mounts.find(m=>m.includes('dst=/input,'));
        const input=mount.match(/src=([^,]+)/)[1];
        const request=JSON.parse(readFileSync(join(input,'request.json')));
        output={...request.context,result};
        if (flags.mutate) flags.mutate(output);
      }
      const text=flags.output !== undefined && !c.probe?flags.output:JSON.stringify(output);
      // Each start crosses an actual child-process boundary with the supplied clean env.
      const code=`let v='';process.stdin.on('data',b=>v+=b);process.stdin.on('end',()=>{
        if(process.env.NIBFIN_SENTINEL_CREDENTIAL)process.exit(90);
        setTimeout(()=>{process.stdout.write(v);process.exit(${flags.exit && !c.probe?flags.exit:0});},${!c.probe?(flags.delay??5):1});});`;
      const child=spawn(process.execPath,['-e',code],{env:command.env,stdio:['pipe','pipe','ignore']});
      Object.defineProperty(c,'child',{value:child,configurable:true});children.add(child);
      const completion=new Promise(resolveResult=>{
        let stdout='', size=0;
        child.stdout.on('data',b=>{size+=b.length;if(size>command.limit){child.kill('SIGKILL');}else stdout+=b;});
        child.on('exit',code=>{
          children.delete(child);c.State={Running:false,Status:'exited',ExitCode:code??137};
          resolveResult({ok:code===0 && size<=command.limit,output:code===0 && size<=command.limit?stdout:''});
        });
      });
      child.stdin.end(text);
      if (flags.attachTimeout && !c.probe) return new Promise(r=>setTimeout(()=>r({ok:false,output:''}),10));
      if (flags.lostStart && !c.probe) return {ok:false,output:''};
      return completion;
    }
    throw Error('Unexpected boundary command');
  };
  const config={root,image,socket:'/run/user/1000/docker.sock',environment,instanceId:'instance-0',
    process:processBoundary,timeout:1000,task:()=>({prompt:'SYNTHETIC task; hostile repo $(touch /escape); no credentials',inputs})};
  const backend=createLinuxCodexBackend(config);
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
