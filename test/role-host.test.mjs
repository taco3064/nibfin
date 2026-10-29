import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as core from '@nibfin/core';
import {configure} from '../host/entry.mjs';
import {codexFixture} from '../tooling/codex-fixture.mjs';
import {wslFixture} from '../tooling/wsl-fixture.mjs';
const roles=['shape','shape-validator','shape-diagnosis','shaper-review','deliver','accept'];
const runner=()=>({version:1,platform:'linux',arch:'x64',account:{user:'member',uid:1000,githubUserId:'42'},
  path:core.supportedRunnerDefaults.path,interpreter:core.supportedRunnerDefaults.interpreter,
  work:'/fixture/work',scratch:'/fixture/scratch',cache:'/fixture/cache'});
const local=()=>({platform:'linux',arch:'x64',user:'member',uid:1000,tokenOverride:false,roots:{work:true,scratch:true,cache:true}});
const probe=async()=>({status:'verified',userId:'42'});
function roleFixture(agent='codex') {
  const fixtures=new Map(),profiles=[];let selected=null;
  for(const role of roles) {
    const f=codexFixture(role,undefined,agent);fixtures.set(role,f);
    f.environment.id=role+'-environment';f.environment.instances.forEach((i,n)=>i.id=role+'-instance-'+n);
    f.config.instanceId=role+'-instance-0';f.input.execution.request=role+'-request';f.input.execution.result=role+'-result';
    f.expected.execution={...f.input.execution};f.current.expected=structuredClone(f.expected);
    const {process:ignored,task,...backend}=f.config;
    profiles.push({id:role,agent,os:'linux',backend});
  }
  const configuration={runner:runner(),profiles,assignments:Object.fromEntries(roles.map(r=>[r,r]))};
  const options={configuration,observe:local,probe,retain:async()=> 'custody:role-command',
    bind:async task=>{
      selected=fixtures.get(task.role);
      return {input:structuredClone(selected.input),current:()=>structuredClone(selected.current),
        deadlineAt:Date.now()+360000,reserveMs:30000,prompt:'approved '+task.role,inputs:selected.expected.inputs};
    },process:command=>selected.config.process(command)};
  return {fixtures,configuration,options,select:role=>{selected=fixtures.get(role);},
    close:async()=>{for(const f of fixtures.values())await f.dispose();}};
}
async function finish(prepared) {
  const id=prepared.input.execution.id;
  for(let n=0;n<300;n++) {
    const value=await prepared.lifecycle.collect(id);
    if(value.result.status!=='pending') {
      assert.equal((await prepared.lifecycle.termination(id)).termination.status,'terminated');return value;
    }
    await new Promise(r=>setTimeout(r,5));
  }throw Error('role did not terminate');
}

