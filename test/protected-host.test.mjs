import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,cp,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import * as core from '../src/index.mjs';
import {configure,validateHostOptions,hostModes} from '../host/entry.mjs';
import {workflowFixture} from '../tooling/workflow-fixture.mjs';
import {relayFixture} from '../tooling/relay-fixture.mjs';
import {registrationFixture,registrationSentinel} from '../tooling/registration-fixture.mjs';
import {rescueFixture} from '../tooling/rescue-fixture.mjs';
import {completionFixture} from '../tooling/completion-fixture.mjs';

const producer=dirname(dirname(fileURLToPath(import.meta.resolve('../src/index.mjs'))));
const digest=v=>createHash('sha256').update(v).digest('hex');
const sentinel='SECRET-SENTINEL-DO-NOT-DISCLOSE';
const options=(context,mode,groupId)=>({version:1,repository:context.repository,repositoryId:context.repositoryId,
  environment:['execute','compute'].includes(mode)?'nibfin-member':'nibfin-hosted',...(groupId?{groupId}:{})});
function compose(mode,context,capabilities,groupId) {
  const permitted=Object.fromEntries([...hostModes[mode],...(groupId?['group']:[])].map(k=>[k,capabilities[k]]));
  return core.createWorkflowEntry(configure({core,mode,context,deployment:{options:options(context,mode,groupId),capabilities:permitted}}));
}
async function delivery(mode='resolve') {
  const f=await workflowFixture();
  const entry=compose(mode,f.context,f.host);
  return {...f,entry,invoke:input=>entry.invoke(mode,input??f.input,f.context)};
}

// Every mode constructs using real existing owners; no host fixture is the object under test.
test('maintained entry is inert, strictly mode-bound and lookup correlates public deployments',async()=>{
  assert(!String(configure).includes('process.env'));
  for(const mode of Object.keys(hostModes)) {
    let effects=0;
    const context={repository:'example/public',repositoryId:'42',run:{id:'100',attempt:'1'}};
    const caps=Object.fromEntries(hostModes[mode].map(k=>[k,()=>{effects++;throw Error(sentinel);} ]));
    const host=configure({core,mode,context,deployment:{options:options(context,mode),capabilities:caps}});
    const entry=core.createWorkflowEntry(host);assert.equal(effects,0);
    const bad=await entry.invoke('lookup',{nibfin_request:'request',nibfin_correlation:'correlation'},context);
    assert.equal(bad.status,'blocked');assert(!JSON.stringify(bad).includes(sentinel));
    assert.equal(effects,mode==='lookup'?1:0);
  }
  for(const ownership of ['personal','organization']) {
    const f=await workflowFixture();f.identity.ownership=ownership;
    const entry=compose('lookup',f.context,f.host);
    assert.deepEqual(await entry.invoke('lookup',f.inputWithoutIssue??{
      nibfin_request:f.input.nibfin_request,nibfin_correlation:f.input.nibfin_correlation},f.context),{status:'resolved',issue:f.input.issue});
    const out=await entry.invoke('lookup',{nibfin_request:'unknown',nibfin_correlation:sentinel},f.context);
    assert.equal(out.status,'blocked');assert(!JSON.stringify(out).includes(sentinel));
  }
});

test('maintained resolve and compute/execute preserve retained routing and actual Core decisions',async()=>{
  const f=await delivery(),resolved=await f.invoke();assert.equal(resolved.status,'selected');
  const compute=compose('compute',f.context,f.host);
  const result=await compute.invoke('compute',{...f.input,resolution:resolved.resolution},f.context);
  assert.equal(result.status,'completed');assert.equal(f.sh.records.length,1);
  assert.equal(f.records.at(-1).kind,'stage-result');assert.equal(f.records.at(-1).value.executed,'shape');
  assert.notEqual((await compute.invoke('compute',{...f.input,resolution:resolved.resolution},f.context)).status,'completed');
  // A writer mode cannot run a compute decision, even with a real retained resolution.
  const g=await delivery(),r=await g.invoke(),execute=compose('execute',g.context,g.host);
  assert.equal((await execute.invoke('execute',{...g.input,resolution:r.resolution},g.context)).status,'blocked');
  assert.equal(g.sh.records.length,0);
});

