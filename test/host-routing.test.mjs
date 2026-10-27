import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.mjs';
import {validateHostOptions} from '../host/entry.mjs';
import {hostRoutingFixture} from '../tooling/host-routing-fixture.mjs';
const inventory=f=>f.sf.routes[f.sf.prefix+'/actions/runners?per_page=100'];

test('authenticated routing is inert and resumes through a fresh protected host and maintained custody',async()=>{
  const f=await hostRoutingFixture();f.calls.length=0;const resolve=f.make('resolve');
  assert.equal(f.calls.length,0);assert.equal(f.remote.remote.uploads,0);
  const selected=await resolve.invoke();assert.equal(selected.status,'selected',JSON.stringify(selected));
  assert.deepEqual(JSON.parse(selected.runs_on),{labels:['self-hosted','linux','x64','nibfin-user-9007199254740999']});
  assert.equal(f.sh.records.length,0);
  const result=await f.execute(selected.resolution);assert.equal(result.status,'completed',JSON.stringify(result));
  assert.equal(f.sh.records.length,1);
  const saved=await core.createCustodyHost(f.custody).recover({kind:'stage-result',key:result.reference});
  assert.equal(saved.outcome,'recovered');assert.deepEqual(saved.value.run,f.request.run);
  assert.deepEqual(saved.value.routing,{route:JSON.parse(selected.runs_on),memberId:f.sf.members[0].id,
    execution:{runnerId:'21',operatorId:f.sf.members[0].id,repository:'example-org/core',repositoryId:'42',
      sourceRepository:'example-org/core',sourceRepositoryId:'42',run:f.request.run}});
  const resolution=await core.createCustodyHost(f.custody).recover({kind:'resolution',key:selected.resolution});
  assert.deepEqual(resolution.value.observation.candidateOrder,f.sf.members.map(m=>m.id));
  assert.equal(resolution.value.observation.source,'github-api');
  assert.equal(resolution.value.observation.repositoryId,'42');
  assert.deepEqual(saved.value.target,f.request.target);assert.equal(saved.value.request,f.request.request);
  assert.equal((await f.execute(selected.resolution)).status,'completed'); // retained result, no relaunch
  assert.equal(f.sh.records.length,1);
});

test('current array order, online-busy priority and pre-dispatch fallback produce exact native AND routes',async()=>{
  for(const scenario of ['original','reversed','offline','wrong-platform','missing-label','busy','multiple']) {
    const f=await hostRoutingFixture(),runners=inventory(f).runners;
    let expected=f.sf.members[0].id;
    if(scenario==='reversed') {f.sf.routes[f.sf.issuePath].assignees.reverse();expected='42';}
    if(scenario==='offline') {runners[0].status='offline';expected='42';}
    if(scenario==='wrong-platform') {
      runners[0].os='windows';runners[0].labels[1].name='windows';f.pin.selectionInput.records[0].platform='windows';expected='42';
    }
    if(scenario==='missing-label') {runners[0].labels=runners[0].labels.filter(l=>l.name!=='x64');expected='42';}
    if(scenario==='multiple') {
      runners.push(f.sf.runner('23',expected,{busy:false}));inventory(f).total_count++;
      f.pin.selectionInput.records.push(f.sf.record('23',expected));
    }
    await f.requeue();const selected=await f.resolve();assert.equal(selected.status,'selected',scenario);
    assert.deepEqual(JSON.parse(selected.runs_on),{labels:['self-hosted','linux','x64','nibfin-user-'+expected]});
    assert.equal(f.sh.records.length,0);
  }
  for(const platform of ['windows','macos']) {
    const f=await hostRoutingFixture();f.pin.selectionInput.conditions.platform=platform;
    for(const r of inventory(f).runners){r.os=platform;r.labels[1].name=platform;}
    f.pin.selectionInput.records.forEach(r=>r.platform=platform);await f.requeue();
    const r=await f.resolve();assert.equal(r.status,'selected');
    assert.deepEqual(JSON.parse(r.runs_on).labels,['self-hosted',platform,'x64','nibfin-user-'+f.sf.members[0].id]);
    assert.equal((await f.execute(r.resolution)).status,'completed');
  }
});

