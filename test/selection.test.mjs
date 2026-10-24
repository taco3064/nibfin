import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionFixture} from '../tooling/selection-fixture.mjs';
import {createAssigneeSelector} from '../src/index.mjs';
const noRoute = r => {assert.equal(Object.hasOwn(r,'routing'),false);assert.equal(Object.hasOwn(r,'memberId'),false);};
const inventory = h => h.routes[h.prefix+'/actions/runners?per_page=100'];
const permission = (h,i=0) => h.routes[h.prefix+'/collaborators/'+h.members[i].login+'/permission'];

test('inert public construction; exact fresh order, large IDs and busy rank',async()=>{
  let calls=0;
  createAssigneeSelector({provider:{request:()=>{calls++;}},authorizationFor:()=>{calls++;},maxCheckpointMs:50});
  assert.equal(calls,0);
  const h=selectionFixture(), first=await h.select();
  assert.equal(first.memberId,h.members[0].id);
  assert.deepEqual(first.routing,{runnerLabel:'nibfin-user-9007199254740999',platform:'linux',
    labels:['self-hosted','linux','x64','nibfin-user-9007199254740999']});
  assert.deepEqual(first.observation.candidateOrder,h.members.map(m=>m.id));
  assert.equal(first.observation.repositoryId,h.input.target.id);
  assert.equal(first.observation.issueId,'I_101');assert.equal(first.observation.source,'github-api');
  const before=h.calls.filter(c=>c.endpoint===h.issuePath).length;
  h.routes[h.issuePath].assignees=[...h.members].reverse();
  assert.equal((await h.select()).memberId,'42');
  assert.ok(h.calls.filter(c=>c.endpoint===h.issuePath).length>before);
  assert.ok(h.calls.every(c=>c.method==='GET' && !/events|timeline|dispatch/.test(c.endpoint)));
});

test('Issue response failure, ambiguity and identity cannot route or use old data',async()=>{
  const mutations=[
    h=>{h.routes[h.issuePath].node_id='I_wrong';},h=>{h.routes[h.issuePath].number=102;},
    h=>{h.routes[h.issuePath].repository_url='https://api.github.com/repos/other/core';},
    h=>{h.routes[h.issuePath].pull_request={};},h=>{h.routes[h.issuePath].assignees=null;},
    h=>{h.routes[h.issuePath].assignees=[h.members[0],h.members[0]];},
    h=>{h.routes[h.issuePath].assignees=[h.members[0],{id:'3',login:'ZED'}];},
    h=>{h.routes[h.issuePath].assignees=[{id:'01',login:'zed'}];},
    h=>{h.routes[h.issuePath]=()=>({status:403,body:'SECRET'});},
    h=>{h.routes[h.issuePath]=()=>{h.setClock(1150);return {status:200,body:'{}'};};},
  ];
  for(const mutate of mutations){const h=selectionFixture();assert.equal((await h.select()).outcome,'selected');
    mutate(h);const r=await h.select();assert.equal(r.outcome,'blocked');noRoute(r);assert.ok(!JSON.stringify(r).includes('SECRET'));}
  for(const field of ['labels','assignees']){const h=selectionFixture();h.routes[h.issuePath][field]=[];
    const r=await h.select();assert.equal(r.outcome,'waiting');noRoute(r);}
});

test('current Write/Maintain/Admin; verified lower permission yields to next member',async()=>{
  for(const ownerType of ['User','Organization'])for(const role of ['write','maintain','admin','read','triage','none']){
    const h=selectionFixture();h.input.target.ownerType=ownerType;h.routes[h.prefix].owner.type=ownerType;
    permission(h).permission=role;
    assert.equal((await h.select()).memberId,['write','maintain','admin'].includes(role)?h.members[0].id:'42');
    assert.ok(!h.calls.some(c=>c.endpoint.startsWith('/orgs/')));
  }
});

test('authorization ambiguity, signed Grant rejection and private/unknown visibility block',async()=>{
  const mutations=[
    h=>{permission(h).permission='custom';},h=>{permission(h).user={id:'3',login:'zed'};},
    h=>{h.routes['/users/zed']={id:'3',login:'zed'};},
    h=>{h.routes[h.prefix].id='3';},h=>{h.routes[h.prefix].private=true;},
    h=>{delete h.routes[h.prefix].visibility;},h=>{delete h.grant.signature;},
    h=>{h.grant.payload.revision='tampered';},h=>{h.context.revocation.revokedRecords=['record-1'];},
    h=>{h.context.revocation.available=false;},h=>{h.setClock(2000);h.input.execution.observedAt=2000;},
    h=>{h.context.request.operation='merge';},h=>{h.context.expectedWork[0].scope.body='changed';},
    h=>{h.routes[h.prefix+'/collaborators/zed/permission']=()=>({status:404,body:'{}'});},
  ];
  for(const mutate of mutations){const h=selectionFixture();mutate(h);const r=await h.select();
    assert.equal(r.outcome,'blocked');noRoute(r);}
  const h=selectionFixture(),ac=new AbortController();ac.abort();
  noRoute(await h.selector.select(h.input,{signal:ac.signal}));
});