test('maintained execute invokes the real publication owner with independent predecessor evidence',async()=>{
  const f=await workflowFixture();
  const authored=(await f.core.run(await f.queued())).owner.output,receipt=authored.author.receipt;
  f.pin.shapeBody=authored.author.body;f.pin.binding.shapeHash=core.bodyDigest(f.pin.shapeBody);
  f.pin.receipts.shape=receipt;f.pin.evidenceCurrent.shape={expected:structuredClone(receipt),consumed:[]};
  f.pin.stageInput=authored;f.pin.invocation={request:'validator',run:{id:'101',attempt:'1'}};
  const validated=(await f.core.run(await f.queued())).owner.output,vr=validated.validator.receipt;
  f.pin.receipts['shape-validator']=vr;f.pin.evidenceCurrent['shape-validator']={expected:structuredClone(vr),consumed:[]};
  f.pin.stageInput=validated;f.pin.invocation={request:'publication',run:{id:'102',attempt:'1'}};
  f.input.nibfin_request='publication';f.identity.run=f.pin.invocation.run;f.context.run=f.pin.invocation.run;
  Object.assign(f.queuedRequest,await f.queued());
  const resolution=await compose('resolve',f.context,f.host).invoke('resolve',f.input,f.context);
  assert.equal(resolution.execution_mode,'execute');assert.equal(f.sh.writes().length,0);
  const result=await compose('execute',f.context,f.host).invoke('execute',{...f.input,resolution:resolution.resolution},f.context);
  assert.equal(result.status,'completed');assert.equal(f.sh.writes().length,2);
  assert.equal(f.records.at(-1).value.executed,'publication');
});

test('denied source/private targets, unavailable custody and attempted-result uncertainty fail closed',async()=>{
  for(const change of [f=>f.state.source=false,f=>f.identity.visibility='private',f=>f.state.denied=true,
    f=>{f.host.retain=async()=>{throw Error(sentinel);};}]) {
    const f=await workflowFixture();change(f);const entry=compose('resolve',f.context,f.host);
    const out=await entry.invoke('resolve',f.input,f.context);assert.equal(out.status,'blocked');
    assert(!JSON.stringify(out).includes(sentinel));assert.equal(f.sh.records.length,0);
  }
  const f=await delivery(),r=await f.invoke(),retain=f.host.retain;
  f.host.retain=async value=>{if(value.kind==='stage-result')throw Error(sentinel);return retain(value);};
  const compute=compose('compute',f.context,f.host);
  assert.deepEqual(await compute.invoke('compute',{...f.input,resolution:r.resolution},f.context),
    {status:'unresolved',request:f.input.nibfin_request,reason:'result-reconciliation-required'});
  assert.equal(f.sh.records.length,1);
  assert.notEqual((await compute.invoke('compute',{...f.input,resolution:r.resolution},f.context)).status,'completed');
  assert.equal(f.sh.records.length,1);
});

