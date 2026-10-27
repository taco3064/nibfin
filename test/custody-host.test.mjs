import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import * as core from '../src/index.mjs';
import {configure,validateHostOptions} from '../host/entry.mjs';
import {custodyHostFixture} from '../tooling/custody-host-fixture.mjs';
import {workflowFixture} from '../tooling/workflow-fixture.mjs';
import {coreFixture} from '../tooling/core-fixture.mjs';
import {operationsFixture} from '../tooling/operations-fixture.mjs';
const copy=structuredClone,h='a'.repeat(64);

// Fresh instances receive ONLY service bytes and independent expected identities.
// Producer temp files/objects are discarded, not shared with consumers.
test('public personal and organization: durable round trip after producer cleanup',async()=>{
  for(const repository of ['example/core','example-org/core']) {
    const f=custodyHostFixture(repository),s=f.register(f.slot());let root;
    f.remote.afterUpload=async v=>{root=v.root;};
    let producer=f.fresh();
    const record=core.retainedRoleRecord({status:'capacity-failure',output:'partial role output',
      verification:[{command:'node --test focused',digest:h,outcome:'failed',log:'capacity limit'}],
      repair:{accepted:false,findings:['unaccepted input']}});
    const retained=await producer.retain(f.argument(s,record));assert.equal(retained.outcome,'retained');
    assert.equal(f.remote.uploads,2);assert.equal(existsSync(root),false);producer=null;
    const recovered=await f.fresh().recover({kind:s.kind,key:retained.key});
    assert.equal(recovered.outcome,'recovered');assert.deepEqual(recovered.value,record);
    assert.equal(recovered.value.repair.accepted,false);assert.equal(f.remote.uploads,2);
    assert.throws(()=>core.compareEvidence(recovered.value,{}));
    for(const request of f.remote.storage){assert.equal(request.options.credentials,'omit');assert.deepEqual(request.options.headers,{});}
  }
});