test('missing scope/assignees, unavailable members and failed identity/permission/Grant reads never dispatch',async()=>{
  const changes={
    scope:f=>f.sf.routes[f.sf.issuePath].labels=[],
    assignees:f=>f.sf.routes[f.sf.issuePath].assignees=[],
    offline:f=>inventory(f).runners.forEach(r=>r.status='offline'),
    read:f=>{for(const m of f.sf.members)f.sf.routes[f.sf.prefix+'/collaborators/'+m.login+'/permission'].permission='read';},
    triage:f=>{for(const m of f.sf.members)f.sf.routes[f.sf.prefix+'/collaborators/'+m.login+'/permission'].permission='triage';},
    permission:f=>f.sf.routes[f.sf.prefix+'/collaborators/zed/permission']={permission:'invalid'},
    malformed:f=>f.sf.routes[f.sf.issuePath].assignees=[{id:'42'}],
    denied:f=>f.state.denied=true,
    grant:f=>f.grant.signature='forged',
    revoked:f=>f.grantContext.revocation.revokedRecords.push(f.sf.payload.recordId),
    private:f=>f.sf.routes[f.sf.prefix].private=true
  };
  for(const [name,change] of Object.entries(changes)) {
    const f=await hostRoutingFixture();change(f);
    const out=await f.resolve();assert.equal(out.status,['scope','assignees','offline','read','triage'].includes(name)?'waiting':'blocked',name);
    assert.equal(f.sh.records.length,0,name);assert.equal(f.remote.remote.uploads,0,name);
    assert(!JSON.stringify(out).includes('PRIVATE-SENTINEL'));
  }
});

test('trusted actual Runner permits a second valid instance but rejects substitutions and unavailable inventory',async()=>{
  {
    const f=await hostRoutingFixture(),member=f.sf.members[0].id;
    inventory(f).runners.push(f.sf.runner('23',member));inventory(f).total_count++;
    f.pin.selectionInput.records.push(f.sf.record('23',member));await f.requeue();
    const r=await f.resolve();f.source.policy.runnerId='23';f.stateRouting.actual='23';
    assert.equal((await f.execute(r.resolution)).status,'completed');assert.equal(f.sh.records.length,1);
  }
  const changes={
    member:f=>{f.source.policy.runnerId='22';f.stateRouting.actual='22';},
    unknown:f=>{f.source.policy.runnerId='999';f.stateRouting.actual='999';},
    untrusted:f=>{f.stateRouting.actual='22';f.context.runnerId='21';f.context.event={runnerId:'21'};},
    missing:f=>f.stateRouting.missing=true,
    login:f=>f.stateRouting.operator={id:'7',login:'operator'},
    assignee:f=>f.sf.routes[f.sf.issuePath].assignees.splice(0,1),
    permission:f=>f.sf.routes[f.sf.prefix+'/collaborators/zed/permission'].permission='read',
    grant:f=>f.grant.signature='forged',
    revoked:f=>f.grantContext.revocation.revokedRecords.push(f.sf.payload.recordId),
    exception:f=>f.state.onRead=()=>{throw Error('PRIVATE-SENTINEL');},
    copied:f=>{inventory(f).runners.push(f.sf.runner('29',f.sf.members[0].id));inventory(f).total_count++;},
    replaced:f=>inventory(f).runners[0].id='29',
    repository:f=>f.pin.selectionInput.records[0].repositoryId='99',
    registration:f=>f.pin.selectionInput.registration.id='99',
    platform:f=>inventory(f).runners[0].os='windows',
    labels:f=>inventory(f).runners[0].labels.pop(),
    group:f=>f.pin.selectionInput.conditions.groupId='9',
    denied:f=>f.state.denied=true,
    incomplete:f=>inventory(f).total_count++,
    malformed:f=>inventory(f).runners[0].busy='true'
  };
  for(const [name,change] of Object.entries(changes)) {
    const f=await hostRoutingFixture(),r=await f.resolve();assert.equal(r.status,'selected');change(f);
    const out=await f.execute(r.resolution);assert.equal(out.status,'blocked',name);
    assert.equal(f.sh.records.length,0,name);assert.equal(f.sh.writes().length,0,name);
    assert(!JSON.stringify(out).includes('PRIVATE-SENTINEL'));
  }
});

