import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {workflowFiles,workflowInstallation,workflowInput,workflowRoute,projectIssue,issueWakeup,
  nativeConcurrency,createWorkflowEntry,createRegistrationArtifactChannel,openRegistrationResponse,canonicalJSON} from '../src/index.mjs';
import {workflowYAML,resolveYAML,callInputs,workflowFixture} from '../tooling/workflow-fixture.mjs';
import {relayFixture} from '../tooling/relay-fixture.mjs';
import {parse} from 'yaml';
const delivery='workflow/templates/nibfin-delivery.yml', registration='workflow/templates/nibfin-registration.yml';
const ctx={github:{repository_id:'42',event:{issue:{number:101}}},inputs:{issue:'101'}};
const guard=scope=>nativeConcurrency({repository:'example/core',repositoryId:'42',scope,...(scope==='issue'?{issue:'101'}:{})});

test('shared pool installation fixes each target namespace, dispatch entry and logical concurrency in actual YAML',()=>{
  const source={version:1,repository:'example/core',repositoryId:'41',ownerId:'7',ownerType:'User'},
    targets=[source,{...source,repository:'example/cli',repositoryId:'42'},{...source,repository:'example/action',repositoryId:'43'}];
  const result=workflowInstallation({commit:'a'.repeat(40),hostRepository:'example/core',hostCommit:'b'.repeat(40),
    executionPool:{version:1,source,targets}});
  assert.equal(result.deployments.length,3);assert.equal(result.files.size,10);
  assert.equal(result.files.has('.github/workflows/nibfin-stage.yml'),false);
  const issueGuards=new Set(),writerGuards=new Set();
  for(const deployment of result.deployments){
    const stage=parse(result.files.get(deployment.stagePath)),delivery=parse(result.files.get(deployment.deliveryPath));
    assert.deepEqual(Object.keys(stage.on.workflow_dispatch.inputs),['nibfin_request','nibfin_correlation','nibfin_issue','nibfin_stage']);
    assert.equal(stage.jobs.stage.uses,'./'+deployment.deliveryPath);
    const lookup=stage.jobs.lookup.steps.at(-1);
    assert.equal(lookup.with.deployment_key,'TARGET_'+deployment.repositoryId);
    assert.equal(lookup.with.host_token,'${{ secrets.NIBFIN_HOST_TOKEN }}');
    issueGuards.add(delivery.concurrency.group);writerGuards.add(stage.jobs.lookup.concurrency.group);
    assert.equal(delivery.concurrency.group,`nibfin-v1-${deployment.repositoryId}-issue-`+'${{ inputs.issue }}');
    for(const job of Object.values(delivery.jobs)){
      assert.equal(job.steps.at(-1).with.deployment_key,deployment.key);
      if(job.concurrency)assert.equal(job.concurrency.group,stage.jobs.lookup.concurrency.group);
      if(['execute','compute'].includes(job.steps.at(-1).with.mode))assert.equal(job.steps.at(-1).with.host_token,undefined);
    }
    assert.equal(deployment.variables.options,`NIBFIN_TARGET_${deployment.repositoryId}_HOST_OPTIONS`);
    assert.equal(deployment.source.repositoryId,'41');
  }
  assert.equal(issueGuards.size,3);assert.equal(writerGuards.size,3);
  const action=workflowYAML().get('workflow/action/action.yml'),env=action.runs.steps.at(-1).env;
  for(const key of ['HOST_OPTIONS','HOST_CAPABILITY_SOURCE','SOURCE_APPROVALS']){
    assert.ok(env['NIBFIN_'+key].includes(`NIBFIN_{0}_${key}`));
    assert.ok(env['NIBFIN_'+key].includes("inputs.deployment_key == '' &&"));
    assert.ok(!env['NIBFIN_'+key].includes(`)] || vars.NIBFIN_${key}`));
  }
});

