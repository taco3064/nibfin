import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,rmSync,symlinkSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {createWindowsWslBackend,windowsLocalPath,windowsToWslPath,wslToWindowsPath,wslSession,wslLaunchEnvironment} from '@nibfin/core';
import {wslFixture} from '../tooling/wsl-fixture.mjs';
const {serveWslGuest,observeWslGuest}=await import(new URL('./wsl-guest.mjs',import.meta.resolve('@nibfin/core')));
const roles=['shape','shape-validator','shape-diagnosis','shaper-review','deliver','accept'];
async function fixture(fn,role) {const f=wslFixture(role);try {await fn(f);}finally {await f.dispose();}}
const id=f=>f.input.execution.id;
async function finish(f,valid=true) {
  assert.equal((await f.collect()).result.status,valid?'valid':'invalid');
  assert.equal((await f.life.termination(id(f))).termination.status,'terminated');
  assert.equal((await f.life.cleanup()).status,'completed');
}

test('AC1/4: inert public adapter, fixed guest bridge, all protected roles and instructions, owned cleanup',async()=>{
  process.env.WSLENV='GH_TOKEN/u';process.env.GH_TOKEN='HOST-CREDENTIAL';process.env.NIBFIN_SENTINEL_CREDENTIAL='ENV-SENTINEL';
  try {for(const role of roles)await fixture(async f=>{
    assert.deepEqual(f.commands,[]);assert.deepEqual(f.calls,[]);
    f.input.ownership=role==='accept'?'organization':'personal';
    assert.equal((await f.life.start(f.input)).start.status,'started');
    assert.equal(f.commands.length,1);
    assert.deepEqual(f.commands[0],{file:f.profile.wsl,cwd:f.profile.cwd,env:wslLaunchEnvironment,
      args:['--distribution','Debian-Nibfin','--user','member','--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C',f.profile.node,f.profile.bridge]});
    const start=f.requests.find(r=>r.op==='start');
    assert.deepEqual(start.value.input.executionIdentity,f.input.execution);
    assert.deepEqual(start.value.input.binding,f.input.binding);
    assert.deepEqual(start.value.input.instructions,f.input.instructions);
    assert.deepEqual(start.value.task.inputs,f.expected.inputs);
    const c=f.calls.find(c=>c.args[2]==='create' && c.args.at(-1)==='execute');
    const mounts=c.args.flatMap((v,n)=>v==='--mount'?[c.args[n+1]]:[]);
    assert.equal(mounts.find(m=>m.includes('dst=/work,')).endsWith(',readonly'),role!=='deliver');
    const input=mounts.find(m=>m.includes('dst=/input,')).match(/src=([^,]+)/)[1];
    assert.equal(readFileSync(join(input,'instructions.md'),'utf8'),f.input.instructions.content);
    assert.deepEqual(c.env,{PATH:'/usr/bin:/bin',LANG:'C'});
    for(const secret of ['HOST-CREDENTIAL','WSLENV','ENV-SENTINEL','LOGIN-SENTINEL','registration1','service1','work1','signing-key'])
      assert.equal(JSON.stringify([f.commands,c]).includes(secret),false);
    assert.ok(mounts.find(m=>m.includes('dst=/tmp/home/.codex/auth.json,')).endsWith(',readonly'));
    await finish(f);assert.equal(f.wslFlags.closed,true);
    assert.ok(existsSync(f.environment.loginSpace));assert.ok(existsSync(f.environment.instances[1].workspace));
    assert.equal(existsSync(f.environment.instances[0].workspace),false);
    assert.equal(f.commands.length,1);assert.doesNotMatch(JSON.stringify(f.commands),/--shutdown|--unregister|--terminate/);
  },role);}finally {delete process.env.WSLENV;delete process.env.GH_TOKEN;delete process.env.NIBFIN_SENTINEL_CREDENTIAL;}
});