test('group capability is required only for approved group routing and verifies access',async()=>{
  const f=await workflowFixture(),i=f.pin.selectionInput,org='/orgs/example-org';
  i.registration={level:'organization',id:'7',organization:'example-org'};i.conditions.groupId='7';
  i.records.forEach(r=>r.registration=i.registration);
  f.sf.routes[org]={id:'7',login:'example-org',type:'Organization'};
  const runners=f.sf.routes[f.sf.prefix+'/actions/runners?per_page=100'];
  f.sf.routes[org+'/actions/runners?per_page=100']=runners;
  f.sf.routes[org+'/actions/runner-groups?per_page=100']={total_count:1,runner_groups:[{
    id:'7',name:'Verified group',visibility:'all',allows_public_repositories:true,restricted_to_workflows:false,selected_workflows:[]}]};
  f.sf.routes[org+'/actions/runner-groups/7/runners?per_page=100']=runners;
  Object.assign(f.queuedRequest,await f.queued());
  const denied=compose('resolve',f.context,f.host);assert.equal((await denied.invoke('resolve',f.input,f.context)).status,'blocked');
  const entry=compose('resolve',f.context,f.host,'7'),out=await entry.invoke('resolve',f.input,f.context);
  assert.equal(out.status,'selected');assert.equal(JSON.parse(out.runs_on).group,'Verified group');
  const capabilities=Object.fromEntries(hostModes.resolve.map(k=>[k,f.host[k]]));
  assert.throws(()=>configure({core,mode:'resolve',context:f.context,deployment:{options:options(f.context,'resolve','7'),capabilities}}));
  f.host.group=async()=>({id:'7',name:'Unverified',repositoryId:f.identity.repositoryId,allowed:false});
  assert.equal((await compose('resolve',f.context,f.host,'7').invoke('resolve',f.input,f.context)).status,'blocked');
});

test('maintained wake uses relay with authenticated source and no duplicate dispatch',async()=>{
  const f=await relayFixture(),context={repository:'example-org/core',repositoryId:'42',run:{id:'100',attempt:'1'}};
  const entry=compose('wake',context,{authenticate:async()=>({...context,visibility:'public',ownership:'organization'}),relay:async()=>f.configuration()});
  assert.equal((await entry.invoke('wake',{event:f.native},context)).status,'run-observed');
  assert.equal((await entry.invoke('wake',{event:f.dispatch},context)).status,'run-observed');assert.equal(f.writes().length,1);
});

test('maintained registration retains intent/result; unknown issuance never reissues',async()=>{
  const f=registrationFixture(),context={repository:f.s.repository,repositoryId:f.s.repositoryId,run:{id:f.s.runId,attempt:f.s.attempt}};
  const input={nibfin_registration:f.s.requestId,public_key:f.s.publicKey,level:'repository'},records=[];
  let prior='new';
  const caps={authenticate:async()=>({...context,visibility:'public',ownership:'personal'}),
    registration:async()=>({config:{authenticate:async()=>f.s,policy:async()=>f.p,transport:f.transport,channel:f.channel,now:()=>f.state.now},handle:'opaque',prior}),
    retain:async r=>{records.push(r);prior='unresolved';return 'retained-response';}};
  const entry=compose('registration',context,caps),out=await entry.invoke('registration',input,context);
  assert.equal(out.status,'delivered');assert.equal(f.posts(),1);
  assert.deepEqual(records.map(r=>r.kind),['registration-intent','registration-result']);
  assert(!JSON.stringify(out).includes(registrationSentinel));
  assert.equal((await entry.invoke('registration',input,context)).status,'unknown');assert.equal(f.posts(),1);
  prior='resolved';assert.equal((await entry.invoke('registration',input,context)).status,'retained');assert.equal(f.posts(),1);
  prior='wrong';assert.equal((await entry.invoke('registration',input,context)).status,'blocked');assert.equal(f.posts(),1);
});

