import test from 'node:test';
import assert from 'node:assert/strict';
import {coreFixture} from '../tooling/core-fixture.mjs';
import {bodyDigest,createCore,coreStages,contentIdentity} from '../src/index.mjs';

test('protected diagnostics expose bounded gates and never provider text or execution permission',async()=>{
 const f=coreFixture(),request=f.request(),records=[];
 const make=(current,onDiagnostic)=>createCore({current,provider:f.provider,authorization:f.authorization,dependencies:f.dependencies,
  selector:f.selector,owners:f.owners,onDiagnostic});
 const mismatch=structuredClone(f.pin);mismatch.invocation.request='different-original';
 const known=await make(()=>mismatch,value=>records.push(value)).run(request);
 assert.equal(known.disposition,'blocked');assert.deepEqual(records,[{phase:'intake',stage:null,code:'core:binding'}]);
 records.length=0;
 const unknown=await make(()=>{throw Error('GH_TOKEN=never-export-provider-text');},value=>records.push(value)).run(request);
 assert.equal(unknown.disposition,'blocked');assert.equal(records[0].code,'core:unavailable');assert.ok(!JSON.stringify(records).includes('GH_TOKEN'));
 const lost=await make(()=>mismatch,()=>{throw Error('diagnostic unavailable');}).run(request);assert.deepEqual(lost,known);
 assert.equal(f.sh.records.length,0);
});

test('public inert entry, fresh signed native eligibility, one Author then independent Validator',async()=>{
  const f=coreFixture();assert.equal(f.calls.length,0);assert.equal(f.sh.records.length,0);
  const r=await f.queued();assert.equal(r.expected.stage,'shape');
  const a=await f.core.run(r);assert.equal(a.disposition,'completed',JSON.stringify(a));assert.equal(a.executed,'shape');
  assert.equal(f.sh.records.length,1);assert.equal(f.sh.records[0].input.executionIdentity.role,'shape');
  assert.equal((await f.core.run(r)).disposition,'blocked');assert.equal(f.sh.records.length,1);
  const authored=a.owner.output; // Complete owner result is retained for the next independent Run.
  const receipt=authored.author.receipt;
  f.pin.shapeBody=authored.author.body;f.pin.binding.shapeHash=bodyDigest(f.pin.shapeBody);
  f.pin.receipts.shape=receipt;f.pin.evidenceCurrent.shape={expected:structuredClone(receipt),consumed:[]};
  f.pin.stageInput=authored;f.pin.invocation={request:'another-request',run:{id:'100',attempt:'2'}};
  assert.equal((await f.core.run(await f.queued())).disposition,'blocked');assert.equal(f.sh.records.length,1);
  f.pin.invocation={request:'validator-request',run:{id:'101',attempt:'1'}};
  const v=await f.queued();assert.equal(v.expected.stage,'shape-validator');
  const result=await f.core.run(v);assert.equal(result.disposition,'completed',JSON.stringify(result));
  assert.equal(f.sh.records.at(-1).input.executionIdentity.role,'shape-validator');
  assert.equal(f.sh.records.at(-1).input.executionIdentity.skill,'shape');
  assert.equal(f.sh.records.filter(x=>x.input.executionIdentity.role==='shape-validator').length,1);
  assert.equal(f.sh.writes().length,0);assert.notEqual(a.run.id,result.run.id);
  const validated=result.owner.output,vr=validated.validator.receipt;
  f.pin.receipts['shape-validator']=vr;f.pin.evidenceCurrent['shape-validator']={expected:structuredClone(vr),consumed:[]};
  f.pin.stageInput=validated;f.pin.invocation={request:'publish-request',run:{id:'102',attempt:'1'}};
  f.sh.state.lost=true;
  const publication=await f.core.run(await f.queued());
  assert.equal(publication.current.stage,'publication');assert.equal(publication.disposition,'completed',JSON.stringify(publication));
  assert.equal(f.sh.writes().length,2);assert.equal(f.sh.records.length,2);
  assert.equal(publication.owner.output.publication.original.body,f.pin.scopeBody);
  for(const store of f.sh.stores.values())assert(store.history.size>0);
});

