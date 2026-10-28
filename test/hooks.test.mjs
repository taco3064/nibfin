import {dockerObservation} from '../tooling/docker-observation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureWorkspace,bodyDigest,createHookRunner,verifyHookReceipt,hookConfigurationAreas,
  contentIdentity,createEvidence,hookProcess} from '../src/index.mjs';
const h='a'.repeat(64), image='sha256:'+h, socket='/run/user/1000/docker.sock';
const current=r=>({identity:r.identity,consumed:[]});
const verify=(r,i,c=current(r??{}))=>verifyHookReceipt(r,i,c);
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture(empty=false, firstHook={path:'pre',script:'#!/bin/sh\nexit 0\n'}) {
  const root=mkdtempSync(join(tmpdir(),'nibfin-hook-test-'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH,HOME:'/nonexistent',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['pipe','pipe','pipe']});
  git('init','--template=');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'.gitignore'),'ignored\n');writeFileSync(join(root,'tracked'),'base');
  git('add','.');git('-c','core.hooksPath=/dev/null','commit','-qm','base');
  const base=git('rev-parse','HEAD').toString().trim();
  writeFileSync(join(root,'tracked'),'candidate');writeFileSync(join(root,'ignored'),'mandatory');
  const hooks=empty?[]:[{path:firstHook.path,event:'pre-commit'},{path:'chain',event:'pre-commit'},
    {path:'prepare',event:'prepare-commit-msg'},{path:'msg',event:'commit-msg'}];
  for(const item of hooks) writeFileSync(join(root,item.path),item.path===firstHook.path?firstHook.script:'#!/bin/sh\nexit 0\n');
  const scopeBody='Scope',shapeBody=['Candidate artifacts applicability: Retained ignored artifact.',
    'Candidate hooks applicability: Explicit empty configuration when empty.','```kairo-candidate',
    JSON.stringify({artifacts:[{path:'ignored',purpose:'required'}],hooks}),'```'].join('\n');
  const workspace=captureWorkspace({root,base,scopeBody,shapeBody,
    permittedPaths:['tracked','.gitignore','ignored',...hooks.map(v=>v.path)],binding:{repository:'owner/public',
      scopeHash:bodyDigest(scopeBody),shapeHash:bodyDigest(shapeBody),cycle:'cycle',policy:h}});
  const observation={areas:hookConfigurationAreas.map(area=>({area,status:'resolved',evidenceReference:'fixture',detail:'checked'})),
    hooks:hooks.map(v=>({...v,evidenceReference:'fixture',applicability:'mandatory',prerequisites:[]}))};
  const input={profile:{id:'linux-amd64-rootless-hooks-v1',image,docker:'28.5.1'},workspace,expected:workspace.expected,phase:'pre-accept',executionId:'first',message:Buffer.from('original\r\n\n'),observation};
  const commands=[], jobs=[], executions=[];let daemonChange={},mutate=null, outcome='success', cleanup='success', hookExit=0;
  const boundary=async command=>{
    commands.push(command);
    const a=command.args;
    if(a[2]==='image')return {outcome:'success',output:JSON.stringify([{Id:image,Os:'linux',Architecture:'amd64',Config:{Env:['PATH=/usr/bin:/bin']}}])};
    if(a[2]==='inspect'){const launched=commands.find(c=>c.args[2]==='run'&&c.args.includes(a[3])),observed=dockerObservation(launched.args.slice(2),image);return {outcome:'success',output:JSON.stringify([{...observed,Name:'/'+a[3],Image:image,Config:{...observed.Config,Labels:{'nibfin.hook':a[3]}}}])};}
    if(a[2]==='container')return {outcome:'success',output:''};
    if(a[2]==='info') return {outcome:'success',output:JSON.stringify({ServerVersion:'28.5.1',OSType:'linux',Architecture:'x86_64',CgroupVersion:'2',CgroupDriver:'systemd',MemoryLimit:true,PidsLimit:true,CpuCfsPeriod:true,CpuCfsQuota:true,SecurityOptions:['name=rootless','name=seccomp,profile=builtin'],...daemonChange})};
    if(a[2]==='rm') return {outcome:cleanup};
    const mount=a[a.indexOf('--mount')+1], job=mount.slice('type=bind,src='.length).split(',dst=')[0];jobs.push(job);
    const repo=join(job,'repo');
    const path=a[a.indexOf('hook')+1];
    if(mutate) mutate({repo,job,path});
    if(outcome==='success') {
      // Execute the production shell wrapper and argv; only the container/process boundary is replaced.
      const args=a.slice(a.indexOf(image)+1).map(v=>v.replaceAll('/job/',job+'/'));
      const result=spawnSync('/bin/sh',args,{cwd:repo,input:'',timeout:1000,
        env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',NIBFIN_TEST_EXIT_CODE:String(hookExit)}});
      executions.push({path,status:result.status});
      return {outcome:result.error||result.signal?'unknown':result.status===0?'success':'nonzero'};
    }
    return outcome==='malformed'?{}:{outcome};
  };
  const runner=createHookRunner({image,socket,process:boundary});
  return {root,input,runner,commands,jobs,executions,git,setDaemon:v=>daemonChange=v,setMutation:f=>mutate=f,setOutcome:v=>outcome=v,setCleanup:v=>cleanup=v,
    setHookExit:v=>hookExit=v,close:()=>{for(const job of jobs)rmSync(job,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}};
}
function second(f,first) {
  const binding={authority:h,grant:h,policy:h,core:h,runtime:h,instructions:h,repositoryId:'42',issueId:'I_96',
    scopeHash:f.input.expected.binding.scopeHash,shapeHash:f.input.expected.binding.shapeHash};
  const execution={role:'deliver',skill:'deliver',id:'hook-execution',request:'request',result:'first-stage',source:null};
  const firstStage={version:1,stage:'pre-accept-hooks',binding,execution,
    inputs:{candidate:f.input.workspace.candidate,phase:'pre-accept',receipt:first.identity},result:null};
  const firstStageCurrent={expected:firstStage,consumed:[]};createEvidence(firstStageCurrent);
  const accept={version:1,stage:'accept',binding:{...binding,instructions:'b'.repeat(64)},execution:{...execution,role:'accept',skill:'accept',id:'independent',result:'accepted'},
    inputs:{candidate:f.input.workspace.candidate,hooks:contentIdentity(firstStage),deliver:'author'},
    result:{version:1,outcome:'accepted',failureClass:'none',summary:'Independent fixture acceptance',conflicts:[]}};
  const acceptCurrent={expected:accept,consumed:[]};createEvidence(acceptCurrent);
  return {...f.input,phase:'pre-commit',executionId:'second',firstExecutionId:'first',first,firstReceiptCurrent:current(first),firstStage,firstStageCurrent,
    firstStageIdentity:contentIdentity(firstStage),accept,acceptCurrent};
}
test('both exported gates, ordered sources, Git message arguments and credential-free invocation',async()=>{
  const f=fixture();try {
    process.env.GH_TOKEN='credential-sentinel';
    const first=await f.runner.execute(f.input);assert.equal(first.ok,true);
    const input=second(f,first.receipt), result=await f.runner.execute(input);assert.equal(result.ok,true);
    verify(result.receipt,input);
    assert.throws(()=>verify(result.receipt,input,{identity:h,consumed:[]}));
    assert.throws(()=>verifyHookReceipt(result.receipt,input));
    assert.throws(()=>verify(result.receipt,input,{identity:result.receipt.identity,consumed:[result.receipt.identity]}));
    assert.throws(()=>verify(result.receipt,{...input,profile:{...input.profile,image:'sha256:'+'b'.repeat(64)}}));
    assert.throws(()=>verify(result.receipt,{...input,acceptCurrent:{...input.acceptCurrent,consumed:['accepted']}}));
    assert.throws(()=>verify(result.receipt,{...input,firstStageCurrent:{...input.firstStageCurrent,consumed:['first-stage']}}));
    const runs=f.commands.filter(c=>c.args[2]==='run');assert.equal(runs.length,8);
    assert.deepEqual(runs.slice(0,4).map(c=>c.args.slice(c.args.indexOf('hook')+1)),[
      ['./pre'],['./chain'],['./prepare','/job/message','message'],['./msg','/job/message']]);
    for(const c of runs) {
      assert(c.args.includes('--network=none'));assert(c.args.includes('--pull=never'));
      assert(c.args.includes('--read-only'));assert(c.args.includes('--cap-drop=ALL'));
      assert.equal(c.args.filter(v=>v==='--mount').length,1);
      assert(!JSON.stringify(c).includes('credential-sentinel'));assert(!JSON.stringify(c).includes(f.root));
      assert.deepEqual(c.env,{PATH:'/usr/bin:/bin',LANG:'C'});
    }
    assert(f.jobs.every(p=>!existsSync(p)));assert.equal(readFileSync(join(f.root,'tracked'),'utf8'),'candidate');
    assert.throws(()=>verify(result.receipt,{...input,executionId:'replayed'}));
    assert.throws(()=>verify(first.receipt,{...f.input,message:Buffer.from('original\n\n')}));
    assert.throws(()=>verify(first.receipt,{...f.input,expected:{...f.input.expected,identity:h}}));
    for(const alter of [r=>r.hooks.reverse(),r=>r.hooks[0].digest=h,r=>r.binding.phase='pre-commit',r=>r.comparisons.index=false]) {
      const r=clone(first.receipt);alter(r);const {identity,...payload}=r;r.identity=contentIdentity(payload);
      assert.throws(()=>verify(r,f.input));
    }
    assert.throws(()=>verify(null,f.input));
    assert.throws(()=>verify(result.receipt,{...input,accept:{...input.accept,inputs:{...input.accept.inputs,hooks:h}}}));
    assert.throws(()=>verify(first.receipt,{...f.input,observation:{...f.input.observation,hooks:[...f.input.observation.hooks].reverse()}}));
    await assert.rejects(()=>f.runner.execute({...f.input,phase:'pre-commit'}));
  } finally {delete process.env.GH_TOKEN;f.close();}
});
test('empty verified inventory launches no process; missing prerequisites and unknown events reject',async()=>{
  const f=fixture(true);try {
    const r=await f.runner.execute(f.input);assert(r.ok);assert.equal(r.receipt.status,'not-applicable');
    assert((await f.runner.execute(second(f,r.receipt))).ok);assert.equal(f.commands.length,0);
    f.input.observation.areas.pop();await assert.rejects(()=>f.runner.execute(f.input));
  } finally {f.close();}
  const g=fixture();try {
    g.input.observation.hooks[0].prerequisites=[{name:'network install',status:'unsupported',evidenceReference:'fixture'}];
    await assert.rejects(()=>g.runner.execute(g.input));
    g.input.observation.hooks[0].prerequisites=[];g.input.observation.hooks[0].event='post-commit';
    await assert.rejects(()=>g.runner.execute(g.input));
  } finally {g.close();}
});
const mutations={
  source:({repo})=>writeFileSync(join(repo,'pre'),'exit 0\n'),
  artifact:({repo})=>writeFileSync(join(repo,'ignored'),'altered'),
  worktree:({repo})=>writeFileSync(join(repo,'tracked'),'altered'),
  paths:({repo})=>writeFileSync(join(repo,'new-path'),'extra'),
  index:({repo})=>execFileSync('git',['read-tree','HEAD'],{cwd:repo}),
  message:({job})=>writeFileSync(join(job,'message'),'original\n\n'),
  fifo:({job})=>{rmSync(join(job,'message'));execFileSync('mkfifo',[join(job,'message')]);},
  missing:({job})=>rmSync(join(job,'message')),
  object:({repo})=>{
    const oid=execFileSync('git',['rev-parse','HEAD:tracked'],{cwd:repo}).toString().trim();
    writeFileSync(join(repo,'.git/objects',oid.slice(0,2),oid.slice(2)),'corrupt');
  },
  configuration:({repo})=>writeFileSync(join(repo,'.git/config'),'[core]\nworktree = /work\n'),
  symlink:({repo})=>{rmSync(join(repo,'tracked'));symlinkSync('/etc/passwd',join(repo,'tracked'));}
};
for(const phase of ['pre-accept','pre-commit']) {
  for(const [kind,mutation] of Object.entries(mutations)) test(`${phase} zero-exit ${kind} mutation rejects`,async()=>{
    const f=fixture();try {
      let input=f.input;if(phase==='pre-commit') input=second(f,(await f.runner.execute(input)).receipt);
      const bytes=f.input.workspace.sources.map(v=>v.bytes.toString('base64'));
      f.commands.length=0;f.setMutation(mutation);
      const r=await f.runner.execute(input);assert.equal(r.ok,false);assert.equal(r.cleanup,true);
      assert.equal(f.commands.filter(c=>c.args[2]==='run').length,1);
      assert(f.jobs.every(p=>!existsSync(p)));assert.equal(readFileSync(join(f.root,'tracked'),'utf8'),'candidate');
      assert.deepEqual(f.input.workspace.sources.map(v=>v.bytes.toString('base64')),bytes);
    } finally {f.close();}
  });
  for(const outcome of ['nonzero','timeout','unknown','malformed','missing-tool','cleanup']) test(`${phase} ${outcome} blocks and stops`,async()=>{
    const f=fixture();try {
      let input=f.input;if(phase==='pre-commit') input=second(f,(await f.runner.execute(input)).receipt);
      f.commands.length=0;
      if(outcome==='cleanup') f.setCleanup('unknown');else f.setOutcome(outcome);
      const r=await f.runner.execute(input);assert.equal(r.ok,false);assert.equal(r.receipt,undefined);
      assert.equal(f.commands.filter(c=>c.args[2]==='run').length,1);
      assert.equal(r.cleanup,outcome!=='cleanup');
      if(outcome==='cleanup')assert(existsSync(f.jobs.at(-1)),'unresolved container retains scratch');
      else assert(f.jobs.every(p=>!existsSync(p)));
    } finally {f.close();}
  });
}

test('external process outcomes and bounded diagnostics are real, with no hook output forwarded',async()=>{
  const command={file:'/bin/sh',args:['-c','exit 0'],env:{PATH:'/usr/bin:/bin'},timeout:1000};
  assert.equal((await hookProcess(command)).outcome,'success');
  assert.equal((await hookProcess({...command,args:['-c','exit 2']})).outcome,'nonzero');
  assert.equal((await hookProcess({...command,args:['-c','exit 127']})).outcome,'missing-tool');
  assert.equal((await hookProcess({...command,args:['-c','exec sleep 10'],timeout:50})).outcome,'timeout');
  assert.equal((await hookProcess({...command,file:'/nonexistent-hook-tool'})).outcome,'unknown');
});
test('invalid message, unsupported backend and unresolved cleanup cannot yield proof or blind retry',async()=>{
  const f=fixture();try {
    await assert.rejects(()=>f.runner.execute({...f.input,message:'normalize me'}));
    await assert.rejects(()=>f.runner.execute({...f.input,message:undefined}));
    const backend=createHookRunner({image,socket,process:async()=>({outcome:'success',output:'{}'})});
    assert.equal((await backend.execute(f.input)).diagnostic,'hooks:unsupported-backend');
    const malformed=createHookRunner({image,socket,process:async()=>({outcome:'success',
      output:JSON.stringify({ServerVersion:'28.5.1',OSType:'linux',Architecture:'x86_64',SecurityOptions:'name=rootless'})})});
    assert.equal((await malformed.execute(f.input)).diagnostic,'hooks:unsupported-backend');
    const unrelated=join(f.root,'unrelated');writeFileSync(unrelated,'preserve');
    f.setCleanup('unknown');const r=await f.runner.execute(f.input);
    assert.equal(r.ok,false);assert.match(r.residual,/nibfin-hook-/);
    await assert.rejects(()=>f.runner.execute(f.input),/reconciliation-required/);
    assert.equal(readFileSync(unrelated,'utf8'),'preserve');
  } finally {f.close();}
});

for(const name of ['-s','-c','--']) for(const phase of ['pre-accept','pre-commit']) {
  test(`${phase} executes leading-dash hook ${name} and rejects its nonzero exit`,async()=>{
    // The external process environment supplies changing execution outcomes;
    // source bytes, Candidate and all production comparisons stay unchanged.
    const script=phase==='pre-accept'?'#!/bin/sh\nexit 23\n':'#!/bin/sh\nexit "$NIBFIN_TEST_EXIT_CODE"\n';
    const f=fixture(false,{path:name,script});try {
      let input=f.input;
      if(phase==='pre-commit') {
        const first=await f.runner.execute(input);assert.equal(first.ok,true);
        input=second(f,first.receipt);f.setHookExit(23);
      }
      f.commands.length=0;f.executions.length=0;
      const result=await f.runner.execute(input);
      assert.equal(result.ok,false);assert.equal(result.diagnostic,'hooks:execution-nonzero');
      assert.equal(result.receipt,undefined);assert.equal(result.cleanup,true);
      assert.deepEqual(f.executions,[{path:`./${name}`,status:23}]);
      assert.equal(f.commands.filter(c=>c.args[2]==='run').length,1);
      assert(f.jobs.every(p=>!existsSync(p)));
      assert.equal(readFileSync(join(f.root,name),'utf8'),script);
      assert.deepEqual(f.input.workspace.expected,f.input.expected);
    } finally {f.close();}
  });
}

test('actual Hook preflight rejects missing seccomp/cgroup resource enforcement before launching any hook',async()=>{
 for(const change of [{CgroupDriver:'none'},{CgroupVersion:'1'},{MemoryLimit:false},{PidsLimit:false},{CpuCfsQuota:false},{CpuCfsPeriod:false},{SecurityOptions:['name=rootless']}]) {
  const f=fixture();try{f.setDaemon(change);const result=await f.runner.execute(f.input);assert.equal(result.ok,false);assert.equal(f.commands.some(c=>c.args[2]==='run'),false);}finally{f.close();}
 }
});