test('resolution and stage result through maintained protected host, with inert construction',async()=>{
  for(const ownership of ['personal','organization']) {
    const f=await workflowFixture();f.identity.ownership=ownership;
    const storage=custodyHostFixture(f.context.repository,f.context.run.id),slots=new Map();
    function slotFor(kind,key){
      const s=storage.slot(kind,key);s.binding.target={repository:f.context.repository,repositoryId:f.context.repositoryId,issueId:f.pin.target.issueId};
      // Keep source storage separate from target, as in hosted -> member Runs.
      s.binding.requirements={revision:h,scopeHash:f.pin.binding.scopeHash,shapeHash:f.pin.binding.shapeHash};
      s.binding.role='shape';s.binding.stage='shape';return storage.register(s);
    }
    const expectations=async({kind,key})=>{
      const s=slots.get(kind+':'+key);assert(s);return s;
    };
    const publication=async()=>({client:storage.client,runtime:storage.runtime});
    const authorizeNew=async s=>{const id=core.custodySlotIdentity(s);if(storage.remote.reserved.has(id))return false;storage.remote.reserved.add(id);return true;};
    // Core current() reconstructs the original prior record through durable
    // custody too; authorization and all other expectations remain independent.
    const priorSlot=slotFor('repair-input','original-prior');
    slots.set('repair-input:'+priorSlot.key,priorSlot);
    slots.set('repair-input:'+core.custodySlotIdentity(priorSlot),priorSlot);
    let priorProducer=core.createCustodyHost({provider:storage.provider,archive:storage.archive,
      expect:expectations,publication,authorizeNew,now:()=>storage.remote.clock});
    const retainedPrior=await priorProducer.retain({kind:'repair-input',key:priorSlot.key,value:copy(f.pin.prior)});
    assert.equal(retainedPrior.outcome,'retained');priorProducer=null;
    const currentCustody=core.createCustodyHost({provider:storage.provider,archive:storage.archive,
      expect:expectations,publication,authorizeNew,now:()=>storage.remote.clock});
    f.config.current=core.createCustodyCurrent({load:async()=>({pin:copy(f.pin),records:[{
      destination:'prior',query:{kind:'repair-input',key:retainedPrior.key},expected:{digest:core.contentIdentity(f.pin.prior)}}]}),custody:currentCustody});
    const {custodyDeployment}=await import(new URL('../host/custody.example.mjs',import.meta.resolve('../src/index.mjs')));
    function host(mode) {
      const capabilities={authenticate:f.host.authenticate,delivery:f.host.delivery,
        ...(['compute','execute'].includes(mode)?{verifyRunner:f.host.verifyRunner}:{})};
      const reads=storage.remote.reads;
      const deployment=custodyDeployment({core,options:{version:1,repository:f.context.repository,
        repositoryId:f.context.repositoryId,environment:mode==='resolve'?'nibfin-hosted':'nibfin-member'},capabilities,
        provider:storage.provider,archive:storage.archive,expectations,publication,authorizeNew});
      const composed=configure({core,mode,context:f.context,deployment});
      assert.equal(storage.remote.reads,reads);return core.createWorkflowEntry(composed);
    }
    const resolutionSlot=slotFor('resolution',f.input.nibfin_request);
    slots.set('resolution:'+resolutionSlot.key,resolutionSlot);
    slots.set('resolution:'+core.custodySlotIdentity(resolutionSlot),resolutionSlot);
    let producer=host('resolve');const r=await producer.invoke('resolve',f.input,f.context);
    assert.equal(r.status,'selected');assert.equal(r.resolution,core.custodySlotIdentity(resolutionSlot));producer=null;
    const attemptSlot=slotFor('stage-attempt',f.input.nibfin_request);
    slots.set('stage-attempt:'+attemptSlot.key,attemptSlot);
    const resultSlot=slotFor('stage-result',f.input.nibfin_request);
    slots.set('stage-result:'+resultSlot.key,resultSlot);slots.set('stage-result:'+core.custodySlotIdentity(resultSlot),resultSlot);
    const consumer=host('compute');
    const executed=await consumer.invoke('compute',{...f.input,resolution:r.resolution},f.context);
    assert.equal(executed.status,'completed');assert.equal(f.sh.records.length,1);
    const fresh=core.createCustodyHost({provider:storage.provider,archive:storage.archive,expect:expectations,
      publication,authorizeNew,now:()=>storage.remote.clock});
    const recovered=await fresh.recover({kind:'stage-result',key:executed.reference});
    assert.equal(recovered.outcome,'recovered');assert.equal(recovered.value.executed,'shape');
    assert.equal(recovered.value.disposition,'completed');
    // Rebuild ALL workflow/host objects with a stale new prior. Durable results
    // prevent a second role launch, even though local duplicate Sets were lost.
    const replay=await host('compute').invoke('compute',{...f.input,resolution:r.resolution},f.context);
    assert.equal(replay.status,'completed');assert.equal(f.sh.records.length,1);
  }
});

test('each materially independent expectation rejects wrong context without consumed payloads',async()=>{
  const f=custodyHostFixture(),s=f.register(f.slot());
  assert.equal((await f.fresh().retain(f.argument(s,{output:'original'}))).outcome,'retained');
  const changes=[
    b=>b.source.repository='other/core',b=>b.source.repositoryId='43',b=>b.source.revision='c'.repeat(40),
    b=>b.source.runId='902',b=>b.source.attempt='2',b=>b.target.repository='other/core',
    b=>b.target.repositoryId='43',b=>b.target.issueId='I_102',b=>b.requirements.revision='c'.repeat(64),
    b=>b.requirements.scopeHash='c'.repeat(64),b=>b.requirements.shapeHash='c'.repeat(64),
    b=>b.authorization='c'.repeat(64),b=>b.cycle='new-cycle',b=>b.role='accept',b=>b.stage='accept',
    b=>b.request='other',b=>b.result='other',b=>b.candidate={identity:'c'.repeat(64),payloads:[]}
  ];
  for(const change of changes) {
    const wrong=copy(s);change(wrong.binding);
    const consumer=f.fresh({expect:async()=>wrong});const result=await consumer.recover(f.argument(s));
    assert.equal(result.outcome,'unresolved');assert.equal(result.value,undefined);
  }
  assert.equal(f.remote.uploads,2);
  const original=copy(s);f.register({...s,kind:'repair-input'});
  assert.equal((await f.fresh().recover({kind:'repair-input',key:s.key})).outcome,'unresolved');
  assert.equal((await f.fresh({expect:async()=>({...original,key:'other'})}).recover(f.argument(s))).outcome,'unresolved');
});