test('offline, absent and nonmatching online instances allow fallback; later wakeup is fresh',async()=>{
  for(const mode of ['offline','absent','label','platform','mixed']){
    const h=selectionFixture(),inv=inventory(h);
    if(mode==='offline'||mode==='mixed')inv.runners[0].status='offline';
    if(mode==='absent'){h.input.records.shift();inv.runners.shift();inv.total_count--;}
    if(mode==='label')inv.runners[0].labels=inv.runners[0].labels.filter(l=>l.name!=='x64');
    if(mode==='platform'){inv.runners[0].os='windows';inv.runners[0].labels=inv.runners[0].labels.filter(l=>l.name!=='linux');h.input.records[0].platform='windows';}
    if(mode==='mixed'){h.input.records.push(h.record('23',h.members[0].id));
      const r=h.runner('23',h.members[0].id);r.labels=r.labels.filter(l=>l.name!=='x64');inv.runners.push(r);inv.total_count++;}
    assert.equal((await h.select()).memberId,'42');
  }
  const h=selectionFixture();inventory(h).runners.forEach(r=>{r.status='offline';});
  const waiting=await h.select();assert.equal(waiting.outcome,'waiting');assert.equal(waiting.reason,'all_unavailable');noRoute(waiting);
  assert.equal(waiting.reasons.length,2);
  inventory(h).runners[0].status='online';assert.equal((await h.select()).memberId,h.members[0].id);
});

test('registration mismatches, incomplete/denied inventory and conflicting unknown registration block',async()=>{
  const mutations=[
    h=>{h.input.records[0].runnerId='99';},h=>{h.input.records[0].repositoryId='99';},
    h=>{h.input.records[0].platform='windows';},
    h=>{inventory(h).runners[0].labels.push({name:'nibfin-user-88',type:'custom'});},
    h=>{inventory(h).total_count++;},h=>{inventory(h).runners.push(h.runner('23',h.members[0].id));inventory(h).total_count++;},
    h=>{h.input.records.shift();},
    h=>{h.routes[h.prefix+'/actions/runners?per_page=100']=()=>({status:403,body:'SECRET credential'});},
    h=>{h.routes[h.prefix+'/actions/runners?per_page=100']=()=>{throw Error('SECRET private');};},
  ];
  for(const mutate of mutations){const h=selectionFixture();mutate(h);const r=await h.select();
    assert.equal(r.outcome,'blocked');noRoute(r);assert.ok(!JSON.stringify(r).includes('SECRET'));}
});

test('same member multiple busy instances output only member and cumulative conditions',async()=>{
  const h=selectionFixture();h.input.records.push(h.record('23',h.members[0].id));
  inventory(h).runners.push(h.runner('23',h.members[0].id));inventory(h).total_count++;
  const r=await h.select();assert.equal(r.outcome,'selected');
  assert.deepEqual(Object.keys(r).sort(),['memberId','observation','outcome','reason','routing']);
  assert.equal(r.routing.labels.filter(l=>l.startsWith('nibfin-user-')).length,1);
  assert.ok(!JSON.stringify(r).includes('runnerId'));assert.ok(!JSON.stringify(r).includes('Agent'));
});

test('repeat execution observations wait without dispatch or cross-member reassignment',async()=>{
  for(const state of ['queued','running','completed','unknown']){
    const h=selectionFixture();h.input.execution.state=state;
    inventory(h).runners[0].status='offline';h.routes[h.issuePath].assignees.reverse();
    const r=await h.select();assert.equal(r.outcome,'waiting');noRoute(r);assert.equal(h.calls.length,0);
    assert.equal(r.reason,state==='unknown'?'reconciliation_required':'existing_work');
    h.input.execution.state='new';assert.equal((await h.select()).memberId,'42');
  }
  for(const patch of [{repositoryId:'9'},{issueId:'I_wrong'},{operation:'merge'},{state:'invented'},{observedAt:999}]){
    const h=selectionFixture();Object.assign(h.input.execution,patch);assert.equal((await h.select()).outcome,'blocked');}
});