test('real YAML schemas, expressions, outputs, immutable acquisition and native guards',()=>{
  const docs=workflowYAML();assert.equal(docs.size,7);
  const installed=workflowInstallation({commit:'a'.repeat(40),hostRepository:'example/core',hostCommit:'b'.repeat(40)}).files;
  for(const [path,w] of docs) {
    if(path.includes('/action/')) continue;
    assert.deepEqual(w.permissions,{});assert(w.on);assert(!w.on.pull_request && !w.on.pull_request_target);
    if(w.concurrency)assert.deepEqual(resolveYAML(w.concurrency,ctx),guard('issue'));
    for(const [id,j] of Object.entries(w.jobs)) {
      if(j.needs)assert(w.jobs[j.needs]);
      if(j.uses){assert(!j.concurrency);assert(installed.has(j.uses.slice(2)));continue;}
      if(id!=='compute')assert.deepEqual(resolveYAML(j.concurrency,ctx),guard('repository-write'));
      else assert.equal(j.concurrency,undefined);
      const stepIds=j.steps.map(s=>s.id).filter(Boolean);
      for(const [name,out] of Object.entries(j.outputs??{})) {
        assert.match(out,/^\$\{\{ steps\.entry\.outputs\.[a-z_]+ \}\}$/);assert(stepIds.includes('entry'));
        assert(Object.hasOwn(docs.get('workflow/action/action.yml').outputs,name));
      }
      assert.deepEqual(j.permissions,id==='execute'||id==='compute'?{contents:'read','id-token':'write'}:{contents:'read',actions:'read','id-token':'write'});
      assert.equal(j.steps[0].name,'Validate immutable installation pins');
      for(const step of j.steps) {
        for(const value of Object.values(step.with??{}))assert(['string','boolean','number'].includes(typeof value),'Action inputs must be scalars');
        if(step.uses?.startsWith('actions/'))assert.match(step.uses,/@[a-f0-9]{40}$/);
        if(step.with?.repository){assert.equal(step.with['persist-credentials'],false);assert.match(step.with.ref,/vars\.NIBFIN_(BUNDLE|HOST)_COMMIT/);}
        if(step.run)assert(!step.run.includes('${{'));
      }
      const entry=j.steps.at(-1);assert.equal(entry.uses,'./nibfin-bundle/workflow/action');
      if(['execute','compute'].includes(id))assert.equal(entry.with.host_token,undefined);
    }
  }
  const d=docs.get(delivery),r=docs.get(registration),stage=docs.get('workflow/templates/nibfin-stage.yml');
  assert.equal(d.jobs.resolve['runs-on'],'ubuntu-latest');assert.equal(r.jobs.registration['runs-on'],'ubuntu-latest');
  assert.equal(r.concurrency,undefined);assert.equal(stage.concurrency,undefined);
  assert.deepEqual(Object.keys(stage.on.workflow_dispatch.inputs),['nibfin_request','nibfin_correlation','nibfin_issue','nibfin_stage']);
  assert.equal(resolveYAML(stage['run-name'],{inputs:{nibfin_correlation:'abc',nibfin_issue:'101',nibfin_stage:'accept'}}),'#101 | accept | op:abc');
  const inputs=callInputs(d,'workflow_call',{issue:'101',nibfin_request:'req',nibfin_correlation:'corr',nibfin_issue:'101',nibfin_stage:'shape'});
  assert.equal(inputs.issue,'101');assert.throws(()=>callInputs(d,'workflow_call',{...inputs,role:'merge'}));
  assert.throws(()=>callInputs(d,'workflow_call',{...inputs,issue:101}));assert.throws(()=>callInputs(d,'workflow_call',{}));
  assert.equal(callInputs(r,'workflow_call',{nibfin_registration:'req',public_key:'pem'}).level,'repository');
  assert.throws(()=>workflowInput('resolve',{...inputs,issue:'01'}));
  const installation=workflowInstallation({commit:'a'.repeat(40),hostRepository:'example/host',hostCommit:'b'.repeat(40)});
  assert.equal(installation.files.size,6);
  for(const text of installation.files.values())assert(!text.includes('vars.NIBFIN_'));
  assert(installation.files.get(delivery).includes('ref: '+ 'a'.repeat(40)));assert(installation.inventory.every(v=>/^[a-f0-9]{64}$/.test(v.sha256)));
  for(const p of workflowFiles)assert(installation.inventory.some(v=>v.path===p));
  assert.throws(()=>workflowInstallation({commit:'main',hostRepository:'example/host',hostCommit:'b'.repeat(40)}));
});

