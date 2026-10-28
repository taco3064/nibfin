import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {createLocalRunnerLifecycle,localRunnerCount} from '../src/index.mjs';
import {selectionFixture} from '../tooling/selection-fixture.mjs';
import {registrationFixture,registrationKeys,registrationSentinel} from '../tooling/registration-fixture.mjs';
const target=(ownerType='User',level='repository',repository='example/core',repositoryId='42')=>({version:1,
  repository,repositoryId,ownerId:'7',ownerType,level,registrationId:level==='repository'?repositoryId:'7'});
const secret='SENTINEL-model-login';
async function fixture(t,member={id:'8',login:'member'}) {
  const root=await mkdtemp(join(tmpdir(),'nibfin-local-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[],observations=new Map(),state={permission:'write',management:true,policy:true,configured:0,
    acquired:0,failConfigure:false,failObserve:false,local:true};
  const registration={
    authorize:async q=>{
      calls.push(['authorize',q]);const t=q.target;
      return {ok:true,memberId:member.id,registrationId:t.registrationId,level:t.level,
        memberPermission:state.permission,management:state.management?(t.level==='repository'?'administration:write':'organization_self_hosted_runners:write'):null,
        policyEnabled:state.policy,repository:{id:t.repositoryId,full_name:t.repository,private:false,visibility:'public',
          owner:{id:t.ownerId,login:t.repository.split('/')[0],type:t.ownerType}}};
    },
    acquire:async q=>{state.acquired++;calls.push(['acquire',q]);return {outcome:'available',token:registrationSentinel,
      expires_at:new Date(Date.now()+60000).toISOString(),url:'https://github.com/'+(q.target.level==='repository'?q.target.repository:q.target.repository.split('/')[0])};},
    configure:async q=>{
      state.configured++;calls.push(['configure',q]);assert.equal(q.token,registrationSentinel);
      assert.equal(await readFile(q.login+'/sentinel','utf8'),secret);
      const o={confirmed:true,runnerId:String(100+state.configured),memberId:member.id,repositoryId:q.target.repositoryId,
        platform:'linux',registration:{level:q.target.level,id:q.target.registrationId,
          ...(q.target.level==='organization'?{organization:q.target.repository.split('/')[0]}:{})},labels:q.labels};
      if(state.process)execFileSync(process.execPath,['-e',
        "const fs=require('node:fs');fs.writeFileSync(process.env.FIXTURE_REGISTRATION+'/.credentials',process.env.FIXTURE_TOKEN,{mode:0o600});"],
        {env:{FIXTURE_REGISTRATION:q.registration,FIXTURE_TOKEN:q.token},stdio:'pipe'});
      observations.set(q.instanceId,o);
      if(state.failConfigure)throw Error(registrationSentinel);
    },
    observe:async q=>{calls.push(['observe',q]);if(state.failObserve)throw Error(secret);return observations.get(q.instanceId);}
  };
  const config={version:1,root,member,registration,checkLocal:async q=>{
    calls.push(['local',q]);if(!state.local)return {status:'blocked'};
    if(q.stage==='create')await writeFile(q.login+'/sentinel',secret,{mode:0o600});
    return {status:'ready',memberId:member.id,agent:q.agent};
  }};
  return {root,member,config,registration,calls,observations,state,client:()=>createLocalRunnerLifecycle(config),
    disk:async name=>JSON.parse(await readFile(join(root,name,'environment.json'),'utf8'))};
}

test('count default and explicit totals; malformed inputs create no partial environment or API effects',async t=>{
  const f=await fixture(t),c=f.client();
  assert.equal(localRunnerCount(),2);
  for(const count of [0,-1,1.5,'2','',null,NaN,Infinity,{},[]]) {
    assert.throws(()=>localRunnerCount(count));assert.equal((await c.create({name:'bad',agent:'codex',count})).outcome,'blocked');
    assert.deepEqual(await readdir(f.root),[]);
  }
  for(const [name,agent,count] of [['a','codex',undefined],['b','claude',1],['c','gemini',4]]) {
    const r=await c.create({name,agent,...(count===undefined?{}:{count})});assert.equal(r.outcome,'created');
    assert.equal(r.environment.instances.length,count??2);
    assert.ok(r.environment.instances.every(i=>i.state==='unregistered'&&!i.binding));
    const local=f.calls.findLast(([k])=>k==='local')[1];
    assert.equal(new Set(local.instances.map(i=>i.work)).size,count??2);
    assert.equal(new Set(local.instances.map(i=>i.registration)).size,count??2);
    assert.equal(new Set(local.instances.map(i=>i.service)).size,count??2);
    assert.equal(new Set(local.instances.map(i=>i.login)).size,1);
    assert.doesNotMatch(JSON.stringify(r),/SENTINEL/);
  }
  assert.equal(f.state.acquired,0);assert.equal(f.state.configured,0);
  assert.equal((await c.create({name:'a',agent:'gemini'})).outcome,'blocked');
  f.state.local=false;assert.equal((await c.create({name:'fail',agent:'codex'})).outcome,'blocked');
  assert.ok(!(await readdir(f.root)).includes('fail'));
});

test('separate members/login environments and registration resources; standby does not need an Issue Grant',async t=>{
  for(const member of [{id:'8',login:'member'},{id:'9',login:'other'}])for(const ownerType of ['User','Organization']) {
    const f=await fixture(t,member),c=f.client();
    const created=await c.create({name:'local',agent:'codex'});assert.equal(created.outcome,'created');
    assert.equal((await c.standby('local')).outcome,'blocked');
    const first=await c.register({name:'local',method:'manual',target:target(ownerType)});
    const second=await c.register({name:'local',method:'manual',target:target(ownerType,'repository','example/second','43')});
    assert.equal(first.outcome,'registered');assert.equal(second.outcome,'registered');
    assert.equal(second.environment.instances.length,2);
    assert.equal((await c.register({name:'local',method:'manual',target:target(ownerType)})).reason,'instances_exhausted');
    assert.equal(f.state.acquired,2);assert.equal((await c.standby('local')).outcome,'ready');
    const m=await f.disk('local');assert.doesNotMatch(JSON.stringify(m),/SENTINEL|token/);
    const configs=f.calls.filter(([k])=>k==='configure').map(([,q])=>q);
    assert.notEqual(configs[0].work,configs[1].work);assert.notEqual(configs[0].registration,configs[1].registration);
    assert.equal(configs[0].login,configs[1].login);
    assert.ok(f.calls.filter(([k])=>k==='local').every(([,q])=>!('grant' in q)&&!('issue' in q)));
    const wrong=createLocalRunnerLifecycle({...f.config,member:{id:member.id==='8'?'9':'8',login:'foreign'}});
    assert.equal((await wrong.list('local')).outcome,'blocked');
    f.state.policy=false;assert.equal((await c.standby('local')).outcome,'ready');
  }
});

test('existing #198 issuer, encrypted artifact readback and member consumer feed official local configuration',async t=>{
  for(const ownerType of ['User','Organization'])for(const level of (ownerType==='User'?['repository']:['repository','organization'])) {
    const f=await fixture(t),issuer=registrationFixture();issuer.state.ownerType=ownerType;issuer.s.level=level;
    issuer.state.now=Date.now();issuer.state.expiry=new Date(Date.now()+60000).toISOString();
    f.registration.acquire=async()=>{
      const result=await issuer.issue();assert.equal(result.outcome,'delivered',JSON.stringify(result));
      return {bytes:issuer.bytes(),expected:result.context,privateKey:registrationKeys.privateKey};
    };
    const c=f.client();await c.create({name:'auto',agent:'claude'});
    const r=await c.register({name:'auto',method:'auto',target:target(ownerType,level)});
    assert.equal(r.outcome,'registered',JSON.stringify(r));assert.equal(issuer.posts(),1);assert.equal(f.state.configured,1);
    assert.doesNotMatch(JSON.stringify(r)+JSON.stringify(await f.disk('auto'))+issuer.staged.join(''),/SENTINEL/);
  }
});

test('registration management/automatic policy separate from local login and valid registration',async t=>{
  for(const mutate of [s=>s.management=false,s=>s.policy=false,s=>s.permission='read',s=>s.permission='triage']) {
    const f=await fixture(t);mutate(f.state);const c=f.client();await c.create({name:'local',agent:'gemini'});
    const r=await c.register({name:'local',method:'auto',target:target('Organization')});
    assert.equal(r.outcome,'blocked');assert.equal(f.state.acquired,0);assert.equal(f.state.configured,0);
  }
  const f=await fixture(t);f.state.policy=false;const c=f.client();await c.create({name:'manual',agent:'gemini',count:1});
  assert.equal((await c.register({name:'manual',method:'manual',target:target('Organization')})).outcome,'registered');
});

// Adapted donor service-check: stale locks are evidence, never permission to steal.
test('crash locks and unknown official effects block replay; recovery only reads',async t=>{
  const f=await fixture(t),c=f.client();await c.create({name:'local',agent:'codex'});
  const lock=join(f.root,'local','mutation.lock'),content='{"pid":99999999}';await writeFile(lock,content);
  assert.equal((await c.register({name:'local',method:'manual',target:target()})).reason,'local_reconciliation_required');
  assert.equal((await c.standby('local')).outcome,'blocked');assert.equal(await readFile(lock,'utf8'),content);
  assert.equal(f.state.acquired,0);await rm(lock); // Explicit fixture operator recovery, not production behavior.
  f.state.failConfigure=true;
  const lost=await c.register({name:'local',method:'manual',target:target()});assert.equal(lost.outcome,'unknown');
  assert.doesNotMatch(JSON.stringify(lost),/SENTINEL/);
  const fresh=f.client();assert.equal((await fresh.register({name:'local',method:'manual',target:target()})).outcome,'blocked');
  assert.equal(f.state.acquired,1);assert.equal(f.state.configured,1);
  f.state.failObserve=true;assert.equal((await fresh.reconcile('local')).outcome,'unknown');
  f.state.failObserve=false;assert.equal((await fresh.reconcile('local')).outcome,'reconciled');
  assert.equal(f.state.acquired,1);assert.equal(f.state.configured,1);assert.equal((await fresh.standby('local')).outcome,'ready');
});

test('invalid versions, untrusted substitutions and symlinks fail before local/official execution',async t=>{
  const f=await fixture(t);
  for(const version of [0,2,'1',null])assert.throws(()=>createLocalRunnerLifecycle({...f.config,version}));
  const c=f.client();
  for(const extra of ['shell','credentials','adapter','operation']) {
    assert.equal((await c.create({name:'local',agent:'codex',[extra]:'SENTINEL'})).outcome,'blocked');
  }
  assert.equal(f.calls.length,0);await c.create({name:'local',agent:'codex'});
  for(const targetChange of [{version:2},{repositoryId:'99'},{level:'organization'},{registrationId:'99'}])
    assert.equal((await c.register({name:'local',method:'manual',target:{...target(),...targetChange}})).outcome,'blocked');
  assert.equal(f.state.acquired,0);
  const path=join(f.root,'local','login');await rm(path,{recursive:true});await symlink(f.root,path);
  assert.equal((await c.register({name:'local',method:'manual',target:target()})).outcome,'blocked');
  assert.equal(f.state.configured,0);
});


test('official process gets only its local registration space; separate environment logins and public results exclude credentials',async t=>{
  const f=await fixture(t),c=f.client();f.state.process=true;
  await c.create({name:'one',agent:'codex',count:1});await c.create({name:'two',agent:'codex',count:1});
  const one=f.calls.find(([k,q])=>k==='local'&&q.stage==='create'&&q.login.includes('/one/'))[1];
  const two=f.calls.find(([k,q])=>k==='local'&&q.stage==='create'&&q.login.includes('/two/'))[1];
  assert.notEqual(one.login,two.login);assert.notEqual(one.instances[0].work,two.instances[0].work);
  await writeFile(two.login+'/sentinel','SENTINEL-second-login');
  const registered=await c.register({name:'one',method:'manual',target:target()});
  assert.equal(registered.outcome,'registered');
  assert.equal(await readFile(one.instances[0].registration+'/.credentials','utf8'),registrationSentinel);
  assert.equal(await readFile(two.login+'/sentinel','utf8'),'SENTINEL-second-login');
  assert.deepEqual(await readdir(two.instances[0].registration),[]);
  // Only safe summaries can be forwarded to Owner/role/hook diagnostics.
  assert.doesNotMatch(JSON.stringify([registered,await c.list('one'),await c.list('two')]),/SENTINEL|token|login/);
  f.state.management=false;
  const denied=await c.register({name:'two',method:'manual',target:target()});
  assert.equal(denied.outcome,'blocked');assert.equal(f.state.configured,1);assert.deepEqual(await readdir(two.instances[0].registration),[]);
});

test('failed binding readback and corrupted local manifests cannot turn into successful registration or leak arbitrary fields',async t=>{
  for(const mutate of [o=>o.runnerId='replaced',o=>o.memberId='9',o=>o.labels=['nibfin-user-9'],
    o=>o.repositoryId='99',o=>o.registration.id='99']) {
    const f=await fixture(t),observe=f.registration.observe;
    f.registration.observe=async q=>{const o=await observe(q);mutate(o);return o;};
    const c=f.client();await c.create({name:'local',agent:'gemini',count:1});
    assert.equal((await c.register({name:'local',method:'manual',target:target()})).outcome,'unknown');
    assert.equal((await f.client().register({name:'local',method:'manual',target:target()})).outcome,'blocked');
    assert.equal(f.state.acquired,1);assert.equal(f.state.configured,1);
  }
  const f=await fixture(t),c=f.client();await c.create({name:'local',agent:'codex',count:1});
  assert.equal((await c.register({name:'local',method:'manual',target:target()})).outcome,'registered');
  const m=await f.disk('local');m.instances[0].binding.secret='SENTINEL-corrupt';
  await writeFile(join(f.root,'local','environment.json'),JSON.stringify(m));
  const result=await c.list('local');assert.equal(result.outcome,'blocked');assert.doesNotMatch(JSON.stringify(result),/SENTINEL/);
});


test('creation/listing require no registration API or target; input is snapshotted across awaited registration checks',async t=>{
  const f=await fixture(t),{registration,...localOnly}=f.config;
  const local=createLocalRunnerLifecycle(localOnly);
  const created=await local.create({name:'local',agent:'codex'});assert.equal(created.outcome,'created');
  assert.equal(created.environment.instances.length,2);assert.equal((await local.list('local')).outcome,'listed');
  assert.equal(f.state.acquired,0);assert.equal(f.state.configured,0);
  assert.equal((await local.register({name:'local',method:'manual',target:target()})).outcome,'blocked');
  const request={name:'local',method:'manual',target:target()},acquire=f.registration.acquire;
  f.state.policy=false;
  f.registration.acquire=async q=>{
    request.name='foreign';request.method='auto';request.target.repositoryId='99';return acquire(q);
  };
  assert.equal((await f.client().register(request)).outcome,'registered');
  const configured=f.calls.find(([k])=>k==='configure')[1];
  assert.equal(configured.target.repositoryId,'42');assert.ok(configured.work.includes('/local/'));
});

test('lifecycle-produced records feed the maintained selector: busy priority, offline fallback and revocation',async t=>{
  for(const ownerType of ['User','Organization']) {
    const sf=selectionFixture(),records=[];
    sf.input.target.ownerType=ownerType;sf.routes[sf.prefix].owner.type=ownerType;
    for(const [n,member] of sf.members.entries()) {
      const f=await fixture(t,member);f.state.configured=n*100;
      const c=f.client();await c.create({name:'local',agent:n?'gemini':'claude',count:1});
      const registered=await c.register({name:'local',method:'manual',
        target:{...target(ownerType),repository:'example-org/core',repositoryId:sf.input.target.id,
          registrationId:sf.input.registration.id}});
      assert.equal(registered.outcome,'registered');records.push(registered.environment.instances[0].binding);
    }
    sf.input.records=records;
    const inventory={total_count:records.length,runners:records.map((b,n)=>sf.runner(b.runnerId,b.memberId,{busy:n===0}))};
    sf.routes[sf.prefix+'/actions/runners?per_page=100']=inventory;
    const selected=await sf.select();assert.equal(selected.memberId,sf.members[0].id,JSON.stringify(selected));
    inventory.runners[0].status='offline';assert.equal((await sf.select()).memberId,sf.members[1].id);
    records[0].active=false;assert.equal((await sf.select()).outcome,'blocked');
    assert.ok(sf.calls.every(r=>r.method==='GET'));
  }
});