test('archive integrity, expiry, artifact identity and complete unambiguous discovery',async()=>{
  const cases=[
    f=>f.remote.archiveChange=b=>b.subarray(0,b.length-8),
    f=>f.remote.archiveChange=b=>{const v=Buffer.from(b);v[50]^=1;return v;},
    f=>f.remote.metadataChange=m=>({...m,expired:true}),
    f=>f.remote.metadataChange=m=>({...m,expires_at:'2000-01-01'}),
    f=>f.remote.metadataChange=m=>({...m,workflow_run:{...m.workflow_run,id:'4'}}),
    f=>f.remote.metadataChange=m=>({...m,workflow_run:{...m.workflow_run,repository_id:'4'}}),
    f=>f.remote.metadataChange=m=>({...m,digest:'sha256:'+'f'.repeat(64)}),
    f=>f.remote.metadataChange=m=>({...m,size_in_bytes:m.size_in_bytes+1}),
    f=>f.remote.incomplete=true,f=>f.remote.duplicate=true,
    f=>{const a=[...f.remote.artifacts.values()].at(-1);f.remote.artifacts.set('999',{...a,id:'999'});},
    f=>f.remote.artifacts.clear(),
    f=>f.remote.runChange=r=>({...r,head_sha:'d'.repeat(40)}),
    f=>f.remote.runChange=r=>({...r,run_attempt:2}),
    f=>f.remote.runChange=r=>({...r,repository:{...r.repository,private:true}})
  ];
  for(const change of cases) {
    const f=custodyHostFixture(),s=f.register(f.slot());
    assert.equal((await f.fresh().retain(f.argument(s,{output:'exact'}))).outcome,'retained');
    change(f);const result=await f.fresh().recover(f.argument(s));
    assert.equal(result.outcome,'unresolved');assert(!Object.hasOwn(result,'value'));
  }
});

test('interrupted publication before upload, lost submission and readback never blindly replay',async()=>{
  for(const phase of ['before','intent','result','readback']) {
    const f=custodyHostFixture(),s=f.register(f.slot());
    if(phase==='before')f.remote.failUpload='intent';
    if(['intent','result'].includes(phase))f.remote.lostUpload=phase;
    if(phase==='readback')f.remote.afterUpload=async({phase:p})=>{if(p==='result')f.remote.readbackFail=true;};
    const first=await f.fresh().retain(f.argument(s,{output:'retained output'}));assert.equal(first.outcome,'unresolved');
    const uploads=f.remote.uploads;f.remote.lostUpload=null;f.remote.failUpload=null;f.remote.readbackFail=false;
    const fresh=f.fresh(),recovery=await fresh.recover(f.argument(s));
    assert.equal(recovery.outcome,['result','readback'].includes(phase)?'recovered':'unresolved');
    const duplicate=await fresh.retain(f.argument(s,{output:'retained output'}));
    assert.equal(duplicate.outcome,['result','readback'].includes(phase)?'recovered':'unresolved');
    assert.equal(f.remote.uploads,uploads);
  }
});

test('duplicate and out-of-order wakeups cannot change a retained result or upload twice',async()=>{
  const f=custodyHostFixture(),s=f.register(f.slot());
  const producer=f.fresh();const results=await Promise.all([producer.retain(f.argument(s,{output:'one'})),producer.retain(f.argument(s,{output:'two'}))]);
  assert.equal(results.filter(r=>r.outcome==='retained').length,1);
  assert.equal(results.filter(r=>r.outcome==='unresolved').length,1);
  assert.equal((await f.fresh().retain(f.argument(s,{output:'one'}))).outcome,'recovered');
  assert.equal((await f.fresh().retain(f.argument(s,{output:'two'}))).outcome,'unresolved');
  assert.equal(f.remote.uploads,2);
  const missing=f.register(f.slot('stage-result','earlier-request'));
  assert.equal((await f.fresh().recover(f.argument(missing))).outcome,'unresolved');assert.equal(f.remote.uploads,2);
});

