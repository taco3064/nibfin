import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentEnvironments, createAgentLifecycle, bodyDigest, skillForRole, outcomesForRole} from '@nibfin/core';
const clone = v => structuredClone(v), hash = 'a'.repeat(64);
const descriptor = (root='/fixture') => ({id:root,agent:'recording',loginSpace:root+'/login',instances:[
  {id:root+'-one',workspace:root+'/work1',registration:root+'/reg1',service:root+'/svc1'},
  {id:root+'-two',workspace:root+'/work2',registration:root+'/reg2',service:root+'/svc2'}]});
const ready = () => ({login:'available',tool:'available',isolation:'verified',read:'verified',write:'verified',
  evidence:['fixture-contract-only'],limitations:['No isolation or OS certification']});
function setup(role='shape', overrides={}, environment=descriptor(), deferred=false) {
  const execution = {role,skill:skillForRole(role),id:role+'-execution',request:'request',result:'result',source:null};
  const binding = {authority:hash,grant:hash,policy:hash,core:hash,runtime:hash,instructions:bodyDigest('approved'),
    repositoryId:'42',issueId:'I_one',scopeHash:hash,shapeHash:hash};
  const candidate = {base:'a'.repeat(40),tree:'b'.repeat(40),diff:hash,paths:[],artifacts:[],hooks:[],emptyHooksReason:'No hooks'};
  const inputs = {shape:{body:hash},'shape-validator':{body:hash,author:'author'},'shape-diagnosis':{body:hash},
    deliver:{publication:hash,candidate},accept:{candidate,hooks:hash,deliver:'writer'},
    'shaper-review':{candidate,pr:hash,ci:hash,head:'c'.repeat(40),base:'a'.repeat(40),author:'author',validator:'validator',deliver:'writer',accept:'reviewer'}};
  const expected = {version:1,stage:role,binding,execution,inputs:inputs[role],
    result:{version:1,outcome:outcomesForRole(role)[0],failureClass:'none',summary:'fixture',conflicts:[]}};
  const trusted = {expected:clone(expected),consumed:[]}, calls=[];
  const backend = Object.fromEntries(Object.entries({readiness:()=>ready(),start:()=>({status:'started'}),
    collect:()=>({status:'complete',exitCode:0,evidence:clone(expected)}),stop:()=>({status:'requested'}),
    termination:()=>({status:'terminated'}),cleanup:()=>({status:'completed',residuals:[]}),...overrides})
    .map(([k,fn])=>[k,async v=>{calls.push([k,v]);return fn(v);} ]));
  const life=createAgentLifecycle({environment,instanceId:environment.instances[0].id,backend,current:()=>clone(trusted),
    startCurrent:deferred?()=>({expected:Object.fromEntries(['stage','execution','binding','result'].map(k=>[k,clone(trusted.expected[k])])),consumed:clone(trusted.consumed)}):null});
  const input={execution,binding,instructions:{identity:binding.instructions,content:'approved'},visibility:'public',ownership:'personal'};
  return {life,input,calls,trusted,expected};
}

test('AC1: fixed Agent and non-aliasing environment/instance resources, no side effects',()=>{
  const registry=createAgentEnvironments(), d=descriptor();
  const a=registry.describe(d); assert.ok(Object.isFrozen(a.instances[0]));
  assert.deepEqual(registry.describe(d),a);
  assert.throws(()=>registry.describe({...d,agent:'substitution'}));
  const b=registry.describe(descriptor('/second'));
  assert.notEqual(a.loginSpace,b.loginSpace);
  for (const key of ['workspace','registration','service']) {
    const bad=descriptor('/new');bad.instances[1][key]=a.instances[0][key];
    assert.throws(()=>registry.describe(bad));
    const nested=descriptor('/nested');nested.instances[1][key]=nested.instances[0][key]+'/child';
    assert.throws(()=>registry.describe(nested));
  }
});