test('caller resolves real entry outputs, full AND routes, Busy retention and platform fixtures',async()=>{
  for(const platform of ['linux','windows','macos']) {
    const f=await workflowFixture();f.pin.selectionInput.conditions.platform=platform;
    f.pin.selectionInput.records.forEach(r=>r.platform=platform);
    const runners=f.sf.routes[f.sf.prefix+'/actions/runners?per_page=100'].runners;
    runners.forEach(r=>{r.os=platform;r.labels.find(l=>l.name==='linux').name=platform;});
    // Requeue on changed *trusted* platform input; no old request is reused.
    Object.assign(f.queuedRequest,await f.queued());const out=await f.resolve();assert.equal(out.selected,'true',JSON.stringify(out));
    const labels=JSON.parse(out.runs_on).labels;assert.deepEqual(labels,['self-hosted',platform,'x64','nibfin-user-'+f.sf.members[0].id]);
    const w=workflowYAML().get(delivery),needs={resolve:{result:'success',outputs:resolveYAML(w.jobs.resolve.outputs,{steps:{entry:{outputs:out}}})}};
    assert.equal(resolveYAML(w.jobs.compute.if,{needs}),true);assert.equal(resolveYAML(w.jobs.execute.if,{needs}),false);
    assert.deepEqual(resolveYAML(w.jobs.compute['runs-on'],{needs}),{labels});
    const result=await f.execute(out.resolution);assert.equal(result.status,'completed',JSON.stringify(result));
    assert.equal(f.sh.records.length,1);const retained=f.records.at(-1).value;
    assert.equal(retained.executed,'shape');assert.equal(retained.cycle,f.pin.cycle);
    assert.deepEqual(retained.run,f.context.run);assert.deepEqual(retained.target,f.pin.target);
    assert.equal((await f.execute(out.resolution)).status,'blocked');assert.equal(f.sh.records.length,1);
    // A permissive condition cannot manufacture a retained resolution or bypass source validation.
    const g=await workflowFixture();assert.equal((await g.execute('missing')).status,'blocked');assert.equal(g.sh.records.length,0);
    for(const failed of ['failure','cancelled','skipped'])assert.equal(resolveYAML(w.jobs.compute.if,{needs:{resolve:{result:failed,outputs:out}}}),false);
  }
});

test('group and route validation reject altered member, incomplete platform and malformed labels',async()=>{
  const selection={outcome:'selected',memberId:'8',routing:{runnerLabel:'nibfin-user-8',platform:'linux',labels:['self-hosted','linux','arm64','nibfin-user-8'],groupId:'7'}};
  const conditions={platform:'linux',labels:['arm64'],groupId:'7'},target={repositoryId:'42'};
  const group=async()=>({id:'7',name:'Native group',repositoryId:'42',allowed:true});
  assert.deepEqual(await workflowRoute(selection,conditions,target,group),{group:'Native group',labels:selection.routing.labels});
  for(const change of [s=>s.routing.runnerLabel='nibfin-user-9',s=>s.routing.labels.pop(),s=>s.routing.labels.splice(1,1),s=>s.routing.labels=['self-hosted'],s=>s.routing.labels='[broken',s=>s.outcome='waiting']) {
    const s=structuredClone(selection);change(s);await assert.rejects(workflowRoute(s,conditions,target,group));
  }
  for(const g of [undefined,async()=>({id:'7',name:'Native group',repositoryId:'41',allowed:true}),async()=>({id:'7',name:'Native group',repositoryId:'42',allowed:false})])await assert.rejects(workflowRoute(selection,conditions,target,g));
});