// Interpret the published JSON Schema vocabulary independently of runtime fields.
function conforms(schema,value,root=schema) {
  if(schema.if){const branch=conforms(schema.if,value,root)?schema.then:schema.else;if(branch&&!conforms(branch,value,root))return false;}
  if(schema.$ref) return conforms(schema.$ref==='#'?root:schema.$ref.slice(2).split('/').reduce((v,k)=>v[k],root),value,root);
  if(schema.allOf && !schema.allOf.every(s=>conforms(s,value,root)))return false;
  if(schema.anyOf && !schema.anyOf.some(s=>conforms(s,value,root)))return false;
  if(schema.not && conforms(schema.not,value,root))return false;
  if('const' in schema && schema.const!==value)return false;
  if(schema.enum && !schema.enum.includes(value))return false;
  if(schema.type && (schema.type==='object'?(!value||typeof value!=='object'||Array.isArray(value)):typeof value!==schema.type))return false;
  if(schema.pattern && typeof value==='string' && !new RegExp(schema.pattern).test(value))return false;
  if(value && typeof value==='object' && !Array.isArray(value)) {
    if(schema.minProperties && Object.keys(value).length<schema.minProperties)return false;
    if(schema.required && !schema.required.every(k=>Object.hasOwn(value,k)))return false;
    if(schema.additionalProperties===false && Object.keys(value).some(k=>!Object.hasOwn(schema.properties??{},k)))return false;
    for(const [k,v] of Object.entries(value))if(schema.properties?.[k] && !conforms(schema.properties[k],v,root))return false;
  }
  return true;
}

test('schema/runtime agree on strict fields, types, modes and group applicability before effects',async()=>{
  const schema=JSON.parse(await readFile(join(producer,'host/configuration.schema.json')));
  const context={repository:'example/public',repositoryId:'42',run:{id:'100',attempt:'1'}};
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(Object.keys(schema.$defs).filter(k=>k!=='environment'),Object.keys(hostModes));
  assert.deepEqual(schema.required,['version','repository','repositoryId','environment']);
  assert(conforms(schema.$defs.environment,{lookup:options(context,'lookup'),wake:options(context,'wake')},schema));
  assert(!conforms(schema.$defs.environment,{lookup:options(context,'lookup'),compute:options(context,'compute')},schema));
  let calls=0;const base=()=>({options:options(context,'lookup'),capabilities:{authenticate:()=>{calls++;},lookup:()=>{calls++;}}});
  for(const mutate of [d=>delete d.capabilities.lookup,d=>d.capabilities.management=()=>{},d=>d.capabilities.lookup='wrong',
    d=>d.options.secret=sentinel,d=>d.options.version='1',d=>d.options.repositoryId='01',d=>d.options.environment='nibfin-member',
    d=>d.options.repository='EXAMPLE/public',d=>d.options.repository='bad--owner/repo',d=>d.options.repository='example/..',
    d=>d.options.groupId='7',d=>Object.defineProperty(d.capabilities,'lookup',{get(){calls++;throw Error(sentinel);},enumerable:true})]) {
    const deployment=base();mutate(deployment);
    assert.throws(()=>configure({core,mode:'lookup',context,deployment}),{message:'protected-host:configuration'});
  }
  assert.throws(()=>configure({core,mode:'merge',context,deployment:base()}));assert.equal(calls,0);
  for(const mode of Object.keys(hostModes)) {
    assert.doesNotThrow(()=>validateHostOptions(options(context,mode),mode));
    assert(conforms(schema.$defs[mode],options(context,mode),schema));
    const changes=[v=>delete v.version,v=>v.version='1',v=>v.repositoryId='01',v=>v.repository='a--b/repo',
      v=>v.repository='owner/..',v=>v.extra=true,v=>v.environment='other',v=>v.groupId=7,v=>v.repository=null];
    if(!['resolve','execute','compute'].includes(mode))changes.push(v=>v.groupId='7');
    for(const mutate of changes){const changed=options(context,mode);mutate(changed);
      assert.equal(conforms(schema.$defs[mode],changed,schema),false);
      assert.throws(()=>validateHostOptions(changed,mode));}

    const routed={...options(context,mode),authentication:'actions-oidc',routing:'authenticated'};
    if(['resolve','execute','compute'].includes(mode)) {
      assert.doesNotThrow(()=>validateHostOptions(options(context,mode,'7'),mode));
      assert.doesNotThrow(()=>validateHostOptions(routed,mode));assert(conforms(schema.$defs[mode],routed,schema));
      delete routed.authentication;
    }
    assert(!conforms(schema.$defs[mode],routed,schema));assert.throws(()=>validateHostOptions(routed,mode));
    for(const [key,s] of Object.entries(schema.properties)) {
      const value=options(context,mode)[key];
      if(value!==undefined && s.pattern)assert.match(value,new RegExp(s.pattern));
    }
  }
});