test('next checkpoints reject changed membership, permission and Grant',async()=>{
  for(const mutate of [h=>{h.routes[h.issuePath].assignees=[];},
    h=>{h.members.forEach((_,i)=>{permission(h,i).permission='read';});},
    h=>{h.context.revocation.revokedRecords=['record-1'];}]){
    const h=selectionFixture();assert.equal((await h.select()).outcome,'selected');mutate(h);noRoute(await h.select());
  }
  // Membership changes during the authorization boundary read fail closed.
  const h=selectionFixture(),original=h.routes[h.issuePath];let reads=0;
  h.routes[h.issuePath]=()=>({status:200,body:JSON.stringify({...original,assignees:++reads===1?h.members:[]})});
  assert.equal((await h.select()).outcome,'blocked');
});

test('member with several platforms validates all bindings and filters cumulative job conditions',async()=>{
  const h=selectionFixture();inventory(h).runners[0].status='offline';
  const other=h.runner('23',h.members[0].id,{os:'windows'});other.labels=other.labels.filter(l=>l.name!=='linux');
  other.labels.push({name:'windows',type:'read-only'});
  inventory(h).runners.push(other);inventory(h).total_count++;
  h.input.records.push(h.record('23',h.members[0].id,{platform:'windows'}));
  assert.equal((await h.select()).memberId,'42');
  other.labels.push({name:'nibfin-user-88',type:'custom'});
  assert.equal((await h.select()).outcome,'blocked');
});

test('organization group, repository and workflow access remain required in routing',async()=>{
  function grouped(){
    const h=selectionFixture(),org='/orgs/example-org';
    h.input.registration={level:'organization',organization:'example-org',id:'7'};
    h.input.records.forEach(r=>{r.registration=h.input.registration;});
    h.input.conditions.groupId='31';h.input.conditions.workflow='example-org/core/.github/workflows/run.yml@main';
    h.routes[org]={id:'7',login:'example-org',type:'Organization'};
    h.routes[org+'/actions/runners?per_page=100']=inventory(h);
    const group={id:'31',name:'trusted',visibility:'selected',allows_public_repositories:true,
      restricted_to_workflows:true,selected_workflows:[h.input.conditions.workflow]};
    h.routes[org+'/actions/runner-groups?per_page=100']={total_count:1,runner_groups:[group]};
    h.routes[org+'/actions/runner-groups/31/runners?per_page=100']=inventory(h);
    const repos={total_count:1,repositories:[{id:h.input.target.id,full_name:'example-org/core',private:false}]};
    h.routes[org+'/actions/runner-groups/31/repositories?per_page=100']=repos;
    return {h,group,repos};
  }
  const {h}=grouped(),r=await h.select();assert.equal(r.outcome,'selected');assert.equal(r.routing.groupId,'31');
  assert.deepEqual(r.routing.labels,['self-hosted','linux','x64','nibfin-user-9007199254740999']);
  for(const mutate of [x=>{x.group.allows_public_repositories=false;},x=>{x.group.selected_workflows=[];},
    x=>{x.h.input.conditions.groupId='32';},x=>{x.repos.repositories=[];x.repos.total_count=0;}]){
    const x=grouped();mutate(x);assert.equal((await x.h.select()).outcome,'blocked');
  }
});

test('every emitted default Label is required, even with nondefault Runner registration',async()=>{
  for(const label of ['self-hosted','linux']){
    const h=selectionFixture();inventory(h).runners[0].labels=inventory(h).runners[0].labels.filter(l=>l.name!==label);
    assert.equal((await h.select()).memberId,'42');
  }
});

test('input and checkpoint failures are bounded without weakening upstream authorization',async()=>{
  for(const mutate of [h=>{h.input.operation=undefined;},h=>{h.input.conditions.labels=['nibfin-user-42'];},
    h=>{h.input.target.id='01';},h=>{h.input.issueId='bad issue';},
    h=>{h.input.conditions.platform='other';},h=>{h.input.execution.observedAt=1200;}]){
    const h=selectionFixture();mutate(h);const r=await h.select();assert.equal(r.outcome,'blocked');noRoute(r);
  }
  for(const stage of ['issue','permission','runner']){
    const h=selectionFixture();
    const endpoint=stage==='issue'?h.issuePath:stage==='permission'?h.prefix+'/collaborators/zed/permission':h.prefix+'/actions/runners?per_page=100';
    const original=h.routes[endpoint];
    h.routes[endpoint]=()=>{h.setClock(1150);return {status:200,body:JSON.stringify(original)};};
    const r=await h.select();assert.equal(r.outcome,'blocked');noRoute(r);
  }
});