test('execute/compute are mode-bound and fresh routing checks stop changes after initial Execute validation',async()=>{
  const f=await hostRoutingFixture(),r=await f.resolve();
  assert.equal((await f.execute(r.resolution,'execute')).status,'blocked');assert.equal(f.sh.records.length,0);
  // Changing API order alone keeps the queued member; no cancellation/reassignment.
  f.sf.routes[f.sf.issuePath].assignees.reverse();
  assert.equal((await f.execute(r.resolution)).status,'completed');assert.equal(f.sh.records.length,1);
  for(const change of [f=>f.sf.routes[f.sf.issuePath].assignees.splice(0,1),
    f=>f.sf.routes[f.sf.prefix+'/collaborators/zed/permission'].permission='read',
    f=>f.grant.signature='forged',f=>inventory(f).runners[0].labels.pop()]) {
    const g=await hostRoutingFixture(),r=await g.resolve();
    // Lifecycle readiness runs after Core and Workflow's initial checks.
    g.sh.state.onReadiness=()=>change(g);
    assert.notEqual((await g.execute(r.resolution)).status,'completed');assert.equal(g.sh.records.length,0);
  }
});

test('execute reaches maintained publication and rechecks a controlled write checkpoint',async()=>{
  const f=await hostRoutingFixture('publication'),r=await f.resolve();
  assert.equal(r.execution_mode,'execute');assert.equal(f.sh.writes().length,0);
  assert.equal((await f.execute(r.resolution,'execute')).status,'completed');assert.equal(f.sh.writes().length,2);
  const g=await hostRoutingFixture('publication'),s=await g.resolve();
  // After the body write, before the label write: the next controlled mutation
  // observes permission loss, rather than relying on the initial Runner check.
  g.sh.state.mutate=()=>{if(g.sh.state.body===g.pin.shapeBody)
    g.sf.routes[g.sf.prefix+'/collaborators/zed/permission'].permission='read';};
  const out=await g.execute(s.resolution,'execute');assert.notEqual(out.status,'completed');
  assert(g.sh.writes().length<=1);assert.equal(g.sh.state.labels.includes('shaped'),false);
});

test('retained request/route/source identities reject stale or substituted resolutions without a new attempt',async()=>{
  const mutations={
    missing:f=>f.remote.remote.artifacts.clear(),
    expired:f=>f.remote.remote.metadataChange=m=>({...m,expired:true}),
    source:f=>f.remote.remote.runChange=r=>({...r,head_sha:'f'.repeat(40)}),
    request:f=>f.request.request='different',
    cycle:f=>f.request.cycle='different',
    issue:f=>f.request.target.issueId='I_other',
    repository:f=>f.request.target.repository='example-org/other',
    run:f=>f.request.run.id='999',
    attempt:f=>f.request.run.attempt='2',
    expected:f=>f.request.expected.decision='f'.repeat(64),
    member:f=>{const s=f.remote.remote.slots.get('resolution:'+f.request.request);
      f.remote.rewrite(s,'result',files=>{const v=JSON.parse(files.get('host-record.json'));v.value.memberId='42';files.set('host-record.json',Buffer.from(JSON.stringify(v)));});},
    route:f=>{const s=f.remote.remote.slots.get('resolution:'+f.request.request);
      f.remote.rewrite(s,'result',files=>{const v=JSON.parse(files.get('host-record.json'));v.value.route.labels=['self-hosted','linux','nibfin-user-42'];files.set('host-record.json',Buffer.from(JSON.stringify(v)));});}
  };
  for(const [name,change] of Object.entries(mutations)) {
    const f=await hostRoutingFixture(),r=await f.resolve();change(f);
    assert.equal((await f.execute(r.resolution)).status,'blocked',name);assert.equal(f.sh.records.length,0,name);
  }
  for(const state of ['queued','running','completed','unknown']) {
    const f=await hostRoutingFixture();f.pin.selectionInput.execution.state=state;
    const result=await f.resolve();assert.equal(result.status,'waiting',state);
    assert.equal(f.remote.remote.uploads,0);assert.equal(f.sh.records.length,0);
  }
});

test('a failed result publication after a stage remains tied to the original attempt across restart',async()=>{
  const f=await hostRoutingFixture(),r=await f.resolve();
  f.sh.state.onStart=()=>{f.remote.remote.failUpload='result';};
  const out=await f.execute(r.resolution);assert.deepEqual(out,{status:'unresolved',request:f.request.request,reason:'result-reconciliation-required'});
  assert.equal(f.sh.records.length,1);f.remote.remote.failUpload=null;
  const resumed=await f.execute(r.resolution);assert.equal(resumed.status,'unresolved');assert.equal(f.sh.records.length,1);
});