test('AC2/3: all roles receive exact trusted inputs, scope and readiness reject before start',async()=>{
  for (const role of ['shape','shape-validator','shape-diagnosis','shaper-review','deliver','accept']) {
    for (const ownership of ['personal','organization']) {
      const {life,input,calls}=setup(role);input.ownership=ownership;
      await life.start(input);
      const start=calls.find(c=>c[0]==='start')[1];
      assert.deepEqual(start.executionIdentity,input.execution);
      assert.deepEqual(start.binding,input.binding);assert.deepEqual(start.instructions,input.instructions);
      assert.deepEqual(start.workspace,{path:'/fixture/work1',access:role==='deliver'?'write':'read'});
      assert.deepEqual(start.processEnvironment,{});assert.equal(start.agentLogin.owner,'/fixture');
      assert.ok(Object.isFrozen(start.instructions));
    }
  }
  for (const [key,value,status] of [['login','unavailable','unavailable'],['tool','unavailable','unavailable'],
    ['read','unsupported','unsupported'],['isolation','unverified','unverified'],['read','unverified','unverified']]) {
    const {life,input,calls}=setup('shape',{readiness:()=>({...ready(),[key]:value})});
    assert.equal((await life.start(input)).readiness.status,status);
    assert.equal(calls.some(c=>c[0]==='start'),false);
  }
  for (const change of [v=>v.execution.role='scope',v=>v.execution.skill='accept',v=>v.visibility='private',
    v=>v.instructions.content='repository replacement',v=>v.workspace='/other',v=>v.binding.issueId='foreign']) {
    const {life,input,calls}=setup();change(input);await assert.rejects(life.start(input));assert.equal(calls.length,0);
  }
});

test('AC4/6: unknown start, stop, collection and cleanup remain separate; duplicates cannot restart',async()=>{
  let running=true, complete=false;
  const {life,input,calls}=setup('shape',{start:()=>{throw Error('private backend detail');},
    termination:()=>({status:running?'running':'terminated'}),collect:()=>({status:complete?'complete':'pending',exitCode:1,evidence:null})});
  assert.equal((await life.start(input)).start.status,'unknown');
  await assert.rejects(life.start(input));assert.equal(calls.filter(c=>c[0]==='start').length,1);
  assert.equal((await life.collect(input.execution.id)).result.status,'pending');
  assert.equal((await life.stop(input.execution.id)).stop.status,'requested');
  await assert.rejects(life.stop(input.execution.id));
  assert.equal((await life.termination(input.execution.id)).termination.status,'running');
  assert.equal((await life.cleanup()).status,'unresolved');assert.equal(calls.some(c=>c[0]==='cleanup'),false);
  running=false;await life.termination(input.execution.id);
  assert.equal((await life.cleanup()).status,'unresolved');
  complete=true;await life.collect(input.execution.id);
  assert.equal((await life.cleanup()).status,'completed');
  assert.equal(life.observe(input.execution.id).start.status,'unknown');
  await assert.rejects(life.cleanup());await assert.rejects(life.start(input));
  const reject=setup('shape',{start:()=>({status:'rejected'})});
  assert.equal((await reject.life.start(reject.input)).start.status,'rejected');
  await assert.rejects(reject.life.collect(reject.input.execution.id));
  assert.equal((await reject.life.cleanup()).status,'completed');
  for (const status of ['failed','unknown']) {
    const f=setup('shape',{stop:()=>({status}),termination:()=>({status:'unknown'}),cleanup:()=>({status:'failed',residuals:['/fixture/work1']})});
    await f.life.start(f.input);assert.equal((await f.life.stop(f.input.execution.id)).stop.status,status);
    assert.equal((await f.life.termination(f.input.execution.id)).termination.status,'unknown');
    assert.equal((await f.life.cleanup()).status,'unresolved');
  }
});

test('AC5: context collection rejects each identity mutation, malformed/foreign/replayed output and self-review',async()=>{
  const changes=[v=>v.version=2,v=>v.result.version=2,v=>v.result.extra=true,v=>v.result.outcome='accepted',
    ...['repositoryId','issueId','instructions','scopeHash','shapeHash'].map(k=>v=>v.binding[k]+='b'),
    ...['id','request','result'].map(k=>v=>v.execution[k]+='other'),
    v=>v.execution.source={repositoryId:'42',workflow:hash,runId:'123',attempt:'2'}];
  for (const mutate of changes) {
    let output;const f=setup('shape',{collect:()=>({status:'complete',exitCode:0,evidence:output})});
    output=clone(f.expected);mutate(output);await f.life.start(f.input);
    assert.equal((await f.life.collect(f.input.execution.id)).result.status,'invalid');
  }
  for (const [role,key] of [['shape-validator','author'],['accept','deliver'],
    ...['author','validator','deliver','accept'].map(k=>['shaper-review',k])]) {
    const f=setup(role);f.trusted.expected.inputs[key]=f.input.execution.id;
    await assert.rejects(f.life.start(f.input));assert.equal(f.calls.length,0);
  }
  const f=setup();await f.life.start(f.input);
  f.trusted.consumed.push('result');assert.equal((await f.life.collect(f.input.execution.id)).result.status,'invalid');
  const good=setup();await good.life.start(good.input);
  assert.equal((await good.life.collect(good.input.execution.id)).result.status,'valid');
  await assert.rejects(good.life.collect(good.input.execution.id));
  for (const [exitCode,evidence] of [[1,null],[0,null],[0,'malformed']]) {
    const b=setup('shape',{collect:()=>({status:'complete',exitCode,evidence})});await b.life.start(b.input);
    assert.equal((await b.life.collect(b.input.execution.id)).result.status,'invalid');
  }
});