test('fresh grant, source, Scope, dependencies, Runner, queued decision and prior effects block old execution',async()=>{
  for(const change of [f=>f.state.source=false,f=>f.state.runner=false,f=>f.pin.scopeBody+='drift',
    f=>f.context.run.attempt='2',f=>f.pin.base='b'.repeat(40),f=>f.pin.candidate='b'.repeat(64),
    f=>f.grant.signature='invalid',f=>f.sf.routes[f.sf.issuePath].assignees=[],
    f=>f.sf.routes[f.sf.prefix+'/collaborators/zed/permission'].permission='triage',
    f=>f.sf.routes[f.sf.prefix+'/actions/runners?per_page=100'].runners.forEach(r=>r.status='offline'),
    f=>f.pin.prior={state:'unresolved',stage:'shape',request:{request:'old',run:{id:'9',attempt:'1'}}},
    f=>f.state.dependencies=[{id:'62',node_id:'I_102',number:102,repository_url:'https://api.github.com'+f.sf.prefix,url:'https://api.github.com'+f.sf.prefix+'/issues/102',state:'closed',labels:[{name:'delivered'}]}]]) {
    const f=await workflowFixture(),out=await f.resolve();assert.equal(out.selected,'true');change(f);
    assert.notEqual((await f.execute(out.resolution)).status,'completed',change.toString());assert.equal(f.sh.records.length,0);
  }
  for(const mutate of [f=>{f.state.denied=true;},f=>{f.identity.visibility='private';},f=>{f.config.selector={select:async()=>({outcome:'waiting'})};},f=>{delete f.host.delivery;}]) {
    const f=await workflowFixture();mutate(f);assert.equal((await f.resolve()).selected,'false');assert.equal(f.sh.records.length,0);
  }
  for(const attack of [{role:'merge'},{ref:'fork/main'},{command:'$(touch /tmp/nope)'},{nibfin_request:'unknown'},{nibfin_correlation:'unknown'}]) {
    const f=await workflowFixture();assert.equal((await f.entry.invoke('resolve',{...f.input,...attack},f.context)).status,'blocked');assert.equal(f.sh.records.length,0);
  }
});

test('actual entry delegates source-safe independent wakeups to maintained relay',async()=>{
  const f=await relayFixture(),context={repository:'example-org/core',repositoryId:'42',run:{id:'100',attempt:'1'}};
  const identity={...context,visibility:'public',ownership:'personal'};
  const host={authenticate:async()=>identity,relay:async()=>f.configuration()};
  const e=createWorkflowEntry(host),out=await e.invoke('wake',{event:f.native},context);
  assert.equal(out.status,'run-observed');assert.equal(f.writes().length,1);
  assert.equal((await e.invoke('wake',{event:f.dispatch},context)).status,'run-observed');assert.equal(f.writes().length,1);
  f.args.recordedAt=1;assert.equal((await e.invoke('wake',{event:f.dispatch},context)).status,'blocked');assert.equal(f.writes().length,1);
  for(const action of ['opened','labeled','closed','reopened','edited','unlabeled','assigned','unassigned','milestoned','demilestoned']) {
    const event={action,repository:{id:42},issue:{node_id:'I_101',number:101,labels:[{name:'scope'}],state_reason:'completed'},label:{name:'shaped'}};
    const mapped=projectIssue(event);assert.notEqual(issueWakeup(mapped.payload),null);
  }
  assert.equal(issueWakeup({...f.native.payload,label:'delivered'}),'observe');
});

test('registration caller invokes protected host; source/context denial, encryption and unknown no-retry',async()=>{
  const {registrationFixture,registrationKeys,registrationSentinel}=await import('../tooling/registration-fixture.mjs');
  for(const permission of ['write','maintain','admin','read','triage']) {
    const f=registrationFixture();f.state.permission=permission;
    const context={repository:f.s.repository,repositoryId:f.s.repositoryId,run:{id:f.s.runId,attempt:f.s.attempt}};
    const input=callInputs(workflowYAML().get(registration),'workflow_call',{nibfin_registration:f.s.requestId,public_key:f.s.publicKey});
    const records=[],state={prior:'new'};
    const host={authenticate:async()=>({...context,visibility:'public',ownership:'organization'}),
      registration:async()=>({config:{authenticate:async()=>f.s,policy:async()=>f.p,transport:async r=>{
        // Reuse the maintained provider fixture's exact recording transport.
        return f.transport(r);
      },channel:f.channel,now:()=>f.state.now},handle:'opaque-host-handle',prior:state.prior}),
      retain:async r=>{records.push(r);state.prior='unresolved';return 'retained-response';}};
    const entry=createWorkflowEntry(host),out=await entry.invoke('registration',input,context);
    assert.equal(out.status,['read','triage'].includes(permission)?'unavailable':'delivered',JSON.stringify(out));
    assert(!JSON.stringify(out).includes(registrationSentinel));
    assert.equal(f.posts(),['read','triage'].includes(permission)?0:1);
    if(out.status==='delivered'){
      const result=records.at(-1).value;assert.deepEqual(result.context.runId,context.run.id);
      assert.equal(openRegistrationResponse(f.bytes(),{privateKey:registrationKeys.privateKey,expected:result.context,now:()=>f.state.now}).outcome,'available');
    }
    assert.equal((await entry.invoke('registration',input,context)).status,'unknown');
  }
  for(const change of [f=>f.p.enabled=false,f=>f.s.requester.id='99',f=>f.s.runId='92',f=>f.s.repositoryId='99',
    f=>f.state.loss=true,f=>f.state.readFailure=true,f=>delete f.p.capabilities['administration:write']]) {
    const f=registrationFixture(),context={repository:f.s.repository,repositoryId:f.s.repositoryId,run:{id:f.s.runId,attempt:f.s.attempt}};
    const input={nibfin_registration:f.s.requestId,public_key:f.s.publicKey,level:'repository'};change(f);
    const records=[];const e=createWorkflowEntry({authenticate:async()=>({...context,visibility:'public',ownership:'personal'}),
      registration:async()=>({config:{authenticate:async()=>f.s,policy:async()=>f.p,transport:f.transport,channel:f.channel,now:()=>f.state.now},handle:'opaque',prior:'new'}),
      retain:async r=>{records.push(r);return 'ref-registration';}});
    const result=await e.invoke('registration',input,context);assert.notEqual(result.status,'delivered');assert(!JSON.stringify(result).includes(registrationSentinel));
  }
});