test('native reviewers receive independently materialized files and retained custody before Agent launch',async()=>{
  const source=mkdtempSync(join(tmpdir(),'nibfin-role-source-'));
  const git=(...args)=>execFileSync('git',args,{cwd:source,env:{PATH:process.env.PATH,HOME:source,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['pipe','pipe','pipe']});
  try{
    git('init','--object-format=sha1');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    writeFileSync(join(source,'code'),'base');git('add','.');git('-c','core.hooksPath=/dev/null','commit','-qm','base');
    const base=git('rev-parse','HEAD').toString().trim();writeFileSync(join(source,'code'),'actual candidate');
    const scopeBody='Original scope',shapeBody='Candidate artifacts applicability: No additional artifacts.\nCandidate hooks applicability: No hooks apply.\n```kairo-candidate\n{"artifacts":[],"hooks":[]}\n```';
    const capture=core.captureWorkspace({root:source,base,scopeBody,shapeBody,permittedPaths:['code'],
      binding:{repository:'example/public',cycle:'cycle-1',policy:'a'.repeat(64),scopeHash:core.bodyDigest(scopeBody),shapeHash:core.bodyDigest(shapeBody)}});
    for(const role of ['accept','shaper-review']){
      const f=roleFixture(),records=[];
      try{
        const selected=f.fixtures.get(role),root=selected.environment.instances[0].workspace;chmodSync(root,0o700);
        selected.input.binding={...selected.input.binding,...capture.expected.binding};
        delete selected.input.binding.repository;delete selected.input.binding.cycle;
        selected.expected.binding=structuredClone(selected.input.binding);selected.expected.inputs.candidate=capture.candidate;
        selected.current.expected=structuredClone(selected.expected);
        const host=core.createProtectedRoleHost({...f.options,retain:async r=>{records.push(r);return 'custody:workspace';}});
        const task={role,skill:core.skillForRole(role),instructions:core.selectInstructions({role,skill:core.skillForRole(role)}),
          task:{version:1,repository:'example/public',workspace:JSON.parse(core.exportWorkspace(capture)),expected:capture.expected}};
        const prepared=await host.prepareRole(task);
        assert.equal(readFileSync(join(root,'code'),'utf8'),'actual candidate');
        assert.equal(prepared.workspace.status,'materialized');assert.equal(prepared.workspace.reference,'custody:workspace');
        assert.equal(records.length,1);assert.equal(records[0].kind,'role-workspace');
        assert.deepEqual(records[0].workspace,capture.expected);
        assert.equal(f.fixtures.get(role).calls.some(c=>c.args.includes('start')),false,'no Agent started during transfer');
        assert.equal(readFileSync(join(source,'code'),'utf8'),'actual candidate');
        await assert.rejects(core.createProtectedRoleHost(f.options).prepareRole(task),/materialize-existing-work/);
        assert.equal(records.length,1,'an existing checkout is never silently replaced');
      }finally{await f.close();}
    }
  }finally{rmSync(source,{recursive:true,force:true});}
});

test('Shape returns a late document through each maintained decoder, pins its exact Scope, and retains it before validation',async()=>{
  for(const agent of ['codex','claude','gemini'])for(const changed of [false,true]) {
    const f=roleFixture(agent),records=[];
    try {
      const fixture=f.fixtures.get('shape'),scope='Owner Scope\r\nKeep this exact.\n';
      const body=core.formatRequirementsDocument({scope:changed?'Replaced Scope':scope,shape:'Proposed implementation\n'});
      fixture.flags.mutate=output=>{output.shapeBody=body;};
      const bind=f.options.bind;
      const host=core.createProtectedRoleHost({...f.options,retain:async record=>{records.push(record);return 'custody:actual-document';},
        bind:async task=>{
          const value=await bind(task);value.inputs={};
          // Neither a body nor its hash is known at launch. Identity and the
          // independent success contract are pinned before the model runs.
          const current=()=>{const v=value.current();delete v.expected.inputs;return v;};
          const startCurrent=()=>{const v=current();delete v.expected.version;return v;};
          return {...value,current,startCurrent,outputFormat:'shape-author-v1'};
        }});
      const instructions=core.selectInstructions({role:'shape',skill:'shape'});
      const p=await host.prepareRole({role:'shape',skill:'shape',instructions,task:{original:{body:scope},
        requirementsDocument:{format:'scope-shape-v1',scope,frame:core.requirementsDocumentFrame(scope)}}});
      assert.throws(()=>p.readBody(),/shape-unavailable/);
      assert.equal(Object.hasOwn(p.current().expected,'inputs'),false);
      assert.equal((await p.lifecycle.start(p.input)).start?.status,'started');
      const result=await finish(p);
      if(changed) {
        assert.notEqual(result.result.status,'valid');assert.equal(records.length,0);
        assert.throws(()=>p.readBody(),/shape-unavailable/);
      } else {
        assert.equal(result.result.status,'valid',JSON.stringify(result));
        assert.equal(p.readBody(),body);assert.deepEqual(p.current().expected.inputs,{body:core.bodyDigest(body)});
        assert.equal(records.length,1);assert.equal(records[0].body,body);
        assert.equal(records[0].kind,'shape-author-body');
        assert.deepEqual(records[0].execution,p.input.execution);
        assert.equal(Object.hasOwn(result.result.evidence,'shapeBody'),false);
      }
      assert.equal((await p.lifecycle.cleanup()).status,'completed');
    } finally {await f.close();}
  }
});

test('maintained public composition executes every role across all three actual Linux backends with correlated independent results',async()=>{
  for(const agent of ['codex','claude','gemini']) {
    const f=roleFixture(agent);try {
      const host=core.createProtectedRoleHost(f.options);
      assert([...f.fixtures.values()].every(x=>x.calls.length===0),'construction must be inert');
      const ids=[];
      for(const role of roles) {
        const instructions=core.selectInstructions({role,skill:core.skillForRole(role)});
        const p=await host.prepareRole({role,skill:core.skillForRole(role),instructions,task:{role,repository:'example-org/core'}});
        assert.equal(Object.hasOwn(p,'bindCandidate'),role==='deliver','only Writer receives the trusted handoff');
        ids.push(p.input.execution.id);assert.equal(p.taskIdentity,core.contentIdentity({role,repository:'example-org/core'}));
        const started=await p.lifecycle.start(p.input);assert.equal(started.start?.status,'started',JSON.stringify(started));
        const result=await finish(p);assert.equal(result.result.status,'valid');
        assert.equal(result.result.evidence.execution.id,p.input.execution.id);
        const launch=f.fixtures.get(role).calls.find(c=>c.args.at(-1)==='execute');
        const mounts=launch.args.filter(a=>a.includes('dst=/work,'));assert.equal(mounts.length,1);
        assert.equal(mounts[0].endsWith(',readonly'),role!=='deliver');
        assert.equal((await p.lifecycle.cleanup()).status,'completed');
      }
      assert.equal(new Set(ids).size,6);
    }finally{await f.close();}
  }
});

test('first-party Deliver binds the post-termination Candidate into independent current expectations',async()=>{
 const f=roleFixture();try{
  const selected=f.fixtures.get('deliver');f.select('deliver');selected.expected.result.summary=core.nativeRoleSuccessSummary;
  const instructions=core.selectInstructions({role:'deliver',skill:'deliver'}),scopeBody='Scope',shapeBody='Shape';
  const binding={...selected.input.binding,scopeHash:core.bodyDigest(scopeBody),shapeHash:core.bodyDigest(shapeBody),instructions:instructions.identity};
  const native=core.createNativeRoleBindings({ownership:'personal',retain:async()=> 'custody:request'});
  const host=core.createProtectedRoleHost({...f.options,bind:task=>native.bind(task)});
  const p=await host.prepareRole({role:'deliver',skill:'deliver',instructions,task:{binding,scopeBody,shapeBody,publication:{verified:'publication'}}});
  assert.equal(p.current().expected.inputs.candidate,undefined);assert.equal((await p.lifecycle.start(p.input)).start.status,'started');
  for(let n=0;n<300;n++){if((await p.lifecycle.termination(p.input.execution.id)).termination.status==='terminated')break;await new Promise(r=>setTimeout(r,5));}
  await p.bindCandidate(selected.expected.inputs.candidate);
  assert.deepEqual(p.current().expected.inputs.candidate,selected.expected.inputs.candidate);
  const result=await finish(p);assert.equal(result.result.status,'valid',JSON.stringify(result));
  assert.deepEqual(result.result.evidence.inputs.candidate,selected.expected.inputs.candidate);
  assert.equal((await p.lifecycle.cleanup()).status,'completed');
 }finally{await f.close();}
});

test('protected-host delivery path installs maintained prepareRole into the existing Core owners, preserving selector and approval behavior',async()=>{
  const f=roleFixture();try {
    const context={repository:'example-org/core',repositoryId:'42',run:{id:'10',attempt:'1'}};
    let prepared=0;
    const existing={shape:{current:()=>({}),prepareRole:()=>{throw Error('legacy role construction');}},deliver:{current:()=>({})}};
    const capabilities={authenticate:async()=>({...context,visibility:'public',ownership:'personal'}),
      delivery:async()=>({request:{target:context},config:{owners:existing,selector:{select:async()=>({status:'selected'})}}}),
      retain:async()=>{},retrieve:async()=>{},verifyRunner:async()=>{}};
    const host=configure({core,mode:'execute',context,deployment:{roles:{...f.options,bind:async task=>{prepared++;return f.options.bind(task);}},
      options:{version:1,repository:context.repository,repositoryId:'42',environment:'nibfin-member'},capabilities}});
    const delivery=await host.delivery({identity:{...context,visibility:'public',ownership:'personal'}});
    const selected=core.selectInstructions({role:'shape',skill:'shape'});
    const p=await delivery.config.owners.shape.prepareRole({role:'shape',skill:'shape',instructions:selected,task:{original:'scope'}});
    assert.equal(prepared,1);assert.equal((await p.lifecycle.start(p.input)).start.status,'started');
    assert.equal((await finish(p)).result.status,'valid');await p.lifecycle.cleanup();
    assert.equal((await delivery.config.selector.select({conditions:{}})).status,'selected');
    assert.throws(()=>configure({core,mode:'lookup',context,deployment:{roles:f.options,
      options:{version:1,repository:context.repository,repositoryId:'42',environment:'nibfin-hosted'},capabilities:{authenticate(){},lookup(){}}}}));
  }finally{await f.close();}
});

test('authenticated routing and maintained role preparation coexist in the protected host after base integration',async()=>{
  const {hostRoutingFixture}=await import('../tooling/host-routing-fixture.mjs');
  const routed=await hostRoutingFixture(),f=roleFixture();
  try {
    const selected=await routed.resolve();assert.equal(selected.status,'selected');
    const host=routed.make('compute',{roles:f.options}).host;
    const identity=await host.authenticate({mode:'compute',context:routed.context});
    const spec=await host.delivery({identity,input:routed.input,context:routed.context});
    const held=await host.retrieve({kind:'resolution',key:selected.resolution,identity});
    host.bindResolution(held);
    assert.equal((await core.createCore(spec.config).inspect(routed.request)).reason,'evaluated');
    assert.equal(typeof spec.config.checkpoint,'function');
    const actual={identity,request:routed.request,route:held.route,memberId:held.memberId};
    assert.equal(await host.verifyRunner(actual),true);
    const instructions=core.selectInstructions({role:'shape',skill:'shape'});
    const p=await spec.config.owners.shape.prepareRole({role:'shape',skill:'shape',instructions,task:{scope:'approved'}});
    assert.equal((await p.lifecycle.start(p.input)).start.status,'started');
    assert.equal((await finish(p)).result.status,'valid');
    assert.equal((await p.lifecycle.cleanup()).status,'completed');
    routed.stateRouting.actual='22';
    await assert.rejects(host.verifyRunner(actual),/protected-host:configuration/,
      'role composition must retain the authenticated eligibility gate');
  }finally{await f.close();}
});

test('profile/role/configuration and account/preflight overrides reject before model launch; checkout prose cannot choose a backend',async()=>{
  const f=roleFixture();try {
    for(const mutate of [c=>c.assignments.accept='unknown',c=>c.assignments.accept='deliver',c=>c.profiles[0].agent='other',
      c=>c.profiles[0].os='macos',c=>c.runner.path='/tmp/hostile',c=>c.runner.extra='override']) {
      const c=structuredClone(f.configuration);mutate(c);assert.throws(()=>core.createProtectedRoleHost({...f.options,configuration:c}));
    }
    const host=core.createProtectedRoleHost(f.options);
    await assert.rejects(host.prepareRole({role:'scope',skill:'shape'}));
    await assert.rejects(host.prepareRole({role:'accept',skill:'deliver'}));
    for(const override of [{uid:2000},{user:'other'},{tokenOverride:true}]) {
      const blocked=core.createProtectedRoleHost({...f.options,observe:()=>({...local(),...override})});
      await assert.rejects(blocked.prepareRole({role:'shape',skill:'shape',instructions:core.selectInstructions({role:'shape',skill:'shape'}),task:{}}),/preflight-blocked/);
    }
    assert([...f.fixtures.values()].every(x=>!x.calls.length));
  }finally{await f.close();}
});

test('versioned runner schema/example agree, required probes distinguish denial/authentication/proxy/DNS/TLS/timeout/cache and missing capabilities',async()=>{
  const schema=JSON.parse(readFileSync(new URL('../host/runner.schema.json',import.meta.resolve('@nibfin/core'))));
  const example=JSON.parse(readFileSync(new URL('../host/runner.example.json',import.meta.resolve('@nibfin/core'))));
  assert.deepEqual(Object.keys(example).sort(),schema.required.slice().sort());assert.equal(core.runnerConfiguration(example).version,1);
  assert.equal(core.supportedRunnerDefaults.acquisition.lifecycleScripts,false);
  assert.equal(core.supportedRunnerDefaults.network.management,'outside-agent');
  const configuration=core.runnerConfiguration(runner());
  assert.equal((await core.preflightRunner({configuration,observe:local,probe})).status,'ready');
  for(const kind of ['policy-denial','authentication','proxy','dns','tls','timeout','offline-cache','missing-tool','unprobed']) {
    const output=await core.preflightRunner({configuration,observe:local,probe:async({capability})=>capability==='model-network'?
      {status:'blocked',kind,hostname:'api.anthropic.com',detail:'TOKEN https://private.example/path?token=SECRET'}:probe()});
    assert.equal(output.status,'blocked');assert.deepEqual(output.diagnostics,[{capability:'model-network',kind,
      hostname:'api.anthropic.com',configuration:'runner.v1.model-network'}]);assert.doesNotMatch(JSON.stringify(output),/SECRET|TOKEN|private.example/);
  }
  const unprobed=await core.preflightRunner({configuration,observe:local,probe:async()=>undefined});
  assert.equal(unprobed.status,'blocked');assert.equal(unprobed.diagnostics.length,9);
});

test('maintained WSL selection reaches Claude/Gemini guest backends without a second runtime or session',async()=>{
  // The WSL fixture uses the actual host/guest transport and injected OS observations.
  for(const agent of ['codex','claude','gemini']) {
    const f=wslFixture('accept',agent);try {
      assert.equal((await f.life.start(f.input)).start.status,'started');
      assert.equal((await f.collect()).result.status,'valid');
      await f.life.termination(f.input.execution.id);assert.equal((await f.life.cleanup()).status,'completed');
      assert.equal(f.commands.length,1);
    }finally{await f.dispose();}
  }
});

test('actual Core Shape owner consumes the maintained role composition and reconciles its terminal result',async()=>{
  const {shapeFixture}=await import('../tooling/shape-fixture.mjs');
  const sh=shapeFixture(),f=roleFixture();try {
    const original=sh.capabilities.prepareRole;
    const host=core.createProtectedRoleHost({...f.options,bind:async task=>{
      const generated=await original(task),receipt=sh.expected.get(generated.input.execution.id);
      const fixture=f.fixtures.get(task.role);f.select(task.role);
      Object.assign(fixture.expected.result,receipt.result);
      return {input:generated.input,current:()=>sh.capabilities.evidenceCurrent(generated.input.execution.id),
        deadlineAt:Date.now()+360000,reserveMs:30000,prompt:'Core selected shape task',inputs:receipt.inputs};
    }});
    const owners=host.owners({shape:sh.capabilities}),flow=core.createShapeFlow(owners.shape);
    let value=await flow.author();
    for(let n=0;n<100&&value.outcome==='blocked';n++) {await new Promise(r=>setTimeout(r,10));value=await flow.reconcile();}
    assert.equal(value.outcome,'authored',JSON.stringify(value));assert.equal(value.author.body,sh.body);
    assert.equal(value.author.receipt.execution.role,'shape');
    assert(f.fixtures.get('shape').calls.some(c=>c.args.at(-1)==='execute'));
    await host.get(value.author.receipt.execution.id).lifecycle.cleanup();
  }finally{await f.close();}
});

test('supported Node path prepares and verifies inside the same role container through its single lane, retaining custody and preserving the Candidate',async()=>{
  const {mkdirSync,writeFileSync,existsSync}=await import('node:fs');
  const {join}=await import('node:path');const f=roleFixture();
  try {
    const selected=f.fixtures.get('accept'),source=selected.environment.instances[0].workspace;
    writeFileSync(join(source,'package.json'),JSON.stringify({name:'role-fixture',version:'1.0.0',scripts:{postinstall:'touch FORBIDDEN'}}));
    writeFileSync(join(source,'package-lock.json'),JSON.stringify({name:'role-fixture',version:'1.0.0',lockfileVersion:3,
      packages:{'':{name:'role-fixture',version:'1.0.0'}}}));
    selected.flags.delay=10000;f.configuration.profiles.find(p=>p.id==='accept').backend.egress.node=true;
    const records=[];
    const host=core.createProtectedRoleHost({...f.options,retain:async record=>{records.push(record);return 'custody:node-'+records.length;}});
    const p=await host.prepareRole({role:'accept',skill:'accept',instructions:core.selectInstructions({role:'accept',skill:'accept'}),task:{candidate:'exact'}});
    const before=core.nodeSourceIdentity(source).identity;assert.equal((await p.lifecycle.start(p.input)).start.status,'started');
    const prepared=await p.prepareNode();assert.equal(prepared.status,'prepared',JSON.stringify(records));
    const command=await prepared.command({file:process.execPath,args:['-e','require("node:fs").writeFileSync("writable-fixture","ok")'],timeoutMs:1000});
    assert.equal(command.status,'passed');assert.equal(existsSync(join(source,'writable-fixture')),false);
    assert.equal(core.nodeSourceIdentity(source).identity,before);assert.equal(existsSync(join(prepared.directory,'FORBIDDEN')),false);
    const exec=selected.calls.filter(c=>c.args[2]==='exec'&&c.args.includes('/verification-runner.mjs'));assert.equal(exec.length,2);
    assert(exec.every(c=>c.args.includes('/verification-runner.mjs')&&c.args.includes('--protocol')));
    const names=exec.map(c=>c.args[5]);assert.equal(new Set(names).size,1,'preparation and verification must share the original container');
    const gateway=selected.calls.find(c=>c.args.at(-1)==='/gateway.mjs');assert.match(JSON.stringify(gateway),/registry.npmjs.org/);
    assert.equal(records.length,2);assert(records.every(r=>r.record.execution===p.input.execution.id));
    await p.lifecycle.stop(p.input.execution.id);await finish(p);assert.equal((await p.lifecycle.cleanup()).status,'completed');
  }finally{await f.close();}
});

test('WSL Node preparation runs in the initialized guest and retains command payloads through the existing host custody capability',async()=>{
  const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');const f=wslFixture('accept','codex',{deadlineAt:Date.now()+360000,reserveMs:30000,egress:{image:'sha256:'+'1'.repeat(64),node:true}});
  try {
    const source=f.environment.instances[0].workspace;
    writeFileSync(join(source,'package.json'),'{"name":"wsl-node-fixture","version":"1.0.0"}');
    writeFileSync(join(source,'package-lock.json'),'{"name":"wsl-node-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"wsl-node-fixture","version":"1.0.0"}}}');
    f.flags.delay=10000;
    assert.equal((await f.life.start(f.input)).start.status,'started');const records=[];
    const retain=async record=>{records.push(record);return 'custody:wsl-'+records.length;};
    const prepared=await f.backend.prepareNode(f.input.execution.id,{},retain);
    assert.equal(prepared.status,'prepared',JSON.stringify(records));assert.match(prepared.receipt.logReference,/^custody:wsl-/);
    const receipt=await prepared.command({file:process.execPath,args:['-e','require("node:fs").writeFileSync("wsl-fixture","ok")'],timeoutMs:1000});
    assert.equal(receipt.status,'passed');assert.match(receipt.logReference,/^custody:wsl-/);assert.equal(records.length,2);
    assert.equal(f.commands.length,1);assert(f.requests.some(r=>r.op==='prepareNode'));assert(f.requests.some(r=>r.op==='nodeCommand'));
    assert.equal(core.nodeSourceIdentity(source).identity,prepared.sourceIdentity);
    await f.life.stop(f.input.execution.id);await f.collect();await f.life.termination(f.input.execution.id);
    assert.equal((await f.life.cleanup()).status,'completed');
  }finally{await f.dispose();}
});

test('Linux verification cancellation stops the original container tree and retains a cancelled receipt',async()=>{
  const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');const f=roleFixture();
  try {
    const fixture=f.fixtures.get('accept'),source=fixture.environment.instances[0].workspace;
    writeFileSync(join(source,'package.json'),'{"name":"cancel-fixture","version":"1.0.0"}');
    writeFileSync(join(source,'package-lock.json'),'{"name":"cancel-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"cancel-fixture","version":"1.0.0"}}}');
    fixture.flags.delay=10000;f.configuration.profiles.find(p=>p.id==='accept').backend.egress.node=true;
    const records=[],host=core.createProtectedRoleHost({...f.options,retain:async record=>{records.push(record);return 'custody:cancel-'+records.length;}});
    const p=await host.prepareRole({role:'accept',skill:'accept',instructions:core.selectInstructions({role:'accept',skill:'accept'}),task:{candidate:'current'}});
    await p.lifecycle.start(p.input);const prepared=await p.prepareNode();assert.equal(prepared.status,'prepared');
    const controller=new AbortController();
    const command=prepared.command({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:10000},{signal:controller.signal});
    setTimeout(()=>controller.abort(),100);assert.equal((await command).status,'cancelled');
    assert(fixture.calls.some(c=>c.args[2]==='stop'));assert.equal(records.at(-1).record.status,'cancelled');
    await finish(p);assert.equal((await p.lifecycle.cleanup()).status,'completed');
  }finally{await f.close();}
});


test('missing kernel supervisor prerequisite blocks each maintained adapter before role launch',async()=>{
  for(const agent of ['codex','claude','gemini']) {
    const f=codexFixture('accept',undefined,agent);
    try {
      f.flags.verificationSupervisor=false;
      assert.equal((await f.life.start(f.input)).readiness.status,'unavailable');
      assert.equal(f.backend.diagnostic(),'verification-supervisor-unavailable');
      assert.equal([...f.containers.values()].some(c=>!c.probe),false);
    }finally{await f.dispose();}
  }
});


const selectedCredentialForms = () => {
  const secret='LOGIN-SENTINEL';
  return [secret,Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('hex'),
    [...secret].map(c=>'%'+c.charCodeAt(0).toString(16)).join(''),
    [...secret].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')];
};
function nodeManifest(source) {
  const {name,version}={name:'credential-boundary-fixture',version:'1.0.0'};
  writeFileSync(join(source,'package.json'),JSON.stringify({name,version}));
  writeFileSync(join(source,'package-lock.json'),JSON.stringify({name,version,lockfileVersion:3,packages:{'':{name,version}}}));
}
for(const agent of ['codex','claude','gemini']) {
  test(`WSL ${agent} rejects a credential-bearing host custody reference before returning evidence`,async()=>{
    const f=wslFixture('accept',agent,{deadlineAt:Date.now()+360000,reserveMs:30000,egress:{image:'sha256:'+'1'.repeat(64),node:true}});
    try {
      nodeManifest(f.environment.instances[0].workspace);f.flags.delay=10000;
      assert.equal((await f.life.start(f.input)).start.status,'started');
      let retained=0;
      await assert.rejects(f.backend.prepareNode(f.input.execution.id,{},async()=>{
        retained++;return 'custody:LOGIN-SENTINEL';
      }),/verification-unresolved/);
      assert.equal(retained,1);
      assert.equal((await f.life.cleanup()).status,'unresolved');
    }finally{await f.dispose();}
  });
  test(`protected ${agent} verification rejects selected credentials in arguments and environment before Docker execution or custody`,async()=>{
    const f=roleFixture(agent);
    try {
      const fixture=f.fixtures.get('accept');nodeManifest(fixture.environment.instances[0].workspace);
      fixture.flags.delay=10000;f.configuration.profiles.find(p=>p.id==='accept').backend.egress.node=true;
      const records=[],host=core.createProtectedRoleHost({...f.options,retain:async r=>{records.push(r);return 'custody:filtered-'+records.length;}});
      const p=await host.prepareRole({role:'accept',skill:'accept',instructions:core.selectInstructions({role:'accept',skill:'accept'}),task:{candidate:'current'}});
      await p.lifecycle.start(p.input);const prepared=await p.prepareNode();assert.equal(prepared.status,'prepared');
      const executions=()=>fixture.calls.filter(c=>c.args[2]==='exec'&&c.args.includes('/verification-runner.mjs')).length, before=executions();
      for(const encoded of selectedCredentialForms()) {
        await assert.rejects(prepared.command({file:process.execPath,args:['-e','process.exit(0)',encoded],timeoutMs:1000}),/^Error: verification:credential-input$/);
        await assert.rejects(p.lane.command({file:process.execPath,args:['-e','process.exit(0)'],cwd:prepared.cwd,
          env:{PATH:'/usr/local/bin:/usr/bin:/bin',VALUE:encoded},timeoutMs:1000,inputs:{fixture:'a'.repeat(64)}}),/^Error: verification:credential-input$/);
      }
      assert.equal(executions(),before);assert.equal(records.length,1);
      const receipt=await prepared.command({file:process.execPath,args:['-e','console.log("safe")'],timeoutMs:1000});
      assert.equal(receipt.status,'passed');assert.equal(records.length,2);
      assert(!JSON.stringify({records,receipt}).includes('LOGIN-SENTINEL'));
      const login=join(fixture.environment.loginSpace,agent==='codex'?'auth.json':agent==='claude'?'anthropic-api-key.json':'gemini-api-key.json');
      const loginBytes=readFileSync(login);writeFileSync(login,'LOGIN-SENTINEL invalid JSON');
      await assert.rejects(prepared.command({file:process.execPath,args:['-e','process.exit(0)'],timeoutMs:1000}),
        /^TypeError: codex:verification-credentials-unavailable$/);
      assert.equal(executions(),before+1);assert.equal(records.length,2);
      writeFileSync(login,loginBytes);
      await p.lifecycle.stop(p.input.execution.id);await finish(p);assert.equal((await p.lifecycle.cleanup()).status,'completed');
    }finally{await f.close();}
  });
  test(`WSL ${agent} guest rejects selected credential inputs before child execution and host retention`,async()=>{
    // A rejected RPC deliberately fails the host session closed. Each negative
    // case therefore owns a fresh session rather than reusing uncertain state.
    for(const [n,encoded] of selectedCredentialForms().entries()) {
      const f=wslFixture('accept',agent,{deadlineAt:Date.now()+360000,reserveMs:30000,egress:{image:'sha256:'+'1'.repeat(64),node:true}});
      try {
        nodeManifest(f.environment.instances[0].workspace);f.flags.delay=10000;
        assert.equal((await f.life.start(f.input)).start.status,'started');const records=[];
        const retain=async r=>{records.push(r);return 'custody:wsl-filtered-'+records.length;};
        const prepared=await f.backend.prepareNode(f.input.execution.id,{},retain);assert.equal(prepared.status,'prepared');
        const before=f.calls.filter(c=>c.args[2]==='exec').length;
        const rejected=n%2===0?prepared.command({file:process.execPath,args:['-e','process.exit(0)',encoded],timeoutMs:1000}):
          f.backend.verificationCommand(f.input.execution.id,{file:process.execPath,args:['-e','process.exit(0)'],cwd:prepared.cwd,
            env:{PATH:'/usr/local/bin:/usr/bin:/bin',VALUE:encoded},timeoutMs:1000,inputs:{fixture:'a'.repeat(64)}},retain);
        await assert.rejects(rejected,/verification-unresolved/);
        assert.equal(f.calls.filter(c=>c.args[2]==='exec').length,before);
        assert.equal(records.length,1);assert(!JSON.stringify(records).includes('LOGIN-SENTINEL'));
      }finally{await f.dispose();}
    }
  });
}

test('Agent CLI and Core verification share the same lane and CLI evidence reaches custody before cleanup',async()=>{
 const {runVerification,verificationBudget}=await import(new URL('verification-runner.mjs',import.meta.resolve('@nibfin/core')));
 const {existsSync}=await import('node:fs');const f=roleFixture();
 try {
  const selected=f.fixtures.get('accept');nodeManifest(selected.environment.instances[0].workspace);selected.flags.delay=10000;
  f.configuration.profiles.find(p=>p.id==='accept').backend.egress.node=true;
  const records=[];let allowRetention=true;
  const host=core.createProtectedRoleHost({...f.options,retain:async payload=>{
   if(payload.record.schemaVersion===1&&!allowRetention)throw Error('retention unavailable');records.push(payload);return 'custody:shared-'+records.length;
  }});
  const p=await host.prepareRole({role:'accept',skill:'accept',instructions:core.selectInstructions({role:'accept',skill:'accept'}),task:{candidate:'current'}});
  await p.lifecycle.start(p.input);const prepared=await p.prepareNode();assert.equal(prepared.status,'prepared');
  const directory=join(selected.environment.instances[0].service,'verification','commands'),marker=join(prepared.cwd,'cli-started');
  const command=runVerification(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>console.log('cli-proof'),400)`],
   {directory,budget:{...verificationBudget(10000),execution:p.input.execution.id},cwd:prepared.cwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin'},stdout:null,stderr:null});
  for(let n=0;n<200&&!existsSync(marker);n++)await new Promise(r=>setTimeout(r,5));assert(existsSync(marker));
  const busy=await prepared.command({file:process.execPath,args:['-e','console.log("must not overlap")'],timeoutMs:1000});
  assert.equal(busy.status,'busy');assert.equal((await command).status,'passed');
  const after=await prepared.command({file:process.execPath,args:['-e','console.log("sequential-proof")'],timeoutMs:1000});assert.equal(after.status,'passed');
  await p.lifecycle.stop(p.input.execution.id);await finish(p);
  allowRetention=false;assert.equal((await p.lifecycle.cleanup()).status,'unresolved');assert(existsSync(directory),'failed retention preserves evidence');
  allowRetention=true;assert.equal((await p.lifecycle.cleanup()).status,'completed');
  assert(records.some(r=>r.record.schemaVersion===1&&r.log.includes('cli-proof')));
  assert(records.filter(r=>r.record.schemaVersion===1).every(r=>r.record.execution===p.input.execution.id&&r.record.logDigest));
 }finally{await f.close();}
});