function organization(f) {
  const prefix='/orgs/example-org',registration={level:'organization',id:'7',organization:'example-org'};
  f.pin.selectionInput.registration=registration;f.pin.selectionInput.conditions.groupId='9';
  f.pin.selectionInput.conditions.workflow='example-org/core/.github/workflows/stage.yml@refs/heads/main';
  f.pin.selectionInput.records.forEach(r=>r.registration=registration);
  const group={id:'9',name:'Trusted group',visibility:'selected',allows_public_repositories:true,
    restricted_to_workflows:true,selected_workflows:[f.pin.selectionInput.conditions.workflow]};
  const endpoints={
    [prefix]:{id:'7',login:'example-org',type:'Organization'},
    [prefix+'/actions/runners?per_page=100']:inventory(f),
    [prefix+'/actions/runner-groups?per_page=100']:{total_count:1,runner_groups:[group]},
    [prefix+'/actions/runner-groups/9/runners?per_page=100']:inventory(f),
    [prefix+'/actions/runner-groups/9/repositories?per_page=100']:{total_count:1,repositories:[{id:'42',full_name:'example-org/core',private:false}]},
    '/user/memberships/orgs/example-org':{state:'active',role:'admin'}
  };
  Object.assign(f.sf.routes,endpoints);
  f.targets.push(...Object.keys(endpoints).filter(p=>p.startsWith('/orgs/')).map(p=>p.split('?')[0]));
  return {group,endpoints};
}

test('organization group name/access/workflow are verified from inventory; personal public ownership uses repository runners',async()=>{
  const f=await hostRoutingFixture(),{group}=organization(f);await f.requeue();
  const r=await f.resolve();assert.equal(r.status,'selected');
  assert.equal(JSON.parse(r.runs_on).group,'Trusted group');
  assert.equal((await f.execute(r.resolution)).status,'completed');
  for(const change of [g=>g.visibility='private',g=>g.allows_public_repositories=false,g=>g.selected_workflows=[]]) {
    const f=await hostRoutingFixture(),{group}=organization(f);change(group);
    assert.equal((await f.resolve()).status,'blocked');assert.equal(f.sh.records.length,0);
  }
  const g=await hostRoutingFixture();
  g.pin.ownership='personal';g.sf.routes[g.sf.prefix].owner.type='User';g.pin.selectionInput.target.ownerType='User';
  await g.requeue();const s=await g.resolve();assert.equal(s.status,'selected');
  assert.equal((await g.execute(s.resolution)).status,'completed');
});


test('ineligible earlier candidate is skipped without sorting or bypassing the later candidate Grant',async()=>{
  for(const permission of ['read','triage']) {
    const f=await hostRoutingFixture();
    f.sf.routes[f.sf.prefix+'/collaborators/zed/permission'].permission=permission;
    await f.requeue();const r=await f.resolve();assert.equal(r.status,'selected');
    assert.equal(JSON.parse(r.runs_on).labels.at(-1),'nibfin-user-42');
    f.source.policy.runnerId='22';f.stateRouting.actual='22';
    assert.equal((await f.execute(r.resolution)).status,'completed');
  }
});

test('native dependency and Core plan changes after initial Execute checks stop stage launch',async()=>{
  for(const change of [f=>f.state.dependencies=[{...f.sf.routes[f.sf.issuePath],node_id:'I_missing',id:'777',number:777,
    url:'https://api.github.com/repos/example-org/core/issues/777'}],
    f=>f.pin.cycle='different',f=>f.sf.routes[f.sf.issuePath].body='changed Scope',
    f=>f.sf.routes[f.sf.issuePath].state='closed']) {
    const f=await hostRoutingFixture(),r=await f.resolve();f.sh.state.onReadiness=()=>change(f);
    const result=await f.execute(r.resolution);assert.notEqual(result.status,'completed');assert.equal(f.sh.records.length,0);
  }
});


test('authenticated routing configuration rejects untrusted labels/callbacks and unsafe public options before effects',async()=>{
  const f=await hostRoutingFixture();f.calls.length=0;
  const options={version:1,repository:'example-org/core',repositoryId:'42',environment:'nibfin-hosted',
    authentication:'actions-oidc',routing:'authenticated'};
  for(const changed of [{...options,runnerId:'21'},{...options,labels:['nibfin-user-42']},
    {...options,routing:true},{...options,authentication:undefined},{...options,environment:'nibfin-member'}])
    assert.throws(()=>validateHostOptions(changed,'resolve'));
  assert.throws(()=>validateHostOptions(options,'lookup'));
  for(const capabilities of [{delivery:async()=>{},verifyRunner:async()=>true},
    {delivery:async()=>{},group:async()=>({allowed:true})}])assert.throws(()=>f.make('compute',{capabilities}));
  assert.equal(f.calls.length,0);assert.equal(f.remote.remote.uploads,0);
  f.pin.selectionInput.conditions.labels.push('nibfin-user-42');
  assert.equal((await f.resolve()).status,'blocked');assert.equal(f.sh.records.length,0);
});

