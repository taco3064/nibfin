import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRepositoryIdentity,validateMemberBinding,createWorkflowEntry} from '../src/index.mjs';
import {selectionFixture} from '../tooling/selection-fixture.mjs';
import {hostRoutingFixture} from '../tooling/host-routing-fixture.mjs';

// Donor owner identity/dispatch assertions adapted to public multi-member data.
test('v1 stable target and member binding reject version, recreation, revocation and scope substitution',()=>{
  const a={id:'42',full_name:'example/core',private:false,visibility:'public',owner:{id:'7',login:'example',type:'User'}};
  const e={version:1,repository:'example/core',repositoryId:'42',ownerId:'7',ownerType:'User'};
  assert.equal(verifyRepositoryIdentity(a,e),true);
  for(const change of [{version:2},{version:'1'},{repositoryId:'43'},{ownerId:'8'},{ownerType:'Organization'}])
    assert.throws(()=>verifyRepositoryIdentity(a,{...e,...change}));
  for(const ownerType of ['User','Organization'])assert.equal(verifyRepositoryIdentity({...a,owner:{...a.owner,type:ownerType}},
    {...e,ownerType}),true);
  const registration={level:'repository',id:'42'},r={version:1,active:true,runnerId:'21',memberId:'8',instanceId:'instance-a',
    platform:'linux',repositoryId:'42',registration};
  assert.equal(validateMemberBinding(r,{repositoryId:'42',registration}),r);
  for(const change of [{version:0},{version:'1'},{active:false},{memberId:'08'},{repositoryId:'43'},
    {registration:{level:'organization',id:'7',organization:'example'}}])
    assert.throws(()=>validateMemberBinding({...r,...change},{repositoryId:'42',registration}));
});

test('adapted binding revocation/version failures block selection rather than fall through offline',async()=>{
  for(const change of [{active:false},{version:2},{version:null}]) {
    const f=selectionFixture();Object.assign(f.input.records[0],change);
    const result=await f.select();assert.equal(result.outcome,'blocked');assert.equal(result.routing,undefined);
    assert.equal(f.calls.some(r=>r.method!=='GET'),false);
  }
});

test('both current non-Owner members execute through fresh protected host for personal and Org ownership',async()=>{
  for(const type of ['User','Organization'])for(const reverse of [false,true]) {
    const f=await hostRoutingFixture();f.sf.routes[f.sf.prefix].owner.type=type;
    f.pin.selectionInput.target.ownerType=type;f.pin.ownership=type==='User'?'personal':'organization';
    if(reverse)f.sf.routes[f.sf.issuePath].assignees=[...f.sf.members].reverse();
    const member=f.sf.routes[f.sf.issuePath].assignees[0];
    f.stateRouting.actual=reverse?'22':'21';f.source.policy.runnerId=f.stateRouting.actual;await f.requeue();
    const selected=await f.make('resolve').invoke();assert.equal(selected.status,'selected',JSON.stringify(selected));
    assert.ok(JSON.parse(selected.runs_on).labels.includes('nibfin-user-'+member.id));
    assert.equal((await f.execute(selected.resolution)).status,'completed');assert.equal(f.sh.records.length,1);
  }
});

test('fresh Execute rejects inactive binding after Resolve without spawning the role',async()=>{
  const f=await hostRoutingFixture(),selected=await f.make('resolve').invoke();
  assert.equal(selected.status,'selected');f.pin.selectionInput.records[0].active=false;
  assert.equal((await f.execute(selected.resolution)).status,'blocked');assert.equal(f.sh.records.length,0);
});

test('public event payload cannot select commands, credentials, adapters or a privileged stage',async()=>{
  let effects=0;
  const entry=createWorkflowEntry({authenticate:()=>{effects++;throw Error('must not authenticate invalid input');}});
  const input={issue:'101',nibfin_request:'request',nibfin_correlation:'correlation'};
  for(const field of ['shell','command','credentials','adapter','stage','operation','login','module']) {
    const result=await entry.invoke('resolve',{...input,[field]:'SENTINEL-untrusted'},{});
    assert.equal(result.status,'blocked');assert.equal(effects,0);assert.doesNotMatch(JSON.stringify(result),/SENTINEL/);
  }
});