test('AC2: narrow drive mappings preserve Unicode, spaces and component case; ambiguous paths reject',()=>{
  for(const p of ['C:\\Nibfin Host\\資料','c:\\Case\\File']) {
    const canonical=windowsLocalPath(p);assert.equal(wslToWindowsPath(windowsToWslPath(p)),canonical);
  }
  assert.notEqual(windowsToWslPath('C:\\Case'),windowsToWslPath('C:\\case'));
  for(const p of ['C:work','work','\\work','C:\\a\\..\\b','C:\\a\\.\\b','D:\\work','\\\\server\\share',
    '\\\\wsl$\\Debian\\home','\\\\wsl.localhost\\Debian\\home','\\\\?\\C:\\x','\\\\.\\C:\\x','C:\\a:stream',
    'C:\\a\0b','C:\\a\nb','--user','C:\\a;whoami','C:\\$(whoami)','C:\\a|b','C:\\a\\','C:\\a.','C:\\NUL','C:\\a\\\\b'])
    assert.throws(()=>windowsToWslPath(p),p);
  for(const p of ['/mnt/C/a','/mnt/c/a/../b','/mnt/d/a','/mnt/c/a\\b','relative','/mnt/c/'])assert.throws(()=>wslToWindowsPath(p));
});

test('AC2/3: independent host observations fail closed before launching guest',async()=>{
  const changes=[o=>o.platform='linux',o=>o.arch='arm64',o=>o.sid='S-1-5-21-2000',o=>o.context='interactive',
    o=>o.available=false,o=>o.distribution='other',o=>o.wslVersion=1,o=>delete o.sid,o=>o.files=[],
    o=>o.files[0].canonical='C:\\alias',o=>o.files[0].reparse=true,o=>o.files[1].identity='replacement',
    o=>o.files[1].hash='b'.repeat(64),o=>o.files[0].storage='network',o=>o.files[0].kind='file'];
  for(const change of changes)await fixture(async f=>{
    change(f.host);assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');
    assert.deepEqual(f.commands,[]);assert.deepEqual(f.calls,[]);
  });
  await fixture(async f=>{
    assert.equal((await f.backend.readiness()).login,'available');f.host.files[1].identity='changed';
    assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');
    assert.equal(f.calls.some(c=>c.args.at(-1)==='execute'),false);
  });
});

test('AC3: guest identity, filesystem, executable and Linux capabilities are independently checked',async()=>{
  for(const [key,value] of [['platform','win32'],['arch','arm64'],['uid',0],['user','root'],['kernel','WSL1'],['node','v20.0.0'],
    ['nodeHash','b'.repeat(64)],['bridgeHash','b'.repeat(64)],['nodePath','/other'],['bridgePath','/other'],['filesystem',0x9fa0]])
    await fixture(async f=>{
      f.guest[key]=value;assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');assert.deepEqual(f.calls,[]);
    });
  for(const [key,value] of [['security',[]],['memory',false],['docker','wrong'],['login',false],['tool','wrong'],['throw','info']])
    await fixture(async f=>{
      f.flags[key]=value;assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');
      assert.equal(f.calls.some(c=>c.args.at(-1)==='execute'),false);
    });
  await fixture(async f=>{
    await f.backend.readiness();f.guest.uid=2000;
    assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');
  });
  assert.throws(()=>observeWslGuest({linux:{root:'/nonexistent'},profile:{node:'/missing'}}));
});

test('AC2/3: rejected configuration, aliases, replaced resources and missing guest login',async()=>{
  await fixture(async f=>{
    for(const patch of [{user:'--root'},{distribution:'Debian;root'},{node:'/mnt/c/node'},{bridge:'/a/../b'},
      {cwd:'D:\\work'},{wsl:'C:\\evil.exe'},{context:'other'},{uid:0},{nodeHash:'bad'}])
      assert.throws(()=>createWindowsWslBackend({...f.config,profile:{...f.profile,...patch}}));
    for(const patch of [{socket:'/run/user/2000/docker.sock'},{root:'/opt/nibfin'}, {root:'/mnt/c/root'},{environment:{...f.environment,loginSpace:'/mnt/c/login'}},
      {environment:{...f.environment,instances:[{...f.environment.instances[0],service:f.environment.instances[0].workspace}]}}])
      assert.throws(()=>createWindowsWslBackend({...f.config,linux:{...f.config.linux,...patch}}));
  });
  for(const mode of ['alias','replacement','login'])await fixture(async f=>{
    const work=f.environment.instances[0].workspace;
    if(mode==='alias')symlinkSync(f.environment.loginSpace,join(work,'alias'));
    if(mode==='replacement') {await f.backend.readiness();renameSync(work,work+'-old');mkdirSync(work);}
    if(mode==='login')rmSync(join(f.environment.loginSpace,'auth.json'));
    assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');
    assert.equal(f.calls.some(c=>c.args.at(-1)==='execute'),false);
  });
});

