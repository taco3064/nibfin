import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,rmSync,symlinkSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {createLinuxClaudeBackend,linuxClaudeProfile} from '@nibfin/core';
import {codexFixture} from '../tooling/codex-fixture.mjs';
const entry=await import(new URL('claude-entry.mjs',import.meta.resolve('@nibfin/core')));
const roles=['shape','shape-validator','shape-diagnosis','shaper-review','deliver','accept'];
async function fixture(fn,role='shape') {
  const f=codexFixture(role,undefined,'claude');try {await fn(f);}finally {await f.dispose();}
}
const id=f=>f.input.execution.id;
const auth=f=>join(f.environment.loginSpace,'anthropic-api-key.json');
async function clean(f) {
  await f.life.termination(id(f));assert.equal((await f.life.cleanup()).status,'completed');
  assert.ok(existsSync(auth(f)));assert.ok(existsSync(f.environment.instances[1].workspace));
}

test('AC1/3: exported inert backend, all roles and both public ownership types, isolated mounts',async()=>{
  for(const role of roles)for(const ownership of ['personal','organization'])await fixture(async f=>{
    assert.deepEqual(f.calls,[]);f.input.ownership=ownership;
    assert.throws(()=>createLinuxClaudeBackend({...f.config,authentication:'ambient'}));
    assert.throws(()=>createLinuxClaudeBackend({...f.config,environment:{...f.environment,agent:'codex'}}));
    assert.equal((await f.life.start(f.input)).start.status,'started');
    const c=f.calls.find(c=>c.args[2]==='create' && c.args.at(-1)==='execute');
    const mounts=c.args.flatMap((v,i)=>v==='--mount'?[c.args[i+1]]:[]);
    assert.equal(mounts.length,8);
    assert.equal(mounts.find(m=>m.includes('dst=/work,')).endsWith(',readonly'),role!=='deliver');
    assert.ok(mounts.find(m=>m.includes('dst=/login.json,')).endsWith(',readonly'));
    assert.ok(c.args.includes('--read-only'));assert.ok(c.args.includes('no-new-privileges'));
    assert.deepEqual(c.env,{PATH:'/usr/bin:/bin',LANG:'C'});
    assert.doesNotMatch(JSON.stringify(c),/LOGIN-SENTINEL|GH_TOKEN|GITHUB_TOKEN|service1|registration0/);
    const result=await f.collect();assert.equal(result.result.status,'valid');
    assert.equal(result.result.evidence.execution.id,id(f));
    assert.doesNotMatch(JSON.stringify(result),/UNTRUSTED-CLI-SESSION/);
    await assert.rejects(f.life.collect(id(f)));await clean(f);
  },role);
});

test('AC2/3: real CLI child boundary captures args, clean env, stdin, schema and fresh sessions',async()=>{
  await fixture(async f=>{
    const capture=join(f.root,'capture.json'),fake=join(f.root,'fake.mjs');
    const envelope={type:'result',subtype:'success',is_error:false,structured_output:f.expected.result};
    writeFileSync(fake,`import {writeFileSync} from 'node:fs';let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),env:process.env,input}));process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});});`);
    const sessions=new Set();
    for(const role of roles) {
      const request={access:role==='deliver'?'write':'read',prompt:'$(touch /escape); `false`\nTASK',timeout:1000,context:f.expected};
      const schema='{"type":"object"}';let called=0;
      const run=(file,args,options)=>{called++;assert.equal(file,'/usr/local/bin/claude');return spawnSync(process.execPath,[fake,...args],options);};
      process.env.GH_TOKEN='AMBIENT-SENTINEL';
      let r;try {r=entry.executeClaude(request,schema,'SELECTED-SENTINEL',run);}finally {delete process.env.GH_TOKEN;}
      assert.ok(r.evidence);assert.equal(called,1);
      const c=JSON.parse(readFileSync(capture));assert.equal(c.input,request.prompt);
      assert.deepEqual(c.env,entry.claudeEnvironment('SELECTED-SENTINEL'));
      const value=flag=>c.args[c.args.indexOf(flag)+1];
      assert.ok(c.args.includes('--print'));assert.ok(c.args.includes('--bare'));
      assert.equal(value('--system-prompt-file'),'/input/instructions.md');
      assert.equal(value('--json-schema'),schema);assert.equal(value('--output-format'),'json');
      assert.equal(value('--tools'),role==='deliver'?'Read,Glob,Grep,Edit,Write,Bash':'Read,Glob,Grep');
      assert.equal(value('--allowedTools'),value('--tools'));assert.equal(value('--permission-mode'),'dontAsk');
      assert.equal(value('--setting-sources'),'');assert.deepEqual(JSON.parse(value('--settings')),{disableAllHooks:true});
      assert.ok(c.args.includes('--strict-mcp-config'));assert.equal(value('--disallowedTools'),'mcp__*');
      assert.deepEqual(JSON.parse(value('--mcp-config')),{mcpServers:{}});
      assert.ok(c.args.includes('--no-session-persistence'));
      for(const flag of ['--resume','--continue','--dangerously-skip-permissions'])assert.ok(!c.args.includes(flag));
      sessions.add(value('--session-id'));
    }
    assert.equal(sessions.size,roles.length);
  });
});