test('hosted credentials stay at hosted steps; CLI failures do not leak inputs or exception text',async()=>{
  const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const docs=workflowYAML(),w=docs.get(delivery),sentinel='HOST-MANAGEMENT-SENTINEL';
  assert.deepEqual(w.on.workflow_call.secrets,{NIBFIN_HOST_TOKEN:{required:false}});
  assert.deepEqual(docs.get('workflow/templates/nibfin-stage.yml').jobs.stage.secrets,
    {NIBFIN_HOST_TOKEN:'${{ secrets.NIBFIN_HOST_TOKEN }}'});
  const context={...ctx,vars:{NIBFIN_BUNDLE_COMMIT:'a'.repeat(40),NIBFIN_HOST_COMMIT:'b'.repeat(40)},
    secrets:{NIBFIN_HOST_TOKEN:sentinel},github:{...ctx.github,token:'read-only'},
    needs:{resolve:{outputs:{execution_mode:'compute',resolution:'ref-resolution'}}},inputs:{issue:'101',nibfin_request:'request-1',nibfin_correlation:'corr'}};
  for(const job of ['compute','execute']){
    const resolved=resolveYAML(w.jobs[job].steps,context);assert(!JSON.stringify(resolved).includes(sentinel));
    assert.equal(resolved.at(-1).with.read_token,undefined);
  }
  assert.equal(resolveYAML(w.jobs.resolve.steps.at(-1).with,context).host_token,sentinel);
  const root=await mkdtemp(join(tmpdir(),'nibfin-workflow-cli-'));
  try {
    await writeFile(join(root,'event.json'),'{}');
    await writeFile(join(root,'entry.mjs'),`export function configure(){throw Error('${sentinel}');}`);
    const {workflowMain}=await import(new URL('../src/workflow-entry.mjs',import.meta.resolve('../src/index.mjs')));
    const env={GITHUB_EVENT_PATH:join(root,'event.json'),GITHUB_OUTPUT:join(root,'outputs'),
      GITHUB_REPOSITORY:'example/core',GITHUB_REPOSITORY_ID:'42',GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
      NIBFIN_BUNDLE_COMMIT:'a'.repeat(40),NIBFIN_HOST_COMMIT:'b'.repeat(40),NIBFIN_HOST_ROOT:root,
      NIBFIN_MODE:'resolve',NIBFIN_INPUT:JSON.stringify({...context.inputs,command:'$(touch /tmp/injected)'})};
    assert.equal(await workflowMain(env),1);assert.equal(await readFile(env.GITHUB_OUTPUT,'utf8'),'status=blocked\nselected=false\nreason=host-configuration-unavailable\n');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('group route uses maintained native group/access inventory and retained exact name',async()=>{
  const f=await workflowFixture(),i=f.pin.selectionInput,org='/orgs/example-org';
  i.registration={level:'organization',id:'7',organization:'example-org'};i.conditions.groupId='7';
  i.records.forEach(r=>r.registration=i.registration);
  f.sf.routes[org]={id:'7',login:'example-org',type:'Organization'};
  const runners=f.sf.routes[f.sf.prefix+'/actions/runners?per_page=100'];
  f.sf.routes[org+'/actions/runners?per_page=100']=runners;
  const group={id:'7',name:'Verified group',visibility:'all',allows_public_repositories:true,restricted_to_workflows:false,selected_workflows:[]};
  f.sf.routes[org+'/actions/runner-groups?per_page=100']={total_count:1,runner_groups:[group]};
  f.sf.routes[org+'/actions/runner-groups/7/runners?per_page=100']=runners;
  Object.assign(f.queuedRequest,await f.queued());const out=await f.resolve();assert.equal(out.selected,'true',JSON.stringify(out));
  assert.equal(JSON.parse(out.runs_on).group,group.name);
  group.allows_public_repositories=false;assert.notEqual((await f.execute(out.resolution)).status,'completed');assert.equal(f.sh.records.length,0);
});

test('result retention failure preserves the original reconciliation request after one stage',async()=>{
  const f=await workflowFixture(),out=await f.resolve(),retain=f.host.retain;
  f.host.retain=async arg=>{if(arg.kind==='stage-result')throw Error('lost');return retain(arg);};
  assert.deepEqual(await f.execute(out.resolution),{status:'unresolved',request:f.input.nibfin_request,reason:'result-reconciliation-required'});
  assert.equal(f.sh.records.length,1);assert.notEqual((await f.execute(out.resolution)).status,'completed');assert.equal(f.sh.records.length,1);
});


test('repository-local physical pools queue a native member Job before any Runner registration exists',()=>{
 const targets=Array.from({length:10},(_,i)=>({version:1,repository:'example/project-'+i,repositoryId:String(100+i),ownerId:'7',ownerType:'User'}));
 const pool={version:2,id:'member-default',capacity:6,targets};
 for(const target of targets){
  const plan=workflowInstallation({commit:'a'.repeat(40),hostRepository:'taco3064/nibfin',hostCommit:'b'.repeat(40),executionPool:pool,repository:target.repository});
  const caller=parse(plan.files.get('.github/workflows/nibfin-stage.yml'));assert.equal(plan.files.size,2);assert.equal(plan.files.has(delivery),false);
  const rescue=parse(plan.files.get('.github/workflows/nibfin-rescue.yml'));
  assert.equal(rescue.jobs.rescue['timeout-minutes'],10);
  assert.equal(rescue.jobs.rescue.steps[0].run,'/usr/local/bin/node "$HOME/.local/share/nibfin/control/runtime/client/native-stage-main.mjs"');
  assert.equal(rescue.jobs.rescue.permissions.actions,'write');
  assert.equal(rescue.jobs.rescue.steps[1].env.GH_TOKEN,'${{ github.token }}');
  assert.match(rescue.jobs.rescue.steps[1].run,/actions\/runs\/.*cancel/);
  assert.equal(Object.hasOwn(rescue.on,'schedule'),false);
  assert.deepEqual(Object.keys(caller.jobs),['stage']);assert.equal(caller.jobs.stage.name,'stage / execute');assert.equal(caller.jobs.stage.uses,undefined);
  assert.equal(caller.jobs.stage.steps[0].env.NIBFIN_MEMBER,'${{ inputs.nibfin_member }}');
  assert.equal(caller['run-name'],"#${{ inputs.nibfin_issue }} | ${{ inputs.nibfin_stage }} | op:${{ inputs.nibfin_correlation }}");
  assert.deepEqual(caller.permissions,{});
  const job=caller.jobs.stage;assert.deepEqual(job.permissions,{});
  assert.deepEqual(job['runs-on'],['self-hosted','linux','x64','nibfin-user-${{ inputs.nibfin_member }}','nibfin-request-${{ inputs.nibfin_request }}']);
  assert.equal(job.steps.length,1);assert.equal(job.steps[0].run,'/usr/local/bin/node "$HOME/.local/share/nibfin/control/runtime/client/native-stage-main.mjs"');
  assert.equal(job.steps[0].env.NIBFIN_REPOSITORY,'${{ github.repository }}');
  assert.equal(caller.concurrency['cancel-in-progress'],false);assert.equal(caller.concurrency.queue,'max');
  assert.equal(JSON.stringify(caller).includes('secrets.'),false);assert.equal(JSON.stringify(caller).includes('ubuntu-latest'),false);
 }
});