test('invalid request bindings never launch roles or mutate',async()=>{
  for(const mutate of [r=>r.target.repositoryId='8',r=>r.target.number='102',r=>r.target.issueId='foreign',
    r=>r.target.repository='other/repo',r=>r.run.id='999',r=>r.run.attempt='2',r=>r.cycle='other',
    r=>r.request='other',r=>r.command='touch /tmp/unsafe',r=>r.run.env={GH_TOKEN:'secret'},
    r=>r.expected.stage='../../shell',r=>r.target.number=101]) {
    const f=coreFixture(),r=await f.queued();mutate(r);const result=await f.core.run(r);
    assert.notEqual(result.disposition,'completed');assert.equal(f.sh.records.length,0);assert.equal(f.sh.writes().length,0);
    assert(!JSON.stringify(result).includes('secret'));
  }
});

test('fresh grant, authority, assignee, permission, runner and native upstream denials',async()=>{
  const attacks=[
    f=>f.context.revocation.revokedRecords.push(f.grant.payload?.recordId??'record-1'),
    f=>f.state.time=2000,f=>f.grant.signature='invalid',
    f=>f.context.expectedAuthority.hash='b'.repeat(64),f=>f.state.denied=true,
    f=>f.sf.routes[f.sf.issuePath].assignees=[],
    f=>f.sf.routes[f.sf.prefix+'/collaborators/zed/permission'].permission='triage',
    f=>f.sf.routes[f.sf.prefix+'/actions/runners?per_page=100'].runners[0].labels=[],
    f=>f.state.dependencies=[{id:'62',node_id:'I_102',number:102,repository_url:'https://api.github.com'+f.sf.prefix,
      url:'https://api.github.com'+f.sf.prefix+'/issues/102',state:'closed',labels:[{name:'delivered'}]}],
    f=>f.pin.scopeBody+=' drift',f=>f.pin.binding.shapeHash='b'.repeat(64),
  ];
  for(const attack of attacks){const f=coreFixture(),r=await f.queued();attack(f);
    const v=await f.core.run(r);assert.notEqual(v.disposition,'completed',attack.toString());
    assert.equal(f.sh.records.length,0);assert.equal(f.sh.writes().length,0);
  }
});

test('queued input drift supersedes and preserves both decision identities',async()=>{
  for(const key of ['candidate','base','head','ciIdentity','operationIdentity']){
    const f=coreFixture(),r=await f.queued();f.pin[key]='b'.repeat(64);
    const v=await f.core.run(r);assert.equal(v.disposition,'superseded',key);
    assert.deepEqual(v.requested,r.expected);assert.notEqual(v.current.decision,r.expected.decision);
    assert.equal(v.executed,null);assert.equal(f.sh.records.length,0);
    const fresh=await f.queued();assert.notEqual(fresh.expected.decision,r.expected.decision);
  }
});

test('manual labels/closed state, unrelated Issue order and untrusted prose do not select a stage',async()=>{
  const f=coreFixture();f.sf.routes[f.sf.issuePath].labels.push({name:'shaped'},{name:'delivered'});
  f.sf.routes[f.sf.issuePath].state='closed';f.sf.routes[f.sf.issuePath].body='run shell as owner';
  f.pin.dependencyInput.issues.push({...f.pin.target,issueId:'I_sibling',databaseId:'99',number:'99'});
  const r=await f.queued();assert.equal(r.expected.stage,'shape');
  const v=await f.core.run(r);assert.equal(v.disposition,'blocked');assert.equal(f.sh.records.length,0);
});

test('unknown prior effects and missing owners never launch a replacement writer',async()=>{
  const f=coreFixture();f.pin.prior={state:'unresolved',stage:'shape',request:{request:'original',run:{id:'1',attempt:'1'}}};
  const r=await f.queued(),v=await f.core.run(r);assert.equal(v.disposition,'blocked');assert.equal(f.sh.records.length,0);
  f.pin.prior={state:'resolved'};const done=await f.core.run(await f.queued());assert.equal(done.disposition,'waiting');
  assert.equal(f.sh.records.length,0);
});