test('fresh current hydrates independent pinned input only and validates receipt gates',async()=>{
  const f=custodyHostFixture(),s=f.register(f.slot('repair-input'));
  const prior={state:'unresolved',stage:'deliver',request:{request:s.key}};
  const r=await f.fresh().retain(f.argument(s,prior));assert.equal(r.outcome,'retained');
  const spec={pin:{prior:null,authorization:'independent'},records:[{destination:'prior',
    query:{kind:s.kind,key:r.key},expected:{digest:core.contentIdentity(prior)}}]};
  const current=core.createCustodyCurrent({load:async()=>copy(spec),custody:f.fresh()});
  assert.deepEqual(await current(),{prior,authorization:'independent'});
  spec.records[0].expected.digest='b'.repeat(64);await assert.rejects(current);
  spec.records[0].destination='authorization';await assert.rejects(current);
  spec.records[0].destination='receipts.accept';spec.pin.evidenceCurrent={accept:{}};spec.pin.receipts={};
  spec.records[0].expected.digest=core.contentIdentity(prior);await assert.rejects(current);
});

test('lost final role response recovers exact bytes without producer backend and retains original failures',async()=>{
  for(const status of ['diagnostic','capacity-failure','validation-failure','unknown-write','validated']) {
    const f=custodyHostFixture(),s=f.register(f.slot());
    const record=core.retainedRoleRecord({status,output:'original unaccepted role output',
      verification:[{command:'node --test',digest:h,outcome:status==='validated'?'passed':'failed',log:'bounded log'}],repair:{accepted:false}});
    assert.equal((await f.fresh().retain(f.argument(s,record))).outcome,'retained');
    const recovered=await f.fresh().retrieve(f.argument(s));assert.deepEqual(recovered,record);
    assert.throws(()=>core.compareEvidence(recovered,{}));
  }
  const f=custodyHostFixture(),s=f.register(f.slot());let calls=0;
  const backend=Object.fromEntries(['readiness','start','stop','termination','cleanup'].map(k=>[k,async()=>({status:'unused'})]));
  const value={status:'complete',exitCode:0,evidence:{invalid:'structured result'}};
  backend.collect=async()=>{calls++;return value;};
  let producer=core.createRetainedRoleBackend({backend,custody:f.fresh(),query:async()=>f.argument(s)});
  assert.deepEqual(await producer.collect({execution:'original'}),value);producer=null;
  backend.collect=async()=>{throw Error('producer deleted');};
  const recovered=await core.createRetainedRoleBackend({backend,custody:f.fresh(),query:async()=>f.argument(s)}).collect({execution:'original'});
  assert.deepEqual(recovered,value);assert.equal(calls,1);assert.throws(()=>core.compareEvidence(recovered.evidence,{}));
});

test('interrupted role retention and partial output remain pending, never successful collection',async()=>{
  for(const complete of [false,true]) {
    const f=custodyHostFixture(),s=f.register(f.slot());f.remote.failUpload='result';
    const backend=Object.fromEntries(['readiness','start','stop','termination','cleanup'].map(k=>[k,async()=>({status:'unused'})]));
    backend.collect=async()=>({status:complete?'complete':'pending',exitCode:complete?0:null,evidence:complete?{}:null});
    const wrapped=core.createRetainedRoleBackend({backend,custody:f.fresh(),query:async()=>f.argument(s)});
    assert.equal((await wrapped.collect({execution:'one'})).status,'pending');
    const uploaded=f.remote.uploads;assert.equal(uploaded,complete?2:0);
    f.remote.failUpload=null;assert.equal((await wrapped.collect({execution:'one'})).status,'pending');
    assert.equal(f.remote.uploads,uploaded);
  }
});