test('AC4/6: actual adapter rejects foreign/stale/duplicate, malformed, secret and unsuccessful results',async()=>{
  for(const mode of ['foreign','binding','instructions','stale','duplicate','malformed','truncated','oversized','nonzero','secret'])await fixture(async f=>{
    if(mode==='foreign')f.flags.mutate=v=>v.execution.id='other';
    if(mode==='binding')f.flags.mutate=v=>v.binding.scopeHash='b'.repeat(64);
    if(mode==='instructions')f.flags.mutate=v=>v.binding.instructions='b'.repeat(64);
    if(mode==='malformed')f.flags.output='PROVIDER-SECRET';
    if(mode==='truncated')f.flags.output='{"a":';
    if(mode==='oversized')f.flags.output='x'.repeat(1048577);
    if(mode==='nonzero')f.flags.exit=2;
    if(mode==='secret')f.flags.mutate=v=>v.result.summary='LOGIN-SENTINEL';
    await f.life.start(f.input);
    if(mode==='stale')f.current.expected.binding.shapeHash='b'.repeat(64);
    if(mode==='duplicate')f.current.consumed.push('result');
    const result=await f.collect();assert.equal(result.result.status,'invalid');
    assert.doesNotMatch(JSON.stringify([result,f.backend.diagnostic()]),/PROVIDER-SECRET|LOGIN-SENTINEL/);
    await f.life.termination(id(f));assert.equal((await f.life.cleanup()).status,'completed');
  });
});

test('AC5: cancellation, timeout, lost Docker replies and reconciliation retain owned guest work',async()=>{
  for(const mode of ['cancel','timeout','lostCreate','lostStart','remove','inspect'])await fixture(async f=>{
    if(mode==='cancel') {f.flags.delay=100;f.flags.ackOnly=true;}
    if(mode==='timeout') {f.flags.delay=100;f.flags.attachTimeout=true;}
    if(mode==='lostCreate')f.flags.lostCreate=true;
    if(mode==='lostStart') {f.flags.lostStart=true;f.flags.delay=100;}
    await f.life.start(f.input);
    if(mode==='cancel') {
      assert.equal((await f.life.stop(id(f))).stop.status,'requested');
      assert.notEqual((await f.life.termination(id(f))).termination.status,'terminated');
      assert.equal((await f.life.cleanup()).status,'unresolved');
    }
    if(['timeout','lostStart'].includes(mode)) {
      await f.wait();await f.wait();
      assert.notEqual((await f.life.termination(id(f))).termination.status,'terminated');
      assert.equal((await f.life.cleanup()).status,'unresolved');
    }
    if(mode==='inspect') {
      f.flags.throw='inspect';assert.equal((await f.life.termination(id(f))).termination.status,'unknown');delete f.flags.throw;
    }
    await f.collect();await f.life.termination(id(f));
    if(mode==='remove') {
      f.flags.removeFail=true;assert.equal((await f.life.cleanup()).status,'unresolved');delete f.flags.removeFail;
    }
    assert.equal((await f.life.cleanup()).status,'completed',mode);assert.equal(f.commands.length,1);
    assert.equal(f.calls.filter(c=>c.args[2]==='create' && c.args.at(-1)==='execute').length,1);
  });
});

test('AC5/6: bridge loss never proves guest termination, relaunches, or reports cleaned resources',async()=>{
  for(const mode of ['before','after'])await fixture(async f=>{
    f.wslFlags[mode]='start';
    const started=await f.life.start(f.input);assert.equal(started.start.status,'unknown');
    assert.equal((await f.life.termination(id(f))).termination.status,'unknown');
    assert.equal((await f.life.cleanup()).status,'unresolved');
    assert.equal((await f.backend.readiness()).login,'unavailable');
    assert.equal(f.commands.length,1);assert.ok(existsSync(f.environment.instances[0].workspace));
    assert.doesNotMatch(JSON.stringify([started,f.backend.diagnostic()]),/TRANSPORT-SECRET/);
  });
  await fixture(async f=>{
    await f.backend.readiness();f.wslFlags.hostThrow=true;
    await assert.rejects(f.backend.start({execution:'new'}),/^TypeError: wsl:host-context$/);
  });
  for(const mode of ['spawnFail','hostThrow'])await fixture(async f=>{
    f.wslFlags[mode]=true;assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');assert.deepEqual(f.calls,[]);
  });
});