test('AC2/5: version, feature and selected authentication detection use bounded shell-free commands',()=>{
  const env=entry.claudeEnvironment('SECRET');
  for(const mode of ['ok','missing','version','feature','absent','expired','provider','managed']) {
    const calls=[];
    const run=(file,args,options)=>{
      calls.push(args);assert.equal(file,'/usr/local/bin/claude');assert.equal(options.env,env);assert.equal(options.timeout,10000);
      if(args[0]==='--version')return {status:mode==='missing'?1:0,stdout:mode==='version'?'1.0.0':linuxClaudeProfile.claude};
      if(args[0]==='--help')return {status:0,stdout:mode==='feature'?'--print':entry.claudeFeatures.join(' ')};
      return {status:['absent','expired','provider'].includes(mode)?1:0,stdout:JSON.stringify({loggedIn:mode!=='absent',authMethod:'api_key',error:'SECRET'})};
    };
    const p=entry.probeClaude(env,run,()=>mode==='managed');
    assert.equal(p.diagnostic,{ok:'ready',missing:'cli-unavailable',version:'unsupported-version',feature:'unsupported-features',
      absent:'login-rejected',expired:'login-rejected',provider:'login-rejected',managed:'unsafe-configuration'}[mode]);
    assert.doesNotMatch(JSON.stringify(p),/SECRET/);
    assert.ok(calls.length<=3);
  }
});

test('AC3/5: unsafe checkout configuration and unsupported/absent login reject before launch',async()=>{
  for(const name of ['.claude','.mcp.json','CLAUDE.md','CLAUDE.local.md'])await fixture(async f=>{
    const p=join(f.environment.instances[0].workspace,name);
    if(name==='.claude')mkdirSync(p);else writeFileSync(p,'{"hooks":"evil", "permissions":"bypassPermissions"}');
    assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');assert.equal(f.calls.length,0);
  });
  for(const mode of ['absent','malformed','oauth','empty','expired','feature','version'])await fixture(async f=>{
    if(mode==='absent')rmSync(auth(f));
    if(mode==='malformed')writeFileSync(auth(f),'SECRET');
    if(mode==='oauth')writeFileSync(auth(f),JSON.stringify({auth_mode:'oauth',api_key:'SECRET'}));
    if(mode==='empty')writeFileSync(auth(f),JSON.stringify({auth_mode:'anthropic-api-key',api_key:''}));
    if(mode==='expired')f.flags.diagnostic='login-rejected';
    if(mode==='feature')f.flags.diagnostic='unsupported-features';
    if(mode==='version')f.flags.diagnostic='unsupported-version';
    const r=await f.life.start(f.input);assert.equal(r.readiness.status,'unavailable');
    assert.ok(![...f.containers.values()].some(c=>!c.probe));assert.doesNotMatch(JSON.stringify(r),/SECRET/);
  });
});

