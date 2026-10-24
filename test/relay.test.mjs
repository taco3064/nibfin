import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventRelay, issueWakeup, contentIdentity} from '../src/index.mjs';
import {relayFixture, relayConsumerConfiguration, executeRelayConsumer} from '../tooling/relay-fixture.mjs';

const noWrite = f => assert.equal(f.writes().length,0);
const check = async (f, input=f.native, expected='blocked') => {
  const result = await executeRelayConsumer(f.fresh(), input);
  assert.equal(result.outcome,expected); assert.equal(result.continuation,false); return result;
};
test('installed-capable real adapter: fixed native/Dispatch routing and official concurrency',async()=>{
  const f=await relayFixture();
  const native=await check(f,f.native,'run-observed');
  const dispatch=await check(f,f.dispatch,'run-observed');
  assert.equal(native.wakeup,dispatch.wakeup); assert.equal(f.writes().length,1);
  assert.equal(native.provenance.transport,'issues'); assert.equal(dispatch.provenance.transport,'workflow_dispatch');
  assert.equal(native.operation.observation.effect,'dispatch-run-observed');
  assert.equal(native.continuation,false); // Observed queued Run is never stage success.
  const config=relayConsumerConfiguration({repository:'example-org/core',repositoryId:'42',issue:'101',cycle:'cycle-1'});
  assert.deepEqual(config.concurrency,native.concurrency.issue);
  assert.deepEqual(config.jobs.relay.concurrency,native.concurrency.write);
  assert.equal(config.concurrency['cancel-in-progress'],false);
  assert.deepEqual(Object.keys(config.on.workflow_dispatch.inputs),['nibfin_request','nibfin_correlation']);
  assert.equal(config['run-name'],'nibfin-operation:${{ inputs.nibfin_correlation }}');
  assert.ok(config.on.issues.types.includes('reopened'));
  const write=f.writes()[0];
  assert.equal(write.endpoint,'/repos/example-org/core/actions/workflows/50/dispatches');
  assert.equal(JSON.parse(write.body).ref,'b'.repeat(40));
});
test('opaque selectors, exact event schema and no deserialized capabilities',async()=>{
  const f=await relayFixture();
  for(const payload of [{...f.dispatch.payload,nibfin_request:'unknown'},
    {...f.dispatch.payload,nibfin_request:'$(arbitrary)'}, {...f.dispatch.payload,nibfin_correlation:'01;cmd'},
    {...f.dispatch.payload,nibfin_correlation:'other'},
    ...['command','role','target','authenticated','source','workflow','ref'].map(k=>({...f.dispatch.payload,[k]:'foreign'}))]) {
    await check(f,{name:'workflow_dispatch',payload});
  }
  for(const name of ['issue_dependencies','ping','repository_dispatch','push']) await check(f,{name,payload:{}});
  for(const key of ['repositoryId','number']) {
    await check(f,{name:'issues',payload:{...f.native.payload,[key]:'01'}});
    await check(f,{name:'issues',payload:{...f.native.payload,[key]:'999'}});
  }
  await check(f,{name:'issues',payload:{...f.native.payload,issueId:'I_foreign'}});
  await check(f,{...f.native,role:'deliver'});
  f.relayState.lookup=false; await check(f); noWrite(f);
  assert.throws(()=>createEventRelay({authenticateEvent:true}));
});
test('authenticated source must match fixed public repository/workflow/ref/actor policy',async()=>{
  const f=await relayFixture();
  for(const [key,value] of Object.entries({repository_id:'99',workflow_ref:'evil/repo/.github/workflows/x.yml@main',
    workflow_sha:'c'.repeat(40),workflowDigest:'c'.repeat(64),ref:'refs/heads/evil',actor_id:'99',
    repository_visibility:'private',event_name:'push'})) {
    f.relayState.expectedChanges={[key]:value};f.relayState.authChanges={[key]:value};
    await check(f); noWrite(f);
  }
  f.relayState.expectedChanges={};f.relayState.authChanges={run_attempt:'2'};await check(f);
  f.relayState.authChanges={};f.relayState.sourceClaim={ok:true,authenticated:true};await check(f);noWrite(f);
});
test('complete synthetic cryptographic predecessor, current expectation, freshness and replay rejection',async()=>{
  const f=await relayFixture(), original=structuredClone(f.receipt);
  const mutateLeaves=(value,path=[])=>Object.entries(value).flatMap(([k,v])=>v&&typeof v==='object'
    ?mutateLeaves(v,[...path,k]):[[...path,k]]);
  for(const path of mutateLeaves(original)) {
    const changed=structuredClone(original);let cursor=changed;
    for(const k of path.slice(0,-1))cursor=cursor[k];cursor[path.at(-1)]='foreign';
    f.args.receipt=changed;await check(f);noWrite(f);
  }
  f.args.receipt=original;
  for(const patch of [{source:{...f.args.source}}, {receipt:null}, {now:1300}, {recordedAt:1001},
    {consumerExecution:'validator'},{current:{expected:original,consumed:['approved']}},
    {current:{expected:{...original,execution:{...original.execution,request:'other'}},consumed:[]}}]) {
    const save={...f.args};Object.assign(f.args,patch);await check(f);Object.assign(f.args,save);noWrite(f);
  }
  for(const key of ['identity','request','result']) {
    const old=f.request.predecessor[key];f.request.predecessor[key]=key==='identity'?'c'.repeat(64):'other';
    await check(f);f.request.predecessor[key]=old;noWrite(f);
  }
  f.request.predecessor=null;await check(f);noWrite(f);
});
test('native Issue mappings include observational delivered, eligibility changes and unrelated events',()=>{
  const event={action:'labeled',repositoryId:'42',issueId:'I_101',number:'101',label:null,stateReason:null};
  for(const [action,label,stateReason,want] of [
    ['opened','scope',null,'resolve'],['opened',null,null,null],['labeled','scope',null,'resolve'],
    ['labeled','shaped',null,'deliver'],['labeled','delivered',null,'observe'],['labeled','other',null,null],
    ...['constructor','__proto__','toString'].map(label=>['labeled',label,null,null]),
    ['closed',null,'completed','completion'],['closed',null,'not_planned',null],['reopened',null,null,'recovery'],
    ...['edited','unlabeled','assigned','unassigned','milestoned','demilestoned'].map(a=>[a,null,null,'reevaluate']),
    ['deleted',null,null,null],['transferred',null,null,null]]) {
    assert.equal(issueWakeup({...event,action,label,stateReason}),want,action+':'+label);
  }
  assert.throws(()=>issueWakeup({...event,command:'run'}));
});
test('initial hints reevaluate only; manual labels and Close/Reopen cannot provide Core proof',async()=>{
  for(const [action,label,stateReason,hint] of [['opened','scope',null,'resolve'],['labeled','shaped',null,'deliver'],
    ['closed',null,'completed','completion'],['reopened',null,null,'recovery'],['assigned',null,null,'reevaluate']]) {
    const f=await relayFixture();Object.assign(f.native.payload,{action,label,stateReason});f.request.hint=hint;
    if(hint!=='deliver')f.request.predecessor=null;
    f.gate.applicability=false;await check(f);noWrite(f);
    f.gate.applicability=true;f.gate.mutationReadback=false;
    if(['deliver','completion','recovery'].includes(hint)) {await check(f);noWrite(f);}
    else {f.request.mutation='not-applicable';await check(f,f.native,'run-observed');}
  }
  const f=await relayFixture();f.native.payload.label='delivered';await check(f,f.native,'ignored');
  f.native.payload.label='unrelated';await check(f,f.native,'ignored');noWrite(f);assert.equal(f.relayState.gateCalls,0);
});
test('each denied fresh checkpoint prevents dispatch, including already known effects',async()=>{
  for(const key of ['authorization','dependencies','upstream','applicability','runner','mutationReadback']) {
    const f=await relayFixture();f.gate[key]=false;await check(f);noWrite(f);
  }
  const f=await relayFixture();await check(f,f.native,'run-observed');
  f.gate.dependencies=false;await check(f,f.dispatch);assert.equal(f.writes().length,1);
  const denied=await relayFixture();denied.operationState.allowed=false;
  await check(denied,denied.native,'waiting');noWrite(denied);
});
test('GITHUB_TOKEN suppression uses only approved alternate wakeup and truthful provenance',async()=>{
  const f=await relayFixture(),suppressed={...f.native,name:'suppressed'};
  f.request.fallback.approved=false;
  await check(f,suppressed,'waiting');await check(f,f.dispatch,'waiting');noWrite(f);
  f.request.fallback.approved=true;
  const result=await check(f,suppressed,'run-observed');
  assert.equal(result.provenance.transport,'suppressed');assert.ok(result.provenance.reason);
  const native=await check(f,f.native,'run-observed');assert.equal(result.wakeup,native.wakeup);
  assert.equal(f.writes().length,1);
});
test('both transport orders and later observer recover immutable original intent from custody',async()=>{
  for(const order of ['native','dispatch']) {
    const f=await relayFixture(),first=f[order],second=f[order==='native'?'dispatch':'native'];
    const a=await check(f,first,'run-observed');const b=await check(f,second,'run-observed');
    f.relayState.observedRun='200';
    const c=await f.fresh('200').wake(second);
    assert.equal(c.outcome,'run-observed');assert.equal(c.wakeup,a.wakeup);assert.equal(b.wakeup,a.wakeup);
    assert.equal(c.provenance.runId,'200');assert.equal(f.writes().length,1);
    assert.equal(c.operation.refs.intent.source.runId,'100');assert.equal(c.operation.refs.result.source.runId,'200');
  }
});
test('changed request binding rejects correlation reuse; new cycle/result is distinct',async()=>{
  const f=await relayFixture();const first=await check(f,f.native,'run-observed');
  f.request.intent.binding.cycle='cycle-2';f.receipt.execution.result='approved-2';
  f.args.current.expected=structuredClone(f.receipt);
  Object.assign(f.request.predecessor,{result:'approved-2',identity:contentIdentity(f.receipt)});
  await check(f,f.dispatch,'waiting');assert.equal(f.writes().length,1);
  f.request.intent.correlation='request-2';f.request.intent.payload.inputs.nibfin_correlation='request-2';
  f.dispatch.payload.nibfin_correlation='request-2';
  f.operationState.mutate=d=>({...d,display_title:'nibfin-operation:request-2'});
  const next=await check(f,f.dispatch,'run-observed');assert.notEqual(next.wakeup,first.wakeup);assert.equal(f.writes().length,2);
  const other=await relayFixture('102');const independent=await check(other,other.native,'run-observed');
  assert.notEqual(independent.wakeup,first.wakeup);assert.equal(other.writes().length,1);
});
test('unknown dispatch outcomes reconcile without resubmission and never imply stage success',async()=>{
  for(const mode of ['lost','no-run','wrong-run','duplicate-count','pagination','permission','attempt-retention','result-retention']) {
    const f=await relayFixture(),s=f.operationState;
    if(mode==='lost')s.lost=true;
    if(mode==='no-run')s.onWrite=()=>{s.effect=false;};
    if(mode==='wrong-run')s.mutate=d=>({...d,head_sha:'c'.repeat(40)});
    if(mode==='duplicate-count')s.total=2;
    if(mode==='pagination')s.incomplete=true;
    if(mode==='permission')s.failRead=true;
    if(mode==='attempt-retention')s.retainFail='attempt';
    if(mode==='result-retention')s.retainFail='result';
    const first=await check(f,f.native,mode==='lost'?'run-observed':'waiting');
    const count=f.writes().length;
    s.lost=false;s.onWrite=null;s.mutate=d=>d;s.total=undefined;s.incomplete=false;s.failRead=false;s.retainFail=false;
    const recovered=await check(f,f.dispatch,count && mode!=='no-run'?'run-observed':'waiting');
    assert.equal(f.writes().length,count,mode);assert.equal(recovered.wakeup,first.wakeup);
    assert.equal(recovered.continuation,false);
    if(mode==='no-run') {s.effect=true;await check(f,f.dispatch,'run-observed');assert.equal(f.writes().length,count);}
  }
});
test('inaccessible/missing/corrupt/expired retained history blocks instead of inferring newness',async()=>{
  for(const mode of ['corrupt','expired','missing','historyUnavailable']) {
    const f=await relayFixture();await check(f,f.native,'run-observed');
    if(mode==='missing')f.records.clear();else f.operationState[mode]=true;
    await check(f,f.dispatch,'waiting');assert.equal(f.writes().length,1);
  }
});