test('member construction projects public context and exposes no management/agent/hook/subprocess input',async()=>{
  const f=await workflowFixture(),r=await f.resolve(),seen=[];
  const context={...f.context,managementToken:sentinel,env:{NIBFIN_HOST_TOKEN:sentinel},agent:{secret:sentinel},hooks:{secret:sentinel},subprocess:{secret:sentinel}};
  const caps=Object.fromEntries(hostModes.compute.map(name=>[name,async args=>{seen.push(args);return f.host[name](args);} ]));
  const entry=compose('compute',context,caps);
  assert.equal(seen.length,0);assert.equal((await entry.invoke('compute',{...f.input,resolution:r.resolution},context)).status,'completed');
  assert(seen.length>0);assert(!JSON.stringify(seen,(_,v)=>typeof v==='function'?undefined:v).includes(sentinel));
  const deployment={options:options(context,'compute'),capabilities:{...caps,management:()=>sentinel}};
  assert.throws(()=>configure({core,mode:'compute',context,deployment}));
});

async function sourceFixture() {
  const root=await mkdtemp(join(tmpdir(),'nibfin-host-source-')),bundle=join(root,'nibfin-bundle'),host=join(root,'nibfin-host');
  await mkdir(bundle);await mkdir(host);
  const manifest=JSON.parse(await readFile(join(producer,'package.json')));
  const paths=['package.json','package-lock.json','README.md',...manifest.files];
  for(const path of paths) {
    await mkdir(dirname(join(bundle,path)),{recursive:true});
    if(path==='package-lock.json') {
      // npm does not distribute the root lock; the installed-consumer harness
      // supplies the exact producer lock as a test input for synthetic checkouts.
      const lock=await readFile(join(producer,path)).catch(()=>readFile(join(process.cwd(),'core-lock-fixture.json')));
      await writeFile(join(bundle,path),lock);
    } else await cp(join(producer,path),join(bundle,path));
  }
  for(const path of core.protectedHostFiles) {await mkdir(dirname(join(host,path)),{recursive:true});await cp(join(producer,path),join(host,path));}
  const approval=async (where,paths,commit)=>({repository:'taco3064/nibfin',commit,
    files:await Promise.all(paths.map(async path=>({path,sha256:digest(await readFile(join(where,path)))})))});
  const b=await approval(bundle,paths,'a'.repeat(40)),h=await approval(host,core.protectedHostFiles,'b'.repeat(40));
  return {root,bundle,host,args:{bundle:{root:bundle,allowedRoot:bundle,repository:b.repository,commit:b.commit,approval:b},
    host:{root:host,allowedRoot:host,repository:h.repository,commit:h.commit,approval:h}}};
}

