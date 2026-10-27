import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRoleBudget,createVerificationLane,verificationProcess,redactRuntimeText,
  prepareNodeVerification,nodeSourceIdentity} from '@nibfin/core';
const hash='a'.repeat(64);
function laneFixture({now=Date.now,process:run,deadlineAt=now()+120000}={}) {
  const retained=[];
  const budget=createRoleBudget({deadlineAt,reserveMs:1000,now});
  const lane=createVerificationLane({execution:'independent-role',budget,now,...(run?{process:run}:{}),
    retain:async value=>{retained.push(value);return 'custody:'+retained.length;}});
  return {lane,budget,retained};
}
const input=(cwd,args=['-e','process.stdout.write("ok")'])=>({file:process.execPath,args,cwd,env:{PATH:'/usr/bin:/bin'},inputs:{source:hash},timeoutMs:10000});

test('one verification lane rejects overlap, reuses only exact passed same-role inputs and retains real outcomes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nibfin-lane-'));
  try {
    const f=laneFixture();
    const pending=f.lane.command(input(root,['-e','setTimeout(()=>process.stdout.write("done"),100)']));
    assert.deepEqual(await f.lane.command(input(root)),{status:'busy'});
    assert.equal((await pending).status,'passed');
    const passed=await f.lane.command(input(root));assert.equal(passed.status,'passed');
    assert.equal((await f.lane.command(input(root),{reuse:true})).id,passed.id);
    const changed=await f.lane.command({...input(root),inputs:{source:'b'.repeat(64)}},{reuse:true});
    assert.notEqual(changed.id,passed.id);
    const failed=await f.lane.command(input(root,['-e','process.exit(9)']));
    assert.equal(failed.status,'failed');assert.equal(failed.exitCode,9);
    assert.notEqual((await f.lane.command(input(root,['-e','process.exit(9)']),{reuse:true})).id,failed.id);
    const other=laneFixture();assert.notEqual((await other.lane.command(input(root),{reuse:true})).id,passed.id);
    assert(f.retained.every(r=>r.record.execution==='independent-role'&&r.record.finishedAt>=r.record.startedAt));
    assert.equal(f.retained[1].log,'ok');assert.match(passed.logReference,/^custody:/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('absolute budget includes waits/preparation, cannot reset or start after cutoff; failed retention is not a pass',async()=>{
  let time=1000,calls=0;
  const f=laneFixture({now:()=>time,deadlineAt:10000,process:async command=>{
    calls++;assert.equal(command.timeoutMs,8000);time=9000;return {status:'passed',exitCode:0,signal:null,log:''};}});
  assert.equal((await f.lane.command(input('/tmp'))).status,'passed');
  assert.equal((await f.lane.command(input('/tmp'))).status,'budget_exhausted');assert.equal(calls,1);
  time=8000;assert.throws(()=>f.budget.remaining(),/clock/);
  const lane=createVerificationLane({execution:'role',budget:laneFixture().budget,retain:async()=>{throw Error('private');},
    process:async()=>({status:'passed',exitCode:0,signal:null,log:''})});
  await assert.rejects(lane.command(input('/tmp')));
});

test('real child cancellation/timeout reap a process group and do not leave verification descendants alive',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nibfin-tree-'));
  try {
    for(const mode of ['cancel','timeout']) {
      const marker=join(root,mode),ready=join(root,mode+'-ready');
      const script=join(root,mode+'.mjs');
      writeFileSync(script,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
        spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),500);`)}],{stdio:'ignore'});
        writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
      const controller=new AbortController();
      const running=verificationProcess({file:process.execPath,args:[script],cwd:root,env:{},timeoutMs:mode==='timeout'?150:5000,signal:controller.signal});
      if(mode==='cancel'){
        for(let n=0;n<600&&!existsSync(ready);n++)await new Promise(r=>setTimeout(r,10));
        assert(existsSync(ready));controller.abort();
      }
      assert.equal((await running).status,mode==='cancel'?'cancelled':'timeout');
      await new Promise(r=>setTimeout(r,550));assert.equal(existsSync(marker),false);
    }
    assert.equal((await verificationProcess({file:'/missing',args:[],cwd:root,env:{},timeoutMs:100})).status,'failed');
  }finally{rmSync(root,{recursive:true,force:true});}
});

function nodeFixture() {
  const root=mkdtempSync(join(tmpdir(),'nibfin-cold-')),source=join(root,'candidate'),scratch=join(root,'scratch');
  mkdirSync(source);mkdirSync(scratch);mkdirSync(join(source,'vendor'));mkdirSync(join(source,'vendor','fixture'));
  writeFileSync(join(source,'vendor','fixture','package.json'),JSON.stringify({name:'fixture',version:'1.0.0',main:'index.cjs'}));
  writeFileSync(join(source,'vendor','fixture','index.cjs'),'module.exports=42;');
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'verification-fixture',version:'1.0.0',private:true,
    dependencies:{fixture:'file:vendor/fixture'},scripts:{postinstall:'touch UNSAFE_SCRIPT'}}));
  writeFileSync(join(source,'package-lock.json'),JSON.stringify({name:'verification-fixture',version:'1.0.0',lockfileVersion:3,
    packages:{'':{name:'verification-fixture',version:'1.0.0',dependencies:{fixture:'file:vendor/fixture'}},
      'node_modules/fixture':{resolved:'vendor/fixture',link:true},'vendor/fixture':{version:'1.0.0'}}}));
  mkdirSync(join(source,'.git'));writeFileSync(join(source,'.git','private'),'not copied');
  mkdirSync(join(source,'node_modules'));writeFileSync(join(source,'node_modules','old'),'stale cache');
  return {root,source,scratch,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('two independent cold Node preparations use locked local dependencies offline, writable fixture copies, disabled scripts and unchanged original',async()=>{
  const f=nodeFixture();
  try {
    const original=nodeSourceIdentity(f.source).identity,caches=[];
    for(let n=0;n<2;n++) {
      const lane=laneFixture(),p=await prepareNodeVerification({...f,lane:lane.lane,npm:'/usr/local/bin/npm'});
      assert.equal(p.status,'prepared',JSON.stringify(lane.retained));caches.push(p.cache);
      assert.equal(existsSync(join(p.directory,'.git')),false);assert.equal(existsSync(join(p.directory,'node_modules','old')),false);
      assert.equal(existsSync(join(p.directory,'UNSAFE_SCRIPT')),false);
      const command=await p.command({file:process.execPath,args:['-e',
        'if(require("fixture")!==42)process.exit(1);require("node:fs").writeFileSync("fixture-output","written");'],timeoutMs:5000});
      assert.equal(command.status,'passed');assert.equal(readFileSync(join(p.directory,'fixture-output'),'utf8'),'written');
      const offline=await p.command({file:'/usr/local/bin/npm',args:['ls','--offline','--ignore-scripts'],timeoutMs:5000});
      assert.equal(offline.status,'passed');assert.equal(p.assertCurrent(),original);
      assert.equal(existsSync(join(f.source,'fixture-output')),false);assert.equal(nodeSourceIdentity(f.source).identity,original);
    }
    assert.notEqual(caches[0],caches[1]);
  }finally{f.close();}
});

test('stale source, unsafe paths/links/configuration, missing nested locks and dependency failure block preparation or reuse',async()=>{
  for(const mode of ['symlink','hardlink','npmrc','missing-lock','failure','stale','modified-copy']) {
    const f=nodeFixture();try {
      const lane=laneFixture({...(mode==='failure'?{process:async()=>({status:'failed',exitCode:23,signal:null,log:'dependency denied'})}:{})});
      if(mode==='symlink')symlinkSync('/etc/passwd',join(f.source,'escape'));
      if(mode==='hardlink')linkSync(join(f.source,'package.json'),join(f.source,'alias'));
      if(mode==='npmrc')writeFileSync(join(f.source,'.npmrc'),'registry=https://unapproved.invalid');
      if(mode==='missing-lock')await assert.rejects(prepareNodeVerification({...f,lane:lane.lane,project:'vendor/fixture'}),/locked-project/);
      else if(['symlink','hardlink','npmrc'].includes(mode))await assert.rejects(prepareNodeVerification({...f,lane:lane.lane}));
      else {
        const p=await prepareNodeVerification({...f,lane:lane.lane,npm:'/usr/local/bin/npm'});
        if(mode==='failure'){assert.equal(p.status,'failed');assert.equal(p.receipt.exitCode,23);assert.equal(p.command,undefined);}
        if(mode==='modified-copy'){
          writeFileSync(join(p.directory,'package.json'),'{}');
          await assert.rejects(p.command({file:process.execPath,args:['-v'],timeoutMs:1000}),/modified-copy/);
        }
        if(mode==='stale'){
          writeFileSync(join(f.source,'changed'),'new bytes');assert.throws(()=>p.assertCurrent(),/stale-copy/);
          await assert.rejects(p.command({file:process.execPath,args:['-v'],timeoutMs:1000}),/stale-copy/);
        }
      }
      await assert.rejects(prepareNodeVerification({...f,lane:lane.lane,project:'../escape'}));
    }finally{f.close();}
  }
});

test('credential redaction covers nested escaped output and input credentials never execute',async()=>{
  const secret='sentinel-token',outputs=[secret,JSON.stringify(secret),encodeURIComponent(secret),Buffer.from(secret).toString('base64')];
  for(const output of outputs)assert.equal(redactRuntimeText(output,[secret]).includes(secret),false);
  let calls=0;
  const lane=createVerificationLane({execution:'role',budget:laneFixture().budget,secrets:[secret],retain:async()=> 'custody',
    process:async()=>{calls++;return {status:'passed',exitCode:0,signal:null,log:secret};}});
  await assert.rejects(lane.command(input('/tmp',['-e',secret])),/credential-input/);assert.equal(calls,0);
});

test('a late successful subprocess reply cannot turn an aborted command into a pass',async()=>{
  const controller=new AbortController();
  const f=laneFixture({process:async()=>{controller.abort();return {status:'passed',exitCode:0,signal:null,log:'finished after cancellation'};}});
  const value=await f.lane.command(input('/tmp'),{signal:controller.signal});assert.equal(value.status,'cancelled');
  assert.equal(f.retained[0].record.status,'cancelled');
});

test('both production owners reap detached double-fork descendants before completion, timeout or cancellation and lane reuse',async()=>{
  const {runVerificationChild,probeVerificationSupervisor}=await import(new URL('verification-child.mjs',import.meta.resolve('@nibfin/core')));
  assert.equal(probeVerificationSupervisor(),true);
  const root=mkdtempSync(join(tmpdir(),'nibfin-detached-'));
  try {
    for(const owner of [verificationProcess,(c)=>runVerificationChild(c,{signal:c.signal})]) {
      for(const mode of ['complete','timeout','cancel']) {
        const key=Math.random().toString(16).slice(2),marker=join(root,key),ready=marker+'-ready';
        const leaf=`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),2500);`;
        const middle=`const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'}).unref();`;
        const script=`const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'ignore'}).unref();${mode==='complete'?`const t=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(ready)})){clearInterval(t);}},2);`:'setInterval(()=>{},1000);'}`;
        const controller=new AbortController();
        const f=laneFixture({process:owner});
        const running=f.lane.command({...input(root,['-e',script]),timeoutMs:mode==='timeout'?1500:4000},{signal:controller.signal});
        if(mode==='cancel') {
          for(let n=0;n<600&&!existsSync(ready);n++)await new Promise(r=>setTimeout(r,5));
          assert(existsSync(ready));controller.abort();
        }
        const receipt=await running;assert(existsSync(ready),'detached grandchild must actually start: '+mode);assert.equal(receipt.status,mode==='complete'?'passed':mode==='timeout'?'timeout':'cancelled');
        // A second real command occupies the lane while the old child would write.
        assert.equal((await f.lane.command(input(root,['-e','setTimeout(()=>{},2700)']))).status,'passed');
        assert.equal(existsSync(marker),false,'detached descendant survived '+mode);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('unreconciled subprocess permanently blocks further lane admission and passed-result reuse',async()=>{
  let calls=0;const f=laneFixture({process:async()=>{calls++;return calls===1?{status:'passed',exitCode:0,signal:null,log:''}:{status:'unresolved',exitCode:null,signal:null,log:''};}});
  assert.equal((await f.lane.command(input('/tmp'))).status,'passed');
  assert.equal((await f.lane.command(input('/tmp',['-e','process.exit(1)']))).status,'unresolved');
  assert.equal((await f.lane.command(input('/tmp'),{reuse:true})).status,'unresolved');assert.equal(calls,2);
});