test('valid custody bytes cannot substitute a differently bound retained route or result',async()=>{
  for(const resultKind of ['resolution-member','resolution-route','result-route','result-execution','result-runner','result-operator']) {
    const f=await hostRoutingFixture();let resolution;
    const identity={...f.context,visibility:'public',ownership:'organization'},store=core.createCustodyHost(f.custody);
    const route={labels:['self-hosted','linux','x64','nibfin-user-'+f.sf.members[0].id]};
    if(resultKind.startsWith('resolution')) {
      const value={request:f.request,route,memberId:f.sf.members[0].id};
      if(resultKind==='resolution-member')value.memberId='42';else value.route={labels:['self-hosted','linux']};
      const retained=await store.retain({kind:'resolution',key:f.request.request,identity,value});
      assert.equal(retained.outcome,'retained');resolution=retained.key;
    } else {
      resolution=(await f.resolve()).resolution;
      const value={version:1,target:f.request.target,cycle:f.request.cycle,request:f.request.request,
        run:f.request.run,requested:f.request.expected,disposition:'completed',routing:{route,memberId:f.sf.members[0].id,
          execution:{repository:f.context.repository,repositoryId:'42',run:f.request.run,runnerId:'21',
            operatorId:f.sf.members[0].id,sourceRepository:f.context.repository,sourceRepositoryId:'42'}}};
      if(resultKind==='result-route')value.routing.route={labels:['self-hosted','linux']};
      else if(resultKind==='result-runner')value.routing.execution.runnerId='999';
      else if(resultKind==='result-operator')value.routing.execution.operatorId='7';
      else value.routing.execution.run={id:'999',attempt:'1'};
      const retained=await store.retain({kind:'stage-result',key:f.request.request,identity,value});
      assert.equal(retained.outcome,'retained');
    }
    const out=await f.execute(resolution);assert.notEqual(out.status,'completed',resultKind);
    assert.equal(f.sh.records.length,0,resultKind);
  }
});


test('actual Runner matching permits other valid platforms and nonmatching instances for the selected member',async()=>{
  const f=await hostRoutingFixture(),member=f.sf.members[0].id;
  inventory(f).runners.push(f.sf.runner('23',member,{os:'windows',labels:[
    {name:'self-hosted',type:'read-only'},{name:'windows',type:'read-only'},
    {name:'nibfin-user-'+member,type:'custom'}]}));inventory(f).total_count++;
  f.pin.selectionInput.records.push(f.sf.record('23',member,{platform:'windows'}));
  await f.requeue();const selected=await f.resolve();assert.equal(selected.status,'selected');
  assert.equal((await f.execute(selected.resolution)).status,'completed');assert.equal(f.sh.records.length,1);
});


test('an unsupported lifecycle cannot silently ignore the final routing checkpoint',async()=>{
  const f=await hostRoutingFixture(),prepare=f.owners.shape.prepareRole;
  f.owners.shape={...f.owners.shape,prepareRole:async task=>{
    const prepared=await prepare(task);return {...prepared,lifecycle:{...prepared.lifecycle}};
  }};
  const r=await f.resolve();assert.equal(r.status,'selected');
  assert.notEqual((await f.execute(r.resolution)).status,'completed');assert.equal(f.sh.records.length,0);
});


test('an authenticated Job from another repository cannot claim a repository Runner for this target',async()=>{
  const f=await hostRoutingFixture(),r=await f.resolve();
  f.source.policy.repository='example-org/other';f.source.policy.repository_id='999';
  f.source.policy.workflow_ref='example-org/other/.github/workflows/stage.yml@refs/heads/main';
  f.source.association.repository_id='999';
  f.source.state.token=await f.source.sign(Object.fromEntries(['run_id','repository','repository_id',
    'repository_owner_id','workflow_ref'].map(k=>[k,f.source.policy[k]])));
  assert.equal((await f.execute(r.resolution)).status,'blocked');assert.equal(f.sh.records.length,0);
});