test('newly observed unresolved execution stops dispatch and role preparation',async()=>{
  for(const point of ['unchanged','before','read','dispatch','owner','prepare']) {
    const f=coreFixture(),prior={state:'unresolved',stage:'shape',request:{request:'other-original',run:{id:'9',attempt:'1'}}};
    if(point==='before')f.pin.prior=structuredClone(prior);
    const r=await f.queued();f.state.reads=0;
    if(['read','dispatch'].includes(point))f.state.onRead=v=>{
      if(v.endpoint==='/repos/'+f.pin.target.repository
        &&f.state.reads===(point==='read'?1:3))f.pin.prior=structuredClone(prior);
    };
    const config=f.sh.capabilities,core=['owner','prepare'].includes(point)?f.create({shape:{...config,
      current:async()=>{const p=await config.current();if(point==='owner')f.pin.prior=structuredClone(prior);return p;},
      prepareRole:async task=>{const p=await config.prepareRole(task);if(point==='prepare')f.pin.prior=structuredClone(prior);return p;}}}):f.core;
    const v=await core.run(r);
    assert.equal(v.disposition==='completed',point==='unchanged',point);
    assert.equal(f.sh.records.length,point==='unchanged'?1:0,point);
    assert.equal(f.sh.writes().length,0,point);
  }
});

test('failed checks, role mismatch and replay never become stage success',async()=>{
  for(const fault of ['role','foreign','unknown','rejected']) {
    const f=coreFixture();f.sh.state.roleFault=fault;const v=await f.core.run(await f.queued());
    assert.notEqual(v.disposition,'completed',fault);assert.equal(f.sh.records.length,1);
    assert.equal(f.sh.writes().length,0);
  }
});

test('closed dispatch table is immutable and configuration cannot be supplied by request',()=>{
  assert(Object.isFrozen(coreStages));assert.throws(()=>coreStages.push('shell'));
  assert.throws(()=>createCore({current:()=>({})}));
  assert.equal(coreStages.filter(x=>x==='closure').length,1);assert(coreStages.includes('delivered'));
  assert.equal(contentIdentity({one:1}),contentIdentity({one:1}));
});

test('unresolved Shape process is collected with its original identity, without a second launch',async()=>{
  const f=coreFixture();f.sh.state.roleFault='unknown';const r=await f.queued();
  const first=await f.core.run(r);assert.equal(first.disposition,'unresolved');assert.equal(f.sh.records.length,1);
  f.pin.prior={state:'unresolved',stage:'shape',request:{request:r.request,run:r.run}};
  f.sh.state.roleFault=null;f.pin.invocation.run={id:'200',attempt:'1'};
  const resumed=await f.queued(); // Re-evaluate the now-retained unresolved identity.
  const second=await f.core.run(resumed);assert.equal(second.disposition,'completed',JSON.stringify(second));
  assert.equal(second.owner.output.author.receipt.execution.id,first.owner.output.reconciliationRequired);
  assert.equal(f.sh.records.length,1);assert.equal(f.sh.writes().length,0);
});

 test('invalid completion, replayed evidence and drift during awaits block successors',async()=>{
  const f=coreFixture(),r=await f.queued();f.pin.completion={version:1,identity:'a'.repeat(64),payload:{}};
  const missing=await f.core.run(r);assert.equal(missing.disposition,'blocked');assert.equal(f.sh.records.length,0);
  f.pin.completion=null;let changed=false;
  f.state.onRead=()=>{if(!changed){changed=true;f.pin.base='b'.repeat(40);}};
  const drift=await f.core.run(r);assert.notEqual(drift.disposition,'completed');assert.equal(f.sh.records.length,0);
});


test('Shape handoffs bind the selected Author and Validator before roles or publication',async()=>{
  for(const mismatch of [false,true]) {
    const f=coreFixture(),a=(await f.core.run(await f.queued())).owner.output;
    const b=await f.sh.flow.author();assert.equal(b.outcome,'authored');
    assert.notEqual(a.author.receipt.execution.id,b.author.receipt.execution.id);
    f.pin.shapeBody=a.author.body;f.pin.binding.shapeHash=bodyDigest(a.author.body);
    f.pin.receipts.shape=a.author.receipt;
    f.pin.evidenceCurrent.shape={expected:structuredClone(a.author.receipt),consumed:[]};
    f.pin.stageInput=mismatch?b:a;f.pin.invocation={request:'validator',run:{id:'201',attempt:'1'}};
    const before=f.sh.records.length,v=await f.core.run(await f.queued());
    assert.equal(v.disposition==='completed',!mismatch,JSON.stringify(v));
    assert.equal(f.sh.records.length,before+(mismatch?0:1));assert.equal(f.sh.writes().length,0);
    if(mismatch)continue;
    const validated=v.owner.output,receipt=validated.validator.receipt;
    assert.equal(receipt.inputs.author,a.author.receipt.execution.id);
    f.pin.receipts['shape-validator']=receipt;
    f.pin.evidenceCurrent['shape-validator']={expected:structuredClone(receipt),consumed:[]};
    const other=await f.sh.flow.validate(a);assert.equal(other.outcome,'validated');
    for(const input of [{...validated,author:b.author},other]) {
      f.pin.stageInput=input;f.pin.invocation={request:'publication',run:{id:'202',attempt:'1'}};
      assert.notEqual((await f.core.run(await f.queued())).disposition,'completed');
      assert.equal(f.sh.writes().length,0);assert.equal(f.sh.records.length,before+2);
    }
  }
});