test('403, timeout, cancellation, malformed records, limits and confidentiality fail bounded',async()=>{
  for(const change of [f=>f.remote.error=403,f=>f.remote.hang=true,f=>f.remote.readbackFail=true]) {
    const f=custodyHostFixture(),s=f.register(f.slot());
    assert.equal((await f.fresh().retain(f.argument(s,{safe:'public'}))).outcome,'retained');change(f);
    const start=Date.now(),result=await f.fresh({timeoutMs:15}).recover(f.argument(s));
    assert.equal(result.outcome,'unresolved');assert(Date.now()-start<1000);assert(!JSON.stringify(result).includes('PRIVATE-SENTINEL'));
    assert(!JSON.stringify(result).includes('https://'));
  }
  const f=custodyHostFixture(),s=f.register(f.slot());
  for(const value of [{secret:'PRIVATE-SENTINEL'},{url:'https://storage.example/?sig=secret'},
    {token:'Bearer abc'},{key:'-----BEGIN RSA PRIVATE KEY-----'}, {output:'x'.repeat(1048577)}]) {
    assert.equal((await f.fresh().retain(f.argument(s,value))).outcome,'unresolved');assert.equal(f.remote.uploads,0);
  }
  const controller=new AbortController();controller.abort();
  assert.equal((await f.fresh().retain({...f.argument(s,{output:'safe'}),signal:controller.signal})).outcome,'unresolved');assert.equal(f.remote.uploads,0);
  assert.throws(()=>f.fresh({publication:null}));assert.throws(()=>f.fresh({archive:null}));
  assert.throws(()=>core.retainedRoleRecord({status:'validated'}));
  assert.throws(()=>core.retainedRoleRecord({status:'diagnostic',verification:[{command:'x',digest:h,outcome:'passed',log:'x'.repeat(8193)}]}));
  assert.throws(()=>core.custodySlotIdentity({...s,binding:{...s.binding,role:'invented-role'}}));
  assert.throws(()=>f.register({...s,binding:{...s.binding,source:{...s.binding.source,attempt:'invalid'}}}));
});


test('external effect before result retention uses controlled owner fresh readback, no mutation replay',async()=>{
  const f=operationsFixture();f.state.retainFail='result';
  const interrupted=await f.fresh().execute(f.input);assert.equal(interrupted.outcome,'unknown');assert.equal(f.writes().length,1);
  const store=custodyHostFixture(),s=store.register(store.slot('repair-input'));
  const record=core.retainedRoleRecord({status:'unknown-write',repair:{accepted:false,operation:interrupted}});
  assert.equal((await store.fresh().retain(store.argument(s,record))).outcome,'retained');
  const recovered=await store.fresh().retrieve(store.argument(s));assert.equal(recovered.status,'unknown-write');
  f.state.retainFail=false;
  assert.equal((await f.fresh({runId:'200',attempt:'2'}).execute(f.input)).outcome,'confirmed-success');assert.equal(f.writes().length,1);
  f.state.failRead=true;
  assert.equal((await f.fresh().execute(f.input)).outcome,'unknown');assert.equal(f.writes().length,1);
});


test('applicable Candidate payloads require independent identity and exact bytes',async()=>{
  const f=custodyHostFixture(),s=f.slot('stage-result');
  const bytes=Buffer.from([0,255,3,128]);s.binding.candidate={identity:h,payloads:[{path:'out/ignored.bin',digest:core.byteDigest(bytes)}]};
  f.register(s);
  assert.equal((await f.fresh().retain(f.argument(s,{candidate:'retained'}))).outcome,'unresolved');assert.equal(f.remote.uploads,0);
  const payloads=new Map([['out/ignored.bin',bytes]]);
  assert.equal((await f.fresh().retain({...f.argument(s,{candidate:'retained'}),payloads})).outcome,'retained');
  payloads.clear();
  const recovered=await f.fresh().recover(f.argument(s));assert.equal(recovered.outcome,'recovered');
  assert.deepEqual(recovered.payloads.get('out/ignored.bin'),bytes);
  assert.equal((await f.fresh().retain({...f.argument(s,{candidate:'retained'}),payloads:new Map([['out/ignored.bin',Buffer.from('tampered')]])})).outcome,'unresolved');
  assert.equal(f.remote.uploads,2);
});