test('a later member losing permission or assignment cannot veto an eligible first member',async()=>{
  for(const change of [f=>f.sf.routes[f.sf.prefix+'/collaborators/amy/permission'].permission='read',
    f=>f.sf.routes[f.sf.issuePath].assignees.splice(1,1)]) {
    const f=await hostRoutingFixture();change(f);await f.requeue();
    const r=await f.resolve();assert.equal(r.status,'selected');
    assert.equal(JSON.parse(r.runs_on).labels.at(-1),'nibfin-user-'+f.sf.members[0].id);
    assert.equal((await f.execute(r.resolution)).status,'completed');assert.equal(f.sh.records.length,1);
  }
});


test('authenticated source repository names preserve GitHub case-insensitive coordinates',async()=>{
  const f=await hostRoutingFixture();
  f.source.policy.repository='Example-Org/Core';
  f.source.policy.workflow_ref='Example-Org/Core/.github/workflows/stage.yml@refs/heads/main';
  f.source.state.token=await f.source.sign(Object.fromEntries(['run_id','repository','repository_id',
    'repository_owner_id','workflow_ref'].map(k=>[k,f.source.policy[k]])));
  const r=await f.resolve();assert.equal(r.status,'selected');
  assert.equal((await f.execute(r.resolution)).status,'completed');
});

test('mixed allowed groups preserve busy priority while actual Runner must match the queued group',async()=>{
  async function mixed() {
    const f=await hostRoutingFixture(),{group}=organization(f),prefix='/orgs/example-org/actions';
    const member=f.sf.members[0].id,extra=f.sf.runner('23',member,{busy:false});
    // Keep a separate group-9 snapshot; the full organization inventory includes 23.
    f.sf.routes[prefix+'/runner-groups/9/runners?per_page=100']=structuredClone(inventory(f));
    inventory(f).runners.push(extra);inventory(f).total_count++;
    f.pin.selectionInput.records.push(f.sf.record('23',member,{registration:f.pin.selectionInput.registration}));
    f.sf.routes[prefix+'/runner-groups?per_page=100'].runner_groups.push({...group,id:'10',name:'Other allowed group'});
    f.sf.routes[prefix+'/runner-groups?per_page=100'].total_count++;
    f.sf.routes[prefix+'/runner-groups/10/runners?per_page=100']={total_count:1,runners:[extra]};
    f.sf.routes[prefix+'/runner-groups/10/repositories?per_page=100']=structuredClone(
      f.sf.routes[prefix+'/runner-groups/9/repositories?per_page=100']);
    f.targets.push(prefix+'/runner-groups/10/runners',prefix+'/runner-groups/10/repositories');
    return {f,prefix};
  }
  {
    const {f}=await mixed();await f.requeue();const r=await f.resolve();
    assert.equal(r.status,'selected');assert.deepEqual(JSON.parse(r.runs_on),{
      group:'Trusted group',labels:['self-hosted','linux','x64','nibfin-user-'+f.sf.members[0].id]});
    assert.equal((await f.execute(r.resolution)).status,'completed');assert.equal(f.sh.records.length,1);
  }
  {
    const {f}=await mixed();await f.requeue();const r=await f.resolve();
    f.source.policy.runnerId='23';f.stateRouting.actual='23';
    assert.equal((await f.execute(r.resolution)).status,'blocked');
    assert.equal(f.sh.records.length,0);assert.equal(f.sh.writes().length,0);
  }
  {
    const {f,prefix}=await mixed();
    // No first-member instance in group 9 is online: pre-dispatch fallback remains legal.
    inventory(f).runners[0].status='offline';
    f.sf.routes[prefix+'/runner-groups/9/runners?per_page=100'].runners[0].status='offline';
    await f.requeue();const r=await f.resolve();assert.equal(r.status,'selected');
    assert.equal(JSON.parse(r.runs_on).labels.at(-1),'nibfin-user-42');
    f.source.policy.runnerId='22';f.stateRouting.actual='22';
    assert.equal((await f.execute(r.resolution)).status,'completed');
  }
  {
    const {f,prefix}=await mixed();await f.requeue();const r=await f.resolve();
    // Move the actual instance after initial Execute checks. Another group-9
    // member remains online, but the retained member/instance cannot be reassigned.
    f.sh.state.onReadiness=()=>{
      const group9=f.sf.routes[prefix+'/runner-groups/9/runners?per_page=100'];
      const actual=group9.runners.shift();group9.total_count--;
      const group10=f.sf.routes[prefix+'/runner-groups/10/runners?per_page=100'];
      group10.runners.push(actual);group10.total_count++;
    };
    assert.notEqual((await f.execute(r.resolution)).status,'completed');
    assert.equal(f.sh.records.length,0);assert.equal(f.sh.writes().length,0);
  }
});