test('AC3/4/6: real process env, timeout stop acknowledgment, confirmed exit and bounded cleanup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nibfin-process-'));const d=descriptor(root);
  for (const path of [d.loginSpace,...d.instances.flatMap(i=>[i.workspace,i.registration,i.service])]) mkdirSync(path);
  let child, ended=false, stdout='', exitCode=null, exit;
  process.env.NIBFIN_SENTINEL_CREDENTIAL='sentinel-secret';
  const f=setup('shape',{
    start:async input=>{
      child=spawn(process.execPath,['-e',`process.stdout.write(JSON.stringify({sentinel:process.env.NIBFIN_SENTINEL_CREDENTIAL??null}));setInterval(()=>{},1000)`],
        {cwd:input.workspace.path,env:input.processEnvironment,stdio:['ignore','pipe','pipe']});
      exit=once(child,'exit').then(([code])=>{ended=true;exitCode=code;});
      stdout=await new Promise(resolve=>child.stdout.once('data',b=>resolve(b.toString())));
      return {status:'started'};
    },
    stop:()=>({status:'requested'}), // Simulate timeout cancellation acknowledged without termination.
    termination:()=>({status:ended?'terminated':'running'}),
    collect:()=>({status:ended?'complete':'pending',exitCode,evidence:null}),
    cleanup:({resources})=>{resources.forEach(p=>rmSync(p,{recursive:true,force:true}));return {status:'completed',residuals:[]};}
  },d);
  try {
    await f.life.start(f.input);assert.deepEqual(JSON.parse(stdout),{sentinel:null});
    await f.life.collect(f.input.execution.id);await f.life.stop(f.input.execution.id);
    assert.equal((await f.life.termination(f.input.execution.id)).termination.status,'running');
    assert.equal((await f.life.cleanup()).status,'unresolved');
    child.kill('SIGTERM');await exit;
    await f.life.termination(f.input.execution.id);await f.life.collect(f.input.execution.id);
    assert.equal((await f.life.cleanup()).status,'completed');
    assert.ok(existsSync(d.loginSpace));assert.ok(existsSync(d.instances[1].workspace));assert.ok(existsSync(d.instances[1].registration));
    assert.equal(existsSync(d.instances[0].workspace),false);
    assert.equal(JSON.stringify(f.life.observe(f.input.execution.id)).includes('sentinel-secret'),false);
  } finally {delete process.env.NIBFIN_SENTINEL_CREDENTIAL;if(child&&!ended){child.kill('SIGKILL');await exit;}rmSync(root,{recursive:true,force:true});}
});

test('AC4/6: natural process exit, cleanup failure/residuals and backend response loss',async()=>{
  let ended=false, childExit;
  const f=setup('shape',{
    start:input=>{const child=spawn(process.execPath,['-e','process.exit(0)'],{env:input.processEnvironment});
      childExit=once(child,'exit').then(([code])=>{assert.equal(code,0);ended=true;});return {status:'started'};},
    termination:()=>({status:ended?'terminated':'running'}),
    cleanup:()=>({status:'failed',residuals:['/fixture/work1']})});
  await f.life.start(f.input);await childExit;
  assert.equal((await f.life.collect(f.input.execution.id)).result.status,'valid');
  assert.equal((await f.life.termination(f.input.execution.id)).termination.status,'terminated');
  assert.equal((await f.life.cleanup()).status,'failed');
  assert.deepEqual(f.life.observe(f.input.execution.id).cleanup.residuals,['/fixture/work1']);
  for (const method of ['readiness','collect','stop','termination','cleanup']) {
    const b=setup('shape',{[method]:()=>{throw Error('secret');}});
    const first=await b.life.start(b.input);
    if(method==='readiness'){assert.equal(first.readiness.status,'unknown');continue;}
    if(method==='cleanup'){await b.life.collect(b.input.execution.id);await b.life.termination(b.input.execution.id);
      assert.equal((await b.life.cleanup()).status,'unknown');}
    else {const result=await b.life[method](b.input.execution.id);assert.equal(result[method==='collect'?'result':method].status,'unknown');}
    assert.equal(JSON.stringify(b.life.observe(b.input.execution.id)).includes('secret'),false);
  }
});