test('valid ZIP/digest cannot hide altered manifest bindings or malformed host records',async()=>{
  const mutations=[
    files=>{const m=JSON.parse(files.get('custody-manifest.json'));m.binding.attempt='2';files.set('custody-manifest.json',Buffer.from(JSON.stringify(m)));},
    files=>{const m=JSON.parse(files.get('custody-manifest.json'));m.binding.repositoryId='43';files.set('custody-manifest.json',Buffer.from(JSON.stringify(m)));},
    files=>files.set('host-record.json',Buffer.from('{truncated')),
    files=>{const m=JSON.parse(files.get('host-record.json'));m.slot.binding.role='accept';files.set('host-record.json',Buffer.from(JSON.stringify(m)));},
    files=>{const m=JSON.parse(files.get('host-record.json'));m.version=2;files.set('host-record.json',Buffer.from(JSON.stringify(m)));},
    files=>{const m=JSON.parse(files.get('host-record.json'));m.phase='intent';files.set('host-record.json',Buffer.from(JSON.stringify(m)));}
  ];
  for(const mutate of mutations) {
    const f=custodyHostFixture(),s=f.register(f.slot());
    assert.equal((await f.fresh().retain(f.argument(s,{public:'exact'}))).outcome,'retained');
    f.rewrite(s,'result',files=>{
      mutate(files);
      // Recompute payload entries to distinguish semantic rejection from a
      // mere CRC/digest mismatch. The trusted expected binding remains fixed.
      const manifest=JSON.parse(files.get('custody-manifest.json'));
      manifest.payloads=[...files].filter(([p])=>p!=='custody-manifest.json').map(([path,bytes])=>({path,size:bytes.length,digest:core.byteDigest(bytes)}));
      files.set('custody-manifest.json',Buffer.from(JSON.stringify(manifest)));
    });
    const result=await f.fresh().recover(f.argument(s));assert.equal(result.outcome,'unresolved');assert.equal(result.value,undefined);
  }
});

test('missing or conflicting retained intent prevents consuming a matching result',async()=>{
  for(const missing of [true,false]) {
    const f=custodyHostFixture(),s=f.register(f.slot());
    assert.equal((await f.fresh().retain(f.argument(s,{public:'exact'}))).outcome,'retained');
    const intent=[...f.remote.artifacts.values()].find(a=>a.name.startsWith('nibfin-intent-'));
    if(missing)f.remote.artifacts.delete(intent.id);
    else f.rewrite(s,'intent',files=>{
      const record=JSON.parse(files.get('host-record.json'));record.value.resultDigest='f'.repeat(64);
      files.set('host-record.json',Buffer.from(core.canonicalJSON(record)));
      const manifest=JSON.parse(files.get('custody-manifest.json'));manifest.payloads[0]={path:'host-record.json',size:files.get('host-record.json').length,digest:core.byteDigest(files.get('host-record.json'))};
      files.set('custody-manifest.json',Buffer.from(core.canonicalJSON(manifest)));
    });
    assert.equal((await f.fresh().recover(f.argument(s))).outcome,'unresolved');assert.equal(f.remote.uploads,2);
  }
});


test('recovered valid and rejected role collections pass fresh validation without inheriting producer verdict',async()=>{
  const c=coreFixture(),authored=await c.core.run(await c.queued());
  const receipt=authored.owner.output.author.receipt;
  for(const rejected of [false,true]) {
    const f=custodyHostFixture(),s=f.slot(),value=copy(receipt);
    Object.assign(s.binding,{role:receipt.execution.role,stage:receipt.stage,request:receipt.execution.request,
      result:receipt.execution.result,authorization:receipt.binding.grant,
      requirements:{revision:h,scopeHash:receipt.binding.scopeHash,shapeHash:receipt.binding.shapeHash}});f.register(s);
    if(rejected)value.result={version:1,outcome:'changes_required',failureClass:'implementation_defect',summary:'unaccepted',conflicts:[]};
    const record=core.retainedRoleRecord({status:'diagnostic',output:core.canonicalJSON({status:'complete',exitCode:0,evidence:value})});
    assert.equal((await f.fresh().retain(f.argument(s,record))).outcome,'retained');
    const current={expected:copy(receipt),consumed:[]};
    const checked=await core.recoverRoleCollection({custody:f.fresh(),query:f.argument(s),current});
    assert.equal(checked.outcome,rejected?'rejected':'validated');
    if(rejected)assert.equal(checked.collection.result.failureClass,'implementation_defect');
    else assert.deepEqual(checked.evidence,receipt);
    current.consumed.push(receipt.execution.result);
    assert.equal((await core.recoverRoleCollection({custody:f.fresh(),query:f.argument(s),current})).outcome,'blocked');
    current.consumed=[];
    const wrong=copy(s);wrong.binding.role='accept';f.register(wrong);
    assert.equal((await core.recoverRoleCollection({custody:f.fresh(),query:f.argument(s),current})).outcome,'blocked');f.register(s);
    current.expected.execution.role='deliver';
    assert.equal((await core.recoverRoleCollection({custody:f.fresh(),query:f.argument(s),current})).outcome,'blocked');
  }
  const f=custodyHostFixture(),s=f.register(f.slot('stage-result'));
  assert.equal((await f.fresh().retain(f.argument(s,receipt))).outcome,'retained');
  const load={pin:{receipts:{},evidenceCurrent:{shape:{expected:copy(receipt),consumed:[]}}},
    records:[{destination:'receipts.shape',query:f.argument(s),expected:{digest:core.contentIdentity(receipt)}}]};
  const current=core.createCustodyCurrent({load:async()=>copy(load),custody:f.fresh()});
  assert.deepEqual((await current()).receipts.shape,receipt);
  load.pin.evidenceCurrent.shape.consumed=[receipt.execution.result];await assert.rejects(current);
});