test('two matching Runs remain unknown and no blind second submission occurs',async()=>{
  const f=await relayFixture();await check(f,f.native,'run-observed');
  const run={id:'70',workflow_id:'50',event:'workflow_dispatch',head_sha:'b'.repeat(40),
    display_title:'nibfin-operation:request-1',repository:{id:'42'}};
  f.operationState.runs=[run,{...run,id:'71'}];f.operationState.total=2;
  await check(f,f.dispatch,'waiting');assert.equal(f.writes().length,1);
});

test('importing public package is inert without any configured capabilities',async()=>{
  const {execFileSync}=await import('node:child_process');
  const result=execFileSync(process.execPath,['--input-type=module','-e',`
    import {syncBuiltinESMExports} from 'node:module';
    import child from 'node:child_process';
    import fs from 'node:fs';
    import net from 'node:net';
    import https from 'node:https';
    const forbidden=()=>{throw Error('unexpected import effect');};
    for(const k of ['exec','execSync','execFile','execFileSync','spawn','spawnSync'])child[k]=forbidden;
    for(const k of ['writeFile','writeFileSync','mkdir','mkdirSync','rm','rmSync'])fs[k]=forbidden;
    net.connect=forbidden;https.request=forbidden;globalThis.fetch=forbidden;
    syncBuiltinESMExports();
    const api=await import(${JSON.stringify(import.meta.resolve('../src/index.mjs'))});
    if(typeof api.createEventRelay!=='function')throw Error('missing export');
    console.log('inert');
  `],{encoding:'utf8'});
  assert.equal(result.trim(),'inert');
});
test('every fixed routing binding change under an already retained correlation blocks',async()=>{
  const f=await relayFixture();await check(f,f.native,'run-observed');
  const initial=structuredClone(f.request);
  for(const mutate of [
    r=>{r.intent.binding.authorization='c'.repeat(64);},
    r=>{r.intent.binding.candidate='c'.repeat(64);},
    r=>{r.intent.binding.base='d'.repeat(40);},
    r=>{r.intent.binding.head='c'.repeat(40);},
    r=>{r.intent.binding.runId='201';},
    r=>{r.intent.binding.attempt='2';},
    r=>{r.intent.source.runId='201';},
    r=>{r.intent.source.attempt='2';},
    r=>{r.intent.target.id='51';r.intent.target.workflow='51';},
    r=>{r.intent.payload.ref='c'.repeat(40);},
    r=>{r.intent.binding.cycle='cycle-other';},
    r=>{r.sourcePolicy.actorIds.push('44');},
    r=>{r.fallback.reason='Revised approval';}
  ]) {
    Object.assign(f.request,structuredClone(initial));mutate(f.request);
    const result=await check(f,f.dispatch,'waiting');
    assert.equal(result.operation.continuation,false);assert.equal(f.writes().length,1);
  }
});
test('unknown request, malformed config and missing proof never reach the current checkpoint',async()=>{
  const f=await relayFixture(),initial=structuredClone(f.request);
  for(const mutate of [
    r=>{r.command='shell';}, r=>{r.role='accept';},
    r=>{r.sourcePolicy.actorIds=[];},r=>{r.sourcePolicy.repositoryId='01';},
    r=>{r.intent.payload.inputs.command='echo';},
    r=>{r.intent.payload.inputs.nibfin_request='other';},
    r=>{r.intent.source.request='other';},
    r=>{r.intent.payload.ref='main';},r=>{r.intent.kind='close';},
    r=>{r.predecessor={identity:'bad',request:'previous',result:'approved'};},
    r=>{r.mutation='not-applicable';},r=>{r.fallback.reason='';}
  ]) {
    Object.assign(f.request,structuredClone(initial));
    delete f.request.command;delete f.request.role;mutate(f.request);
    await check(f);noWrite(f);assert.equal(f.relayState.gateCalls,0);
  }
});