test('AC5: changing current expectations cannot rebind a running execution',async()=>{
  let output;
  const f=setup('shape',{collect:()=>({status:'complete',exitCode:0,evidence:output})});
  await f.life.start(f.input);
  f.trusted.expected.binding.scopeHash='b'.repeat(64);
  output=clone(f.trusted.expected);
  assert.equal((await f.life.collect(f.input.execution.id)).result.status,'invalid');
});

test('AC1/6 regression: reject root ownership in every resource position without deletion',()=>{
  for (const key of ['loginSpace','workspace','registration','service']) {
    const d=descriptor();
    if(key==='loginSpace') d[key]='/'; else d.instances[0][key]='/';
    assert.throws(()=>createAgentEnvironments().describe(d),/lifecycle:/,key);
    // Serialized descriptors must meet the same boundary at lifecycle construction.
    assert.throws(()=>setup('shape',{},d),/lifecycle:/,key);
  }
});

test('AC4/6 regression: retained backend responses cannot mutate observations or unlock cleanup/start',async()=>{
  const start={status:'started'}, stop={status:'requested'}, termination={status:'running'};
  const cleanup={status:'failed',residuals:['/fixture/work1']};
  const f=setup('shape',{start:()=>start,stop:()=>stop,termination:()=>termination,cleanup:()=>cleanup});
  const id=f.input.execution.id;
  await f.life.start(f.input);start.status='rejected';
  assert.equal(f.life.observe(id).start.status,'started');
  await f.life.collect(id);
  await f.life.stop(id);stop.status='failed';
  assert.equal(f.life.observe(id).stop.status,'requested');
  await assert.rejects(f.life.stop(id),/stop-transition/);
  await f.life.termination(id);const before=f.life.observe(id);
  termination.status='terminated';
  assert.deepEqual(f.life.observe(id),before);
  assert.equal((await f.life.cleanup()).status,'unresolved');
  assert.equal(f.calls.filter(([op])=>op==='cleanup').length,0);
  const replacement=clone(f.input);replacement.execution.id='replacement';
  f.trusted.expected.execution.id='replacement';
  await assert.rejects(f.life.start(replacement),/duplicate-or-unresolved/);
  assert.equal(f.calls.filter(([op])=>op==='start').length,1);
  // Only a new validated observation can confirm termination.
  await f.life.termination(id);
  assert.equal(f.life.observe(id).termination.status,'terminated');
  await f.life.cleanup();const failed=f.life.observe(id);
  cleanup.status='completed';cleanup.residuals.length=0;
  assert.deepEqual(f.life.observe(id),failed);
  assert.deepEqual(f.life.observe(id).cleanup.residuals,['/fixture/work1']);
  assert.equal((await f.life.cleanup()).status,'completed');
});

test('Deliver-only deferred Candidate contract cannot authorize other roles or incomplete collection',async()=>{
  const f=setup('deliver',{},descriptor(),true);
  delete f.trusted.expected.inputs;
  assert.equal((await f.life.start(f.input)).start.status,'started');
  f.trusted.expected.inputs=clone(f.expected.inputs);
  assert.equal((await f.life.collect(f.input.execution.id)).result.status,'valid');
  for(const role of ['shape','shape-validator','shape-diagnosis','shaper-review','accept']){
    const x=setup(role,{},descriptor(),true);await assert.rejects(x.life.start(x.input));assert.equal(x.calls.length,0);
  }
  const bad=setup('deliver',{},descriptor(),true);await bad.life.start(bad.input);
  delete bad.trusted.expected.inputs;
  assert.equal((await bad.life.collect(bad.input.execution.id)).result.status,'invalid');
  const replay=setup('deliver',{},descriptor(),true);replay.trusted.consumed.push(replay.input.execution.result);
  await assert.rejects(replay.life.start(replay.input));assert.equal(replay.calls.length,0);
});