test('malformed host arguments and missing official upload capability stop without external writes',async()=>{
  const f=custodyHostFixture(),s=f.register(f.slot());
  for(const arg of [null,undefined,{}, {kind:s.kind,key:s.key,signal:{}},f.argument(s,{output:undefined})]) {
    const result=await f.fresh().retain(arg);assert.equal(result.outcome,'unresolved');
    assert(!JSON.stringify(result).includes('PRIVATE-SENTINEL'));
  }
  assert.equal(f.remote.uploads,0);
  assert.equal((await f.fresh({publication:async()=>({})}).retain(f.argument(s,{safe:true}))).outcome,'unresolved');
  assert.equal(f.remote.uploads,0);
});

test('workflow cancellation during intent retention stops downstream upload and stage launch',async()=>{
  const f=await workflowFixture(),storage=custodyHostFixture(f.context.repository,f.context.run.id);
  const s=storage.slot('resolution',f.input.nibfin_request);
  s.binding.target={repository:f.context.repository,repositoryId:f.context.repositoryId,issueId:f.pin.target.issueId};storage.register(s);
  const controller=new AbortController();storage.remote.afterUpload=async()=>controller.abort();
  const custody={provider:storage.provider,archive:storage.archive,expect:async()=>s,
    publication:async()=>({client:storage.client,runtime:storage.runtime}),authorizeNew:async()=>true,now:()=>storage.remote.clock};
  const host=configure({core,mode:'resolve',context:f.context,deployment:{options:{version:1,repository:f.context.repository,
    repositoryId:f.context.repositoryId,environment:'nibfin-hosted'},capabilities:{authenticate:f.host.authenticate,delivery:f.host.delivery},custody}});
  const result=await core.createWorkflowEntry(host).invoke('resolve',f.input,f.context,{signal:controller.signal});
  assert.equal(result.status,'blocked');assert.equal(f.sh.records.length,0);assert.equal(storage.remote.uploads,1);
});


test('approved executable custody configuration loads inertly and changed approval blocks evaluation',async()=>{
  const source=`export const capabilities={resolve:{authenticate:async()=>{},delivery:async()=>{}}};
    export const custody={resolve:{provider:{request:async()=>{},collection:async()=>{}},archive:async()=>{},
      expect:async()=>{},publication:async()=>{},authorizeNew:async()=>false}};`;
  const options=JSON.stringify({resolve:{version:1,repository:'example-org/core',repositoryId:'42',environment:'nibfin-hosted'}});
  const approval={sourceSha256:core.byteDigest(Buffer.from(source)),optionsSha256:core.byteDigest(Buffer.from(options))};
  const deployment=await core.loadProtectedDeployment({source,options,approval,validate:validateHostOptions,mode:'resolve'});
  assert.equal(typeof deployment.custody.expect,'function');
  const context={repository:'example-org/core',repositoryId:'42',run:{id:'100',attempt:'1'}};
  const host=configure({core,mode:'resolve',context,deployment});assert.equal(typeof host.retain,'function');
  await assert.rejects(()=>core.loadProtectedDeployment({source:source+' ',options,approval,validate:validateHostOptions,mode:'resolve'}));
  assert.throws(()=>configure({core,mode:'resolve',context,deployment:{...deployment,custody:{...deployment.custody,archive:null}}}));
});


