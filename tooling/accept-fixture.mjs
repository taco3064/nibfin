import {dockerObservation} from './docker-observation-fixture.mjs';
// Credential-free local contracts only, never live model or native isolation proof.
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureWorkspace,createAcceptFlow,createAgentLifecycle,createHookRunner,selectInstructions,
  bodyDigest,contentIdentity,hookConfigurationAreas} from '../src/index.mjs';
export async function acceptFixture({empty=false,ownership='personal',child=false,rich=false,originalMessage=Buffer.from('candidate message'),repository='owner/public',issueId='I_97',configure=()=>{}}={}) {
  const root=mkdtempSync(join(tmpdir(),'nibfin-accept-'));
  const h='a'.repeat(64), image='sha256:'+h;
  const git=(...args)=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH,HOME:'/nonexistent',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['pipe','pipe','pipe']});
  git('init','--template=');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'.gitignore'),'ignored\n');writeFileSync(join(root,'binary'),Buffer.from([0,1,2,255]));
  if(rich)writeFileSync(join(root,'deleted'),'delete me');
  git('add','.');git('-c','core.hooksPath=/dev/null','commit','-qm','fixture baseline');
  const base=git('rev-parse','HEAD').toString().trim();
  writeFileSync(join(root,'binary'),Buffer.from([0,255,128,3]));writeFileSync(join(root,'ignored'),'required ignored bytes');
  if(rich){chmodSync(join(root,'binary'),0o755);unlinkSync(join(root,'deleted'));}
  const hooks=empty?[]:[{path:'pre',event:'pre-commit'}];
  if(!empty) writeFileSync(join(root,'pre'),'#!/bin/sh\nexit 0\n');
  const scopeBody='Review this exact candidate before commit';
  const shapeBody=['Candidate artifacts applicability: Required ignored fixture payload.',
    'Candidate hooks applicability: Empty only for explicit empty fixture configuration.',
    '```kairo-candidate',JSON.stringify({artifacts:[{path:'ignored',purpose:'fixture output'}],hooks}),'```'].join('\n');
  const captureInput={root,base,scopeBody,shapeBody,permittedPaths:['.gitignore','binary','ignored','pre',...(rich?['deleted']:[])],
    binding:{repository,scopeHash:bodyDigest(scopeBody),shapeHash:bodyDigest(shapeBody),cycle:'one',policy:h}};
  let w=captureWorkspace(captureInput);
  const selected=selectInstructions({skill:'accept',role:'accept'});
  const binding={authority:h,grant:h,policy:h,core:h,runtime:h,instructions:selected.identity,
    repositoryId:'42',issueId,scopeHash:bodyDigest(scopeBody),shapeHash:bodyDigest(shapeBody)};
  configure({scopeBody,shapeBody,binding});
  const observation={hooks:hooks.map(v=>({...v,evidenceReference:'fixture',applicability:'required',prerequisites:[]})),
    areas:hookConfigurationAreas.map(area=>({area,status:'resolved',evidenceReference:'fixture',detail:'inspected'}))};
  const events=[], records=[], expected=new Map(), lives=[];
  const hookCommands=[];
  const runner=createHookRunner({image,socket:'/run/user/1000/docker.sock',process:async c=>{
    hookCommands.push(c);
    if(c.args[2]==='image')return {outcome:'success',output:JSON.stringify([{Id:image,Os:'linux',Architecture:'amd64',Config:{Env:['PATH=/usr/bin:/bin']}}])};
    if(c.args[2]==='inspect'){const launched=hookCommands.find(v=>v.args[2]==='run'&&v.args.includes(c.args[3])),observed=dockerObservation(launched.args.slice(2),image);return {outcome:'success',output:JSON.stringify([{...observed,Name:'/'+c.args[3],Image:image,Config:{...observed.Config,Labels:{'nibfin.hook':c.args[3]}}}])};}
    if(c.args[2]==='container')return {outcome:'success',output:''};
    if(c.args[2]==='info')return {outcome:'success',output:JSON.stringify({ServerVersion:'28.5.1',OSType:'linux',Architecture:'x86_64',CgroupVersion:'2',CgroupDriver:'systemd',MemoryLimit:true,PidsLimit:true,CpuCfsPeriod:true,CpuCfsQuota:true,SecurityOptions:['name=rootless','name=seccomp,profile=builtin']})};
    if(c.args[2]==='rm')return {outcome:'success'};
    const mount=c.args[c.args.indexOf('--mount')+1], job=mount.slice('type=bind,src='.length).split(',dst=')[0];
    const args=c.args.slice(c.args.indexOf(image)+1).map(v=>v.replaceAll('/job/',job+'/'));
    const r=spawnSync('/bin/sh',args,{cwd:join(job,'repo'),env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}});
    return {outcome:r.status===0?'success':'nonzero'};
  }});
  let hookInput={workspace:w,expected:w.expected,phase:'pre-accept',executionId:'first',message:Buffer.from(originalMessage),observation,profile:runner.profile};
  const first=await runner.execute(hookInput);
  if(!first.ok) throw Error(first.diagnostic);
  events.push('first-pass');
  const execution=(role,id)=>({role,skill:role,id,request:id+'-request',result:id+'-result',source:null});
  const deliver={version:1,stage:'deliver',binding:{...binding,instructions:h},execution:execution('deliver','writer'),
    inputs:{publication:h,candidate:w.candidate},result:{version:1,outcome:'ready',failureClass:'none',summary:'fixture deliver',conflicts:[]}};
  const stage={version:1,stage:'pre-accept-hooks',binding:{...binding,instructions:h},execution:execution('deliver','hook'),
    inputs:{candidate:w.candidate,phase:'pre-accept',receipt:first.receipt.identity},result:null};
  const pin={repository,binding,scopeBody,shapeBody,decisions:['No writes from review'],instructions:{},
    visibility:'public',ownership,workspace:w.expected,obligations:{requiredArtifacts:[{path:'ignored',purpose:'fixture output',evidenceReference:'scope'}],
      scopeEvidenceReference:'scope',hookObservation:observation},deliver,deliverCurrent:{expected:structuredClone(deliver),consumed:[]},
    hooks:{stage,stageCurrent:{expected:structuredClone(stage),consumed:[]},receipt:first.receipt,
      receiptCurrent:{identity:first.receipt.identity,consumed:[]},profile:runner.profile,message:hookInput.message.toString('base64'),executionId:'first'}};
  const state={fault:null,onPrepare:null,onStart:null,onCollect:null,onTermination:null,read:'verified',isolation:'verified',
    start:'started',termination:'terminated',pending:false,exitCode:0,result:null,child};
  let n=0;
  const evidenceCurrent=id=>({expected:structuredClone(expected.get(id)),consumed:state.fault==='replay'?[expected.get(id).execution.result]:[]});
  const capabilities={current:()=>structuredClone(pin),workspace:()=>w,evidenceCurrent,
    prepareRole:async ({role,skill,instructions,task})=>{
      const id=state.fault==='self'?'writer':`review-${++n}`;
      const e=execution(role,id), b={...binding};
      const receipt={version:1,stage:'accept',binding:b,execution:e,inputs:{candidate:w.candidate,hooks:contentIdentity(pin.hooks.stage),deliver:'writer'},
        result:{version:1,outcome:'accepted',failureClass:'none',summary:'local independent fixture',conflicts:[]}};
      expected.set(id,structuredClone(receipt));
      const backend={readiness:async()=>({login:'available',tool:'available',isolation:state.isolation,read:state.read,write:'unsupported',
        evidence:['recording-contract'],limitations:['No native isolation measurement']}),
        start:async input=>{records.push({input,task,role,skill});events.push('accept-start');state.onStart?.();return {status:state.start};},
        collect:async()=>{
          state.onCollect?.();events.push('accept-collect');
          if(state.pending) return {status:'pending',exitCode:null,evidence:null};
          let value=structuredClone(receipt);
          if(state.result) value.result=structuredClone(state.result);
          if(state.fault==='foreign')value.execution.id='foreign';
          if(state.fault==='malformed')value.result={authorized:true};
          if(state.fault==='authority')value.result.authorized=true;
          if(state.fault==='absent')value=null;
          if(state.child){
            const script=`let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);
              if(Object.keys(process.env).length)process.exit(2);
              if(!Buffer.from(v.task.workspace.diff,'base64').toString().includes('GIT binary patch'))process.exit(3);
              if(!v.task.workspace.sources.some(s=>s.path==='ignored'&&Buffer.from(s.data,'base64').toString()==='required ignored bytes'))process.exit(4);
              process.stdout.write(JSON.stringify(v.value));`;
            const r=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{},input:JSON.stringify({task,value}),encoding:'utf8'});
            if(r.status!==0) return {status:'complete',exitCode:1,evidence:null};
            value=JSON.parse(r.stdout);events.push('child-serialized');
          }
          return {status:'complete',exitCode:state.exitCode,evidence:value};},
        stop:async()=>{state.termination='terminated';state.pending=false;return {status:'requested'};},
        termination:async()=>{state.onTermination?.();return {status:state.termination};},
        cleanup:async()=>({status:'completed',residuals:[]})};
      const lifecycle=createAgentLifecycle({environment:{id:id+'-env',agent:'recording',loginSpace:`/fixture/${id}/login`,instances:[
        {id,workspace:root,registration:`/fixture/${id}/registration`,service:`/fixture/${id}/service`}]},instanceId:id,backend,
        current:()=>evidenceCurrent(id),collectFailures:true,resultContext:()=>({scopeBody:pin.scopeBody,shapeBody:pin.shapeBody})});
      lives.push(lifecycle);
      const input={execution:e,binding:b,instructions:{identity:instructions.identity,content:instructions.content},visibility:pin.visibility,ownership:pin.ownership};
      if(state.fault==='role') input.execution.role='deliver';
      if(state.fault==='instructions')input.instructions.content='foreign';
      state.onPrepare?.({input,task});return {lifecycle,input};
    }};
  const flow=createAcceptFlow(capabilities);
  return {capabilities,captureInput,flow,pin,state,records,events,expected,lives,root,git,runner,hookInput,first,evidenceCurrent,
    get workspace(){return w;},recapture(){w=captureWorkspace(captureInput);return w;},
    snapshot:()=>['.gitignore','binary','ignored',...hooks.map(h=>h.path)].map(p=>readFileSync(join(root,p)).toString('base64')),
    async second(accept){events.push('second-pass');return runner.execute({...hookInput,phase:'pre-commit',executionId:'second',
      firstExecutionId:'first',first:first.receipt,firstReceiptCurrent:pin.hooks.receiptCurrent,
      firstStage:pin.hooks.stage,firstStageCurrent:pin.hooks.stageCurrent,firstStageIdentity:contentIdentity(pin.hooks.stage),
      accept,acceptCurrent:evidenceCurrent(accept.execution.id)});},
    close:()=>rmSync(root,{recursive:true,force:true})};
}