test('approved checkout distinct bundle/host source loads; syntactic pins, source drift and unsafe roots fail before evaluation',async()=>{
  const f=await sourceFixture();
  try {
    assert.equal(typeof (await core.loadProtectedHost(f.args)).configure,'function');
    for(const role of ['bundle','host'])for(const pin of ['main','v1','latest','a'.repeat(39),'A'.repeat(40),'c'.repeat(40)]) {
      const args=structuredClone(f.args);args[role].commit=pin;await assert.rejects(core.loadProtectedHost(args));
    }
    for(const role of ['bundle','host']) {
      const args=structuredClone(f.args);args[role].repository='evil/host';await assert.rejects(core.loadProtectedHost(args));
      const swapped=structuredClone(f.args);swapped[role].approval=f.args[role==='host'?'bundle':'host'].approval;
      await assert.rejects(core.loadProtectedHost(swapped));
    }
    const marker=join(f.root,'evaluated');
    await writeFile(join(f.host,'host/entry.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');export const configure=()=>({});`);
    await assert.rejects(core.loadProtectedHost(f.args));await assert.rejects(readFile(marker));
    await cp(join(producer,'host/entry.mjs'),join(f.host,'host/entry.mjs'));
    for(const path of ['../escape.mjs','/entry.mjs','host/../entry.mjs','host\\entry.mjs']) {
      const args=structuredClone(f.args);args.host.approval.files[0].path=path;await assert.rejects(core.loadProtectedHost(args));
    }
    for(const entry of ['entry.mjs','../escape.mjs','/tmp/escape.mjs']) {
      const args=structuredClone(f.args);args.host.entry=entry;await assert.rejects(core.loadProtectedHost(args));
    }
    const args=structuredClone(f.args);args.host.root=join(f.host,'host');await assert.rejects(core.loadProtectedHost(args));
    await rm(join(f.host,'host/entry.mjs'));await symlink(join(producer,'host/entry.mjs'),join(f.host,'host/entry.mjs'));
    await assert.rejects(core.loadProtectedHost(f.args));
    await rm(join(f.host,'host/entry.mjs'));await cp(join(producer,'host/entry.mjs'),join(f.host,'host/entry.mjs'));
    const linked=join(f.root,'linked');await symlink(f.host,linked);
    await assert.rejects(core.loadProtectedHost({...f.args,host:{...f.args.host,root:linked,allowedRoot:linked}}));
    // Required non-executable configuration bytes are independently covered too.
    await writeFile(join(f.host,'host/configuration.schema.json'),'{}');await assert.rejects(core.loadProtectedHost(f.args));
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('approved checkout workflow CLI loads the maintained host and protected bindings end to end',async()=>{
  const f=await sourceFixture();
  try {
    // Use the already locked test runtime; no install/network/credential occurs here.
    await mkdir(join(f.bundle,'node_modules'));
    await cp(dirname(dirname(dirname(fileURLToPath(import.meta.resolve('jose'))))),join(f.bundle,'node_modules/jose'),{recursive:true});
    const {workflowMain}=await import(pathToFileURL(join(f.bundle,'src/workflow-entry.mjs')));
    const source=`export const capabilities={lookup:{
      authenticate:async ({context})=>({...context,visibility:'public',ownership:'organization'}),
      lookup:async ({identity,input})=>{if(input.nibfin_correlation!=='correlation')throw Error('SECRET');return {repository:identity.repository,repositoryId:identity.repositoryId,number:'101'};}
    }};`;
    const text=JSON.stringify({lookup:{version:1,repository:'example/public',repositoryId:'42',environment:'nibfin-hosted'}});
    const env={GITHUB_WORKSPACE:f.root,GITHUB_EVENT_PATH:join(f.root,'event.json'),GITHUB_OUTPUT:join(f.root,'output'),
      GITHUB_REPOSITORY:'example/public',GITHUB_REPOSITORY_ID:'42',GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
      NIBFIN_BUNDLE_COMMIT:f.args.bundle.commit,NIBFIN_HOST_COMMIT:f.args.host.commit,
      NIBFIN_HOST_REPOSITORY:'taco3064/nibfin',NIBFIN_HOST_ROOT:f.host,NIBFIN_MODE:'lookup',
      NIBFIN_INPUT:JSON.stringify({nibfin_request:'request',nibfin_correlation:'correlation'}),
      NIBFIN_HOST_OPTIONS:text,NIBFIN_HOST_CAPABILITY_SOURCE:source,
      NIBFIN_SOURCE_APPROVALS:JSON.stringify({bundle:f.args.bundle.approval,host:f.args.host.approval,
        deployment:{sourceSha256:digest(source),optionsSha256:digest(text)}})};
    await writeFile(env.GITHUB_EVENT_PATH,'{}');assert.equal(await workflowMain(env),0);
    assert.equal(await readFile(env.GITHUB_OUTPUT,'utf8'),'status=resolved\nissue=101\n');
    env.NIBFIN_HOST_CAPABILITY_SOURCE+='throw Error("must not evaluate");';
    env.GITHUB_OUTPUT=join(f.root,'blocked');assert.equal(await workflowMain(env),1);
    assert.equal(await readFile(env.GITHUB_OUTPUT,'utf8'),'status=blocked\nselected=false\nreason=host-configuration-unavailable\n');
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('approved-source Rescue CLI never exits green for a neutral Check; only independent current completion succeeds',async()=>{
  for(const resolved of [false,true]) {
    const f=await sourceFixture();
    try {
      await mkdir(join(f.bundle,'node_modules'));
      await cp(dirname(dirname(dirname(fileURLToPath(import.meta.resolve('jose'))))),join(f.bundle,'node_modules/jose'),{recursive:true});
      const {workflowMain}=await import(pathToFileURL(join(f.bundle,'src/workflow-entry.mjs')));
      const recovery=rescueFixture();
      if(resolved) {
        const completed=await completionFixture();await completed.fresh().close();const {receipt}=await completed.fresh().complete();
        const binding=receipt.payload.receipts.publication.binding;
        Object.assign(recovery.target,{scopeHash:binding.scopeHash,shapeHash:binding.shapeHash});
        recovery.blocked.target=structuredClone(recovery.target);recovery.setState({...recovery.state(),target:structuredClone(recovery.target)});
        recovery.flags.final={receipt,expected:Object.fromEntries(Object.entries(receipt.payload.receipts).map(([s,r])=>[s,{expected:r,consumed:[]}])),
          cycle:recovery.target.cycle,caseId:null,continuation:null};
      }
      const id=await recovery.register(),identity={repository:recovery.policy.repository,repositoryId:'42',run:{id:'500',attempt:'1'},visibility:'public',ownership:'organization'};
      let reported=0;
      const deployment={options:options(identity,'rescue'),capabilities:{authenticate:async()=>identity,rescue:async()=>({...recovery.options,
        reporting:{capability:{runId:'500',scope:'reporting-run',neutralCheck:true},report:async()=>{reported++;return {confirmed:true};}}})}};
      const env={GITHUB_WORKSPACE:f.root,GITHUB_EVENT_PATH:join(f.root,'event.json'),GITHUB_OUTPUT:join(f.root,'output'),
        GITHUB_REPOSITORY:identity.repository,GITHUB_REPOSITORY_ID:'42',GITHUB_RUN_ID:'500',GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_NAME:'workflow_dispatch',
        NIBFIN_BUNDLE_COMMIT:f.args.bundle.commit,NIBFIN_HOST_COMMIT:f.args.host.commit,NIBFIN_HOST_REPOSITORY:'taco3064/nibfin',NIBFIN_HOST_ROOT:f.host,
        NIBFIN_MODE:'rescue',NIBFIN_INPUT:JSON.stringify({request_id:id,source_run_id:'100',source_attempt:'1',nibfin_issue:'101',nibfin_correlation:'test-rescue',mode:resolved?'verify':'repair'}),
        NIBFIN_SOURCE_APPROVALS:JSON.stringify({bundle:f.args.bundle.approval,host:f.args.host.approval})};
      await writeFile(env.GITHUB_EVENT_PATH,'{}');assert.equal(await workflowMain(env,{deployment}),resolved?0:1);
      const output=await readFile(env.GITHUB_OUTPUT,'utf8');
      assert.match(output,resolved?/outcome=RESOLVED\nconclusion=success/:/outcome=PENDING_VERIFICATION\nconclusion=neutral\nreason=reporting-unsupported/);
      assert.equal(reported,resolved?1:0);assert.equal(recovery.flags.repairs,resolved?0:1);
    } finally {await rm(f.root,{recursive:true,force:true});}
  }
});

test('approved protected binding bytes/options load without calling a capability; mismatch never evaluates',async()=>{
  const context={repository:'example/public',repositoryId:'42',run:{id:'100',attempt:'1'}};
  const source='export const capabilities={lookup:{authenticate:async()=>{throw Error("secret");},lookup:async()=>{throw Error("secret");}}};';
  const text=JSON.stringify({lookup:options(context,'lookup')});
  const args={source,options:text,approval:{sourceSha256:digest(source),optionsSha256:digest(text)},validate:validateHostOptions,mode:'lookup'};
  const d=await core.loadProtectedDeployment(args);assert.equal(typeof d.capabilities.lookup,'function');
  const multiSource='export const capabilities={lookup:{authenticate:async()=>{},lookup:async()=>{}},wake:{authenticate:async()=>{},relay:async()=>{}}};';
  const multiOptions=JSON.stringify({lookup:options(context,'lookup'),wake:options(context,'wake')});
  const multi={...args,source:multiSource,options:multiOptions,approval:{sourceSha256:digest(multiSource),optionsSha256:digest(multiOptions)}};
  for(const mode of ['lookup','wake']) {
    const deployment=await core.loadProtectedDeployment({...multi,mode});
    assert.doesNotThrow(()=>configure({core,mode,context,deployment}));
  }
  const crossed=JSON.stringify({lookup:options(context,'lookup'),compute:options(context,'compute')});
  await assert.rejects(core.loadProtectedDeployment({...multi,options:crossed,approval:{...multi.approval,optionsSha256:digest(crossed)}}));

  assert.doesNotThrow(()=>configure({core,context,mode:'lookup',deployment:d}));
  for(const changed of [{source:source+'throw Error("must not evaluate");'},{options:text+' '},
    {approval:{sourceSha256:'a'.repeat(64),optionsSha256:digest(text)}}])await assert.rejects(core.loadProtectedDeployment({...args,...changed}));
  const malicious='globalThis.__nibfinUntrustedEvaluated=true;'+source;
  delete globalThis.__nibfinUntrustedEvaluated;
  await assert.rejects(core.loadProtectedDeployment({...args,source:malicious}));
  assert.equal(globalThis.__nibfinUntrustedEvaluated,undefined);
  const malformed=JSON.stringify({lookup:{...options(context,'lookup'),secret:sentinel}});
  await assert.rejects(core.loadProtectedDeployment({...args,source:malicious,options:malformed,
    approval:{sourceSha256:digest(malicious),optionsSha256:digest(malformed)}}));
  assert.equal(globalThis.__nibfinUntrustedEvaluated,undefined);
});

test('deterministic installation includes all maintained host inputs and distinguishes changed pins',()=>{
  const input={commit:'a'.repeat(40),hostRepository:'taco3064/nibfin',hostCommit:'b'.repeat(40)};
  const one=core.workflowInstallation(input),two=core.workflowInstallation(input);
  assert.deepEqual(one,two);for(const path of core.protectedHostFiles)assert(one.inventory.some(i=>i.path===path));
  assert.notDeepEqual(core.workflowInstallation({...input,hostCommit:'c'.repeat(40)}),one);
});

test('approved registration and role bindings retain separate hosted/member mode boundaries',async()=>{
  const context={repository:'example/public',repositoryId:'42',run:{id:'100',attempt:'1'}};
  for(const [mode,key,foreign] of [['registration','registration','roles'],['execute','roles','registration']]) {
    const text=JSON.stringify({[mode]:options(context,mode)});
    const load=source=>core.loadProtectedDeployment({source,options:text,
      approval:{sourceSha256:digest(source),optionsSha256:digest(text)},validate:validateHostOptions,mode});
    const source=`export const capabilities={${mode}:{}};export const ${key}={${mode}:{marker:'${key}'}};`;
    const deployment=await load(source);
    assert.equal(deployment[key].marker,key);assert.equal(deployment[foreign],undefined);
    await assert.rejects(load(`export const capabilities={${mode}:{}};export const ${foreign}={${mode}:{}};`),/protected-host:configuration/);
  }
});