test('AC4/5: envelope and payload rejection, no text fallback, bindings and replay',async()=>{
  for(const mode of ['missing','empty','error','subtype','nonzero','malformed','truncated','oversized','outcome','schema','role','foreign','stale'])await fixture(async f=>{
    f.flags.envelope=v=>{
      if(mode==='missing')delete v.structured_output;
      if(mode==='empty')v.structured_output=null;
      if(mode==='error')v.is_error=true;
      if(mode==='subtype')v.subtype='error_during_execution';
      if(mode==='outcome')v.structured_output.outcome='approved';
      if(mode==='schema')v.structured_output.version=99;
      if(mode==='role')v.structured_output.stage='deliver';
      v.result=JSON.stringify(f.expected.result);
    };
    if(mode==='nonzero')f.flags.exit=2;
    if(mode==='malformed')f.flags.output='not json';
    if(mode==='truncated')f.flags.output='{"type":';
    if(mode==='oversized')f.flags.output='x'.repeat(1048577);
    await f.life.start(f.input);
    if(mode==='foreign')f.current.expected.execution={...f.current.expected.execution,id:'foreign'};
    if(mode==='stale')f.current.expected.binding.shapeHash='b'.repeat(64);
    assert.equal((await f.collect()).result.status,'invalid');await clean(f);
  });
});

test('AC5: decoded metadata, nested strings and keys are redacted, including delayed collection and rotation',async()=>{
  for(const mode of ['metadata','nested','key','escaped','rotation'])await fixture(async f=>{
    f.flags.envelope=v=>{v.extra=mode==='key'?{'LOGIN-SENTINEL':'value'}:[{nested:'LOGIN-SENTINEL'}];};
    if(mode==='escaped')f.flags.output=JSON.stringify({type:'result',subtype:'success',is_error:false,
      structured_output:f.expected.result,extra:'LOGIN-SENTINEL'}).replace('LOGIN','\\u004cOGIN');
    if(mode==='rotation') {delete f.flags.envelope;f.flags.mutate=v=>{v.result.summary='LOGIN-SENTINEL';};}
    await f.life.start(f.input);
    if(mode==='rotation') {
      for(let n=0;n<300;n++){if((await f.life.termination(id(f))).termination.status==='terminated')break;await f.wait();}
      writeFileSync(auth(f),JSON.stringify({auth_mode:'anthropic-api-key',api_key:'ROTATED'}));
      assert.equal((await f.backend.readiness()).login,'available');
    }
    const r=await f.collect();assert.equal(r.result.status,'invalid');assert.doesNotMatch(JSON.stringify(r),/LOGIN-SENTINEL/);await clean(f);
  });
  await fixture(async f=>{
    const request={access:'read',prompt:'task',timeout:100,context:f.expected};
    const r=entry.executeClaude(request,'{}','SECRET',()=>({status:1,stdout:'SECRET',stderr:'SECRET'}));
    assert.deepEqual(r,{diagnostic:'provider-failure'});
  });
});

test('AC6: actual child cancellation, timeout/lost responses and cleanup reconciliation preserve siblings',async()=>{
  for(const mode of ['normal','cancel','timeout','lostStart','lostCreate','noCreate','stopFail','cleanup'])await fixture(async f=>{
    f.flags.delay=100;
    if(mode==='timeout')f.flags.attachTimeout=true;
    if(['lostStart','lostCreate','noCreate'].includes(mode))f.flags[mode]=true;
    await f.life.start(f.input);
    if(mode==='cancel'||mode==='stopFail') {
      f.flags.ackOnly=true;f.flags.stopFail=mode==='stopFail';
      assert.equal((await f.life.stop(id(f))).stop.status,mode==='stopFail'?'unknown':'requested');
      assert.notEqual((await f.life.termination(id(f))).termination.status,'terminated');
      assert.equal((await f.life.cleanup()).status,'unresolved');
    }
    if(mode==='timeout') {
      await new Promise(r=>setTimeout(r,25));assert.equal((await f.life.termination(id(f))).termination.status,'running');
      assert.equal((await f.life.cleanup()).status,'unresolved');await f.life.stop(id(f));
    }
    const r=await f.collect();assert.equal(r.result.status,['normal','cancel','stopFail','cleanup'].includes(mode)?'valid':'invalid');
    for(let n=0;n<300;n++){if((await f.life.termination(id(f))).termination.status==='terminated')break;await f.wait();}
    if(mode==='cleanup'){f.flags.removeFail=true;assert.equal((await f.life.cleanup()).status,'unresolved');f.flags.removeFail=false;}
    await clean(f);
    assert.equal(f.calls.filter(c=>c.args[2]==='create'&&c.args.at(-1)==='execute').length,1);
  });
});