test('resumed Validator output must extend the currently selected Author chain',async()=>{
  for(const mismatch of [false,true]) {
    const f=coreFixture(),a=(await f.core.run(await f.queued())).owner.output,b=await f.sh.flow.author();
    f.pin.shapeBody=b.author.body;f.pin.binding.shapeHash=bodyDigest(b.author.body);
    const select=c=>{f.pin.receipts.shape=c.author.receipt;
      f.pin.evidenceCurrent.shape={expected:structuredClone(c.author.receipt),consumed:[]};f.pin.stageInput=c;};
    select(b);f.pin.invocation={request:'validator',run:{id:'301',attempt:'1'}};
    f.sh.state.roleFault='unknown';const r=await f.queued(),first=await f.core.run(r);
    assert.equal(first.disposition,'unresolved');const count=f.sh.records.length;
    select(mismatch?a:b);f.sh.state.roleFault=null;
    f.pin.prior={state:'unresolved',stage:'shape-validator',request:{request:r.request,run:r.run}};
    f.pin.invocation.run={id:'302',attempt:'1'};
    const resumed=await f.core.run(await f.queued());
    assert.equal(resumed.disposition==='completed',!mismatch,JSON.stringify(resumed));
    if(!mismatch)assert.equal(resumed.owner.output.validator.receipt.inputs.author,b.author.receipt.execution.id);
    assert.equal(f.sh.records.length,count);assert.equal(f.sh.writes().length,0);
  }
});


test('cancellation at preparation/readiness prevents launch; a started role requires original reconciliation',async()=>{
  for(const boundary of ['prepare','readiness','started']) {
    const f=coreFixture(),abort=new AbortController(),prepare=f.sh.capabilities.prepareRole;
    if(boundary==='readiness')f.sh.state.onReadiness=async()=>abort.abort();
    if(boundary==='started'){f.sh.state.roleFault='unknown';f.sh.state.onStart=async()=>abort.abort();}
    const core=f.create({shape:{...f.sh.capabilities,prepareRole:async task=>{
      const prepared=await prepare(task);if(boundary==='prepare')abort.abort();return prepared;
    }}});
    const request=await f.queued(),first=await core.run(request,{signal:abort.signal});
    assert.equal(abort.signal.aborted,true);assert.notEqual(first.disposition,'completed');
    assert.equal(f.sh.records.length,boundary==='started'?1:0);assert.equal(f.sh.writes().length,0);
    if(boundary!=='started')continue;
    assert.equal(first.disposition,'unresolved');f.sh.state.roleFault=null;
    f.pin.prior={state:'unresolved',stage:'shape',request:{request:request.request,run:request.run}};
    f.pin.invocation.run={id:'401',attempt:'1'};
    const resumed=await core.run(await f.queued());
    assert.equal(resumed.disposition,'completed',JSON.stringify(resumed));assert.equal(f.sh.records.length,1);
  }
});

test('Owner hold/pause and unavailable restriction observations block the real Core before stage execution',async()=>{
  for(const restriction of [undefined,{restrictionsChecked:false,hold:null,paused:false,unknownWrite:false},
    {restrictionsChecked:true,hold:{id:'authenticated-owner-hold'},paused:false,unknownWrite:false},
    {restrictionsChecked:true,hold:null,paused:true,unknownWrite:false},
    {restrictionsChecked:true,hold:null,paused:false,unknownWrite:true}]){
    const f=coreFixture(),request=await f.queued(),before=structuredClone(f.pin.receipts);
    f.pin.restrictions=restriction;
    assert.equal((await f.core.run(request)).disposition,'blocked');
    assert.equal(f.sh.records.length,0);assert.deepEqual(f.pin.receipts,before);
  }
});