test('AC6: real bounded process transport rejects nonzero/spawn/timeout/malformed/truncated/oversized responses',async()=>{
  for(const mode of ['valid','nonzero','spawn','timeout','malformed','truncated','oversized','foreign']) {
    const scripts={valid:"process.stdout.write(JSON.stringify({id:1,ok:true,value:{status:'fixture'}})+'\\n')",nonzero:'process.exit(2)',
      timeout:'setTimeout(()=>{},1000)',malformed:"console.log('SECRET')",truncated:"process.stdout.write('{')",
      oversized:"console.log('x'.repeat(2097153))",foreign:"console.log(JSON.stringify({id:2,ok:true,value:{}}))"};
    const s=wslSession({file:mode==='spawn'?'/nonexistent':process.execPath,args:['-e',scripts[mode]??''],cwd:'/',env:{}});
    try {
      if(mode==='valid')assert.deepEqual(await s.request('readiness',{},2000),{status:'fixture'});
      else await assert.rejects(s.request('readiness',{},mode==='timeout'?50:2000),/wsl:/);
    }finally{s.close();}
  }
});

test('AC1/6: fixed guest stdio framing, correlated sanitized errors and bounded requests',async()=>{
  const input=new PassThrough(),output=new PassThrough();let result='',calls=[];
  output.on('data',b=>result+=b);
  serveWslGuest(input,output,async(op,v)=>{calls.push({op,v});if(op==='failure')throw Error('SECRET');return v;});
  input.write(JSON.stringify({id:1,op:'probe',value:{literal:'$(do-not-execute)'}})+'\n');
  input.write(JSON.stringify({id:2,op:'failure',value:{}})+'\n');
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(result.trim().split('\n').map(v=>JSON.parse(v)),[
    {id:1,ok:true,value:{literal:'$(do-not-execute)'}},{id:2,ok:false,value:null}]);
  input.write(JSON.stringify({id:2,op:'probe',value:{}})+'\n');await new Promise(r=>setImmediate(r));
  assert.equal(input.destroyed,true);assert.equal(calls.length,2);assert.doesNotMatch(result,/SECRET/);
  const large=new PassThrough();serveWslGuest(large,new PassThrough(),async()=>({}));large.write('x'.repeat(2097153));assert.equal(large.destroyed,true);
});

test('AC5/6: repeated backend operations, failed stop and malformed bridge values fail safely',async()=>{
  await fixture(async f=>{
    f.flags.delay=100;f.flags.stopFail=true;await f.life.start(f.input);
    assert.equal((await f.life.stop(id(f))).stop.status,'unknown');
    assert.equal((await f.life.cleanup()).status,'unresolved');
    delete f.flags.stopFail;await f.collect();await f.life.termination(id(f));
    const query={environment:f.environment.id,instance:f.config.linux.instanceId,agent:'codex',execution:id(f),request:f.input.execution.request};
    assert.equal((await f.backend.stop(query)).status,'requested');
    assert.equal((await f.backend.stop(query)).status,'requested');
    assert.equal((await f.life.cleanup()).status,'completed');
    const cleanup={environment:f.environment.id,instance:f.config.linux.instanceId,agent:'codex',
      resources:['workspace','registration','service'].map(k=>f.environment.instances[0][k])};
    assert.deepEqual(await f.backend.cleanup(cleanup),{status:'completed',residuals:[]});
    await assert.rejects(f.life.cleanup());
  });
  for(const value of [null,{login:'available'},'SECRET', 'x'.repeat(2097153)])await fixture(async f=>{
    f.wslFlags.response='readiness';f.wslFlags.value=value;
    const result=await f.life.start(f.input);
    assert.notEqual(result.readiness.status,'ready');
    assert.equal(f.calls.some(c=>c.args.at(-1)==='execute'),false);
    assert.doesNotMatch(JSON.stringify([result,f.backend.diagnostic()]),/SECRET/);
  });
});


test('AC5: changed host/guest context during cleanup retains explicit selected residuals',async()=>{
  for(const side of ['host','guest'])await fixture(async f=>{
    await f.life.start(f.input);await f.collect();await f.life.termination(id(f));
    if(side==='host')f.host.sid='S-1-5-21-2000';else f.guest.uid=2000;
    const result=await f.life.cleanup();
    assert.equal(result.status,'unresolved');
    assert.deepEqual(result.residuals,['workspace','registration','service'].map(k=>f.environment.instances[0][k]));
    for(const path of result.residuals)assert.ok(existsSync(path));
    if(side==='host') {f.host.sid=f.profile.sid;assert.equal((await f.life.cleanup()).status,'completed');}
    else assert.equal((await f.life.cleanup()).status,'unresolved');
  });
});