test('durable stage marker with lost final result forbids relaunch across fresh hosts',async()=>{
  const f=custodyHostFixture(),attempt=f.register(f.slot('stage-attempt'));
  f.register(f.slot('stage-result'));
  const first=await f.fresh().beginStage(f.argument(attempt,{request:'original'}));
  assert.equal(first.outcome,'started');assert.equal(f.remote.uploads,2);
  // The original role may have executed; absence of its output is not no effect.
  const recovered=await f.fresh().beginStage(f.argument(attempt,{request:'original'}));
  assert.equal(recovered.outcome,'unresolved');assert.equal(f.remote.uploads,2);
});


test('maintained hosted API permission/redirect adapter integrates custody without storage credentials',async()=>{
  const f=custodyHostFixture(),s=f.register(f.slot());
  const apiCalls=[],storageCalls=[];let actions=true;
  const transport=core.hostedGithubTransport({repository:s.binding.source.repository,repositoryId:'42',now:()=>f.remote.clock,
    getCredential:async()=>({token:'fixture-protected-token',expiresAt:f.remote.clock+10000,repositoryIds:['42'],permissions:actions?{actions:'read'}:{}}),
    fetcher:async(url,options)=>{
      apiCalls.push({url,options});const endpoint=new URL(url).pathname+new URL(url).search;
      const result=endpoint.endsWith('/zip')?{status:302,headers:{location:'https://storage.example/'+endpoint.split('/').at(-2)+'?sig=private'},body:null}
        :await f.transport({method:options.method,endpoint});
      const response=new Response(result.body,{status:result.status,headers:result.headers});Object.defineProperty(response,'url',{value:url});return response;
    }});
  const provider=core.createGithubProvider({transport,attempts:1});
  const archive=core.artifactArchiveTransport({api:transport,fetch:async(url,options)=>{
    storageCalls.push({url,options});const id=new URL(url).pathname.slice(1);return new Response(f.remote.artifacts.get(id).bytes);
  }});
  const retained=await f.fresh({provider,archive}).retain(f.argument(s,{public:'actual hosted adapter'}));
  assert.equal(retained.outcome,'retained');
  const recovered=await f.fresh({provider,archive}).recover(f.argument(s));assert.equal(recovered.outcome,'recovered');
  assert.deepEqual(recovered.value,{public:'actual hosted adapter'});
  assert(apiCalls.some(c=>c.url.includes('/attempts/1')));
  for(const call of apiCalls){assert.equal(call.options.headers.Authorization,'Bearer fixture-protected-token');
    assert.equal(call.options.redirect,call.url.endsWith('/zip')?'manual':'error');}
  assert(storageCalls.length>0);
  for(const call of storageCalls){assert.deepEqual(call.options.headers,{});assert.equal(call.options.credentials,'omit');}
  actions=false;assert.equal((await f.fresh({provider,archive}).recover(f.argument(s))).outcome,'unresolved');
  assert.equal(f.remote.uploads,2);
  for(const endpoint of ['/repos/example-org/core/actions/runs/1/artifacts?per_page=100&page=2',
    '/repos/example-org/core/actions/runs/1/attempts/2','/repos/example-org/core/actions/artifacts/1','/repos/example-org/core/actions/artifacts/1/zip']) {
    assert.equal(core.githubEndpointPermission('GET',endpoint),'actions:read');assert.equal(core.githubEndpointPermission('POST',endpoint),null);
  }
  for(const endpoint of ['/repos/example-org/core/actions/artifacts/1/zip?per_page=1',
    '/repos/example-org/core/actions/runs/1/artifacts?token=unsafe','/repos/example-org/core/actions/runs/1/artifacts?per_page=101'])
    assert.equal(core.githubEndpointPermission('GET',endpoint),null);
});