test('AC4/5: runtime auth/provider failure diagnostics never expose provider stdout or stderr',async()=>{
  await fixture(async f=>{
    const request={access:'read',prompt:'task',timeout:100,context:f.expected};
    for(const status of [0,1]) {
      const r=entry.executeClaude(request,'{}','SECRET',()=>({status,stdout:JSON.stringify({type:'result',is_error:true,error:'authentication_error SECRET'}),stderr:'SECRET'}));
      assert.deepEqual(r,{diagnostic:'login-rejected'});
    }
    f.flags.exit=1;f.flags.output=JSON.stringify({diagnostic:'login-rejected'});
    await f.life.start(f.input);assert.equal((await f.collect()).result.status,'invalid');
    assert.equal(f.backend.diagnostic(),'login-rejected');await clean(f);
  });
});

test('AC1/3: untrusted input cannot change role, binding, instructions or workspace',async()=>{
  for(const field of ['workspace','processEnvironment','image','role','executable'])await fixture(async f=>{
    f.input[field]='hostile';await assert.rejects(f.life.start(f.input));assert.equal(f.calls.length,0);
  });
  for(const field of ['binding','instructions','visibility'])await fixture(async f=>{
    if(field==='binding')f.input.binding={...f.input.binding,repositoryId:'99'};
    if(field==='instructions')f.input.instructions={...f.input.instructions,content:'override role'};
    if(field==='visibility')f.input.visibility='private';
    await assert.rejects(f.life.start(f.input));assert.equal(f.calls.length,0);
  });
});


test('AC2/4/6: real CLI subprocess timeout, nonzero exit, oversized stdout/stderr and missing executable',async()=>{
  await fixture(async f=>{
    const request={access:'read',prompt:'task',timeout:50,context:f.expected};
    for(const mode of ['timeout','nonzero','stdout','stderr','missing']) {
      const run=(file,args,options)=>spawnSync(mode==='missing'?'/nonexistent/claude':process.execPath,
        ['-e',mode==='timeout'?'setInterval(()=>{},1000)':mode==='nonzero'?'process.exit(4)':
          `process.${mode}.write('x'.repeat(1048577))`],options);
      const result=entry.executeClaude(request,'{}','SENTINEL',run);
      assert.deepEqual(result,{diagnostic:'provider-failure'});
    }
  });
});


test('AC3/4: trusted input reader rejects missing, linked, non-file and oversized inputs',async()=>{
  await fixture(async f=>{
    const path=join(f.root,'input.json'),alias=join(f.root,'alias');
    assert.throws(()=>entry.readClaudeFile(path));
    writeFileSync(path,'{"summary":"世界"}');assert.equal(entry.readClaudeFile(path),'{"summary":"世界"}');
    symlinkSync(path,alias);assert.throws(()=>entry.readClaudeFile(alias));rmSync(alias);
    linkSync(path,alias);assert.throws(()=>entry.readClaudeFile(path));rmSync(alias);
    assert.throws(()=>entry.readClaudeFile(f.root));
    writeFileSync(path,'x'.repeat(1048577));assert.throws(()=>entry.readClaudeFile(path));
  });
});
